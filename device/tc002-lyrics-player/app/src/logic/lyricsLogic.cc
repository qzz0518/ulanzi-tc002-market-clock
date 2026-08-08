#pragma once
#include "managers/KeyManager.h"
#include "managers/PageManager.h"
#include "managers/McuManager.h"
#include "mcuProtocol/mcuProtoParse.h"
#include "pages/SplashPage.h"
#include "pages/LyricsPage.h"
#include "pages/VolumePage.h"
#include "managers/AudioManager.h"
#include "net/NetClient.h"
#include <memory>
#include <string>
#include <pthread.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <os/SystemProperties.h>

namespace {

#define TIMER_TICK 1
const int LYRIC_TICK_MS = 60;
const int VOLUME_OVERLAY_MS = 1500;

enum PlayerState { STATE_SPLASH, STATE_LYRICS };
int sState = STATE_SPLASH;
int sSkin = 0;
int sVolume = 4;
int sVolumeShowMs = 0;  // >0 while the boba-cup volume overlay is visible

SplashPage* splashPage() {
	return static_cast<SplashPage*>(PageManager::getInstance().getPage("splash"));
}
LyricsPage* lyricsPage() {
	return static_cast<LyricsPage*>(PageManager::getInstance().getPage("lyrics"));
}
VolumePage* volumePage() {
	return static_cast<VolumePage*>(PageManager::getInstance().getPage("volume"));
}

void applyVolume() {
	awtrix::AudioManager::getInstance().setVolume(sVolume);
	sVolumeShowMs = VOLUME_OVERLAY_MS;
}

// LAN Pixel Studio service. All calls block, so they run off the UI thread.
// The installer writes the current service origin next to the pushed bundle
// at sideload time, so the same binary works on any network; the compile-time
// default only matters for bare manual adb pushes without that file.
#ifndef PIXEL_STUDIO_ORIGIN
#define PIXEL_STUDIO_ORIGIN "http://PIXEL_STUDIO_HOST:43820"
#endif
const char* kServiceOriginFile = "/tmp/tc002-music/service.origin";
const char* kLocalTrackPath   = "/tmp/track.mp3";

std::string readServiceOrigin() {
	FILE* f = fopen(kServiceOriginFile, "r");
	if (f == NULL) return PIXEL_STUDIO_ORIGIN;
	char buffer[256] = {0};
	size_t n = fread(buffer, 1, sizeof(buffer) - 1, f);
	fclose(f);
	std::string origin(buffer, n);
	while (!origin.empty()) {
		char last = origin[origin.size() - 1];
		if (last != '\n' && last != '\r' && last != ' ' && last != '\t') break;
		origin.erase(origin.size() - 1);
	}
	if (origin.compare(0, 7, "http://") != 0 || origin.size() < 10 || origin.size() > 200) {
		return PIXEL_STUDIO_ORIGIN;
	}
	return origin;
}

const std::string& serviceOrigin() {
	static const std::string origin = readServiceOrigin();
	return origin;
}

std::string serviceUrl(const char* path) {
	return serviceOrigin() + path;
}

volatile bool sPolling = true;

int modeToInt(const std::string& m) {
	if (m == "skyline") return 1;
	if (m == "spotlight") return 2;
	if (m == "cascade") return 3;
	return 0;  // ticker
}
const char* modeName(int m) {
	switch (m) {
	case 1: return "skyline";
	case 2: return "spotlight";
	case 3: return "cascade";
	default: return "ticker";
	}
}
int skinToInt(const std::string& s) {
	if (s == "tape") return 1;
	if (s == "blueprint") return 2;
	if (s == "arcade") return 3;
	return 0;  // signal
}

// Fire-and-forget a key-press report to the service, off the UI thread so the
// blocking POST can't stall key handling.
void* reportThread(void* arg) {
	std::string* json = (std::string*)arg;
	pixelnet::httpPost(serviceUrl("/api/music/device/report"), *json);
	delete json;
	return NULL;
}
void reportChange(const std::string& json) {
	std::string* copy = new std::string(json);
	pthread_t t;
	if (pthread_create(&t, NULL, reportThread, copy) == 0) pthread_detach(t);
	else delete copy;
}

// Load the currently selected track's lyrics + audio and start playback.
// setFetching() switches the screen from the idle hint to the loading pulse
// for the whole (blocking, ~5-7s) download.
void loadAndPlaySelection() {
	LyricsPage* fetchingPage = lyricsPage();
	if (fetchingPage) fetchingPage->setFetching(true);
	std::string body;
	if (pixelnet::httpGet(serviceUrl("/api/music/device/now"), body) && !body.empty()) {
		LyricsPage* lp = lyricsPage();
		if (lp) lp->loadRemoteLyrics(body);
	}
	awtrix::AudioManager::getInstance().stopAudio();
	if (pixelnet::downloadFile(serviceUrl("/api/music/device/audio"), kLocalTrackPath)) {
		awtrix::AudioManager::getInstance().playAudio(kLocalTrackPath);
		LyricsPage* lp = lyricsPage();
		if (lp) lp->startPlayback();
	}
	if (fetchingPage) fetchingPage->setFetching(false);
}

// Pull one "KEY\tVALUE" field out of the plain-text /state body.
std::string stateField(const std::string& body, const std::string& key) {
	std::string needle = key + "\t";
	std::string::size_type at = 0;
	while (at <= body.size()) {
		std::string::size_type eol = body.find('\n', at);
		std::string line = body.substr(at, eol == std::string::npos ? std::string::npos : eol - at);
		if (line.compare(0, needle.size(), needle) == 0) {
			std::string v = line.substr(needle.size());
			while (!v.empty() && (v[v.size() - 1] == '\r' || v[v.size() - 1] == ' ')) v.erase(v.size() - 1);
			return v;
		}
		if (eol == std::string::npos) break;
		at = eol + 1;
	}
	return std::string();
}

// Poll the full control state; apply track / play / mode / skin / accent changes
// whenever the service's seq advances. First poll (lastSeq=-1) loads whatever is
// already selected. Runs off the UI thread for its whole lifetime.
void* pollThread(void*) {
	int lastSeq = -1;
	std::string lastTrackId;
	long lastSeekApplied = -1;
	while (sPolling) {
		std::string body;
		if (pixelnet::httpGet(serviceUrl("/api/music/device/state"), body) && !body.empty()) {
			int seq = atoi(stateField(body, "SEQ").c_str());
			if (seq != lastSeq) {
				lastSeq = seq;
				LyricsPage* lp = lyricsPage();
				if (lp) {
					lp->setMode(modeToInt(stateField(body, "MODE")));
					int skinId = skinToInt(stateField(body, "SKIN"));
					lp->setSkin(skinId);
					sSkin = skinId;
					std::string acc = stateField(body, "ACCENT");
					if (acc.empty() || acc == "-") lp->setAccent(0, false);
					else lp->setAccent((uint32_t)strtoul(acc.c_str(), NULL, 16), true);
					std::string tid = stateField(body, "TID");
					bool trackChanged = (!tid.empty() && tid != "-" && tid != lastTrackId);
					if (trackChanged) {
						lastTrackId = tid;
						lastSeekApplied = -1;
						loadAndPlaySelection();
					} else {
						// Web-requested seek: jump both the audio and the lyric clock.
						long seekMs = atol(stateField(body, "SEEK").c_str());
						if (seekMs >= 0 && seekMs != lastSeekApplied) {
							lastSeekApplied = seekMs;
							awtrix::AudioManager::getInstance().seekAudio(seekMs);
							lp->seekTo((uint32_t)seekMs);
						}
						bool wantPlay = (stateField(body, "PLAY") == "1");
						lp->setPlaying(wantPlay);
						if (wantPlay) awtrix::AudioManager::getInstance().resumeAudio();
						else awtrix::AudioManager::getInstance().pauseAudio();
					}
				}
			}
		}
		// Heartbeat: tell the service what we're actually playing so the web can
		// detect the music firmware and sync its preview to our real playhead.
		{
			LyricsPage* lp = lyricsPage();
			if (lp && !lastTrackId.empty() && lastTrackId != "-") {
				char hb[160];
				snprintf(hb, sizeof(hb), "{\"trackId\":%s,\"playheadMs\":%u,\"playing\":%s}",
					lastTrackId.c_str(), (unsigned)lp->getPlayheadMs(),
					lp->getPlaying() ? "true" : "false");
				pixelnet::httpPost(serviceUrl("/api/music/device/heartbeat"), hb);
			}
		}
		sleep(2);
	}
	return NULL;
}

void keyEventCb(int keyCode, int keyStatus) {
	if (sState != STATE_LYRICS) {
		return;
	}
	LyricsPage* lp = lyricsPage();
	if (!lp) {
		return;
	}
	// Buttons act on press; the rotary reports on each detent.
	if (keyStatus != 1 && keyCode != E_KEYCODE_CLOCKWISE && keyCode != E_KEYCODE_ANTI_CLOCKWISE) {
		return;
	}
	switch (keyCode) {
	case E_KEYCODE_MIDDLE_BUTTON: {         // play / pause, and report it back
		bool nowPlaying = lp->togglePlay();
		if (nowPlaying) awtrix::AudioManager::getInstance().resumeAudio();
		else awtrix::AudioManager::getInstance().pauseAudio();
		reportChange(nowPlaying ? "{\"playing\":true}" : "{\"playing\":false}");
		break;
	}
	case E_KEYCODE_LEFT_BUTTON:
		lp->prevLine();
		awtrix::AudioManager::getInstance().seekAudio(lp->getPlayheadMs());
		break;
	case E_KEYCODE_RIGHT_BUTTON:
		lp->nextLine();
		awtrix::AudioManager::getInstance().seekAudio(lp->getPlayheadMs());
		break;
	case E_KEYCODE_CLOCKWISE:               // knob right → louder
		if (sVolume < 6) ++sVolume;
		applyVolume();
		break;
	case E_KEYCODE_ANTI_CLOCKWISE:          // knob left → quieter
		if (sVolume > 0) --sVolume;
		applyVolume();
		break;
	case E_KEYCODE_KNOB_BUTTON: {           // knob press → cycle display mode, report it
		int m = lp->cycleMode();
		reportChange(std::string("{\"mode\":\"") + modeName(m) + "\"}");
		break;
	}
	default: break;
	}
}

}  // namespace

