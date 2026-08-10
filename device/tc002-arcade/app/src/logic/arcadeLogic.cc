#pragma once
#include "managers/KeyManager.h"
#include "managers/PageManager.h"
#include "managers/McuManager.h"
#include "managers/AudioManager.h"
#include "managers/SfxManager.h"
#include "mcuProtocol/mcuProtoParse.h"
#include "pages/SplashPage.h"
#include "pages/MenuPage.h"
#include "pages/InfoPage.h"
#include "pages/GamePage.h"
#include "games/engine.h"
#include "games/breakout.h"
#include "games/flappy.h"
#include "games/snake.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/tetris.h"
#include "net/NetClient.h"
#include <memory>
#include <string>
#include <vector>
#include <mutex>
#include <functional>
#include <pthread.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <os/SystemProperties.h>

namespace {

#define TIMER_TICK 1
const int SPLASH_TICK_MS = 40;   // splash animation budget (~25fps)
const int MAIN_TICK_MS = 30;     // menu/info/game budget (~33fps; the SPI
                                 // frame itself holds a 15ms hard usleep)
const int GAME_SLOTS = 7;

enum ArcadeState { STATE_SPLASH, STATE_MENU, STATE_INFO, STATE_GAME };
int sState = STATE_SPLASH;
int sVolume = 4;                 // 0-6 notch scale; knob-adjustable on the
                                 // info page, kept for the session only
uint64_t sStartMs = 0;           // monotonic origin for heartbeat uptimeMs

SplashPage* splashPage() {
	return static_cast<SplashPage*>(PageManager::getInstance().getPage("splash"));
}
MenuPage* menuPage() {
	return static_cast<MenuPage*>(PageManager::getInstance().getPage("menu"));
}
InfoPage* infoPage() {
	return static_cast<InfoPage*>(PageManager::getInstance().getPage("info"));
}
GamePage* gamePage() {
	return static_cast<GamePage*>(PageManager::getInstance().getPage("game"));
}

uint64_t monoMs() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
}

// ---------------------------------------------------------------------------
// Service origin (LAN Pixel Studio). The installer writes the current origin
// next to the pushed bundle at sideload time, so one binary works on any
// network; the compile-time default only matters for bare manual adb pushes.
#ifndef PIXEL_STUDIO_ORIGIN
#define PIXEL_STUDIO_ORIGIN "http://PIXEL_STUDIO_HOST:43820"
#endif
const char* kServiceOriginFile = "/tmp/tc002-arcade/service.origin";
const char* kSfxDir = "/tmp/tc002-arcade/sfx";

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

// Fire-and-forget POST off the UI thread (the music firmware's reportChange
// pattern): the blocking socket work never stalls a frame.
struct PostJob { std::string url; std::string body; };
void* postThread(void* arg) {
	PostJob* job = (PostJob*)arg;
	pixelnet::httpPost(job->url, job->body);
	delete job;
	return NULL;
}
void postDetached(const std::string& url, const std::string& body) {
	PostJob* job = new PostJob();
	job->url = url;
	job->body = body;
	pthread_t t;
	if (pthread_create(&t, NULL, postThread, job) == 0) pthread_detach(t);
	else delete job;
}

// ---------------------------------------------------------------------------
// Input: KeyManager fires its callback on its own event thread. The callback
// only queues; the UI tick swaps the queue out under the lock and dispatches
// through PageManager::onKeyEvent, so pages mutate state on the UI thread only.
struct RawKeyEvent { int code; int status; };
std::vector<RawKeyEvent> sKeyQueue;
std::mutex sKeyMutex;

void keyEventCb(int keyCode, int keyStatus) {
	std::lock_guard<std::mutex> lock(sKeyMutex);
	if (sKeyQueue.size() < 64) {
		RawKeyEvent ev;
		ev.code = keyCode;
		ev.status = keyStatus;
		sKeyQueue.push_back(ev);
	}
}

