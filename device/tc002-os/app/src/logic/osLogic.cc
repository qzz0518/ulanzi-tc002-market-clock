#pragma once
#include <pthread.h>
#include <stdint.h>
#include <time.h>

#include <mutex>
#include <vector>

#include <os/SystemProperties.h>

#include "core/Presenter.h"
#include "core/Surface.h"
#include "managers/KeyManager.h"
#include "ui/BootScreen.h"
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
// Milestone 1 shows exactly one screen. The Shell, the ring model and the rest
// of the page inventory land in milestone 3; keeping this file honest about
// that is what makes the first device push a pure toolchain proof.
tcos::BootScreen sBoot;

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
	sBoot.onEnter((int)(monoMs() - sStartMs));
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

	// Drain input first so this frame reflects it. Milestone 1 has nowhere to
	// route the events yet; draining still matters, or the queue caps at 64 and
	// the first real screen would inherit a backlog of stale detents.
	std::vector<RawKeyEvent> events;
	{
		std::lock_guard<std::mutex> lock(sKeyMutex);
		events.swap(sKeyQueue);
	}

	const int nowMs = (int)(monoMs() - sStartMs);
	sBoot.render(canvas(), nowMs);
	presenter().present(canvas());

	// The boot animation ends on a dark panel and then simply holds. Milestone 3
	// replaces this with the Shell cutting to the launcher ring.
	return true;
}
