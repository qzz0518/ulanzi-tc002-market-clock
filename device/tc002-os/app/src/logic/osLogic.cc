#pragma once
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

#include <mutex>
#include <vector>

#include <os/SystemProperties.h>
#include <os/UpgradeMonitor.h>

#include <unistd.h>

#include "net/BleProvisionSession.h"
#include "net/ConsoleDiscovery.h"
#include "net/FirmwareUpdate.h"
#include "net/HostLink.h"
#include "net/PortalService.h"
#include "net/WifiPolicy.h"
#include "net/SetupPortal.h"
#include "net/TimeSync.h"
#include "platform/BleService.h"
#include "platform/DeviceControls.h"
#include "platform/BatteryMonitor.h"
#include "platform/DeviceProvisioning.h"
#include "platform/DeviceWifi.h"
#include "platform/InstallMode.h"
#include "platform/NetInfo.h"
#include "platform/Prefs.h"
#include "platform/ProvisionLog.h"
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
#include "ui/LevelControl.h"
#include "ui/LevelOverlay.h"
#include "ui/MusicScreen.h"
#include "ui/ProvisionScreen.h"
#include "ui/Screen.h"
#include "ui/SettingsScreen.h"
#include "ui/SleepPolicy.h"
#include "ui/UpgradeOverlay.h"
#include "ui/VibeScreen.h"

// Defined below; called from the startup path before it is defined.
namespace tcos { void upgradeEntryPoint(int seq); }

