#include "pages/InfoPage.h"

#include <stdio.h>
#include <string.h>
#include <vector>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/PixelFont.h"

using namespace lyricsvisual;

namespace {

// Compile-time firmware version shown on the identity screen.
const char* kArcadeFwVersion = "0.2.0";

// All counts are in 30ms ticks — keep them in sync with the logic's main
// tick period (the music firmware's 60/30 mismatch bug is not welcome here).
const int kScreenSwapTicks = 100;    // 3s per screen
const int kArmWindowTicks = 100;     // 3s power-off confirm window
const int kIpRefreshTicks = 150;     // getifaddrs every 4.5s
const int kUptimeRefreshTicks = 33;  // ~1s

const int kRowY[3] = { 0, 6, 11 };

// Label dim, value bright; lines wider than the panel marquee horizontally.
void drawLine(Surface& s, int y, const char* label, const char* value,
              const Palette& pal, int ticks) {
	char full[64];
	snprintf(full, sizeof(full), "%s %s", label, value);
	int w = textWidth(full);
	int x = 1;
	if (w > 51) {   // columns 1..51 are usable from the x=1 start
		// Slow bounce keeps every character readable without a reset jump.
		int span = w - 51;
		int phase = (ticks / 8) % (2 * span);
		int off = phase < span ? phase : 2 * span - phase;
		x = 1 - off;
	}
	int lx = drawText(s, x, y, label, pal.secondary);
	drawText(s, lx + 4, y, value, Color(255, 255, 255));
}

}  // namespace

InfoPage::InfoPage(const std::string& name)
	: PageBase(name), mBatA(-1), mBatB(-1), mUsb(-1), mVolume(-1),
	  mMcuVer("-"), mIp("-"), mUptimeSec(0),
	  mTicks(0), mArmTicks(0), mVolDelta(0), mBack(false), mPowerOff(false) {}
InfoPage::~InfoPage() {}

void InfoPage::onEnter() {
	mTicks = 0;
	mArmTicks = 0;
	mVolDelta = 0;
	mBack = false;
	mPowerOff = false;
	mIp = ipAddress();
	mUptimeSec = uptimeSeconds();
}
void InfoPage::onExit() {}

bool InfoPage::onKeyEvent(int keyCode, int keyStatus) {
	if (keyStatus != 1 && keyCode != E_KEYCODE_CLOCKWISE && keyCode != E_KEYCODE_ANTI_CLOCKWISE) {
		return true;
	}
	switch (keyCode) {
	case E_KEYCODE_CLOCKWISE:
	case E_KEYCODE_ANTI_CLOCKWISE:
		// Volume nudge, applied by the logic (it owns the session level).
		// Rewind to the status screen so VOL is on show while turning.
		mVolDelta += (keyCode == E_KEYCODE_CLOCKWISE) ? 1 : -1;
		mTicks = 0;
		break;
	case E_KEYCODE_KNOB_BUTTON:
	case E_KEYCODE_LEFT_BUTTON:
		mBack = true;
		break;
	case E_KEYCODE_MIDDLE_BUTTON:
		// Manual screen flip: jump to the next swap boundary so the other
		// screen shows immediately with a full dwell ahead of it.
		mTicks = (mTicks / kScreenSwapTicks + 1) * kScreenSwapTicks;
		break;
	case E_KEYCODE_RIGHT_BUTTON:
		// First press arms, second press inside the window confirms.
		if (mArmTicks > 0) {
			mPowerOff = true;
			mArmTicks = 0;
		} else {
			mArmTicks = kArmWindowTicks;
		}
		break;
	default:
		break;
	}
	return true;
}

void InfoPage::tick() {
	++mTicks;
	if (mArmTicks > 0) --mArmTicks;
	if (mTicks % kIpRefreshTicks == 0) mIp = ipAddress();
	if (mTicks % kUptimeRefreshTicks == 0) mUptimeSec = uptimeSeconds();
}

void InfoPage::setBattery(int rawA, int rawB) { mBatA = rawA; mBatB = rawB; }
void InfoPage::setUsb(int state) { mUsb = state; }
void InfoPage::setMcuVersion(const std::string& ver) { mMcuVer = ver.empty() ? "-" : ver; }
void InfoPage::setVolume(int level) { mVolume = level; }