// ---------------------------------------------------------------------------
// Heartbeat state shared with the reporting thread.
struct HbState { std::string game; std::string phase; int score; };
HbState sHb;
std::mutex sHbMutex;
volatile bool sNetRun = false;

void setHeartbeat(const char* game, const char* phase, int score) {
	std::lock_guard<std::mutex> lock(sHbMutex);
	sHb.game = game;
	sHb.phase = phase;
	sHb.score = score;
}

void* heartbeatThread(void*) {
	while (sNetRun) {
		HbState hb;
		{
			std::lock_guard<std::mutex> lock(sHbMutex);
			hb = sHb;
		}
		char body[192];
		snprintf(body, sizeof(body),
		         "{\"game\":\"%s\",\"phase\":\"%s\",\"score\":%d,\"uptimeMs\":%llu}",
		         hb.game.c_str(), hb.phase.c_str(), hb.score,
		         (unsigned long long)(monoMs() - sStartMs));
		// Blocking POST is fine here — this is the heartbeat's own thread.
		pixelnet::httpPost(serviceUrl("/api/arcade/heartbeat"), body);
		for (int i = 0; i < 5 && sNetRun; ++i) sleep(1);
	}
	return NULL;
}

// ---------------------------------------------------------------------------
// MCU cache. McuManager requests block for up to ~1.5s, so a background
// thread owns every query (never the UI or input thread) and refreshes this
// cache every 10s; spontaneous MCU pushes (mcuEventCb) land in McuManager's
// own cache and get folded in on the next cycle. The info page only reads.
struct McuCache {
	std::pair<int, int> battery;
	int usb;
	std::string version;
};
McuCache sMcuCache = { std::make_pair(-1, -1), -1, std::string() };
std::mutex sMcuCacheMutex;
volatile bool sMcuRun = false;

void* mcuThread(void*) {
	bool verQueried = false;
	while (sMcuRun) {
		if (!verQueried) {
			std::string ver;
			if (McuManager::getInstance().queryMcuVersion(ver) == 0 && !ver.empty()) {
				std::lock_guard<std::mutex> lock(sMcuCacheMutex);
				sMcuCache.version = ver;
			}
			verQueried = true;
		}
		// McuManager returns its cache once set, so invalidate first to force
		// a real query each cycle; a push racing in between just supplies an
		// equally fresh value.
		McuManager::getInstance().setBatteryState(std::make_pair(-1, -1));
		std::pair<int, int> battery = McuManager::getInstance().queryBatteryPower();
		McuManager::getInstance().setUsbState(-1);
		int usb = McuManager::getInstance().queryUsbState();
		{
			std::lock_guard<std::mutex> lock(sMcuCacheMutex);
			sMcuCache.battery = battery;
			sMcuCache.usb = usb;
		}
		for (int i = 0; i < 10 && sMcuRun; ++i) sleep(1);
	}
	return NULL;
}

void* powerOffThread(void*) {
	McuManager::getInstance().powerOff();
	return NULL;
}

// ---------------------------------------------------------------------------
// Game slots, in menu order. Engines are created lazily and kept for the
// app's lifetime; GamePage::onEnter rewinds the mounted one to its attract
// screen on every entry.
GameEngine* sEngines[GAME_SLOTS] = { NULL, NULL, NULL, NULL, NULL, NULL, NULL };
GameEngine* sEngine = NULL;         // engine currently mounted in GamePage
int sEngineSlot = -1;               // its menu slot, for the best-score cache
GameHud sPrevHud;                   // last observed hud, for sfx edges

GameEngine* engineFor(int slot) {
	if (slot < 0 || slot >= GAME_SLOTS) return NULL;
	if (sEngines[slot] == NULL) {
		switch (slot) {
		case 0: sEngines[slot] = new BreakoutEngine(); break;
		case 1: sEngines[slot] = new FlappyEngine(); break;
		case 2: sEngines[slot] = new SnakeEngine(); break;
		case 3: sEngines[slot] = new PongEngine(); break;
		case 4: sEngines[slot] = new RacerEngine(); break;
		case 5: sEngines[slot] = new ShooterEngine(); break;
		case 6: sEngines[slot] = new TetrisEngine(); break;
		default: break;
		}
	}
	return sEngines[slot];
}