namespace {

#define TIMER_TICK 1

// 50 fps, set by the most demanding thing this firmware draws rather than by a
// general judgement about frames.
//
// This was 40 ms (25 fps), chosen for "a procedural 832-pixel frame, which
// measures in microseconds" — true, and beside the point once ui/MusicScreen
// became a port of the dedicated lyrics player. That firmware runs at 30 ms and
// says why (LyricsPage.h): spotlight sweeps the sung line pixel by pixel and
// wants ~50 fps over a 200 px line, cascade walks 18 px inside 0.14 of a line,
// about 32 fps. Ticker and skyline do not care — their text jumps in whole 12 px
// cells and their spectrum is quantised to 8 fps. At 25 fps the two
// motion-sensitive modes stepped, and spotlight is the default mode.
//
// Porting the renderer without its timebase is what left the two mismatched.
// 20 ms rather than the lyrics player's 30 ms because spotlight's own stated
// requirement is 50 fps, and the budget turns out to be there: measured on the
// device beforehand, zkgui took 2.2% of one CPU at 25 fps while drawing the
// digital-rain clock, the most expensive frame here, so 50 fps costs about 4.4%.
//
// The floor below this is the panel's, not the loop's: Presenter::kFramePaceUs
// paces at 15 ms, so a tick shorter than that would only queue against hardware
// that cannot take it. 20 ms leaves 5 ms of headroom over that floor — thinner
// than the old 25 ms, and the reason this constant now carries a measurement
// instead of an adjective.
//
// Safe to change at all because nothing here counts frames: every screen
// animates against nowMs, and the arcade engines take tick(dtMs) into an
// accumulator, so a faster tick makes them smoother rather than faster.
const int TICK_MS = 20;

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
tcos::VibeScreen sVibe;              // 「VIBE」, a peer of 音乐 on the root ring
tcos::SettingsScreen sSettings;
tcos::ProvisionScreen sProvision;

// The console link. A function-local static like the presenter: its threads
// must not start before the framework is up.
tcos::HostLink& hostLink() {
	static tcos::HostLink instance;
	return instance;
}

// The console beacon listener, for the day the console's DHCP lease moves and
// the address above stops answering. Same function-local-static discipline as
// the link, and for the same reason: it owns a thread.
tcos::ConsoleDiscovery& consoleDiscovery() {
	static tcos::ConsoleDiscovery instance;
	return instance;
}

// The wall clock. A function-local static for the same reason as the link: its
// thread must not start before the framework is up.
tcos::TimeSync& timeSync() {
	static tcos::TimeSync instance;
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

// BLE provisioning: the transport on its own thread, the state machine on this
// one. The split is deliberate and is the reason the state machine is pure —
// every request it produces is executed against sWifi / sWifiPolicy here, on the
// UI thread, which is the only thread that has ever touched them.
//
// It exists because the hotspot path cannot scan. Raising the AP issues
// `ctl.stop wpa_supplicant`, and a stopped supplicant has no control socket, so
// the setup page's network list is always the sweep taken BEFORE the radio was
// taken away. BLE runs on the aic8800's other function over a separate UART
// attach, so the station radio stays up: the supplicant keeps running, SCAN and
// SCAN_RESULTS keep working, and the console can offer a live list while the
// user is looking at it.
tcos::BleService sBle;
tcos::BleProvisionSession sBleSession;
// 80 first, 8080 as the fallback.
//
// Port 80 is not a nicety once the hotspot exists: dnsmasq answers every name
// with our address, and a phone's captive-portal probe then asks port 80 — on
// 8080 the sheet never opens and the user has to be told a URL. /etc/init.rc
// runs zkswe as `user root`, so the privileged bind is available; the fallback
// is kept because a firmware that refuses to serve its own setup page because
// a port was taken would be the worst possible failure of this feature.
const int kPortalPreferredPort = 80;
const int kPortalFallbackPort = 8080;

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
	ID_VIBE = 5,
	ID_GAME_BASE = 200,
};

// Settings rows that do something when pressed. Zero means inert.
enum {
	ACTION_NONE = 0,
	ACTION_PROVISION = 1,
	ACTION_SLEEP_WINDOW = 2,
	ACTION_SLEEP_IDLE = 3,
};

// The host's channel list, as the second-level ring currently reflects it.
// Kept as a signature rather than compared item by item: the document's
// sequence bumps on things the ring does not care about (a lyric line changes
// every few seconds), and rebuilding for those would jerk the user's selection
// back to the first channel every time the song moved on.
//
// tcos::menuSignature covers the revision and the ttl as well as the label, and
// that is the whole reason an edit gets this far — id and label alone compare
// equal after every content change ever made, so this gate used to swallow the
// news before the ring ever heard of it. It lives in net/StateDoc.cpp because
// this file cannot be compiled on the host.
std::string sMenuSignature;
// The MCU's reported firmware version, from the handshake at startup. Empty
// means the MCU never answered — which is the difference between a working
// panel and a dark one, so it earns a row on the settings screen.
std::string sMcuVersion;
std::string sPinnedFocus;
// The document sequence 「VIBE」 was last fed at, or -1 for "feed it now".
//
// A gate rather than a per-tick copy: the VIBE block is ten agents of strings,
// and handing it over fifty times a second to redraw numbers that move once
// every five minutes is the same mistake the 160 ms snapshot poll exists to
// avoid one function up. Every change to the block bumps the hub's sequence, so
// comparing one int is exactly as sensitive as comparing the payload.
int sVibeFedSeq = -1;
// When the vendor updater may be started, or -1 for "not staged".
//
// A DELAY, not a flag, and it is the only reason it is a number: the panel has
// to present 安装中 before the chain that tears every service down begins.
// checkUpgradeFile() does not return in any useful sense — it clears
// /tmp/EasyUI.cfg, flashes and reboots — so a frame composed after it is a
// frame nobody sees, and calling it on the same tick the download finished
// meant the last thing on the panel was whatever was there before.
int sUpgradeInstallAtMs = -1;
// When the vendor chain was handed control, or -1. The chain reboots the device
// when it succeeds, so this timer only ever expires on a failure — and the
// vendor's own `zk_upgrade_end` RETURNS WITHOUT REBOOTING for any error code,
// which is precisely how the panel ends up reading 安装中 with nothing running
// behind it. Four minutes: an erase-and-write of mtd3 with an MD5 re-read was
// measured well inside one, and anything past that is not slow, it is over.
int sUpgradeHandoffAtMs = -1;
const int kUpgradeChainTimeoutMs = 240000;
// Long enough for the frame carrying 安装中 to be composed, presented on the
// panel and teed to the console mirror; short enough that it reads as the last
// beat of the install rather than as a pause.
const int kUpgradeHandoffMs = 600;
// The install stage the breadcrumb log was last told about. Seeded with kIdle
// (0), not -1: every boot begins there, and a log line for it would be one jffs2
// write per power-up saying nothing happened.
int sUpgradeLoggedStage = 0;

// The link's view of the world, refreshed on a slower cadence than the render:
// a snapshot copies the whole menu, and doing that 25 times a second to read
// two booleans would be the most expensive thing in the tick.
tcos::HostLink::Snapshot sLink;
uint64_t sLinkPolledMs = 0;
uint64_t sSettingsBuiltMs = 0;
uint64_t sTelemetryReadMs = 0;
// Edge detector for "the policy just entered provisioning", so the sweep it
// gathered is handed to the setup page exactly once per hotspot rather than
// copied out of the policy six times a second.
bool sWasProvisioning = false;
// The highest console sequence already acted on.
//
// PRIMED from the first document rather than started at zero. The service keeps
// a tail of recent presses so a device that missed one can still see it, which
// means a device that has just booted would otherwise replay every press in
// that tail — observed: a reboot mid-testing walked the menu on its own. The
// same reasoning covers settings, where a stale request would override the
// volume the user actually last chose (restored from /data by Prefs).
int sAppliedSettingsSeq = 0;
int sAppliedInputSeq = 0;
int sAppliedSleepSeq = 0;
bool sConsoleSeqPrimed = false;

// ---------------------------------------------------------------------------
// 夜间息屏. Every RULE lives in ui/SleepPolicy.cpp, which the host self-check
// links; what is left here is the state the rules are a function of, and the
// wiring to the panel. Nothing below decides anything about windows or timeouts.
tcos::SleepConfig sSleepConfig;
// CLOCK_MONOTONIC, the UI's zero-based one. Stamped by every key event and by
// every console request whose SEQUENCE ROSE — never by a poll. See the drain in
// onUI_Timer for why the hook is there rather than in a screen.
int sLastActivityMs = 0;
// What was last PRESENTED, and when. The pure decision needs both: the percent
// so the first black frame is guaranteed rather than waiting for the 1 Hz
// repaint, the timestamp so the repaint is 1 Hz rather than 50.
int sLastPanelPercent = 100;
int sLastPresentMs = 0;
// The previous tick's verdict, read by the input drain at the top of THIS tick.
// The drain runs before the decision, so "was the panel dark when the user
// touched it" can only be answered by what was last on the panel.
bool sSwallowsInput = false;
// Which key code the wake swallowed, so its matching release is dropped too. A
// swallowed key-down followed by a delivered key-up would tell a game engine a
// button was released that it never saw pressed.
int sWakeSwallowCode = -1;
bool sSleepAsleep = false;
// What the last telemetry read carried. The panel going dark or lighting up is
// the one telemetry field the console REACTS to rather than displays, so the
// 2 s read throttle is skipped on its edge: without that the console kept
// painting a cleared canvas labelled 已息屏 for up to ~12 s after the panel had
// already woken, and the obvious second press — the one that is no longer
// swallowed — changed the channel. Exactly the trap the swallow exists to
// prevent, reintroduced on the surface most people actually touch.
bool sSleepAsleepReported = false;

// The 主题设置 last written to /data, so a document that repeats it does not
// re-stage a flash write. NOT a sequence: the theme has one writer and no local
// control to fight (the knob is prev/next here and the side buttons stay with
// volume), so it is applied unconditionally on every document and the only
// thing worth remembering is what is already on disk.
int sPersistedMode = -1;
int sPersistedSkin = -1;
// -1 means "no accent", which is why this cannot be a uint32_t.
int sPersistedAccent = -2;

/**
 * Reads the last adopted 主题设置 back off /data.
 *
 * A warm-start cache, not a second store. The link is absent for several
 * seconds on a cold boot — and forever on a flashed unit that was never told a
 * host address, which is the 未配置 case the music screen already has a state
 * for — so without this the panel repaints itself 信号绿 in front of a user who
 * chose 磁带橙 months ago. The first document that arrives overrides it.
 *
 * setTheme ignores out-of-range ids, so a corrupt or hand-edited prefs file
 * leaves the constructor's defaults rather than blanking the screen.
 */
void restoreLyricTheme() {
	sPersistedMode = tcos::prefs::getInt("music.mode", tcos::MusicScreen::kModeSpotlight);
	sPersistedSkin = tcos::prefs::getInt("music.skin", tcos::MusicScreen::kSkinSignal);
	sPersistedAccent = tcos::prefs::getInt("music.accent", -1);
	sMusic.setTheme(sPersistedMode, sPersistedSkin,
	                sPersistedAccent >= 0 ? (uint32_t)sPersistedAccent : 0,
	                sPersistedAccent >= 0);
}

/**
 * Hands the document's theme to the music screen, and remembers it.
 *
 * NO SEQUENCE GATE, deliberately, and this is the one console->device channel
 * without one. `setseq` exists because the knob can change the volume locally,
 * so a stale console value riding in every document would spring back the
 * instant the user let go. The theme has no local control to fight — the knob
 * is prev/next on this screen, the press is play/pause, and the side buttons
 * stay with volume on purpose — so re-applying it on every document is
 * idempotent, and it is also what makes a device correct on its FIRST poll
 * rather than on the first click after boot. A theme cycle added later must
 * arrive with its own `themeseq` and rising-edge gating.
 */
void applyLyricTheme(int mode, int skin, uint32_t accentRgb, bool hasAccent) {
	sMusic.setTheme(mode, skin, accentRgb, hasAccent);
	const int accent = hasAccent ? (int)(accentRgb & 0xffffffu) : -1;
	if (mode == sPersistedMode && skin == sPersistedSkin && accent == sPersistedAccent) return;
	sPersistedMode = mode;
	sPersistedSkin = skin;
	sPersistedAccent = accent;
	// STAGED, not written. /data is jffs2 on raw NAND; the commit is debounced
	// by DeviceControls::flushIfDue, which the tick already calls once a frame.
	// Committing here would put a flash erase on the poll path, which is the
	// same mistake the volume knob avoids one function over.
	tcos::prefs::setInt("music.mode", mode);
	tcos::prefs::setInt("music.skin", skin);
	tcos::prefs::setInt("music.accent", accent);
}

/**
 * Reads the 已用 / 剩余 toggle back off /data.
 *
 * Beside the theme restore, and for the same reason: it is a preference the
 * user set once with a single press, there is no console writer to fight, and a
 * page that forgot it on every power cut would make the toggle not worth having.
 * A missing key reads as 已用, which is what the page showed before the toggle
 * existed.
 */
void restoreVibePrefs() {
	sVibe.setShowLeft(tcos::prefs::getInt("vibe.showLeft", 0) != 0);
}

/**
 * Reads 夜间休眠 back off /data.
 *
 * Beside the volume, brightness and theme restores for the same reason: these
 * are settings a user chose once and expects to still be there after a power
 * cut. Everything is clamped on the way in — a hand-edited or half-written
 * prefs file must land on a config that cannot brick, and sanitizeSleepConfig
 * is where that judgement lives.
 */
void restoreSleepConfig() {
	tcos::SleepConfig cfg;  // the defaults: off, 23:00-07:00, 5 分钟
	cfg.enabled = tcos::prefs::getInt("sleep.enabled", 0) != 0;
	cfg.startMin = tcos::prefs::getInt("sleep.startMin", cfg.startMin);
	cfg.endMin = tcos::prefs::getInt("sleep.endMin", cfg.endMin);
	// Read as seconds and bounded BEFORE the multiply: a corrupt INT_MAX would
	// otherwise overflow rather than clamp.
	int idleSec = tcos::prefs::getInt("sleep.idleSec", cfg.idleMs / 1000);
	if (idleSec < 0) idleSec = 0;
	if (idleSec > tcos::kMaxIdleMs / 1000) idleSec = tcos::kMaxIdleMs / 1000;
	cfg.idleMs = idleSec * 1000;
	sSleepConfig = tcos::sanitizeSleepConfig(cfg);
}

/**
 * Stages 夜间休眠 for /data. STAGED, not written.
 *
 * /data is jffs2 on raw NAND; the commit is debounced by
 * DeviceControls::flushIfDue, which the tick already calls once a frame and
 * which keys on prefs::dirty() — a global flag, so this needs no flush path of
 * its own. Committing here would put a flash erase in the input path, which is
 * the exact mistake the volume knob avoids.
 */
void persistSleepConfig() {
	tcos::prefs::setInt("sleep.enabled", sSleepConfig.enabled ? 1 : 0);
	tcos::prefs::setInt("sleep.startMin", sSleepConfig.startMin);
	tcos::prefs::setInt("sleep.endMin", sSleepConfig.endMin);
	tcos::prefs::setInt("sleep.idleSec", sSleepConfig.idleMs / 1000);
}

/**
 * How long ago the wall clock was last proven, in ms; -1 when it never was.
 *
 * Wall time and monotonic time are never mixed: this is the monotonic age of
 * the last accepted NTP reply, which is what decides whether the window may be
 * believed at all. The window itself is compared against wall time, one
 * function down.
 */
int clockAgeMs(int nowMs) {
	const tcos::TimeSync::Status status = timeSync().status();
	if (!status.synced || status.monoMs == 0) return -1;
	const uint64_t sinceBoot = status.monoMs - sStartMs;
	return nowMs - (int)sinceBoot;
}

/**
 * Local minute-of-day, or -1 when the clock cannot be trusted.
 *
 * The one place in this file that knows the device is on UTC+8 — the 时间 row
 * shares it, so there are not two spellings of that fact to drift apart.
 */
int localMinuteNow() {
	return tcos::localMinuteOfDay((int64_t)time(NULL), tcos::kTzOffsetMinutes);
}

/** Whether 夜间休眠 has a wall clock good enough to act on. */
bool sleepClockUsable(int nowMs) {
	if (!timeSync().synced()) return false;
	const int age = clockAgeMs(nowMs);
	return age >= 0 && age <= tcos::kClockTrustMs;
}

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
//
// The rules live in ui/LevelControl.cpp, and this is the only thing left here:
// binding them to the two device singletons. DeviceControls.cpp calls the
// FlyThings audio manager, so as long as the rules named it directly they could
// not be compiled by any host check — which is how the console branch shipped
// raising the brightness bar for a volume change. See ui/LevelControl.h.
class DeviceLevelControls : public tcos::LevelControls {
 public:
	virtual int volume() const { return tcos::DeviceControls::instance().volume(); }
	virtual int brightness() const { return tcos::DeviceControls::instance().brightness(); }
	virtual int nudgeVolume(int delta) {
		return tcos::DeviceControls::instance().nudgeVolume(delta);
	}
	virtual int nudgeBrightness(int delta) {
		return tcos::DeviceControls::instance().nudgeBrightness(delta);
	}
};

tcos::LevelControls& levels() {
	static DeviceLevelControls single;
	return single;
}

/**
 * The wake gesture, and why it must not also act.
 *
 * At 02:00 the user turns the knob to see the time. If that detent also
 * advanced the channel ring they have lost the channel they left it on and must
 * fix it in the dark — which is what a phone would never do. So the FIRST event
 * after the panel has gone black wakes it and is swallowed; the next one
 * ~100 ms later navigates normally.
 *
 * `pairedCode` is the key code whose RELEASE must be dropped along with it, or
 * -1 for an event that has none — a rotation, or a console-injected action.
 * Returns true when the wake has consumed the event.
 */
bool takeWake(int pairedCode) {
	if (!sSwallowsInput) return false;
	// Exactly one gesture, cleared here rather than at the end of the tick: two
	// presses inside one 20 ms drain must not both be eaten.
	sSwallowsInput = false;
	sWakeSwallowCode = pairedCode;
	return true;
}

/**
 * The physical half of the wake, where the down/up pairing lives.
 *
 * A game reads raw button EDGES (shell().deliverRawButton), so a swallowed
 * key-down followed by a delivered key-up would tell an engine a button was
 * released that it never saw pressed. A rotation carries no release, so nothing
 * is remembered for it.
 */
bool swallowForWake(int code, int status) {
	const bool rotation = (code == E_KEYCODE_CLOCKWISE || code == E_KEYCODE_ANTI_CLOCKWISE);
	if (sWakeSwallowCode >= 0) {
		if (!rotation && code == sWakeSwallowCode && status == 0) {
			sWakeSwallowCode = -1;
			return true;  // the release of the press we already swallowed
		}
		// Anything else means the pair is over; stop waiting for a release that
		// is no longer coming.
		sWakeSwallowCode = -1;
	}
	return takeWake((!rotation && status != 0) ? code : -1);
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

	// A short press adjusts whatever the HUD is currently showing — see
	// applyShortPress, which is where that rule is stated and checked.
	if (code == E_KEYCODE_LEFT_BUTTON) {
		tcos::applyShortPress(levels(), shell().overlay(), -1, nowMs);
	} else if (code == E_KEYCODE_RIGHT_BUTTON) {
		tcos::applyShortPress(levels(), shell().overlay(), +1, nowMs);
	} else {
		tcos::Sfx::instance().play(tcos::Sfx::kConfirm);
		dispatchInput(tcos::kInputPress, nowMs);
	}
}

// Fired from the tick the moment the threshold passes, not on release: waiting
// for the release would make every long press feel like it lagged.
void handleHold(int code, int nowMs) {
	if (code == E_KEYCODE_LEFT_BUTTON) {
		tcos::adjustLevel(levels(), shell().overlay(), true, -1, nowMs);
	} else if (code == E_KEYCODE_RIGHT_BUTTON) {
		tcos::adjustLevel(levels(), shell().overlay(), true, +1, nowMs);
	} else {
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
// Accept the three shapes a human would write, so a redeploy cannot be broken
// by the obvious spelling of the same address.
//
// Delegated rather than written out here, and that is load-bearing. This file is
// #included by activity/*.cpp and is therefore compiled by no host check, while
// ble::consoleUrl is also what BleProvisionSession's takeover rule folds an
// over-the-air `host` through before comparing it with the URL below. A second
// copy of the ":43820" default living here could drift from that one, and the
// symptom would be either a pairing code demanded on every ordinary join or no
// code demanded on a real console takeover.
std::string normalizeHostAddress(const std::string& value) {
	return tcos::ble::consoleUrl(value);
}

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
		return normalizeHostAddress(value);
	}
	return std::string();
}

/**
 * A successful BLE join may carry where the console now lives — the one moment
 * the two facts naturally travel together, because changing Wi-Fi usually means
 * the laptop moved networks too. Written the way Prefs::commit writes: temp,
 * flush, fsync, rename — jffs2 will happily rename over an unflushed file.
 *
 * The pull loop restarts with the new address either way; the file only
 * decides whether it survives a power cycle. A sideload session's /tmp
 * override still wins on re-read, which is that chain's existing contract.
 */
void adoptConsoleHost(const std::string& host) {
	FILE* f = fopen("/data/zos-host.tmp", "w");
	if (f != NULL) {
		fputs(host.c_str(), f);
		fputs("\n", f);
		fflush(f);
		fsync(fileno(f));
		fclose(f);
		if (rename("/data/zos-host.tmp", "/data/zos-host") != 0) {
			unlink("/data/zos-host.tmp");
			tcos::ProvisionLog::device().log("host-persist", "outcome=rename-failed");
		}
	} else {
		tcos::ProvisionLog::device().log("host-persist", "outcome=open-failed");
	}
	// The address is not a secret; the breadcrumb is how a wrong one gets
	// diagnosed after the fact, from the only log this device keeps.
	tcos::ProvisionLog::device().log("host-adopt", std::string("host=") + host);
	hostLink().stop();
	const std::string url = readHostAddress();
	hostLink().start(url.empty() ? normalizeHostAddress(host) : url);
}

void updateChannelRing(const std::vector<tcos::StateDoc::Item>& items, int nowMs) {
	// The filter and the field mapping live on the ring itself, where the host
	// self-check can drive them: the revision and the ttl it carries are what
	// make a saved edit reach the panel, and a field dropped on the way in is a
	// channel that silently stops refreshing.
	sChannelRing.setEntries(tcos::ChannelRingScreen::channelEntries(items), nowMs);
}

// ---------------------------------------------------------------------------
// BLE provisioning.
//
// Everything below runs on the UI thread at the 160 ms link cadence. The
// transport's mailboxes are drained here, the pure session is fed, and whatever
// it asks for is executed against the radio here and nowhere else.

// The SSID and the address, cached. Each costs a socket and an ioctl, and the
// BLE link wants both six times a second; the telemetry block one function over
// already throttles for exactly this reason.
std::string sNetSsid;
std::string sNetIp;
uint64_t sNetReadMs = 0;

bool sBleStarted = false;
// The advertised name, resolved once. netinfo::macAddress() is an ioctl, and
// the answer changes never.
std::string sBleName;
bool sBleScanPending = false;
int sBleScanStartedMs = 0;
int sBleScanIssuedMs = 0;
// Pushed once per offline episode, and never again after the user walks away —
// a screen that re-pushes itself is a device the user cannot leave.
bool sProvisionPushed = false;
// Whether the push was automatic. Only an automatic one auto-pops on success: a
// user who opened 蓝牙 by hand on a clock that is already online asked to be
// here, and yanking them out after three seconds would be the panel arguing.
bool sProvisionAuto = false;
bool sProvisionDismissed = false;
int sProvisionOnlineMs = -1;
// Set by the 配网 row: keeps the advertisement up for a while even on a device
// that is perfectly online, because "reconfigure the clock" is a thing a user
// asks for deliberately.
int sBleForcedUntilMs = -1;

const int kBleForcedMs = 300000;
// How long an authorised-but-idle session may keep the hotspot suppressed.
// Long enough that reading a password off the back of a router is not a
// timeout, bounded so a console that authorises and walks away cannot leave a
// stranded clock with no station link AND no access point — the one state that
// needs somebody to physically fetch the device.
const int kBleHoldIdleMs = 180000;
int sBleHoldActivityMs = 0;
// Breadcrumb budget for the two attacker-driven tags. See the drain in pumpBle.
const int kBleLogBurst = 8;
const int kBleLogSummaryMs = 60000;
int sBleAuditLogged = 0;
int sBleFrameLogged = 0;
int sBleAuditDropped = 0;
int sBleFrameDropped = 0;
int sBleSuppressedLogMs = 0;

void refreshNetInfo() {
	if (monoMs() - sNetReadMs < 1000 && sNetReadMs != 0) return;
	sNetReadMs = monoMs();
	sNetSsid = tcos::netinfo::ssid();
	sNetIp = tcos::netinfo::ipAddress();
}

/**
 * When the Bluetooth radio may be brought up. Read this before changing it.
 *
 * Bring-up is `ctl.start hciattach` plus HCIDEVUP on the aic8800 — the same
 * part that carries wlan0, and therefore adb, and therefore every way this
 * device can be recovered without a screwdriver. Coexistence is attested by a
 * stock-firmware `ps` capture and by nothing this firmware has ever done, so
 * until a bench run says otherwise the rule is: never start it while there is a
 * working station link to lose.
 *
 * That single rule buys the recovery path too. If bring-up does take wlan0
 * down, a power cycle returns to a booted, online clock that does NOT touch
 * Bluetooth — adb is back and the build can be replaced. A grace period after
 * coming online (there used to be one, of two minutes) forfeits exactly that:
 * every boot would repeat the experiment.
 *
 *   forced      设置 → 蓝牙. A physically present person asking by hand, which
 *               is also the supported way to move an ONLINE clock to another
 *               network; the console cannot do it unprompted.
 *   offline     Nothing left to lose: with no station link adb is already gone,
 *               so BLE can only add a way in. Deferred until the policy has
 *               stopped working the radio, so the attach never races
 *               wpa_supplicant's association on the same chip.
 */
bool bleWanted(int nowMs) {
	if (sBleForcedUntilMs > nowMs) return true;
	if (sWifiPolicy.isOnline()) return false;
	return sWifiPolicy.settled();
}

void pumpBle(int nowMs) {
	refreshNetInfo();

	// The console the pull loop is on RIGHT NOW, before a single inbound message
	// is handled. This is what BleProvisionSession::hostIsTakeover compares an
	// over-the-air `host` against, so it must be the address the device will
	// actually poll rather than a copy taken when the radio came up: a join that
	// carries a host calls adoptConsoleHost() below and restarts the loop at a new
	// address mid-session, and a stale value here would let the very next join of
	// that same session re-point the clock again without a code. baseUrl() is the
	// one field that is true by construction — it is the string the loop uses.
	sBleSession.noteConsole(hostLink().baseUrl());

	// Started late rather than in onUI_init, and gated on the MAC: the name on
	// the panel, in the phone's chooser and in the advertisement is derived from
	// it, and a MAC that is not readable yet would put ZOS-0000 on the air
	// permanently — the advertisement is set once, not per connection.
	if (!sBleStarted) {
		const std::string mac = tcos::netinfo::macAddress();
		if (mac.empty() && nowMs < 10000) return;
		sBleName = tcos::DeviceWifi::apSsidFromMac(mac);
		sBleSession.configure(sBleName, tcos::ProvisionLog::buildId(), mac);
		// Wanted BEFORE the worker exists. BleService::mWanted starts false and
		// the worker decides on its first pass whether to touch the radio, so
		// setting it after start() would be a race against a bring-up.
		sBle.setWanted(bleWanted(nowMs));
		sBle.start(sBleName);
		sBleStarted = true;
	}
	sBle.setWanted(bleWanted(nowMs));

	tcos::BleService::Event event;
	while (sBle.takeEvent(&event)) {
		switch (event) {
		case tcos::BleService::kEventAdvertising:
			// A fresh code per advertising session, minted only once the
			// controller has said the advertisement is on the air.
			sBleSession.beginAdvertising(tcos::BleService::randomSeed(), nowMs);
			break;
		case tcos::BleService::kEventConnected:
			sBleSession.onConnect(nowMs);
			sBleHoldActivityMs = nowMs;
			// Per connection, so a real session after a flood still leaves
			// evidence — the budget is against a stream, not against volume.
			sBleAuditLogged = 0;
			sBleFrameLogged = 0;
			break;
		case tcos::BleService::kEventDisconnected:
			sBleSession.onDisconnect(nowMs);
			break;
		case tcos::BleService::kEventRadioDown:
		default:
			break;
		}
	}

	std::string inbound;
	while (sBle.takeInbound(&inbound)) {
		sBleSession.onMessage(inbound, nowMs);
		sBleHoldActivityMs = nowMs;
	}
	// The message itself never reaches this function's log call — see
	// BleProvisionSession::takeAudit for why the redaction is structural rather
	// than a rule someone has to remember.
	//
	// Rate limited, and the limit is not tidiness. Both queues are drained every
	// 160 ms tick and both are fed by an UNAUTHORISED peer: audit() runs on a
	// parse failure, on no-cmd, on unknown and on a refused scan/join, and
	// onFrameError is unconditional. ProvisionLog::log is open+write+fsync+close
	// per line by design, on jffs2, on the one partition a power cycle does not
	// clear — so a stranger dribbling one malformed 20-byte chunk per connection
	// interval buys ~16 fsyncs a second, indefinitely, plus a rotation every
	// ~30 s. Eight lines is enough to diagnose a handshake; after that only a
	// count, and the count is what says a flood happened at all.
	std::string audit;
	while (sBleSession.takeAudit(&audit)) {
		if (sBleAuditLogged < kBleLogBurst) {
			++sBleAuditLogged;
			tcos::ProvisionLog::device().log("BLE_CMD", audit);
		} else {
			++sBleAuditDropped;
		}
	}
	std::string frameError;
	while (sBle.takeFrameError(&frameError)) {
		sBleSession.onFrameError(frameError.c_str(), nowMs);
		if (sBleFrameLogged < kBleLogBurst) {
			++sBleFrameLogged;
			tcos::ProvisionLog::device().log("BLE_FRAME", "why=" + frameError);
		} else {
			++sBleFrameDropped;
		}
	}
	if ((sBleAuditDropped > 0 || sBleFrameDropped > 0) &&
	    (nowMs - sBleSuppressedLogMs) >= kBleLogSummaryMs) {
		sBleSuppressedLogMs = nowMs;
		char fields[64];
		snprintf(fields, sizeof(fields), "cmd=%d frame=%d", sBleAuditDropped,
		         sBleFrameDropped);
		tcos::ProvisionLog::device().log("BLE_SUPPRESSED", fields);
		sBleAuditDropped = 0;
		sBleFrameDropped = 0;
	}

	// Hold the hotspot off while somebody is driving — but only somebody who has
	// proven they can read the panel. Keyed on a raw L2CAP connection this let
	// any unauthenticated peer in radio range tear down a running SoftAP and
	// then suppress the fallback for as long as it kept the socket open, on a
	// device that by definition has no station link. The listener takes no
	// pairing (BT_SECURITY_LOW) and the advertisement accepts any central, so
	// reaching `connected` costs nothing; nothing needs the station radio before
	// `scan` or `join`, and both of those already require the code.
	//
	// A join in flight holds too, and keeps holding after the link drops: that
	// drop is the EXPECTED shape of success here (both radios are the same part
	// and this firmware has never had both up at once), and letting it raise an
	// access point would strand the user halfway through what they asked for.
	// It is bounded by kJoinBudgetMs; the authorised-and-idle case is bounded by
	// kBleHoldIdleMs. Neither can leave a stranded clock without a fallback.
	const bool bleJoining = sBleSession.joining();
	const bool bleAttended = sBleSession.authorised() &&
	                         (nowMs - sBleHoldActivityMs) < kBleHoldIdleMs;
	sWifiPolicy.setHotspotHold(bleJoining || bleAttended, nowMs);

	// Requests BEFORE the link is sampled, and the order is the whole point. A
	// `cmd join` arriving on this tick has already put the session in kJoining;
	// the policy is still in kStandby (the console is connected, so the hotspot
	// hold parked it there) until applyCredentials runs. Sample the link first
	// and noteLink sees "joining, but the policy is not associating", concludes
	// the attempt is over before the radio was asked, and the console is told
	// 找不到网络 on the very tick the user pressed submit — followed seconds
	// later by the truth. The right diagnosis second is still the wrong
	// diagnosis first.
	//
	// The PSK exists in this scope and nowhere else: it goes straight into the
	// policy, which hands it to the supplicant and — only once an address has
	// proven it — to persistCredentials, whose backup-first discipline is what
	// makes writing /data survivable.
	{
		std::string ssid;
		std::string psk;
		const tcos::BleProvisionSession::Request request = sBleSession.takeRequest(&ssid, &psk);
		if (request == tcos::BleProvisionSession::kRequestScan) {
			sWifi.startScan();
			sBleScanPending = true;
			sBleScanStartedMs = nowMs;
			sBleScanIssuedMs = nowMs;
		} else if (request == tcos::BleProvisionSession::kRequestJoin) {
			tcos::ProvisionLog::device().log("BLE_JOIN", "src=ble psk=redacted");
			sWifiPolicy.applyCredentials(ssid, psk, nowMs);
		}
		for (size_t i = 0; i < psk.size(); ++i) psk[i] = '\0';
	}

	tcos::BleProvisionSession::Link link;
	link.online = sWifiPolicy.isOnline();
	const tcos::WifiPolicy::State policyState = sWifiPolicy.state();
	link.joining = policyState == tcos::WifiPolicy::kConnecting ||
	               policyState == tcos::WifiPolicy::kObtainingIp ||
	               policyState == tcos::WifiPolicy::kStartingWpa;
	link.locked = !tcos::install::linkChangesAllowed();
	link.ssid = sNetSsid;
	link.ip = sNetIp;
	link.wpaState = sWifi.lastWpaState();
	sBleSession.noteLink(link, nowMs);

	// A join that carried the console's new address hands it over exactly once,
	// after it has proven itself by coming online.
	{
		const std::string adopted = sBleSession.takeConsoleHost();
		if (!adopted.empty()) adoptConsoleHost(adopted);
	}

	// The scan pump. Same pair WifiPolicy uses — startScan() then scanNetworks()
	// — because there is one sweep and one contract about what an empty result
	// means (see DeviceWifi::scanSweepComplete); a second scan path here would be
	// a second place to get that wrong.
	if (sBleScanPending) {
		std::vector<tcos::WpaCtrl::Network> nets;
		if (sWifi.scanNetworks(&nets)) {
			std::vector<tcos::BleProvisionSession::Network> found;
			for (size_t i = 0; i < nets.size(); ++i) {
				tcos::BleProvisionSession::Network net;
				net.ssid = nets[i].ssid;
				net.rssi = nets[i].signalDbm;
				net.secured = nets[i].secured;
				found.push_back(net);
			}
			sBleSession.deliverScan(found, false, nowMs);
			sBleScanPending = false;
		} else if (nowMs - sBleScanStartedMs >= tcos::WifiPolicy::kScanTimeoutMs) {
			sBleSession.noteScanFailed(nowMs);
			sBleScanPending = false;
		} else if (nowMs - sBleScanIssuedMs >= tcos::WifiPolicy::kScanRetryMs) {
			// The first SCAN of a freshly started supplicant is routinely
			// answered FAIL-BUSY and swallowed whole; nothing else would ask
			// again.
			sBleScanIssuedMs = nowMs;
			sWifi.startScan();
		}
	}

	std::string outbound;
	while (sBleSession.takeOutbound(&outbound)) sBle.send(outbound);

	// --- the panel -----------------------------------------------------------
	tcos::ProvisionScreen::Inputs inputs;
	const tcos::BleService::Stage bleStage = sBle.stage();
	inputs.bleAdvertising = sBle.advertising();
	inputs.bleBlocked = bleStage == tcos::BleService::kBlocked;
	inputs.guardLocked = link.locked;
	inputs.centralConnected = sBle.connected();
	inputs.authorised = sBleSession.authorised();
	inputs.scanning = sBleSession.scanning();
	inputs.joining = sBleSession.joining();
	inputs.online = link.online;
	inputs.failed = sBleSession.failed();
	// The forced window IS the request: 配网 opens it, and it is the only thing
	// that puts the advertisement on the air while the clock is online. Reading
	// it here rather than latching a separate flag keeps the screen and the
	// radio saying the same thing — when the window closes, BLE goes down and
	// the pairing pages stop claiming a code that is no longer being broadcast.
	inputs.requested = sBleForcedUntilMs > nowMs;

	tcos::ProvisionScreen::State panel;
	panel.stage = tcos::ProvisionScreen::stageFor(inputs);
	panel.failure = tcos::ProvisionScreen::failureFor(sBleSession.lastError());
	panel.name = sBleName;
	panel.code = sBleSession.code();
	panel.ssid = sBleSession.targetSsid().empty() ? sNetSsid : sBleSession.targetSsid();
	panel.ip = sNetIp;
	if (panel.stage == tcos::ProvisionScreen::kRadioDown && sPortalService.running() &&
	    !sNetIp.empty()) {
		char portal[64];
		snprintf(portal, sizeof(portal), "%s:%d", sNetIp.c_str(), sPortalService.port());
		panel.portal = portal;
	}
	sProvision.setState(panel, nowMs);
}

/**
 * Open 蓝牙配网 deliberately: put the advertisement back on the air and show it.
 *
 * TWO CALLERS, ONE BODY. 设置 → 配网 is a person standing in front of the clock;
 * POST /api/os/ble is the same person sitting at the console, which is the only
 * way to reach a clock that is online — an online clock advertises nothing, so
 * the browser's chooser is empty exactly when someone wants to move it to a new
 * router. They must do the identical thing, and while this was six statements
 * written out at the settings row the only thing keeping a second entry point
 * equal to it would have been somebody remembering to copy all six. Missing the
 * `setWanted(true)` alone yields a screen that shows a pairing code for an
 * advertisement that is not up until bleWanted() is next evaluated.
 *
 * The window is re-opened even when the screen is already up — that is what a
 * second ask means, since the forced window is exactly what the panel reads to
 * decide it is 配网中 (ProvisionScreen::Inputs::requested) — but the PUSH is
 * guarded, because Shell::push does not deduplicate: stacking the provisioning
 * screen on itself would cost the user one hold per ask to get back out. The
 * settings row can never hit that guard (it presses from 设置), so the row
 * behaves exactly as it did; only the console can ask from this screen.
 */
void openProvisioning(int nowMs) {
	// A deliberate ask, so the advertisement goes back up even on a clock that
	// is perfectly online, and a stack that had given up re-arms.
	sBleForcedUntilMs = nowMs + kBleForcedMs;
	sBle.setWanted(true);
	sProvisionDismissed = false;
	if (shell().top() != &sProvision) shell().push(&sProvision, nowMs);
	sProvisionPushed = true;
	// Never auto: whoever asked for this screen asked for it, so the 3 s
	// success pop that an offline episode gets does not apply.
	sProvisionAuto = false;
	sProvisionOnlineMs = -1;
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

	// 夜间息屏 / 息屏等待, right after 亮度: they are the other two rows that change
	// what the panel EMITS, and near the front of a 17-row ring so a user who
	// went looking for them finds them without a lap.
	//
	// 息屏 rather than 休眠, which in Chinese reads as hibernate — a machine
	// powered down — and is the last thing to promise on a device whose only
	// recovery is a power cycle. The label appears ALONE for 1100 ms with no
	// value beside it to disambiguate it, so it has to be right cold; 休眠等待
	// read as a status ("waiting to sleep") rather than as a duration.
	//
	// Both are cycle rows — press to advance — which is the only interaction this
	// screen has. Two rows rather than three: a separate on/off switch would
	// answer a question 夜间息屏 already answers, at the cost of one more stop on
	// a ring you walk one item at a time with a knob.
	row.label = "\xE5\xA4\x9C\xE9\x97\xB4\xE6\x81\xAF\xE5\xB1\x8F";          // 夜间息屏
	row.value = tcos::formatSleepWindow(sSleepConfig, sleepClockUsable(nowMs));
	row.id = ACTION_SLEEP_WINDOW;
	rows.push_back(row);

	row.label = "\xE6\x81\xAF\xE5\xB1\x8F\xE7\xAD\x89\xE5\xBE\x85";          // 息屏等待
	row.value = tcos::formatSleepIdle(sSleepConfig);
	row.id = ACTION_SLEEP_IDLE;
	rows.push_back(row);
	row.id = ACTION_NONE;

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

	// 热点 / 密码, and only while the hotspot is the way in.
	//
	// These are the two strings a user has to type into a phone, and until now
	// the device never showed either of them: the SSID is derived from the MAC,
	// so it is not on the box, not in the manual, and not anywhere else. The
	// panel asked the user to join a network it would not name. Both fit the
	// 52 px row without a marquee by construction — see apSsidFromMac.
	//
	// Gated on hotspotActive() rather than isProvisioning(), which now also
	// covers kStandby — the state a device sits in while a console drives it
	// over BLE, where there is no hotspot and printing its SSID and passphrase
	// would be an invitation to join a network that is not on the air.
	if (sWifiPolicy.hotspotActive()) {
		row.label = "\xE7\x83\xAD\xE7\x82\xB9";                              // 热点
		row.value = tcos::DeviceWifi::apSsidFromMac(mac);
		rows.push_back(row);

		row.label = "\xE5\xAF\x86\xE7\xA0\x81";                              // 密码
		row.value = tcos::DeviceWifi::softApPassphrase();
		rows.push_back(row);
	}

	// 蓝牙 — and it is the row that opens the provisioning screen, because that
	// screen is the only place the six-digit code exists. Actionable in every
	// state including 未启动: a user who wants to reconfigure a working clock has
	// no other way to ask, and a stack that gave up after kMaxAttempts re-arms on
	// exactly this press.
	row.label = "\xE8\x93\x9D\xE7\x89\x99";                                  // 蓝牙
	{
		const tcos::BleService::Stage stage = sBle.stage();
		if (!tcos::install::linkChangesAllowed()) {
			row.value = "\xE6\x9C\xAA\xE8\xA7\xA3\xE9\x94\x81";            // 未解锁
		} else if (stage == tcos::BleService::kConnected) {
			row.value = "\xE5\xB7\xB2\xE8\xBF\x9E\xE6\x8E\xA5";            // 已连接
		} else if (stage == tcos::BleService::kAdvertising) {
			row.value = "\xE5\xB9\xBF\xE6\x92\xAD\xE4\xB8\xAD";            // 广播中
		} else if (stage == tcos::BleService::kRadioDown) {
			row.value = "\xE6\x9C\xAA\xE5\x90\xAF\xE5\x8A\xA8";            // 未启动
		} else {
			row.value = "--";
		}
	}
	row.id = ACTION_PROVISION;
	rows.push_back(row);
	row.id = ACTION_NONE;

	// 配网, and the label carries the bad news.
	//
	// When the hotspot has no DHCP this row was the most misleading pixel in the
	// whole failure: a perfectly plausible `192.168.100.1:80` that no phone could
	// ever reach, because the phone was never handed an address in that subnet.
	// The address itself still has to be shown — the user needs it to configure
	// one by hand, which is the only way in — so it is the LABEL that changes.
	// 手动配网 is four CJK cells, 48 px, the widest a label can be here.
	const bool apNeedsManualAddress = sWifi.softApDhcpFailed();
	row.label = apNeedsManualAddress
	                ? "\xE6\x89\x8B\xE5\x8A\xA8\xE9\x85\x8D\xE7\xBD\x91"     // 手动配网
	                : "\xE9\x85\x8D\xE7\xBD\x91";                            // 配网
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

	// 电量 sits above MCU because it is the row a user actually looks for, and
	// because a pending shutdown has to be visible somewhere.
	// 时间: the row that proves this device is a clock again. Read off the wall
	// clock rather than the sync instant, because what a user checks here is
	// whether the time is right now. UTC+8 by hand: settimeofday sets UTC and
	// this rootfs carries no tzdata, so localtime() would silently return UTC
	// and look correct in the +0 timezone alone.
	//
	// Through localMinuteOfDay, which 夜间休眠 also uses. This row used to add
	// 8*3600 inline, and a window that disagreed with the time shown two screens
	// away would be indistinguishable from a broken feature.
	row.label = "\xE6\x97\xB6\xE9\x97\xB4";                                  // 时间
	if (!timeSync().synced()) {
		row.value = "\xE6\x9C\xAA\xE5\x90\x8C\xE6\xAD\xA5";                // 未同步
	} else {
		char clock[32];
		const int minute = localMinuteNow();
		snprintf(clock, sizeof(clock), "%02d:%02d", minute / 60, minute % 60);
		row.value = clock;
	}
	rows.push_back(row);

	row.label = "\xE7\x94\xB5\xE9\x87\x8F";                                  // 电量
	{
		const int pct = tcos::BatteryMonitor::instance().percent();
		if (pct < 0) {
			row.value = "--";
		} else {
			char buf[48];
			const int left = tcos::BatteryMonitor::instance().shutdownInSeconds();
			if (left >= 0) {
				snprintf(buf, sizeof(buf), "%d%% %ds", pct, left);   // 关机倒计时
			} else if (tcos::BatteryMonitor::instance().charging()) {
				snprintf(buf, sizeof(buf), "%d%% +", pct);            // 充电中
			} else {
				snprintf(buf, sizeof(buf), "%d%%", pct);
			}
			row.value = buf;
		}
	}
	rows.push_back(row);

	row.label = "MCU";
	row.value = sMcuVersion.empty() ? "\xE6\x97\xA0\xE5\xBA\x94\xE7\xAD\x94" : sMcuVersion;  // 无应答
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

	// Knock on the updater's door, the way the stock app does.
	//
	// This is not the framework's job, which is the thing that cost a whole
	// evening to learn: /bin/zkgui links libzkupgrade and libeasyui owns
	// UpgradeMonitor, but NOTHING in either calls it unprompted. The stock
	// Ulanzi app imports UpgradeMonitor::getInstance and ::checkUpgradeFile and
	// calls them itself — those two symbols are in its .so and in no other. So
	// the vendor's documented "push update.img, set four properties, restart
	// zkswe" recipe flashes a stock device and did nothing at all on ours: once
	// ZOS replaced /res, the door was still there and nobody was knocking.
	//
	// Without this an installed ZOS cannot be updated by the supported path at
	// all — the only way in is a sideload, which a power cycle undoes. That
	// makes this call the difference between a firmware that can be upgraded
	// and one that can only be replaced.
	//
	// checkUpgradeFile() is cheap when there is nothing staged: it stats
	// <dir>update.img and returns immediately. The directory is the vendor's
	// own — /mnt/storage is the UDISK partition their stock image sits on, and
	// zkdaemon points at the same place on boot.
	// Deliberately NOT called here — see upgradeEntryPoint().
	//
	// What DOES belong on the startup path is the opposite: clearing away an
	// image a previous boot already installed. The vendor chain leaves it where
	// it found it, and a staged image is the only thing the updater needs to
	// flash again — so the leftover, not the knock, is what a reboot turns into
	// a loop. Guarded on having ever knocked, so an image staged by hand on a
	// device that has never taken an OTA is still there when it is asked for.
	if (hostLink().installedUpgradeSeq() > 0) {
		tcos::FirmwareUpdate::discardStaged(tcos::FirmwareUpdate::stagingDir());
		tcos::FirmwareUpdate::discardStaged(tcos::FirmwareUpdate::legacyStagingDir());
	}
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

	// A blocking version query, immediately. The arcade firmware deliberately
	// skips this ("the version is fetched by mcuThread") and gets away with it
	// because it has only ever run sideloaded, on top of a stock app that had
	// already talked to the MCU. apps/flythings/pixel-pet-display — the one app
	// in the official repo written to be deployed on its own — does exactly
	// this, and the ordering is the only thing that distinguishes its startup
	// from ours. Opening the UART is not the same as talking over it: the
	// round trip is what tells the MCU a host is present, and the panel stays
	// on the MCU's own boot screen until it believes that.
	// Kept and shown in 设置 rather than logged: it is the one piece of evidence
	// that the MCU is talking to us at all, and the night this was added proved
	// that is worth a row.
	McuManager::getInstance().queryMcuVersion(sMcuVersion);
	// After the handshake, because it queries the same MCU. Flashed, ZOS is the
	// only firmware left on a battery-powered device: the stock app's
	// awtrix::BatteryMonitor went with the /res it replaced, and nothing else
	// will ever notice a flat cell.
	tcos::BatteryMonitor::instance().start();
	// Before Sfx: initialize() sets the mixer level, and Sfx primes the audio
	// output as part of coming up. Reversed, the priming burst and every effect
	// until the first onUI_show ran at whatever level the previous firmware left.
	tcos::DeviceControls::instance().initialize();
	// Beside the volume and brightness restore for the same reason: these are the
	// settings a user chose once and expects to still be there after a power cut.
	// Prefs loads the file lazily, so the ordering here is only about running
	// before the first frame, not about who opens what.
	restoreLyricTheme();
	restoreVibePrefs();
	restoreSleepConfig();
	tcos::Sfx::instance().initialize();
	KeyManager::getInstance().start();
	// Started here rather than in onUI_show: onUI_show runs on every return to
	// this activity, and the link's threads must be created exactly once.
	hostLink().start(readHostAddress());
	// Started unconditionally, INCLUDING on a unit that has no address at all:
	// with no console adopted the link can never come up, so such a device is
	// "lost" from its sixtieth second and the first console that both shouts on
	// its /24 and answers as one becomes its console. That is the same fact the
	// four gates already encode, not an extra rule.
	consoleDiscovery().start(tcos::ConsoleDiscovery::kPort);
	// Nothing else in this firmware has ever called settimeofday. Sideloaded that
	// was invisible: the stock app NTP-synced at startup and the kernel keeps the
	// time across a framework restart, so ZOS inherited a correct clock it never
	// asked for. Flashed, ZOS is the only app that has ever run and this SoC has
	// no battery-backed RTC — the device was measured sitting at 1970 with this
	// line absent. Its own thread; resolution and the round trip both block.
	timeSync().start();
	// The provisioning breadcrumbs open with WHICH BUILD this is, and they open
	// BEFORE the portal starts serving so BOOT is genuinely the first line of a
	// session. /data survives the power cycle that is the only way to read
	// anything from a stranded device, and the stamp kills hypothesis zero —
	// "the fix was never actually flashed" — before any other line is trusted.
	// Compare-first, so an unchanged id costs a read of jffs2, not a write.
	tcos::ProvisionLog::writeFileIfChanged(tcos::ProvisionLog::buildIdPath(),
	                                       std::string(tcos::ProvisionLog::buildId()) + "\n");
	tcos::ProvisionLog::device().log("BOOT",
	                                 std::string("rev=") + tcos::ProvisionLog::buildId());
	if (sPortalService.start(kPortalPreferredPort, &sPortal) < 0) {
		sPortalService.start(kPortalFallbackPort, &sPortal);
	}
	sWifiPolicy.begin(0);
}

static void onUI_intent(const Intent *intentPtr) {
	if (intentPtr != NULL) {
	}
}

namespace tcos {

/**
 * Offer the vendor updater a chance to run — ON REQUEST, never at startup.
 *
 * Calling this from the app's init path froze the panel: UpgradeMonitor is a
 * Thread and the chain it drives tears services down, and doing that before the
 * first Screen exists leaves an app that heartbeats forever and never draws.
 * Measured, not reasoned about — the panel came back the moment the call left
 * the startup path.
 *
 * Worse, an unconditional check re-fires on every boot as long as an image is
 * staged: the updater does not remove the file it flashed, so the device would
 * reinstall the same image, restart, and do it again. That is a boot loop with
 * a frozen screen, which is exactly what it looked like from the outside.
 *
 * So the trigger is explicit: the console asks by publishing `upgrade\t<id>` in
 * the pull document — a deliberate act with a human behind it — and the id is
 * seconds-since-epoch, recorded on /data once this device has handed it over.
 * A request no newer than that record is not a request. Everything the vendor
 * chain does after that — ready, perform, end, reboot — is theirs, including
 * its failures, which is why it is on a timer: its exit path reboots only on
 * success and returns silently on every error.
 *
 * WHAT PUTS THE IMAGE THERE. HostLink, on its worker thread, before this is
 * ever called: it streams GET /api/os/firmware into
 * FirmwareUpdate::stagingDir() as update.img.part and renames it only once the
 * byte has arrived (net/FirmwareUpdate.h). So by the time this runs, the file
 * the updater is about to find is either whole or absent — a dropped connection
 * cannot leave a truncated container in the directory this function points at.
 */
void upgradeEntryPoint(int seq) {
	// Latches on a chain that ACTUALLY STARTED, not on having tried. The vendor
	// chain, once running, must never be interrupted by a second knock — but a
	// knock that never reached it (no record, no updater, no image) has taken
	// nothing over and there is no reason for it to cost the device its only
	// attempt this boot.
	static bool started = false;
	if (started) {
		return;
	}

	// Written BEFORE the knock, because there is no after: a successful install
	// reboots from inside the vendor chain. This is what stops the next boot
	// from reading the console's still-standing request as a new one and
	// installing the same image again, forever.
	//
	// AND IT IS A PRECONDITION, not a courtesy. Knocking without the record is
	// the boot loop with extra steps: the install succeeds, the device reboots,
	// nothing remembers, the request is still standing. If /data will not take
	// it, this attempt is over.
	if (!hostLink().noteUpgradeInstalled(seq)) {
		hostLink().noteInstallFailed(HostLink::kInstallNoRecord);
		return;
	}

	UpgradeMonitor* monitor = UpgradeMonitor::getInstance();
	if (monitor == NULL) {
		hostLink().noteInstallFailed(HostLink::kInstallNoMonitor);
		return;
	}
	// Where we stage, and the directory we used to stage in so a hand-pushed
	// image still installs. /tmp is first because it is where FirmwareUpdate
	// writes: tmpfs cannot develop the bad region this unit's UDISK did, and it
	// is cleared by the reboot the install ends in — see net/FirmwareUpdate.h.
	//
	// `/mnt/storage/` ITSELF IS NOT IN THIS LIST, and must never be. That is
	// where the FACTORY STOCK update.img lives — every unit has one, the mtd3
	// write does not touch it, and this repo pulls it as the round-trip
	// reference for its own packer. A loop that falls through to it turns "the
	// image I asked for was refused" into "ZOS was replaced by the firmware it
	// replaced", with the request recorded as installed on the way out. The
	// user pressed 升级 and lost the system. A refused image must be a visible
	// failure, never a substitution.
	static const char* kDirs[2] = {FirmwareUpdate::stagingDir(),
	                               FirmwareUpdate::legacyStagingDir()};
	for (int i = 0; i < 2; ++i) {
		// zk_upgrade_check() reads `sys.zkupgrade.flag` ONLY when
		// `sys.zkupgrade.dir` is non-empty; with the directory unset it takes
		// the caller's path and leaves the flag at 0, and a flag of 0 selects
		// nothing. Nothing selected means startUpgrade() has no work, which on
		// the panel is the word 安装中 and an image that never installs — the
		// exact symptom, measured twice.
		//
		// The flag is a BITMASK OVER PARTITION TYPE, not a boolean: bit 3 is
		// `res`, the only partition we ever ship. 255 would also work and is
		// what the vendor's own zkdaemon writes, but it means "install every
		// partition this container carries", which is not a thing to say
		// casually to a flash writer.
		//
		// Both are consumed — check() clears them as it reads — so they are set
		// immediately before each attempt rather than once up front.
		SystemProperties::setString("sys.zkupgrade.dir", kDirs[i]);
		SystemProperties::setInt("sys.zkupgrade.flag", 1 << 3);
		if (!monitor->checkUpgradeFile(kDirs[i])) {
			continue;
		}
		LOGD("zos: upgrade staged in %s\n", kDirs[i]);
		// checkUpgradeFile() only VALIDATES and SELECTS. What runs the install
		// is startUpgrade(), and on stock the caller is UpgradeActivity —
		// which cannot exist here: its layout `zkupgrade.ftu` is in no /res on
		// this unit, Ulanzi's included. So checkUpgradeFile alone leaves an
		// image selected and nothing happening, which on the panel is the word
		// 安装中 forever. Measured, not reasoned about: a probe that called
		// only checkUpgradeFile never wrote mtd3; adding this line wrote it.
		//
		// Everything past here is the vendor's — ready, perform, end — with
		// its own magic/CRC/model-id/flash-type gates and a post-write MD5
		// re-read. It reboots the device itself when it succeeds.
		if (monitor->startUpgrade()) {
			LOGD("zos: upgrade started\n");
			started = true;
		} else {
			// Nothing selected, or one is already running. Either way nothing
			// further happens on this device until it is asked again, so the
			// panel has to stop claiming otherwise.
			LOGD("zos: startUpgrade declined\n");
			hostLink().noteInstallFailed(HostLink::kInstallDeclined);
		}
		return;
	}

	// Every candidate directory refused the image. On the panel this used to be
	// the word 安装中 for as long as the device stayed up, which is the single
	// most misleading thing this firmware could display: nobody power-cycles a
	// device that says it is working.
	hostLink().noteInstallFailed(HostLink::kInstallNoImage);
}

}  // namespace tcos

static void onUI_show() {
	{
		std::lock_guard<std::mutex> lock(sKeyMutex);
		sKeyQueue.clear();
	}
	KeyManager::getInstance().addKeyEventCallback(keyEventCb);

	// The root ring is fixed: these five are what the device does, and they do
	// not come from the host. The workspace's channels are content, not
	// destinations — they live one level down, under 轮播, the same way the
	// seven games live under 游戏. Ten channels on this ring would push the
	// other four off the end of a ring that shows one item at a time.
	//
	// 「VIBE」 sits between 轮播 and 设置 so the first three keep the position
	// three firmware releases of muscle memory put them in, and 设置 stays last.
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
	entry.label = "VIBE";
	entry.icon = tcos::LauncherScreen::kIconVibe;
	entry.id = ID_VIBE;
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
	// 「VIBE」 reuses the equaliser rather than earning a sixth motif: the card
	// the user just pressed is three bars rising inside their ceiling, so bars
	// rising into the room is the same gesture continued rather than a borrowed
	// one. Seven of kMaxEntryStyles' eight slots are now spoken for; an eighth
	// destination must raise that constant, because overflow degrades silently.
	shell().setEntryStyle(&sVibe, tcos::Shell::kEntryEqualiser);
	shell().setEntryStyle(&sSettings, tcos::Shell::kEntryDrop);
	shell().setEntryStyle(&sProvision, tcos::Shell::kEntryDrop);
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
		// 夜间休眠's countdown is reset HERE, at the drain, before any routing —
		// not per screen. "Which gestures count as operating" must not be a
		// question a screen can answer differently, and this is also what makes
		// the wake swallow correct inside a game, where the side buttons are raw
		// edges rather than volume. Every event KeyManager delivers counts:
		// rotation, the knob press, the middle button, both side buttons short
		// and long, and the raw edges a game sees.
		sLastActivityMs = nowMs;
		if (swallowForWake(events[i].code, events[i].status)) continue;
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
		// ...and the verdict comes back the same way. The page has no other
		// source: the address it can see during provisioning is the hotspot's
		// own, so without this it reported success for every submission,
		// including a wrong password.
		{
			const bool provisioning = sWifiPolicy.isProvisioning();
			sProvisioning.noteLinkOutcome(sWifiPolicy.isOnline(), provisioning);
			// The network list the page offers is captured on the way INTO
			// provisioning, because raising the hotspot stops the supplicant and
			// the radio cannot be asked again for as long as the page is up.
			//
			// hotspotActive(), not provisioning: kStandby is also "waiting for a
			// human" but keeps the supplicant, so there the page can ask the
			// radio itself and a frozen sweep would be worse than no sweep.
			const bool hotspot = sWifiPolicy.hotspotActive();
			if (hotspot && !sWasProvisioning) {
				sProvisioning.setScannedNetworks(sWifiPolicy.scanned());
				// The first two lines a coordinator reads after a failed session:
				// what the sweep produced, and why the hotspot went up at all. A
				// non-empty sweep already logged its own SCAN_DONE with a duration;
				// the timeout case has nobody else to say so.
				const int scanned = (int)sWifiPolicy.scanned().size();
				if (scanned == 0) {
					tcos::ProvisionLog::device().log("SCAN_DONE", "n=0 exit=timeout");
				}
				char apFields[64];
				snprintf(apFields, sizeof(apFields), "reason=%s scanned=%d",
				         sWifiPolicy.provisionReason(), scanned);
				tcos::ProvisionLog::device().log("AP_ENTER", apFields);
			}
			sWasProvisioning = hotspot;
		}

		// BLE provisioning, on the same cadence and for the same reason: every
		// predicate it reads costs a socket or an ioctl, and nothing it decides
		// changes faster than a person can type.
		pumpBle(nowMs);

		sLink = hostLink().snapshot();

		// --- the console beacon ----------------------------------------------
		// Three assignments handed to the listener thread, and one mailbox read.
		// Everything that DECIDES lives in net/ConsoleDiscovery, where the host
		// check can drive it; this file is #included by activity/*.cpp and is
		// compiled by no check, so a gate written here would be a gate nothing
		// ever asserts.
		//
		// sNetIp is wlan0's address, refreshed by refreshNetInfo() inside
		// pumpBle() a few lines up. baseUrl() is the address the pull loop is
		// really using — the same field the BLE takeover rule compares against,
		// and true by construction rather than a copy taken at boot.
		{
			tcos::ConsoleDiscovery::Link discovery;
			discovery.deviceIp = sNetIp;
			discovery.baseUrl = hostLink().baseUrl();
			discovery.lastPullMs = sLink.lastPullMonoMs;
			discovery.nowMs = monoMs();
			consoleDiscovery().noteLink(discovery);

			// The adoption itself goes through adoptConsoleHost — the same six
			// statements the BLE join path uses. A second copy of the
			// /data/zos-host.tmp -> rename write is a second place to get a
			// power-cut-during-write wrong, on the one file that decides whether
			// this device can ever be reached again.
			std::string discovered;
			if (consoleDiscovery().takeAdoption(&discovered)) {
				adoptConsoleHost(discovered);
			}
		}

		// The first document only establishes where the sequences already are.
		// Acting on it would replay whatever the console did before this boot.
		if (!sConsoleSeqPrimed && sLink.online) {
			sConsoleSeqPrimed = true;
			sAppliedSettingsSeq = sLink.settings.seq;
			// 夜间休眠 is primed with them. Without this a reboot would replay the
			// console's last write over a window the knob had since changed —
			// the same trade already accepted for volume, and here it would also
			// mean a boot could re-enable sleeping that the user turned off.
			sAppliedSleepSeq = sLink.sleep.seq;
			for (size_t i = 0; i < sLink.inputs.size(); ++i) {
				if (sLink.inputs[i].seq > sAppliedInputSeq) sAppliedInputSeq = sLink.inputs[i].seq;
			}
		}

		// The console's 主题设置. Applied outside the music screen's own branch
		// because it must survive not being on that screen: the user picks a
		// colour while the panel shows the launcher, and it has to be right the
		// moment they walk into 音乐 rather than one tick later.
		//
		// Gated on `online`, and ONLY on that. An offline snapshot is a
		// default-constructed one, so applying it would repaint a device that
		// cannot reach the service back to 信号绿 and overwrite the /data value
		// that exists precisely for that case. This is not a staleness sweeper —
		// once adopted, a theme never expires. There is nothing for it to go
		// stale against.
		if (sLink.online) {
			applyLyricTheme(sLink.lyricMode, sLink.lyricSkin, sLink.accentRgb, sLink.hasAccent);
		}

		// Settings the console asked for. The whole rule — apply only on a rising
		// sequence, and raise the bar for the level that actually moved — is
		// applyConsoleSettings, so it is compiled and asserted by the host
		// self-check. It used to be written out here, where nothing could run it,
		// which is how a volume-only change came to draw the BRIGHTNESS bar: the
		// document carries both values forever, so a `requestedBrightness >= 0`
		// test was true from the first brightness the console ever set.
		// ACTIVITY, but only on the rising edge — the same distinction that
		// decides whether it is applied at all. The document repeats the last
		// request forever; counting its mere presence would hold the panel awake
		// for the whole life of the service.
		if (tcos::applyConsoleSettings(sLink.settings, sAppliedSettingsSeq, levels(),
		                               shell().overlay(), nowMs)) {
			sLastActivityMs = nowMs;
		}

		// 夜间休眠 from the console. Also activity on a rising sequence, and
		// deliberately so: a console PUT of {enabled:false} must not merely stop
		// the panel sleeping AGAIN, it must light it now. That is the remote
		// escape hatch for a user whose clock went dark and who is not in the
		// room with it.
		if (tcos::applySleepRequest(sLink.sleep, sAppliedSleepSeq, &sSleepConfig)) {
			sLastActivityMs = nowMs;
			persistSleepConfig();
			// The rows are rebuilt on a 500 ms cadence anyway, but only while the
			// screen is on top; this keeps the value honest if the console writes
			// while the user is standing on the row.
			if (shell().top() == &sSettings) rebuildSettings(nowMs);
		}

		// Button and knob presses the console made on the user's behalf. Injected
		// through the same path a real key takes, so a remote press cannot behave
		// differently from a physical one — which is the whole point of driving the
		// device by its knob rather than by a remote API per screen.
		for (size_t i = 0; i < sLink.inputs.size(); ++i) {
			const tcos::StateDoc::Input& event = sLink.inputs[i];
			if (event.seq <= sAppliedInputSeq) continue;
			sAppliedInputSeq = event.seq;
			// A remote press is operating the clock, so it resets the countdown
			// exactly as a physical one does — which also makes the console's
			// existing direction buttons the wake control, with nothing new to add.
			//
			// ...INCLUDING the swallow. A remote press must not behave differently
			// from a physical one; that is the whole reason console input is
			// injected through this path instead of a per-screen remote API, and
			// the console's own notice already says a press wakes the panel.
			sLastActivityMs = nowMs;
			if (takeWake(-1)) continue;
			if (event.action == "cw") {
				tcos::Sfx::instance().play(tcos::Sfx::kTick);
				dispatchInput(tcos::kInputTurnCw, nowMs);
			} else if (event.action == "ccw") {
				tcos::Sfx::instance().play(tcos::Sfx::kTick);
				dispatchInput(tcos::kInputTurnCcw, nowMs);
			} else if (event.action == "press") {
				tcos::Sfx::instance().play(tcos::Sfx::kConfirm);
				dispatchInput(tcos::kInputPress, nowMs);
			} else if (event.action == "hold") {
				tcos::Sfx::instance().play(tcos::Sfx::kBack);
				dispatchInput(tcos::kInputHold, nowMs);
			} else if (event.action == "left") {
				tcos::applyShortPress(levels(), shell().overlay(), -1, nowMs);
			} else if (event.action == "right") {
				tcos::applyShortPress(levels(), shell().overlay(), +1, nowMs);
			}
		}
		const std::string signature = tcos::menuSignature(sLink.items);
		if (!sLink.items.empty() && signature != sMenuSignature) {
			sMenuSignature = signature;
			updateChannelRing(sLink.items, nowMs);
		}

		// The console pinning a channel is a remote navigation, so it is handled
		// exactly like a press: only on the edge, so the user can still walk away
		// from a pinned channel without it yanking them back every tick.
		if (sLink.pinned && !sLink.focus.empty() && sLink.focus != sPinnedFocus) {
			sPinnedFocus = sLink.focus;
			// Remote navigation, so activity — on the EDGE, like everything else
			// here. The document carries `focus` forever, so keying on the field
			// rather than on its change would mean a console that once pinned a
			// channel keeps the panel awake for good.
			sLastActivityMs = nowMs;
			// The console can name any menu entry, not just a channel. Routing
			// only channels meant pinning 音乐 or 游戏 succeeded in the console,
			// looked plausible, and moved nothing on the device — the same silent
			// no-op the display endpoint was hardened against on the host side.
			// The ids are the ones service.ts publishes in publishOsMenu.
			if (sLink.focus == "music") {
				if (shell().top() != &sMusic) shell().push(&sMusic, nowMs);
			} else if (sLink.focus.compare(0, 5, "game:") == 0) {
				// `game:tetris` — the console naming one engine rather than the ring.
				// The ids are the engines' own id() strings, which is also what the
				// arcade heartbeat reports, so there is one spelling of "which game"
				// in the whole system rather than a console-side table to drift.
				const std::string wanted = sLink.focus.substr(5);
				int index = -1;
				for (int i = 0; i < 7; ++i) {
					if (wanted == sEngines[i]->id()) index = i;
				}
				if (index >= 0) {
					if (shell().top() != &sGameList && shell().top() != &sGameScreen) {
						shell().push(&sGameList, nowMs);
					}
					sGameList.selectById(ID_GAME_BASE + index, nowMs);
					sGameScreen.setEngine(sEngines[index]);
					if (shell().top() != &sGameScreen) shell().push(&sGameScreen, nowMs);
					sSfxGame = tcos::Sfx::gameFromId(sEngines[index]->id());
					tcos::Sfx::instance().playGame(sSfxGame, tcos::Sfx::kGameStart);
				}
			} else if (sLink.focus == "game") {
				if (shell().top() != &sGameList) shell().push(&sGameList, nowMs);
			} else if (sLink.focus == "vibe") {
				// The console's 「在时钟上打开」 button. The id is the one
				// publishOsMenu emits for the 「VIBE」 entry.
				sVibeFedSeq = -1;
				if (shell().top() != &sVibe) shell().push(&sVibe, nowMs);
			} else if (sLink.focus == "settings") {
				rebuildSettings(nowMs);
				if (shell().top() != &sSettings) shell().push(&sSettings, nowMs);
			} else if (sChannelRing.selectApp(sLink.focus, nowMs) &&
			           shell().top() != &sChannelRing) {
				shell().push(&sChannelRing, nowMs);
			}
		} else if (!sLink.pinned) {
			sPinnedFocus.clear();
		}
	}

