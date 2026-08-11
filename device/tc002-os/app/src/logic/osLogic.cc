#pragma once
#include <pthread.h>
#include <stdint.h>
#include <time.h>

#include <mutex>
#include <vector>

#include <os/SystemProperties.h>

#include "platform/DeviceControls.h"
#include "platform/Presenter.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "managers/KeyManager.h"
#include "games/breakout.h"
#include "games/flappy.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/snake.h"
#include "games/tetris.h"
#include "ui/BootScreen.h"
#include "ui/GameScreen.h"
#include "ui/LauncherScreen.h"
#include "ui/LevelOverlay.h"
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
tcos::LauncherScreen sLauncher;      // the root ring
tcos::LauncherScreen sGameList;      // the games ring, one level down
tcos::GameScreen sGameScreen;

// Engines are created once and kept: re-creating one on every visit would
// churn the heap on a device with ~1 MB free, and GameScreen::onEnter already
// rewinds whichever is mounted.
BreakoutEngine sBreakout;
FlappyEngine sFlappy;
SnakeEngine sSnake;
PongEngine sPong;
RacerEngine sRacer;
ShooterEngine sShooter;
TetrisEngine sTetris;
GameEngine* sEngines[7] = {
	&sBreakout, &sFlappy, &sSnake, &sPong, &sRacer, &sShooter, &sTetris,
};

// Launcher ids. Channels will take 100+ once the poll thread lands, so the
// built-ins are numbered low and the games ring uses its own range.
enum {
	ID_MUSIC = 1,
	ID_GAMES = 2,
	ID_SETTINGS = 3,
	ID_CHANNELS = 4,
	ID_GAME_BASE = 200,
};

tcos::Shell& shell() {
	static tcos::Shell instance(tcos::kPanelWidth, tcos::kPanelHeight);
	return instance;
}

bool sHandedOff = false;

// Translates MCU key codes into the Shell's device-independent vocabulary, and
// turns a long press on the middle/knob button into kInputHold. The threshold
// lives here rather than in a screen so "hold means up" is uniform everywhere.
const int HOLD_MS = 600;
// The side buttons carry two functions each, so they need their own hold
// tracking: a short press is volume, a long press is brightness. Keeping them
// in one table rather than three variables is what stops "which button am I
// holding" from becoming a bug.
struct HeldButton {
	int code;
	uint64_t atMs;
	bool fired;
};
HeldButton sHeld = { -1, 0, false };

void dispatchInput(tcos::Input input, int nowMs) {
	shell().onInput(input, nowMs);
}

// Side buttons: short press adjusts volume, long press adjusts brightness. Both
// raise the same HUD, because neither change is visible otherwise — the speaker
// may be muted and a brightness step on an already-dim panel is easy to miss.
void adjustLevel(bool brightness, int delta, int nowMs) {
	tcos::DeviceControls& controls = tcos::DeviceControls::instance();
	if (brightness) {
		const int level = controls.nudgeBrightness(delta);
		shell().overlay().show(tcos::LevelOverlay::kBrightness, level,
		                       tcos::DeviceControls::kBrightnessSteps, nowMs);
	} else {
		const int level = controls.nudgeVolume(delta);
		shell().overlay().show(tcos::LevelOverlay::kVolume, level,
		                       tcos::DeviceControls::kVolumeMax, nowMs);
	}
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

	if (status != 0) {
		sHeld.code = code;
		sHeld.atMs = monoMs();
		sHeld.fired = false;
		return;
	}

	// Release. A long press already acted on the tick that crossed the
	// threshold, so only a short press is reported here — without that split one
	// gesture would fire both meanings.
	const bool wasHeld = (sHeld.code == code);
	const bool alreadyFired = sHeld.fired;
	sHeld.code = -1;
	sHeld.fired = false;
	if (!wasHeld || alreadyFired) return;

	// A short press adjusts whatever the HUD is currently showing. While a
	// brightness bar is up the user is in brightness, and making them hold the
	// button for every step — or silently moving the volume instead — would both
	// be wrong.
	const bool brightness =
		shell().overlay().shortPressKind(nowMs) == tcos::LevelOverlay::kBrightness;
	if (code == E_KEYCODE_LEFT_BUTTON) adjustLevel(brightness, -1, nowMs);
	else if (code == E_KEYCODE_RIGHT_BUTTON) adjustLevel(brightness, +1, nowMs);
	else dispatchInput(tcos::kInputPress, nowMs);
}

// Fired from the tick the moment the threshold passes, not on release: waiting
// for the release would make every long press feel like it lagged.
void handleHold(int code, int nowMs) {
	if (code == E_KEYCODE_LEFT_BUTTON) adjustLevel(true, -1, nowMs);
	else if (code == E_KEYCODE_RIGHT_BUTTON) adjustLevel(true, +1, nowMs);
	else dispatchInput(tcos::kInputHold, nowMs);
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

	// The games ring: one card per engine, titles straight from the engines so
	// the two can never disagree about what is installed.
	std::vector<tcos::LauncherScreen::Entry> games;
	for (int i = 0; i < 7; ++i) {
		tcos::LauncherScreen::Entry game;
		game.label = sEngines[i]->title();
		game.icon = tcos::LauncherScreen::kIconGame;
		game.id = ID_GAME_BASE + i;
		games.push_back(game);
	}

	const int nowMs = (int)(monoMs() - sStartMs);
	sLauncher.setEntries(entries, nowMs);
	sGameList.setEntries(games, nowMs);
	tcos::DeviceControls::instance().initialize();
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

	if (sHeld.code >= 0 && !sHeld.fired && (monoMs() - sHeld.atMs) >= (uint64_t)HOLD_MS) {
		sHeld.fired = true;
		handleHold(sHeld.code, nowMs);
	}

	// Boot hands over to the launcher exactly once, on a cross-fade.
	if (!sHandedOff && sBoot.isDone(nowMs)) {
		sHandedOff = true;
		shell().reset(&sLauncher, nowMs);
	}

	// Route activations before rendering, so a press lands on the panel in the
	// same frame the user made it.
	const int rootPick = sLauncher.takeActivated();
	if (rootPick == ID_GAMES) {
		shell().push(&sGameList, nowMs);
	}
	const int gamePick = sGameList.takeActivated();
	if (gamePick >= ID_GAME_BASE && gamePick < ID_GAME_BASE + 7) {
		sGameScreen.setEngine(sEngines[gamePick - ID_GAME_BASE]);
		shell().push(&sGameScreen, nowMs);
	}
	if (sGameScreen.takeExitRequest()) {
		shell().pop(nowMs);
	}

	shell().render(canvas(), nowMs);
	presenter().present(canvas());
	return true;
}
