#pragma once
#include <pthread.h>
#include <stdint.h>
#include <time.h>

#include <mutex>
#include <vector>

#include <os/SystemProperties.h>

#include "platform/Presenter.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "managers/KeyManager.h"
#include "ui/BootScreen.h"
#include "ui/LauncherScreen.h"
#include "ui/Screen.h"

namespace {

#define TIMER_TICK 1

// 25 fps. The panel enforces its own 15 ms floor inside Presenter::present, so
// a 40 ms tick leaves ~25 ms of slack for the render itself — comfortable for a
// procedural 832-pixel frame, which measures in microseconds.
const int TICK_MS = 40;

uint64_t monoMs() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
}

uint64_t sStartMs = 0;

// The single owner of the LED bus, and the single 52x16 buffer every screen
// composes into. Both are function-local statics so their construction order is
// explicit and happens on first use, after the framework is up.
tcos::Presenter& presenter() {
	static tcos::Presenter instance;
	return instance;
}

Surface& canvas() {
	static Surface instance(tcos::kPanelWidth, tcos::kPanelHeight);
	return instance;
}

// ---------------------------------------------------------------------------
// Input. KeyManager fires on its own event thread; the callback only enqueues,
// and the UI tick drains it, so screen state is only ever mutated on one thread.
struct RawKeyEvent {
	int code;
	int status;
};
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
// Screens are long-lived singletons rather than allocated per visit: on a device
// with ~1 MB free, churning a screen's state on every navigation buys nothing.
tcos::BootScreen sBoot;
tcos::LauncherScreen sLauncher;

tcos::Shell& shell() {
	static tcos::Shell instance(tcos::kPanelWidth, tcos::kPanelHeight);
	return instance;
}

bool sHandedOff = false;

// Translates MCU key codes into the Shell's device-independent vocabulary, and
// turns a long press on the middle/knob button into kInputHold. The threshold
// lives here rather than in a screen so "hold means up" is uniform everywhere.
const int HOLD_MS = 600;
int sPressedCode = -1;
uint64_t sPressedAtMs = 0;
bool sHoldFired = false;

void dispatchInput(tcos::Input input, int nowMs) {
	shell().onInput(input, nowMs);
}

void handleKey(int code, int status, int nowMs) {
	// KeyManager reports status 1 for down and 0 for up; rotation arrives as a
	// single event with no press semantics.
	if (code == E_KEYCODE_CLOCKWISE) {
		dispatchInput(tcos::kInputTurnCw, nowMs);
		return;
	}
	if (code == E_KEYCODE_ANTI_CLOCKWISE) {
		dispatchInput(tcos::kInputTurnCcw, nowMs);
		return;
	}
	const bool isConfirm = (code == E_KEYCODE_KNOB_BUTTON || code == E_KEYCODE_MIDDLE_BUTTON);
	if (!isConfirm) {
		if (status != 0) return;
		if (code == E_KEYCODE_LEFT_BUTTON) dispatchInput(tcos::kInputLeft, nowMs);
		else if (code == E_KEYCODE_RIGHT_BUTTON) dispatchInput(tcos::kInputRight, nowMs);
		return;
	}
	if (status != 0) {
		sPressedCode = code;
		sPressedAtMs = monoMs();
		sHoldFired = false;
		return;
	}
	// Release: a hold already fired on the tick that crossed the threshold, so
	// only a short press is reported here. Without that split the user would get
	// both a "press" and a "hold" from one gesture.
	if (sPressedCode == code && !sHoldFired) dispatchInput(tcos::kInputPress, nowMs);
	sPressedCode = -1;
	sHoldFired = false;
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

	// zkdaemon watches this property; without it the framework treats the app
	// as hung and can restart zkswe under us.
	SystemProperties::setString("sys.zkapp.state", "running");
	sStartMs = monoMs();
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
	KeyManager::getInstance().addKeyEventCallback(keyEventCb);

	// A placeholder catalogue until the host link lands: the workspace channels
	// arrive over /api/os/pull and replace the first group wholesale.
	std::vector<tcos::LauncherScreen::Entry> entries;
	tcos::LauncherScreen::Entry entry;
	entry.label = "\xE9\x9F\xB3\xE4\xB9\x90";              // 音乐
	entry.icon = tcos::LauncherScreen::kIconMusic;
	entry.id = 1;
	entries.push_back(entry);
	entry.label = "\xE6\xB8\xB8\xE6\x88\x8F";              // 游戏
	entry.icon = tcos::LauncherScreen::kIconGame;
	entry.id = 2;
	entries.push_back(entry);
	entry.label = "\xE8\xAE\xBE\xE7\xBD\xAE";              // 设置
	entry.icon = tcos::LauncherScreen::kIconSettings;
	entry.id = 3;
	entries.push_back(entry);
	entry.label = "\xE8\xBD\xAE\xE6\x92\xAD";              // 轮播
	entry.icon = tcos::LauncherScreen::kIconChannel;
	entry.id = 4;
	entries.push_back(entry);

	const int nowMs = (int)(monoMs() - sStartMs);
	sLauncher.setEntries(entries, nowMs);
	sHandedOff = false;
	shell().reset(&sBoot, nowMs);
	mActivityPtr->registerUserTimer(TIMER_TICK, TICK_MS);
}

static void onUI_hide() {
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onUI_quit() {
	KeyManager::getInstance().removeKeyEventCallback(keyEventCb);
	mActivityPtr->unregisterUserTimer(TIMER_TICK);
}

static void onProtocolDataUpdate(const SProtocolData &data) {
}

static bool onUI_Timer(int id) {
	if (id != TIMER_TICK) {
		return true;
	}

	const int nowMs = (int)(monoMs() - sStartMs);

	// Drain input on the UI thread, so screen state is only ever mutated here.
	std::vector<RawKeyEvent> events;
	{
		std::lock_guard<std::mutex> lock(sKeyMutex);
		events.swap(sKeyQueue);
	}
	for (size_t i = 0; i < events.size(); ++i) {
		handleKey(events[i].code, events[i].status, nowMs);
	}

	// A hold fires as soon as the threshold passes, not on release: waiting for
	// the release would make "up one level" feel like it lagged the gesture.
	if (sPressedCode >= 0 && !sHoldFired && (monoMs() - sPressedAtMs) >= (uint64_t)HOLD_MS) {
		sHoldFired = true;
		dispatchInput(tcos::kInputHold, nowMs);
	}

	// Boot hands over to the launcher exactly once, on a cross-fade.
	if (!sHandedOff && sBoot.isDone(nowMs)) {
		sHandedOff = true;
		shell().reset(&sLauncher, nowMs);
	}

	shell().render(canvas(), nowMs);
	presenter().present(canvas());

	// Milestone 4 has nowhere to descend to yet; the activation is consumed so
	// it cannot pile up, and the press flash is the whole feedback for now.
	sLauncher.takeActivated();
	return true;
}
