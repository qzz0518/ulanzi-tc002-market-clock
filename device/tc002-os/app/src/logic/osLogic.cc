#pragma once
#include <pthread.h>
#include <stdint.h>
#include <time.h>

#include <mutex>
#include <vector>

#include <os/SystemProperties.h>

#include "net/HostLink.h"
#include "net/PortalService.h"
#include "net/WifiPolicy.h"
#include "net/SetupPortal.h"
#include "platform/DeviceControls.h"
#include "platform/DeviceProvisioning.h"
#include "platform/DeviceWifi.h"
#include "platform/NetInfo.h"
#include "platform/Sfx.h"
#include "platform/Presenter.h"
#include "core/Shell.h"
#include "core/Surface.h"
#include "managers/KeyManager.h"
#include "managers/McuManager.h"
#include "games/breakout.h"
#include "games/flappy.h"
#include "games/pong.h"
#include "games/racer.h"
#include "games/shooter.h"
#include "games/snake.h"
#include "games/tetris.h"
#include "ui/BootScreen.h"
#include "ui/ChannelRingScreen.h"
#include "ui/GameScreen.h"
#include "ui/LauncherScreen.h"
#include "ui/LevelOverlay.h"
#include "ui/MusicScreen.h"
#include "ui/Screen.h"
#include "ui/SettingsScreen.h"

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
tcos::ChannelRingScreen sChannelRing;  // the channels, one level down
tcos::MusicScreen sMusic;
tcos::SettingsScreen sSettings;

// The console link. A function-local static like the presenter: its threads
// must not start before the framework is up.
tcos::HostLink& hostLink() {
	static tcos::HostLink instance;
	return instance;
}

// The provisioning page, served on the device's NORMAL address rather than only
// while a hotspot is up. Everything about the flow — the page, the routes, the
// network list, the submit round trip, the status poll — is then reachable from
// a laptop on the same LAN, so it can all be verified without touching the
// radio. That matters more here than anywhere else in the firmware: adb reaches
// this device over that same link, so a mistake costs a physical power cycle.
//
// Declaration order is the construction order within this translation unit, so
// the backend exists before the portal that points at it.
// The WiFi state machine and the real radio behind it. On a sideloaded device
// this pair does almost nothing on purpose: begin() finds a link the previous
// firmware already brought up and adopts it without issuing one command, and
// every mutator refuses unless /tmp/zos-allow-link exists. What it buys today
// is an honest reading of the radio for the settings screen; what it buys later
// is a provisioning path whose state machine is already exercised.
tcos::DeviceWifi sWifi;
tcos::WifiPolicy sWifiPolicy(&sWifi);

tcos::DeviceProvisioning sProvisioning;
tcos::SetupPortal sPortal(&sProvisioning);
tcos::PortalService sPortalService;
// 8080, not 80: binding a privileged port would need us to still be root at
// that point, and nothing here needs the well-known one while the device has a
// normal address. The hotspot's captive-portal mode is a later, guarded step.
const int kPortalPort = 8080;

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

// Settings rows that do something when pressed. Zero means inert.
enum {
	ACTION_NONE = 0,
};

// The host's channel list, as the second-level ring currently reflects it.
// Kept as a signature rather than compared item by item: the document's
// sequence bumps on things the ring does not care about (a lyric line changes
// every few seconds), and rebuilding for those would jerk the user's selection
// back to the first channel every time the song moved on.
std::string sMenuSignature;
std::string sPinnedFocus;

// The link's view of the world, refreshed on a slower cadence than the render:
// a snapshot copies the whole menu, and doing that 25 times a second to read
// two booleans would be the most expensive thing in the tick.
tcos::HostLink::Snapshot sLink;
uint64_t sLinkPolledMs = 0;
uint64_t sSettingsBuiltMs = 0;
uint64_t sTelemetryReadMs = 0;

tcos::Shell& shell() {
	static tcos::Shell instance(tcos::kPanelWidth, tcos::kPanelHeight);
	return instance;
}

