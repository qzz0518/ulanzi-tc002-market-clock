#ifndef UI_SLEEPPOLICY_H_
#define UI_SLEEPPOLICY_H_

#include <stdint.h>

#include <string>

#include "net/StateDoc.h"

namespace tcos {

/**
 * 夜间息屏 — when the panel goes dark, and how it comes back.
 *
 * 息屏, not 休眠, in everything the user reads. In Chinese computing 休眠 is
 * hibernate — a machine that is POWERED DOWN — which on a device whose only
 * recovery is a power cycle is the exact connotation that stops someone
 * enabling this. Phones say 息屏 / 自动锁屏 for a screen going dark, and the
 * project's own prose gave the game away: every explanation of this feature had
 * to reach for 息屏 to say what 休眠 meant. The prefs keys and the wire keys
 * stay `sleep.*` — renaming those would be a migration for a copy change.
 *
 * WHY THIS IS A FILE AND NOT A BRANCH IN osLogic.cc. logic/osLogic.cc is
 * `#include`d by an activity rather than compiled as a translation unit, so no
 * host check can reach it; the last rule that lived there — which bar to raise
 * for which level — was wrong for the whole life of a build while a hand-copied
 * duplicate in the self-check stayed green (see ui/LevelControl.h). A rule that
 * can BLANK THE PANEL is the last one that should be written where nothing can
 * run it, so every decision below is here, `mise run os-hostcheck` links this
 * file, and the task guards that nothing else re-implements insideSleepWindow.
 *
 * THE ONE INVARIANT: every uncertainty resolves to a LIT panel. Unsynced clock,
 * stale clock, corrupt prefs, a monotonic wrap, a pending shutdown — all of
 * them return 100%. The failure this feature must never produce is a clock that
 * is dark with no way back, because the user's only recovery is a power cycle
 * and a power cycle reproduces a bad window exactly.
 *
 * THERE IS NO STORED STATE HERE. decideSleep() is a pure function of
 * (now, config, lastActivity, clock); the panel's condition is recomputed on
 * every 20 ms tick. A stored "asleep" flag is a thing that can latch dark.
 */

// Minutes east of UTC. This rootfs carries no tzdata, so localtime() would
// silently return UTC and look correct in the +0 timezone alone — the same
// reason rebuildSettings' 时间 row adds the offset by hand.
const int kTzOffsetMinutes = 480;
const int kMinutesPerDay = 1440;

// 600 ms. Long enough to read as "going away" rather than as a crash, short
// enough that a user who turns the knob mid-fade never waits on an animation.
const int kSleepFadeMs = 600;

// How often the dark panel is rewritten. NOT zero, and not "stop writing":
// Presenter::present clocks a whole frame to the MCU, which drives the matrix
// itself and HOLDS the last frame it accepted — the README's own cautionary
// tale is a panel stuck on the MCU's boot logo because nothing handshook it. So
// "stop rendering" means "freeze the picture", the opposite of this feature. We
// write black instead, and we keep writing it: spi.write() can fail, and one
// lost black frame must not leave the panel lit all night with nothing to
// correct it. 1 Hz also keeps the console's mirror inside its staleness bar.
const int kSleepRepaintMs = 1000;

// 26 hours. Past this the SoC's oscillator is no longer evidence about the wall
// clock, so the window cannot be trusted and the panel stays lit. More than a
// full day, so an afternoon of broken DNS still lets the device sleep that
// night with seconds of drift; bounded, so a device off the network for a week
// does not blank itself on a clock nobody has checked.
const int kClockTrustMs = 26 * 60 * 60 * 1000;

// Idle bounds. Below 30 s the panel blanks while the user is looking at it;
// above two hours the window is doing all the work anyway.
const int kMinIdleMs = 30 * 1000;
const int kMaxIdleMs = 7200 * 1000;

struct SleepConfig {
  bool enabled;
  int startMin;  // 0..1439, minutes since local midnight
  int endMin;    // 0..1439, EXCLUSIVE; == startMin means the whole day
  int idleMs;

  /**
   * Off, with the window pre-filled.
   *
   * This ships onto an already-flashed unit. A firmware that starts blanking
   * the panel by itself after an update — on a device whose clock may not have
   * synced yet — is exactly the support call this feature must not become.
   * Turning it on is one press on the row the user came looking for.
   */
  SleepConfig();
};

/** Everything decideSleep() reads. Assembled by the caller; nothing is global. */
struct SleepInputs {
  SleepConfig config;
  int nowMs;             // CLOCK_MONOTONIC ms, the UI's zero-based one
  int lastActivityMs;    // same clock
  int lastPresentMs;     // same clock; when the panel was last written
  int lastPanelPercent;  // what was last PRESENTED, so the first black frame is
                         // guaranteed even if the repaint clock has not come round
  bool clockSynced;
  int clockAgeMs;   // nowMs - the sync's monotonic stamp; < 0 means never synced
  int minuteOfDay;  // localMinuteOfDay(); only read when the clock is trusted
  bool forceAwake;  // a pending low-battery shutdown

  SleepInputs();
};

struct SleepDecision {
  int panelPercent;    // 100 awake, 0 dark, in between while fading
  bool asleep;         // panelPercent == 0
  bool repaintDue;     // whether the panel should be written this tick
  bool swallowsInput;  // == asleep; the wake gesture must not also act