bool InfoPage::takeBack() {
	bool b = mBack;
	mBack = false;
	return b;
}

bool InfoPage::takePowerOff() {
	bool p = mPowerOff;
	mPowerOff = false;
	return p;
}

int InfoPage::takeVolumeDelta() {
	int d = mVolDelta;
	mVolDelta = 0;
	return d;
}

std::string InfoPage::ipAddress() const {
	struct ifaddrs* list = NULL;
	if (getifaddrs(&list) != 0 || list == NULL) return "-";
	std::string best;
	for (struct ifaddrs* it = list; it != NULL; it = it->ifa_next) {
		if (it->ifa_addr == NULL || it->ifa_addr->sa_family != AF_INET) continue;
		if (it->ifa_flags & IFF_LOOPBACK) continue;
		char buf[INET_ADDRSTRLEN] = {0};
		const struct sockaddr_in* sa = (const struct sockaddr_in*)it->ifa_addr;
		if (inet_ntop(AF_INET, &sa->sin_addr, buf, sizeof(buf)) == NULL) continue;
		bool wlan = it->ifa_name != NULL && strncmp(it->ifa_name, "wlan", 4) == 0;
		if (best.empty() || wlan) best = buf;
		if (wlan) break;
	}
	freeifaddrs(list);
	return best.empty() ? "-" : best;
}

long InfoPage::uptimeSeconds() const {
	FILE* f = fopen("/proc/uptime", "r");
	if (f == NULL) return 0;
	double up = 0.0;
	int n = fscanf(f, "%lf", &up);
	fclose(f);
	return n == 1 ? (long)up : 0;
}

void InfoPage::draw() {
	Surface s(52, 16, Color(0, 0, 0));
	const Palette& pal = paletteFor(SKIN_ARCADE);
	char v[40];

	bool statusScreen = ((mTicks / kScreenSwapTicks) % 2) == 0;
	if (statusScreen) {
		// Battery is the raw MCU 0x03 pair until its semantics are settled
		// on hardware (see ADR 0004) — no percent sign, no interpretation.
		snprintf(v, sizeof(v), "%d/%d", mBatA, mBatB);
		drawLine(s, kRowY[0], "BAT", v, pal, mTicks);
		snprintf(v, sizeof(v), "%d", mUsb);
		int lx = drawText(s, 1, kRowY[1], "USB", pal.secondary);
		drawText(s, lx + 4, kRowY[1], v, Color(255, 255, 255));
		snprintf(v, sizeof(v), "%d", mVolume);
		lx = drawText(s, 28, kRowY[1], "VOL", pal.secondary);
		drawText(s, lx + 4, kRowY[1], v, Color(255, 255, 255));
		long h = mUptimeSec / 3600, m = (mUptimeSec % 3600) / 60, sec = mUptimeSec % 60;
		if (h > 0) snprintf(v, sizeof(v), "%ldH%02ldM", h, m);
		else snprintf(v, sizeof(v), "%ldM%02ldS", m, sec);
		drawLine(s, kRowY[2], "UP", v, pal, mTicks);
	} else {
		drawLine(s, kRowY[0], "VER", kArcadeFwVersion, pal, mTicks);
		drawLine(s, kRowY[1], "MCU", mMcuVer.c_str(), pal, mTicks);
		drawLine(s, kRowY[2], "IP", mIp.c_str(), pal, mTicks);
	}

	// Power-off confirm overlay replaces the bottom line while armed.
	if (mArmTicks > 0) {
		for (int y = 10; y < 16; ++y)
			for (int x = 0; x < 52; ++x) s.setPixel(x, y, Color(0, 0, 0));
		// 3x5 font has no '?', so keep the prompt to its charset.
		drawText(s, 1, 11, "PRESS R OFF", pal.secondary);
		// Shrinking window indicator along the very bottom edge.
		int w = (mArmTicks * 52) / kArmWindowTicks;
		for (int x = 0; x < w; ++x) s.setPixel(x, 15, pal.context);
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}