static S_ACTIVITY_TIMEER REGISTER_ACTIVITY_TIMER_TAB[] = {
};

static void onUI_init() {
	static bool initialized = false;
	if (initialized) {
		return;
	}
	initialized = true;

	SystemProperties::setString("sys.zkapp.state", "running");
	McuManager::getInstance().initialize(
		new PixelMcuProto::McuParse("/dev/ttyS1", 1500000));

	std::string mcuVer;
	McuManager::getInstance().queryMcuVersion(mcuVer);
	LOGI_TRACE("PixelMusic: mcuVer [%s]", mcuVer.c_str());

	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new SplashPage("splash")));
	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new LyricsPage("lyrics")));
	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new VolumePage("volume")));

	awtrix::AudioManager::getInstance().setVolume(sVolume);

	KeyManager::getInstance().start();
}

static void onUI_intent(const Intent *intentPtr) {
	if (intentPtr != NULL) {
	}
}

static void onUI_show() {
	KeyManager::getInstance().addKeyEventCallback(keyEventCb);
	sState = STATE_SPLASH;
	PageManager::getInstance().navigateTo("splash");
	mActivityPtr->registerUserTimer(TIMER_TICK, 40);
}

static void onUI_hide() {
	sPolling = false;
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onUI_quit() {
	sPolling = false;
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onProtocolDataUpdate(const SProtocolData &data) {
}

static bool onlyricsActivityTouchEvent(const MotionEvent &ev) {
	// No touch surface on TC002; keys drive everything.
	return false;
}

static bool onUI_Timer(int id) {
	if (id != TIMER_TICK) {
		return true;
	}
	if (sState == STATE_SPLASH) {
		SplashPage* sp = splashPage();
		if (sp) {
			sp->tick();
			sp->draw();
			if (sp->isDone()) {
				sState = STATE_LYRICS;
				PageManager::getInstance().navigateTo("lyrics");
				LyricsPage* lp = lyricsPage();
				if (lp) {
					mActivityPtr->resetUserTimer(TIMER_TICK, lp->getTickIntervalMs());
				}
				// Fetch the track from the LAN service and play it via MI_AO,
				// off the UI thread so the download can't stall the animation.
				static pthread_t sPollThread;
					sPolling = true;
				pthread_create(&sPollThread, NULL, pollThread, NULL);
				pthread_detach(sPollThread);
			}
		}
	} else {
		// The volume cup takes over the screen briefly after a knob turn.
		if (sVolumeShowMs > 0) {
			sVolumeShowMs -= LYRIC_TICK_MS;
			LyricsPage* lp = lyricsPage();
			if (lp) lp->tick();  // keep the lyric clock running under the volume overlay
			VolumePage* vp = volumePage();
			if (vp) {
				vp->setVolume(sVolume);
				vp->setSkin(sSkin);
				vp->draw();
			}
		} else {
			LyricsPage* lp = lyricsPage();
			if (lp) {
				lp->tick();
				lp->draw();
			}
		}
	}
	return true;
}