  SleepDecision();
};

/**
 * Local minute-of-day from a UTC instant. Wraps across the date line, which is
 * the ordinary case at UTC+8: 17:00 UTC is 01:00 the next day here.
 */
int localMinuteOfDay(int64_t unixSeconds, int tzOffsetMinutes);

/**
 * Is this minute inside the window?
 *
 * CROSSING MIDNIGHT IS THE ORDINARY CASE. 23:00→07:00 is what a person means by
 * "night", so it is the normal path here, not an edge. The end is EXCLUSIVE, so
 * 07:00 is already morning and the panel comes back on the hour. start == end
 * means the whole day: a zero-length window is useless, whereas an all-day
 * screensaver is a thing someone would ask for and is the only way to try the
 * feature at 15:00 without waiting for night.
 *
 * Total for any integer: the minutes are wrapped, so a corrupt prefs value
 * cannot produce a window nobody can reason about.
 */
bool insideSleepWindow(int minuteOfDay, int startMin, int endMin);

/**
 * Clamps a prefs- or wire-sourced config into a range that cannot brick.
 *
 * Applied at the boundaries — on the read from /data and on a console request —
 * rather than inside decideSleep, which stays defensive about a config that
 * never passed through here. Minutes are WRAPPED rather than clamped because a
 * minute-of-day is cyclic: clamping 1441 to 1439 invents 23:59, wrapping gives
 * the 00:01 that was meant.
 */
SleepConfig sanitizeSleepConfig(const SleepConfig& raw);

/**
 * The whole policy, so it can be asserted rather than described.
 *
 * osLogic.cc reads panelPercent / asleep / repaintDue / swallowsInput and
 * nothing else — it never names a phase and never does the window arithmetic,
 * which is what keeps the one file no host check compiles trivially correct.
 */
SleepDecision decideSleep(const SleepInputs& in);

/**
 * Adopts a console request, at most once per RISING sequence.
 *
 * The document keeps carrying the last request forever — that is what makes a
 * coalesced poll apply it at all — so acting on the field being present rather
 * than on the sequence moving would overrule the knob on every poll, exactly as
 * it would for volume. Returns true when `appliedSeq` moved, which is also the
 * signal the caller uses to count this as user activity.
 *
 * A sequence that moved BACKWARDS restarts the count instead of being refused:
 * the hub's counter lives in the Bun process and returns to zero every time the
 * service is restarted, and refusing everything below the old high-water mark
 * would kill the remote escape hatch in the most common deployment state. See
 * the implementation for why that cannot re-open a replay.
 *
 * Each field is optional — an absent LINE means "leave this one alone", not a
 * sentinel value — so a console that only moves the timeout keeps the window the
 * knob configured. OsLinkHub.serialize() is the other half of that contract: it
 * emits only the fields the console has actually written.
 */
bool applySleepRequest(const SleepRequest& request, int& appliedSeq, SleepConfig* config);

/**
 * The 夜间息屏 row's value.
 *
 * `clockUsable` false APPENDS 等待校时 to the window rather than replacing it —
 * the same trick 手动配网 uses of putting the bad news where the user is already
 * looking. It is the answer to "I turned it on and nothing happened": the 时间
 * row that would otherwise explain it is nine rows away. Appended, because
 * replacing rendered every window identically and left the row write-only on
 * exactly the clock a new user has.
 *
 * Hours only (23-07) unless an endpoint is off the hour. The full 23:00-07:00
 * is 66 px against a 50 px clip, so it would marquee — and the value only
 * appears after the 1100 ms label dwell, which would make a glance take ~3 s.
 */
std::string formatSleepWindow(const SleepConfig& config, bool clockUsable);

/** The 息屏等待 row's value: 5分钟, or 45秒 for a console-set sub-minute value. */
std::string formatSleepIdle(const SleepConfig& config);

/**
 * One press of the 夜间息屏 row.
 *
 * 关闭 → 22-07 → 23-07 → 00-08 → [自定义] → 关闭.
 *
 * 全天 IS NOT ON THE KNOB. It is reachable over the wire and read back as 全天,
 * but a row you press to find out what it does must not be able to land on the
 * one mode that has no wall-clock moment of its own to come back at.
 *
 * 关闭 keeps the configured window in the config rather than clearing it, so
 * telemetry keeps reporting it and a console `{enabled:true}` restores it. It
 * does NOT mean the next press returns to it: this is a ring, and from 关闭 the
 * next press is 22-07.
 *
 * A window the CONSOLE set that is not a preset sits at the END of the lap, so
 * the press that leaves it lands on 关闭 — which keeps it. The press after that
 * does replace it, visibly. One window slot in the config makes anything
 * stronger than that impossible; see the implementation for the two shapes that
 * look like they would work and do not.
 *
 * A separate on/off row was argued down: it would be a third row on a screen you
 * scroll one item at a time with a knob, answering a question this row already
 * answers.
 */
SleepConfig cycleSleepWindow(const SleepConfig& config);

/** One press of the 息屏等待 row: 1 → 3 → 5 → 10 → 30 分钟 → 1. */
SleepConfig cycleSleepIdle(const SleepConfig& config);

}  // namespace tcos

#endif  // UI_SLEEPPOLICY_H_