	// --- the provisioning screen -------------------------------------------
	//
	// PUSHED, not made the root. The design calls provisioning 开机前置 and it is
	// what the user sees, but a device whose BT stack failed and whose network is
	// gone would then be a panel with nothing behind it: a hold pops back to the
	// launcher, so the clock is still a clock. Pushed once per offline episode —
	// walking away has to mean something, or the screen is a trap.
	{
		const bool offline = !sWifiPolicy.isOnline();
		const bool haveStack = sBleStarted && sBle.stage() != tcos::BleService::kStopped;
		if (!offline) sProvisionDismissed = false;
		if (sHandedOff && offline && haveStack && !sProvisionDismissed && !sProvisionPushed &&
		    shell().top() == &sLauncher) {
			shell().push(&sProvision, nowMs);
			sProvisionPushed = true;
			sProvisionAuto = true;
			sProvisionOnlineMs = -1;
		}
		if (sProvisionPushed && shell().top() != &sProvision) {
			// The user left. Remember that.
			sProvisionPushed = false;
			sProvisionDismissed = true;
		}
		// The success beat, then out of the way. A user who just watched their
		// clock join a network does not want to be left staring at the screen
		// that asked them to.
		if (sProvisionPushed && sProvisionAuto && !offline) {
			if (sProvisionOnlineMs < 0) sProvisionOnlineMs = nowMs;
			if (nowMs - sProvisionOnlineMs >= 3000) {
				shell().pop(nowMs);
				sProvisionPushed = false;
				sProvisionOnlineMs = -1;
			}
		} else if (offline) {
			sProvisionOnlineMs = -1;
		}
	}