bool sHandedOff = false;
GameHud sPrevHud;
// Which voice bank the running game uses; -1 while none is mounted.
int sSfxGame = -1;

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
		tcos::Sfx::instance().play(tcos::Sfx::kTick);
		dispatchInput(tcos::kInputTurnCw, nowMs);
		return;
	}
	if (code == E_KEYCODE_ANTI_CLOCKWISE) {
		tcos::Sfx::instance().play(tcos::Sfx::kTick);
		dispatchInput(tcos::kInputTurnCcw, nowMs);
		return;
	}

	const bool isSide = (code == E_KEYCODE_LEFT_BUTTON || code == E_KEYCODE_RIGHT_BUTTON);

	// A game integrates how long a direction is held, so while one is on top the
	// side buttons go through as raw edges instead of becoming volume steps.
	// Volume and brightness stay available everywhere else, which is where a
	// user would actually reach for them.
	if (isSide && shell().topWantsRawButtons()) {
		shell().deliverRawButton(
			code == E_KEYCODE_LEFT_BUTTON ? tcos::kInputLeft : tcos::kInputRight,
			status != 0, nowMs);
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
	else {
		tcos::Sfx::instance().play(tcos::Sfx::kConfirm);
		dispatchInput(tcos::kInputPress, nowMs);
	}
}

// Fired from the tick the moment the threshold passes, not on release: waiting
// for the release would make every long press feel like it lagged.
void handleHold(int code, int nowMs) {
	if (code == E_KEYCODE_LEFT_BUTTON) adjustLevel(true, -1, nowMs);
	else if (code == E_KEYCODE_RIGHT_BUTTON) adjustLevel(true, +1, nowMs);
	else {
		tcos::Sfx::instance().play(tcos::Sfx::kBack);
		dispatchInput(tcos::kInputHold, nowMs);
	}
}


// ---------------------------------------------------------------------------
// Where the console lives.
//
// The device has to be told, because nothing on this LAN announces the service:
// it is a Bun process on someone's laptop, not a router service with a name.
// The sideload bundle carries the address and the launch script drops it here,
// which also means changing it is a redeploy rather than a rebuild. A missing
// file is not an error — the firmware runs standalone, it just has no channels.
std::string readHostAddress() {
	// tmpfs first, because a sideload's address is the one being tested and
	// should win; then the persistent copies, which are the only ones a FLASHED
	// install can have — /tmp is empty on a cold boot, so a flashed ZOS that
	// only looked there would come up with no console link at all and no way to
	// be given one. /data is writable and survives; /res ships inside the image
	// itself, so an address can be baked in at pack time.
	static const char* kPaths[4] = {
		"/tmp/zos-host", "/tmp/tc002-os/host", "/data/zos-host", "/res/etc/zos-host",
	};
	for (int i = 0; i < 4; ++i) {
		FILE* f = fopen(kPaths[i], "r");
		if (f == NULL) continue;
		char line[128];
		line[0] = '\0';
		if (fgets(line, sizeof(line), f) == NULL) line[0] = '\0';
		fclose(f);
		std::string value(line);
		while (!value.empty() && (value[value.size() - 1] == '\n' ||
		                          value[value.size() - 1] == '\r' ||
		                          value[value.size() - 1] == ' ')) {
			value.erase(value.size() - 1);
		}
		if (value.empty()) continue;
		// Accept the three shapes a human would write, so a redeploy cannot be
		// broken by the obvious spelling of the same address.
		if (value.compare(0, 7, "http://") == 0) return value;
		if (value.find(':') != std::string::npos) return "http://" + value;
		return "http://" + value + ":43820";
	}
	return std::string();
}

// One line per item, which is exactly what has to change for the ring to be
// rebuilt: the kind decides the icon, the id decides the route, the label is
// what is drawn.
std::string menuSignature(const std::vector<tcos::StateDoc::Item>& items) {
	std::string out;
	for (size_t i = 0; i < items.size(); ++i) {
		char kind[8];
		snprintf(kind, sizeof(kind), "%d", (int)items[i].kind);
		out += kind;
		out += '\x1f';
		out += items[i].id;
		out += '\x1f';
		out += items[i].label;
		out += '\x1e';
	}
	return out;
}

void updateChannelRing(const std::vector<tcos::StateDoc::Item>& items, int nowMs) {
	// Only channels. The root ring is fixed at the four things this device does;
	// the workspace's content is a level down, where it can be browsed without
	// pushing music, games and settings off the end of a ten-item ring.
	std::vector<tcos::ChannelRingScreen::Entry> channels;
	for (size_t i = 0; i < items.size(); ++i) {
		if (items[i].kind != tcos::StateDoc::kChannel) continue;
		tcos::ChannelRingScreen::Entry entry;
		entry.appName = items[i].id;
		entry.label = items[i].label;
		channels.push_back(entry);
	}
	sChannelRing.setEntries(channels, nowMs);
}