const char* phaseName(GameHud::Phase phase) {
	switch (phase) {
	case GameHud::Ready: return "ready";
	case GameHud::Playing: return "playing";
	case GameHud::Over: return "over";
	default: return "ready";
	}
}

bool sBgStarted = false;

// Splash handoff: switch to the 30ms cadence and start the background
// reporters exactly once per visible session.
void enterMenuFromSplash() {
	sState = STATE_MENU;
	PageManager::getInstance().navigateTo("menu");
	mActivityPtr->resetUserTimer(TIMER_TICK, MAIN_TICK_MS);
	// Single-activity app: onUI_hide/quit only fire on teardown, so a
	// hide->show re-entry (which would leave these workers stopped for good)
	// cannot happen while the app lives. The gate is one-shot by design.
	if (!sBgStarted) {
		sBgStarted = true;
		sNetRun = true;
		sMcuRun = true;
		pthread_t t;
		if (pthread_create(&t, NULL, heartbeatThread, NULL) == 0) pthread_detach(t);
		if (pthread_create(&t, NULL, mcuThread, NULL) == 0) pthread_detach(t);
	}
}

void startGame(int slot) {
	GameEngine* engine = engineFor(slot);
	GamePage* gp = gamePage();
	if (engine == NULL || gp == NULL) {
		LOGE_TRACE("PixelArcade: no engine for slot %d", slot);
		return;
	}
	gp->setEngine(engine);
	sEngine = engine;
	sEngineSlot = slot;
	sState = STATE_GAME;
	// navigateTo runs GamePage::onEnter, which resets the engine — capture
	// the hud baseline after that so the sfx edge detector starts clean.
	PageManager::getInstance().navigateTo("game");
	sPrevHud = engine->hud();
	SfxManager::getInstance().play(SfxManager::SFX_CONFIRM);
}

void backToMenu() {
	sState = STATE_MENU;
	PageManager::getInstance().navigateTo("menu");
	SfxManager::getInstance().play(SfxManager::SFX_TICK);
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
	sStartMs = monoMs();
	McuManager::getInstance().initialize(
		new PixelMcuProto::McuParse("/dev/ttyS1", 1500000));
	// No blocking MCU query here — the version is fetched by mcuThread.

	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new SplashPage("splash")));
	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new MenuPage("menu")));
	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new InfoPage("info")));
	PageManager::getInstance().registerPage(std::unique_ptr<PageBase>(new GamePage("game")));

	// Order matters: the awtrix singleton's constructor zeroes the mixer idle
	// timeout, and SfxManager::init sets the safe 3000ms afterwards.
	awtrix::AudioManager::getInstance().setVolume(sVolume);
	SfxManager::getInstance().init(kSfxDir);


	KeyManager::getInstance().start();
}

static void onUI_intent(const Intent *intentPtr) {
	if (intentPtr != NULL) {
	}
}

static void onUI_show() {
	{
		std::lock_guard<std::mutex> lock(sKeyMutex);
		sKeyQueue.clear();
	}
	sBgStarted = false;
	KeyManager::getInstance().addKeyEventCallback(keyEventCb);
	sState = STATE_SPLASH;
	setHeartbeat("menu", "splash", 0);
	PageManager::getInstance().navigateTo("splash");
	mActivityPtr->registerUserTimer(TIMER_TICK, SPLASH_TICK_MS);
}