	// 蓝牙配网 the console explicitly asked for.
	//
	// The other half of 设置 → 配网, and the one that makes the console's wizard
	// work at all on a healthy clock: this device advertises only while offline
	// or inside the forced window, so a browser scanning for an online clock
	// finds nothing. The console cannot open a radio from across the LAN, so it
	// asks and this runs the same six statements the settings row runs.
	//
	// TAKEN, not read: the request stands in every document the console serves
	// from the moment it is made, so a tick that read the value would re-open the
	// window and re-arm the screen 6 times a second for as long as the console
	// remembered it. HostLink hands it over exactly once per rising sequence.
	{
		const int bleOpenSeq = hostLink().takeBleOpenRequest();
		if (bleOpenSeq != 0) openProvisioning(nowMs);
	}

	// An install the console explicitly asked for.
	//
	// The DOWNLOAD is the link's job and runs on its worker thread: the device
	// fetches /api/os/firmware and stages it at FirmwareUpdate::stagingDir(),
	// which is what the vendor updater looks at first. Nothing here waits on it —
	// a 1 MB transfer inside the 20 ms tick would freeze the panel for exactly as
	// long as the user is most likely to be watching it.
	//
	// What is left on this thread is the two things that must be on it: what the
	// panel says, and starting the vendor chain, which is a Thread that tears
	// every service down and has only ever been called from here.
	{
		const tcos::HostLink::UpgradeState upgrade = hostLink().upgradeState();

		tcos::UpgradeOverlay::Stage panel = tcos::UpgradeOverlay::kHidden;
		int percent = 0;
		switch (upgrade.stage) {
		case tcos::HostLink::UpgradeState::kPending:
			panel = tcos::UpgradeOverlay::kDownloading;
			break;
		case tcos::HostLink::UpgradeState::kDownloading:
			panel = tcos::UpgradeOverlay::kDownloading;
			// `long` is 32 bits on this ARM, and the numerator peaks at
			// kMaxImageBytes * 100 = 838,860,800 — inside it with room, because
			// FirmwareUpdate refuses anything larger than the partition before a
			// byte is written.
			if (upgrade.total > 0) {
				percent = (int)((upgrade.received * 100) / upgrade.total);
			}
			break;
		case tcos::HostLink::UpgradeState::kInstalling:
			panel = tcos::UpgradeOverlay::kInstalling;
			percent = 100;
			break;
		case tcos::HostLink::UpgradeState::kFailed:
			panel = tcos::UpgradeOverlay::kFailed;
			break;
		case tcos::HostLink::UpgradeState::kIdle:
		default:
			break;
		}
		shell().upgrade().set(panel, percent, nowMs);

		// A breadcrumb per stage change, on /data, because this is the one path
		// whose outcome the device cannot report afterwards: a success reboots
		// into different firmware and a failure happens with nobody watching.
		// logcat wedges adbd on this unit, so this file is the whole record.
		if ((int)upgrade.stage != sUpgradeLoggedStage) {
			sUpgradeLoggedStage = (int)upgrade.stage;
			char fields[96];
			snprintf(fields, sizeof(fields), "seq=%d stage=%d bytes=%ld/%ld verdict=%d",
			         upgrade.seq, (int)upgrade.stage, upgrade.received, upgrade.total,
			         upgrade.verdict);
			tcos::ProvisionLog::device().log("UPGRADE", fields);
		}

		// An install keeps the panel awake for as long as it runs, and this is
		// the one place activity is a STATE rather than an edge. A human pressed
		// a button in the console, so it counts at all — the rule the settings
		// and input blocks above follow — and it counts throughout, because
		// 夜间息屏 skips render entirely: a panel that went dark mid-install
		// would make the one operation the user most needs to watch the one they
		// cannot. A failure is excluded on purpose; the clock goes back to being
		// a clock, and to sleeping.
		if (upgrade.stage != tcos::HostLink::UpgradeState::kIdle &&
		    upgrade.stage != tcos::HostLink::UpgradeState::kFailed) {
			sLastActivityMs = nowMs;
		}

		// ONLY after a complete image has been staged. A failed or refused
		// download never reaches this line, so the updater is never offered a
		// truncated container — and it is still honoured once per boot, by
		// upgradeEntryPoint's own guard: the vendor chain does not delete what it
		// flashed, so a second pass would reinstall the same image forever.
		if (hostLink().takeUpgradeInstallReady()) {
			sUpgradeInstallAtMs = nowMs + kUpgradeHandoffMs;
		}
		if (sUpgradeInstallAtMs >= 0 && nowMs >= sUpgradeInstallAtMs) {
			sUpgradeInstallAtMs = -1;
			tcos::ProvisionLog::device().log("UPGRADE", "stage=handoff");
			sUpgradeHandoffAtMs = nowMs;
			tcos::upgradeEntryPoint(upgrade.seq);
		}
		// The vendor chain's own failures are ASYNCHRONOUS and silent: it runs on
		// its own thread, and its exit path reboots only on success. Without this
		// the panel keeps saying 安装中 until someone pulls the plug — which is
		// the worst thing this screen can do, because it is indistinguishable
		// from an install that is still working and nobody interrupts one of
		// those. Cleared as soon as the state leaves kInstalling, so a chain that
		// reported a failure through its own path is not double-reported.
		if (upgrade.stage != tcos::HostLink::UpgradeState::kInstalling) {
			sUpgradeHandoffAtMs = -1;
		} else if (sUpgradeHandoffAtMs >= 0 &&
		           nowMs - sUpgradeHandoffAtMs > kUpgradeChainTimeoutMs) {
			sUpgradeHandoffAtMs = -1;
			hostLink().noteInstallFailed(tcos::HostLink::kInstallTimedOut);
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
	} else if (rootPick == ID_VIBE) {
		// Re-armed on entry rather than only on a bump: the numbers may not have
		// moved since the last visit, but the link state might have, and walking
		// into a page still showing 离线 because nothing bumped is the whole
		// class of bug the gate could introduce.
		sVibeFedSeq = -1;
		shell().push(&sVibe, nowMs);
	}

	// --- feed whichever screen is on top -----------------------------------
	{
		tcos::FrameBundle fresh;
		std::string freshApp;
		std::string freshRev;
		if (hostLink().takeChannelFrames(&fresh, &freshApp, &freshRev)) {
			// The ring drops frames that do not belong to the settled channel, so
			// a slow download landing after the knob moved on cannot paint over
			// the channel the user is actually looking at.
			sChannelRing.adoptFrames(fresh, freshApp, freshRev, nowMs);
		}
	}
	if (shell().top() == &sChannelRing) {
		// Two different questions, and both have to be asked every tick because
		// each is answered by a flag the ring raises on its own schedule: has the
		// SELECTION moved (a detent, a pin, a channel whose content the console
		// just changed), and do the frames we are holding need fetching again
		// although it has not (a ttl that expired, or walking back in here).
		//
		// Guarded on there being a channel at all rather than consuming the flags
		// and dropping them: the document can arrive after the user is already
		// standing in an empty ring, and a request swallowed then is a page that
		// never loads.
		if (!sChannelRing.currentApp().empty()) {
			const bool moved = sChannelRing.takeSelectionChanged();
			const bool stale = sChannelRing.takeRefreshDue(nowMs);
			if (stale) {
				// Forced, because by definition nothing the link keys on has moved.
				// It also wins when BOTH are up — walking back into the ring on the
				// same tick a republished menu landed — because a forced refresh
				// asks for exactly what a select would and asks unconditionally,
				// while a select can decline. Two flags for one fetch is fine; a
				// tick where both were raised and neither reached the network is a
				// page that never loads.
				hostLink().refreshChannel(sChannelRing.currentApp(), sChannelRing.currentRev());
			} else if (moved) {
				hostLink().selectChannel(sChannelRing.currentApp(), sChannelRing.currentRev());
			}
		}
		if (!sLink.online && sChannelRing.status() != tcos::ChannelRingScreen::kReady) {
			sChannelRing.setStatus(tcos::ChannelRingScreen::kOffline, nowMs);
		} else if (hostLink().channelFailed()) {
			sChannelRing.setStatus(tcos::ChannelRingScreen::kFailed, nowMs);
		}
	} else if (shell().top() == &sMusic) {
		// The empty state must say WHICH emptiness it is: "nothing is playing" is a
		// lie on a device that was never given a console address (a flashed unit
		// has no /tmp/zos-host) or cannot reach the one it has.
		sMusic.setLink(!hostLink().baseUrl().empty(), sLink.online);
		sMusic.setNowPlaying(sLink.nowPlaying, sLink.track, sLink.artist, sLink.lyric,
		                     sLink.playing, sLink.positionMs, sLink.durationMs,
		                     (int)(sLink.stampMonoMs - sStartMs),
		                     sLink.lyricStartMs, sLink.lyricEndMs, sLink.lyricUntilMs,
		                     // The per-glyph table, whose count is 0 for the ~80% of
		                     // tracks with no word timings — the screen falls back to
		                     // the even sweep on its own.
		                     sLink.lyricCells.cells, sLink.lyricCells.count);
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
	} else if (shell().top() == &sVibe) {
		// Same three emptinesses the music screen separates: a device that was
		// never told where the console lives has no way to know whether anyone is
		// signed in, and saying 未登录 would send the user hunting a login they
		// already have.
		sVibe.setLink(!hostLink().baseUrl().empty(), sLink.online);
		if (sLink.seq != sVibeFedSeq) {
			sVibeFedSeq = sLink.seq;
			sVibe.setAgents(sLink.vibe, nowMs);
		}
		if (sVibe.takeShowLeftChanged()) {
			// STAGED, not written, exactly like the theme: /data is jffs2 on raw
			// NAND and DeviceControls::flushIfDue already commits once a frame.
			// Erasing flash inside a button press is the mistake the volume knob
			// avoids two functions up.
			tcos::prefs::setInt("vibe.showLeft", sVibe.showLeft() ? 1 : 0);
		}
	} else if (shell().top() == &sSettings) {
		// Values move while the screen is up — the volume keys work here too —
		// so they are rebuilt on a cadence rather than only on entry.
		if (monoMs() - sSettingsBuiltMs >= 500) {
			sSettingsBuiltMs = monoMs();
			rebuildSettings(nowMs);
		}
		const int settingsPick = sSettings.takeActivated();
		if (settingsPick == ACTION_PROVISION) {
			// The body is shared with the console's POST /api/os/ble; see
			// openProvisioning for why the two entry points may not drift.
			openProvisioning(nowMs);
		} else if (settingsPick == ACTION_SLEEP_WINDOW || settingsPick == ACTION_SLEEP_IDLE) {
			// The cycle itself is in ui/SleepPolicy.cpp; this is only the wiring.
			sSleepConfig = settingsPick == ACTION_SLEEP_WINDOW
			                   ? tcos::cycleSleepWindow(sSleepConfig)
			                   : tcos::cycleSleepIdle(sSleepConfig);
			persistSleepConfig();
			// Rebuild, then skip the label dwell: a cycle row changes its OWN
			// value, so leaving the 1100 ms dwell in place would make the press
			// look like it did nothing and invite a second one.
			rebuildSettings(nowMs);
			sSettings.revealValue(nowMs);
		}
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

	// Commit volume/brightness once the user has stopped adjusting them. Here
	// rather than in nudge*(), so a held key does not put a flash erase between
	// two frames.
	tcos::DeviceControls::instance().flushIfDue(nowMs);

	// --- 夜间休眠, and the panel ---------------------------------------------
	//
	// The decision is a pure function of (now, config, lastActivity, clock),
	// recomputed every tick — there is no stored "asleep" state to latch dark.
	// This branch reads four fields off it and names no phase of its own.
	tcos::SleepInputs sleepIn;
	sleepIn.config = sSleepConfig;
	sleepIn.nowMs = nowMs;
	sleepIn.lastActivityMs = sLastActivityMs;
	sleepIn.lastPresentMs = sLastPresentMs;
	sleepIn.lastPanelPercent = sLastPanelPercent;
	sleepIn.clockSynced = timeSync().synced();
	sleepIn.clockAgeMs = clockAgeMs(nowMs);
	sleepIn.minuteOfDay = localMinuteNow();
	// A device about to power itself off must not go dark first — the user would
	// never learn why their clock died overnight.
	sleepIn.forceAwake = tcos::BatteryMonitor::instance().shutdownInSeconds() >= 0;
	const tcos::SleepDecision sleep = tcos::decideSleep(sleepIn);
	sSwallowsInput = sleep.swallowsInput;
	sSleepAsleep = sleep.asleep;

	// The TICK stays at 20 ms while dark. It is the only thing that drains the
	// key queue, polls the link, commits prefs and decides to wake, and putting
	// 200 ms between the knob turning and the panel lighting would be the one
	// moment the user is judging this feature. What is skipped is render+present
	// — the expensive pair — for 49 of every 50 ticks.
	if (sleep.repaintDue) {
		if (sleep.asleep) {
			// BLACK FRAMES, not stopped writes. The MCU holds the last frame it
			// accepted, so a firmware that merely stopped rendering would FREEZE
			// the picture rather than hide it. Clearing the canvas rather than
			// relying on present(…, 0) alone is load-bearing for the tee below:
			// the console must receive the black the panel received.
			canvas().clear(Color(0, 0, 0));
		} else {
			shell().render(canvas(), nowMs);
		}
		presenter().present(canvas(), sleep.panelPercent);
		sLastPresentMs = nowMs;
		sLastPanelPercent = sleep.panelPercent;

		// The mirror tee. Exactly one place in the firmware produces finished
		// pixels, and this is immediately after it: the LED bus is write-only and
		// /dev/fb0 is unrelated to the matrix, so a capture is the only way the
		// console can show what the panel actually shows. Gated on someone
		// watching, because the extract alone is 2496 bytes 25 times a second.
		//
		// INSIDE this branch, so the console can only ever receive frames the
		// panel actually received — which is the property publishMirror exists to
		// guarantee. While asleep that is one black frame a second, comfortably
		// inside the console's 2500 ms staleness bar, so it reads 休眠中 off the
		// telemetry flag rather than 画面已停更 off a starved stream.
		if (sLink.mirrorWanted) {
			static std::vector<uint8_t> mirrorRgb;
			canvas().extractRGB(mirrorRgb);
			if (!mirrorRgb.empty()) {
				hostLink().publishMirror(&mirrorRgb[0], (int)mirrorRgb.size());
			}
		}
	}

	// Telemetry. Throttled not because setting it is expensive but because
	// reading it is: the SSID and the address each cost a socket and an ioctl,
	// and at 25 fps that would be fifty syscalls a second to answer a question
	// whose answer changes about once a week.
	if (monoMs() - sTelemetryReadMs >= 2000 || sSleepAsleep != sSleepAsleepReported) {
		sTelemetryReadMs = monoMs();
		sSleepAsleepReported = sSleepAsleep;
		tcos::Screen* top = shell().top();
		const char* screenName = "launcher";
		if (top == &sChannelRing) screenName = "channel";
		else if (top == &sMusic) screenName = "music";
		else if (top == &sVibe) screenName = "vibe";
		else if (top == &sSettings) screenName = "settings";
		else if (top == &sGameScreen) screenName = "game";
		else if (top == &sGameList) screenName = "games";
		else if (top == &sBoot) screenName = "boot";
		else if (top == &sProvision) screenName = "provision";
		// The real count, not a placeholder. It is also the console's only way to
		// tell an adopted link from one the policy is failing to rebuild: an
		// adopted link issues no commands at all, so this stays 0 forever, while
		// a policy stuck retrying a refused startSupplicant climbs every tick.
		hostLink().setTelemetry(screenName, sChannelRing.currentApp(), tcos::netinfo::ssid(),
		                        tcos::netinfo::ipAddress(),
		                        sWifiPolicy.supplicantRestarts() + sWifiPolicy.softApRestarts(),
		                        tcos::BatteryMonitor::instance().percent(),
		                        tcos::BatteryMonitor::instance().charging(),
		                        !tcos::install::isSideloaded(),
		                        // 夜间休眠, as the DEVICE has it — which differs from
		                        // what the console last asked for whenever the knob
		                        // moved it, and is the only truth a form should show.
		                        sSleepConfig.enabled, sSleepConfig.startMin,
		                        sSleepConfig.endMin, sSleepConfig.idleMs / 1000,
		                        sSleepAsleep, sleepClockUsable(nowMs));
	}
	return true;
}