std::string formatUptime(uint64_t ms) {
	const unsigned long total = (unsigned long)(ms / 1000ull);
	char buf[32];
	if (total < 3600) snprintf(buf, sizeof(buf), "%lum %lus", total / 60, total % 60);
	else snprintf(buf, sizeof(buf), "%luh %lum", total / 3600, (total % 3600) / 60);
	return std::string(buf);
}

void rebuildSettings(int nowMs) {
	std::vector<tcos::SettingsScreen::Row> rows;
	tcos::SettingsScreen::Row row;
	row.id = ACTION_NONE;

	const std::string ssid = tcos::netinfo::ssid();
	row.label = "\xE7\xBD\x91\xE7\xBB\x9C";                                  // 网络
	row.value = ssid.empty() ? "\xE6\x9C\xAA\xE8\xBF\x9E\xE6\x8E\xA5" : ssid;  // 未连接
	rows.push_back(row);

	const std::string ip = tcos::netinfo::ipAddress();
	row.label = "IP";
	row.value = ip.empty() ? "--" : ip;
	rows.push_back(row);

	row.label = "\xE6\x8E\xA7\xE5\x88\xB6\xE5\x8F\xB0";                      // 控制台
	if (hostLink().baseUrl().empty()) {
		row.value = "\xE6\x9C\xAA\xE8\xAE\xBE\xE7\xBD\xAE";                   // 未设置
	} else if (sLink.online) {
		// The address is the useful half: "connected" without saying to what is
		// exactly the state that makes a wrong host address impossible to spot.
		row.value = hostLink().baseUrl().substr(7);  // drop the "http://"
	} else {
		row.value = "\xE7\xA6\xBB\xE7\xBA\xBF";                               // 离线
	}
	rows.push_back(row);

	char buf[32];
	snprintf(buf, sizeof(buf), "%d / %d", tcos::DeviceControls::instance().volume(),
	         tcos::DeviceControls::kVolumeMax);
	row.label = "\xE9\x9F\xB3\xE9\x87\x8F";                                  // 音量
	row.value = buf;
	rows.push_back(row);

	snprintf(buf, sizeof(buf), "%d / %d", tcos::DeviceControls::instance().brightness(),
	         tcos::DeviceControls::kBrightnessSteps);
	row.label = "\xE4\xBA\xAE\xE5\xBA\xA6";                                  // 亮度
	row.value = buf;
	rows.push_back(row);

	const std::string mac = tcos::netinfo::macAddress();
	row.label = "MAC";
	row.value = mac.empty() ? "--" : mac;
	rows.push_back(row);

	// 链路: adopted / the policy's own state. Worth a row because "we never
	// touched your network" is a claim the user can otherwise only take on faith.
	row.label = "\xE9\x93\xBE\xE8\xB7\xAF";                                  // 链路
	if (sWifiPolicy.adopted()) {
		row.value = "\xE6\xB2\xBF\xE7\x94\xA8";                              // 沿用
	} else if (sWifiPolicy.isOnline()) {
		row.value = "\xE5\xB7\xB2\xE8\xBF\x9E\xE6\x8E\xA5";                // 已连接
	} else if (sWifiPolicy.isProvisioning()) {
		row.value = "\xE9\x85\x8D\xE7\xBD\x91\xE4\xB8\xAD";                // 配网中
	} else {
		row.value = "\xE8\xBF\x9E\xE6\x8E\xA5\xE4\xB8\xAD";                // 连接中
	}
	rows.push_back(row);

	row.label = "\xE9\x85\x8D\xE7\xBD\x91";                                  // 配网
	if (!sPortalService.running()) {
		row.value = "\xE6\x9C\xAA\xE5\x90\xAF\xE5\x8A\xA8";                // 未启动
	} else if (ip.empty()) {
		row.value = "--";
	} else {
		char portal[64];
		snprintf(portal, sizeof(portal), "%s:%d", ip.c_str(), sPortalService.port());
		row.value = portal;
	}
	rows.push_back(row);

	row.label = "\xE8\xBF\x90\xE8\xA1\x8C";                                  // 运行
	row.value = formatUptime(monoMs() - sStartMs);
	rows.push_back(row);

	row.label = "ZOS";
	row.value = "1.0";
	rows.push_back(row);

	sSettings.setRows(rows, nowMs);
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

	// Bring the MCU up. This is not optional, and the reason it looked optional
	// for so long is a trap worth recording: while ZOS was SIDELOADED the stock
	// app had already run and initialised the MCU, so the panel was already in
	// the state where Presenter's SPI writes land. Flashed, ZOS is the only app
	// there has ever been — nothing initialises the MCU, every SPI write goes
	// nowhere, and the panel sits on the boot logo while the rest of the
	// firmware (input, audio, network, the whole render loop) runs perfectly.
	// That failure looks like a display bug and is not one.
	//
	// 1.5 Mbaud on ttyS1, matching the arcade firmware, which is the only other
	// code here proven to drive this panel from a cold start.
	McuManager::getInstance().initialize(
		new PixelMcuProto::McuParse("/dev/ttyS1", 1500000));
	// Before Sfx: initialize() sets the mixer level, and Sfx primes the audio
	// output as part of coming up. Reversed, the priming burst and every effect
	// until the first onUI_show ran at whatever level the previous firmware left.
	tcos::DeviceControls::instance().initialize();
	tcos::Sfx::instance().initialize();
	KeyManager::getInstance().start();
	// Started here rather than in onUI_show: onUI_show runs on every return to
	// this activity, and the link's threads must be created exactly once.
	hostLink().start(readHostAddress());
	sPortalService.start(kPortalPort, &sPortal);
	sWifiPolicy.begin(0);
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

	// The root ring is fixed: these four are what the device does, and they do
	// not come from the host. The workspace's channels are content, not
	// destinations — they live one level down, under 轮播, the same way the
	// seven games live under 游戏. Ten channels on this ring would push the
	// other three off the end of a ring that shows one item at a time.
	std::vector<tcos::LauncherScreen::Entry> entries;
	tcos::LauncherScreen::Entry entry;
	entry.label = "\xE9\x9F\xB3\xE4\xB9\x90";              // 音乐
	entry.icon = tcos::LauncherScreen::kIconMusic;
	entry.id = ID_MUSIC;
	entries.push_back(entry);
	entry.label = "\xE6\xB8\xB8\xE6\x88\x8F";              // 游戏
	entry.icon = tcos::LauncherScreen::kIconGame;
	entry.id = ID_GAMES;
	entries.push_back(entry);
	entry.label = "\xE8\xBD\xAE\xE6\x92\xAD";              // 轮播
	entry.icon = tcos::LauncherScreen::kIconChannel;
	entry.id = ID_CHANNELS;
	entries.push_back(entry);
	entry.label = "\xE8\xAE\xBE\xE7\xBD\xAE";              // 设置
	entry.icon = tcos::LauncherScreen::kIconSettings;
	entry.id = ID_SETTINGS;
	entries.push_back(entry);

	// The games ring: one card per engine, titles straight from the engines so
	// the two can never disagree about what is installed.
	std::vector<tcos::LauncherScreen::Entry> games;
	for (int i = 0; i < 7; ++i) {
		tcos::LauncherScreen::Entry game;
		game.label = sEngines[i]->title();
		// One sprite per engine, in that engine's own palette. The order here
		// must match gameicons::Icon, which is why both follow the launcher's.
		game.icon = static_cast<tcos::LauncherScreen::Icon>(
			tcos::LauncherScreen::kIconGameBreakout + i);
		game.id = ID_GAME_BASE + i;
		games.push_back(game);
	}

	const int nowMs = (int)(monoMs() - sStartMs);
	sLauncher.setEntries(entries, nowMs);
	sGameList.setEntries(games, nowMs);
	// Arcade blue chrome and a lift on entry, so the games ring announces itself
	// as a different place rather than looking like the root menu relabelled.
	sGameList.setChrome(Color(120, 170, 255), Color(18, 28, 46));
	sGameList.setEntryRise(true);

	// Each destination announces itself with the entry that suits it rather than
	// one generic slide: a channel arrives like a CRT waking up, music rises as
	// an equaliser, a game is a cartridge seated behind a shine, settings drop
	// in and bounce. The Shell keeps this table across reset(), so it is set
	// once here rather than at every push.
	shell().setEntryStyle(&sMusic, tcos::Shell::kEntryEqualiser);
	shell().setEntryStyle(&sGameList, tcos::Shell::kEntryCartridge);
	shell().setEntryStyle(&sGameScreen, tcos::Shell::kEntryCartridge);
	shell().setEntryStyle(&sChannelRing, tcos::Shell::kEntryCrt);
	shell().setEntryStyle(&sSettings, tcos::Shell::kEntryDrop);
	// volume/brightness already adopted in onUI_init
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

	// --- console link ------------------------------------------------------
	// Polled at ~6 Hz. A snapshot copies the whole menu, and doing that on every
	// frame to read two booleans would be the single most expensive thing in the
	// tick; nothing it carries changes faster than a person can see.
	if (monoMs() - sLinkPolledMs >= 160) {
		sLinkPolledMs = monoMs();
		// Every predicate the policy reads costs a socket or an ioctl, so it runs
		// at the link poll's cadence rather than at 25 fps. Nothing it decides
		// changes faster than a radio can associate.
		sWifiPolicy.tick(nowMs);
		// Credentials submitted through the provisioning page are handed over
		// here, on the UI thread, rather than from the HTTP thread — the policy
		// has no lock of its own and this is the only place it is touched.
		{
			std::string pendingSsid;
			std::string pendingPsk;
			if (sProvisioning.takePending(&pendingSsid, &pendingPsk)) {
				sWifiPolicy.applyCredentials(pendingSsid, pendingPsk, nowMs);
			}
		}
		sLink = hostLink().snapshot();
		const std::string signature = menuSignature(sLink.items);
		if (!sLink.items.empty() && signature != sMenuSignature) {
			sMenuSignature = signature;
			updateChannelRing(sLink.items, nowMs);
		}

		// The console pinning a channel is a remote navigation, so it is handled
		// exactly like a press: only on the edge, so the user can still walk away
		// from a pinned channel without it yanking them back every tick.
		if (sLink.pinned && !sLink.focus.empty() && sLink.focus != sPinnedFocus) {
			sPinnedFocus = sLink.focus;
			if (sChannelRing.selectApp(sLink.focus, nowMs) &&
			    shell().top() != &sChannelRing) {
				shell().push(&sChannelRing, nowMs);
			}
		} else if (!sLink.pinned) {
			sPinnedFocus.clear();
		}
	}

	// Route activations before rendering, so a press lands on the panel in the
	// same frame the user made it.
	const int rootPick = sLauncher.takeActivated();
	if (rootPick == ID_GAMES) {
		shell().push(&sGameList, nowMs);
	} else if (rootPick == ID_SETTINGS) {
		rebuildSettings(nowMs);
		shell().push(&sSettings, nowMs);
	} else if (rootPick == ID_MUSIC) {
		shell().push(&sMusic, nowMs);
	} else if (rootPick == ID_CHANNELS) {
		shell().push(&sChannelRing, nowMs);
	}

	// --- feed whichever screen is on top -----------------------------------
	{
		tcos::FrameBundle fresh;
		std::string freshApp;
		if (hostLink().takeChannelFrames(&fresh, &freshApp)) {
			// The ring drops frames that do not belong to the settled channel, so
			// a slow download landing after the knob moved on cannot paint over
			// the channel the user is actually looking at.
			sChannelRing.adoptFrames(fresh, freshApp, nowMs);
		}
	}
	if (shell().top() == &sChannelRing) {
		// One request per move, not one per frame: the ring reports the change
		// once and clears it.
		if (sChannelRing.takeSelectionChanged() && !sChannelRing.currentApp().empty()) {
			hostLink().selectChannel(sChannelRing.currentApp());
		}
		if (!sLink.online && sChannelRing.status() != tcos::ChannelRingScreen::kReady) {
			sChannelRing.setStatus(tcos::ChannelRingScreen::kOffline, nowMs);
		} else if (hostLink().channelFailed()) {
			sChannelRing.setStatus(tcos::ChannelRingScreen::kFailed, nowMs);
		}
	} else if (shell().top() == &sMusic) {
		sMusic.setNowPlaying(sLink.nowPlaying, sLink.track, sLink.artist, sLink.lyric,
		                     sLink.playing, sLink.positionMs, sLink.durationMs,
		                     (int)(sLink.stampMonoMs - sStartMs));
		switch (sMusic.takeAction()) {
		case tcos::MusicScreen::kToggle:
			hostLink().sendMusicAction(sLink.playing ? "pause" : "play");
			break;
		case tcos::MusicScreen::kNext:
			hostLink().sendMusicAction("next");
			break;
		case tcos::MusicScreen::kPrevious:
			hostLink().sendMusicAction("previous");
			break;
		default:
			break;
		}
	} else if (shell().top() == &sSettings) {
		// Values move while the screen is up — the volume keys work here too —
		// so they are rebuilt on a cadence rather than only on entry.
		if (monoMs() - sSettingsBuiltMs >= 500) {
			sSettingsBuiltMs = monoMs();
			rebuildSettings(nowMs);
		}
		sSettings.takeActivated();
	}
	const int gamePick = sGameList.takeActivated();
	if (gamePick >= ID_GAME_BASE && gamePick < ID_GAME_BASE + 7) {
		sGameScreen.setEngine(sEngines[gamePick - ID_GAME_BASE]);
		shell().push(&sGameScreen, nowMs);
		sSfxGame = tcos::Sfx::gameFromId(sEngines[gamePick - ID_GAME_BASE]->id());
		tcos::Sfx::instance().playGame(sSfxGame, tcos::Sfx::kGameStart);
	}
	if (sGameScreen.takeExitRequest()) {
		shell().pop(nowMs);
	}

	// Score and game-over are edges in the engine's own state, so they are
	// watched here rather than guessed from input: a point can be scored by the
	// simulation with no key pressed at all.
	if (sGameScreen.engine() != 0) {
		const GameHud hud = sGameScreen.engine()->hud();
		if (hud.phase == GameHud::Over && sPrevHud.phase != GameHud::Over) {
			tcos::Sfx::instance().playGame(sSfxGame, tcos::Sfx::kGameOver);
		} else if (hud.phase == GameHud::Playing && hud.score > sPrevHud.score) {
			tcos::Sfx::instance().playGame(sSfxGame, tcos::Sfx::kGameScore);
		}
		sPrevHud = hud;
	}

	shell().render(canvas(), nowMs);
	presenter().present(canvas());

	// The mirror tee. Exactly one place in the firmware produces finished
	// pixels, and this is immediately after it: the LED bus is write-only and
	// /dev/fb0 is unrelated to the matrix, so a capture is the only way the
	// console can show what the panel actually shows. Gated on someone
	// watching, because the extract alone is 2496 bytes 25 times a second.
	if (sLink.mirrorWanted) {
		static std::vector<uint8_t> mirrorRgb;
		canvas().extractRGB(mirrorRgb);
		if (!mirrorRgb.empty()) {
			hostLink().publishMirror(&mirrorRgb[0], (int)mirrorRgb.size());
		}
	}

	// Telemetry. Throttled not because setting it is expensive but because
	// reading it is: the SSID and the address each cost a socket and an ioctl,
	// and at 25 fps that would be fifty syscalls a second to answer a question
	// whose answer changes about once a week.
	if (monoMs() - sTelemetryReadMs >= 2000) {
		sTelemetryReadMs = monoMs();
		tcos::Screen* top = shell().top();
		const char* screenName = "launcher";
		if (top == &sChannelRing) screenName = "channel";
		else if (top == &sMusic) screenName = "music";
		else if (top == &sSettings) screenName = "settings";
		else if (top == &sGameScreen) screenName = "game";
		else if (top == &sGameList) screenName = "games";
		else if (top == &sBoot) screenName = "boot";
		// The real count, not a placeholder. It is also the console's only way to
		// tell an adopted link from one the policy is failing to rebuild: an
		// adopted link issues no commands at all, so this stays 0 forever, while
		// a policy stuck retrying a refused startSupplicant climbs every tick.
		hostLink().setTelemetry(screenName, sChannelRing.currentApp(), tcos::netinfo::ssid(),
		                        tcos::netinfo::ipAddress(),
		                        sWifiPolicy.supplicantRestarts());
	}
	return true;
}