static void onUI_hide() {
	sNetRun = false;
	sMcuRun = false;
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onUI_quit() {
	sNetRun = false;
	sMcuRun = false;
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onProtocolDataUpdate(const SProtocolData &data) {
}

static bool onarcadeActivityTouchEvent(const MotionEvent &ev) {
	// No touch surface on TC002; keys drive everything.
	return false;
}

static bool onUI_Timer(int id) {
	if (id != TIMER_TICK) {
		return true;
	}

	// Drain the input queue first: events reach the page that was current at
	// the top of the tick, and state changes below apply from the next tick.
	std::vector<RawKeyEvent> events;
	{
		std::lock_guard<std::mutex> lock(sKeyMutex);
		events.swap(sKeyQueue);
	}
	for (size_t i = 0; i < events.size(); ++i) {
		PageManager::getInstance().onKeyEvent(events[i].code, events[i].status);
	}

	switch (sState) {
	case STATE_SPLASH: {
		SplashPage* sp = splashPage();
		if (sp) {
			sp->tick();
			sp->draw();
			if (sp->isDone()) enterMenuFromSplash();
		}
		break;
	}
	case STATE_MENU: {
		MenuPage* mp = menuPage();
		if (mp) {
			mp->tick();
			mp->draw();
			setHeartbeat("menu", "menu", 0);
			int action = mp->takeAction();
			if (action >= 0 && action < GAME_SLOTS) {
				startGame(action);
			} else if (action == GAME_SLOTS) {
				sState = STATE_INFO;
				PageManager::getInstance().navigateTo("info");
				SfxManager::getInstance().play(SfxManager::SFX_CONFIRM);
			}
		}
		break;
	}
	case STATE_INFO: {
		InfoPage* ip = infoPage();
		if (ip) {
			{
				std::lock_guard<std::mutex> lock(sMcuCacheMutex);
				ip->setBattery(sMcuCache.battery.first, sMcuCache.battery.second);
				ip->setUsb(sMcuCache.usb);
				ip->setMcuVersion(sMcuCache.version);
			}
			// Knob detents (queued above) adjust the session volume before
			// the push-back, so this very frame renders the new level. The
			// tick sounds at the new volume — that IS the feedback; at the
			// clamped ends it just restates the current level.
			int volDelta = ip->takeVolumeDelta();
			if (volDelta != 0) {
				int level = sVolume + volDelta;
				if (level < 0) level = 0;
				if (level > 6) level = 6;
				if (level != sVolume) {
					sVolume = level;
					awtrix::AudioManager::getInstance().setVolume(sVolume);
				}
				SfxManager::getInstance().play(SfxManager::SFX_TICK);
			}
			ip->setVolume(sVolume);
			ip->tick();
			ip->draw();
			setHeartbeat("menu", "info", 0);
			if (ip->takePowerOff()) {
				// MCU write shares the manager mutex with the cache thread's
				// queries, so it goes to its own throwaway thread too.
				pthread_t t;
				if (pthread_create(&t, NULL, powerOffThread, NULL) == 0) pthread_detach(t);
			}
			if (ip->takeBack()) backToMenu();
		}
		break;
	}
	case STATE_GAME: {
		GamePage* gp = gamePage();
		if (gp && sEngine) {
			gp->tick(MAIN_TICK_MS);   // advances the engine + long-press timer
			gp->draw();
			GameHud hud = sEngine->hud();
			if (hud.phase == GameHud::Over && sPrevHud.phase != GameHud::Over) {
				SfxManager::getInstance().play(SfxManager::SFX_OVER);
			} else if (hud.phase == GameHud::Playing && sPrevHud.phase != GameHud::Playing) {
				SfxManager::getInstance().play(SfxManager::SFX_CONFIRM);
			} else if (hud.phase == GameHud::Playing && hud.score > sPrevHud.score) {
				SfxManager::getInstance().play(SfxManager::SFX_SCORE);
			}
			sPrevHud = hud;
			setHeartbeat(sEngine->id(), phaseName(hud.phase), hud.score);
			// Long-press exit is GamePage's own affair; the shell just asks.
			if (gp->wantsExitToMenu()) backToMenu();
		}
		break;
	}
	default:
		break;
	}
	return true;
}
