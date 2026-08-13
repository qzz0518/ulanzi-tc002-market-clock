#include "ui/SleepPolicy.h"

#include <stdio.h>

namespace tcos {

namespace {

// Minutes are cyclic, so an out-of-range one is wrapped rather than clamped.
int wrapMinute(int minute) {
  int m = minute % kMinutesPerDay;
  if (m < 0) m += kMinutesPerDay;
  return m;
}

// The three windows the knob offers, in cycle order. Presets rather than a
// minute picker because minute-level entry is 1440 detents per endpoint; the
// console gets arbitrary minutes over the wire, and a window it set that is not
// one of these is inserted into the lap by cycleSleepWindow.
//
// 全天 (start == end) IS NOT HERE, and that is the point. It used to sit one
// detent past 00-08, so two presses of a row whose label a user was merely
// reading turned a night-sleep clock into an all-day screensaver — and 全天 is
// the one mode with no wall-clock moment at which the panel comes back by
// itself, which is the safety property the rest of this file is built on. The
// firmware still HONOURS it (a console can set it, and formatSleepWindow reads
// it back as 全天), because a whole-day screensaver is a real thing to want and
// the only way to try the feature at 15:00. It just cannot be arrived at by
// pressing a knob: a form can label it and explain it, a 52 px row cannot.
struct WindowPreset {
  int startMin;
  int endMin;
};
const WindowPreset kWindowPresets[3] = {
  {1320, 420},  // 22-07
  {1380, 420},  // 23-07
  {0, 480},     // 00-08
};
const int kWindowPresetCount = 3;

const int kIdlePresets[5] = {60000, 180000, 300000, 600000, 1800000};
const int kIdlePresetCount = 5;

bool isWindowPreset(int startMin, int endMin) {
  for (int i = 0; i < kWindowPresetCount; ++i) {
    if (kWindowPresets[i].startMin == startMin && kWindowPresets[i].endMin == endMin) return true;
  }
  return false;
}

}  // namespace

SleepConfig::SleepConfig()
    : enabled(false), startMin(1380), endMin(420), idleMs(300000) {}

SleepInputs::SleepInputs()
    : nowMs(0), lastActivityMs(0), lastPresentMs(0), lastPanelPercent(100),
      clockSynced(false), clockAgeMs(-1), minuteOfDay(0), forceAwake(false) {}

SleepDecision::SleepDecision()
    : panelPercent(100), asleep(false), repaintDue(true), swallowsInput(false) {}

int localMinuteOfDay(int64_t unixSeconds, int tzOffsetMinutes) {
  const int64_t local = unixSeconds + static_cast<int64_t>(tzOffsetMinutes) * 60;
  // Floor division rather than C's truncation, so an instant before the epoch
  // (which only a broken clock produces, but which must not produce a negative
  // minute) still lands inside the day.
  int64_t minutes = local / 60;
  if (local < 0 && local % 60 != 0) minutes -= 1;
  int m = static_cast<int>(minutes % kMinutesPerDay);
  if (m < 0) m += kMinutesPerDay;
  return m;
}

bool insideSleepWindow(int minuteOfDay, int startMin, int endMin) {
  const int now = wrapMinute(minuteOfDay);
  const int start = wrapMinute(startMin);
  const int end = wrapMinute(endMin);
  if (start == end) return true;  // 全天
  if (start < end) return now >= start && now < end;
  // The ordinary case: 23:00 → 07:00. Written as one expression rather than as
  // an "edge case" branch, because it is what a person means by night.
  return now >= start || now < end;
}

SleepConfig sanitizeSleepConfig(const SleepConfig& raw) {
  SleepConfig out = raw;
  out.startMin = wrapMinute(raw.startMin);
  out.endMin = wrapMinute(raw.endMin);
  if (out.idleMs < kMinIdleMs) out.idleMs = kMinIdleMs;
  if (out.idleMs > kMaxIdleMs) out.idleMs = kMaxIdleMs;
  return out;
}

SleepDecision decideSleep(const SleepInputs& in) {
  SleepDecision awake;  // the default-constructed decision IS "lit, repaint now"

  // Read straight off the config rather than through sanitizeSleepConfig: this
  // function is the last line of defence, and every guard below must resolve a
  // value it cannot make sense of to a LIT panel. Clamping a corrupt idleMs of
  // 0 up to the 30 s floor here would do the opposite — start blanking a panel
  // on a number nobody chose.
  const SleepConfig& config = in.config;
  if (!config.enabled) return awake;
  if (config.idleMs <= 0) return awake;

  // A pending low-battery shutdown outranks everything. A device about to power
  // itself off must not go dark first, or the user never learns why their clock
  // died overnight.
  if (in.forceAwake) return awake;

  // THE 1970 TRAP. Before TimeSync existed this device measured 1970-01-01
  // 00:00 — which is INSIDE 23:00→07:00. A naive implementation blanks the
  // panel within `idle` of every boot, the user sees a clock that never comes
  // on, and the obvious recovery (power cycle) reproduces it exactly.
  if (!in.clockSynced) return awake;
  // Negative means the sync has no monotonic stamp, i.e. it never happened.
  if (in.clockAgeMs < 0 || in.clockAgeMs > kClockTrustMs) return awake;

  if (!insideSleepWindow(in.minuteOfDay, config.startMin, config.endMin)) return awake;

  // CLOCK_MONOTONIC only. The wall clock steps 56 years at the first sync; the
  // countdown must not be able to see that, which is why the window is compared
  // against wall time and the countdown against the monotonic one. A negative
  // idle (the 24.8-day wrap of the UI's int ms) reads as "just used".
  const int idle = in.nowMs - in.lastActivityMs;
  if (idle < config.idleMs) return awake;

  const int fade = idle - config.idleMs;
  if (fade < kSleepFadeMs) {
    SleepDecision fading;
    // 99 down to 1 across the fade. The caps are load-bearing, not cosmetic:
    // 100 means awake and 0 means asleep everywhere else in this file, so the
    // ramp must occupy neither. That is what makes `swallowsInput ==
    // (panelPercent == 0)` an assertion instead of a coincidence.
    int percent = ((kSleepFadeMs - fade) * 100) / kSleepFadeMs;
    if (percent > 99) percent = 99;
    if (percent < 1) percent = 1;
    fading.panelPercent = percent;
    fading.asleep = false;
    fading.repaintDue = true;
    // NOT swallowed. The screen is still visible, so ignoring the user here
    // would be the panel arguing with someone who can see it.
    fading.swallowsInput = false;
    return fading;
  }

  SleepDecision dark;
  dark.panelPercent = 0;
  dark.asleep = true;
  dark.swallowsInput = true;
  // The first black frame is guaranteed by the percent having moved, so a panel
  // that was lit one tick ago goes dark on this one rather than up to a second
  // later. After that the repaint is the 1 Hz self-heal.
  dark.repaintDue = in.lastPanelPercent != 0 ||
                    (in.nowMs - in.lastPresentMs) >= kSleepRepaintMs;
  return dark;
}

bool applySleepRequest(const SleepRequest& request, int& appliedSeq, SleepConfig* config) {
  if (config == 0) return false;

  // A LOWER sequence means the counter restarted, not that a request is being
  // replayed. The hub's sequence is plain instance state on the Mac: restarting
  // the Bun service — routine, since every web/ change needs a rebuild — puts it
  // back at 0 while this device is still up and still holding the last number it
  // applied. Without this line every console write is silently dropped until it
  // climbs back past that number, and the write that matters most is the one
  // that comes last: `PUT /api/os/sleep {enabled:false}` at 02:00, the documented
  // way back for a user who is not in the room with a dark panel. The route
  // answers 200 either way, so nothing anywhere would surface the loss.
  //
  // Safe because a replay repeats a number rather than going backwards: after
  // adopting seq 1 the applied sequence is 1, so the same document on the next
  // poll is still refused and the knob still wins.
  if (request.seq > 0 && request.seq < appliedSeq) appliedSeq = 0;
  if (request.seq <= appliedSeq) return false;
  appliedSeq = request.seq;

  SleepConfig next = *config;
  // Each field is optional, so a console that only flips the switch keeps the
  // window the knob configured.
  if (request.on >= 0) next.enabled = request.on != 0;
  if (request.startMin >= 0) next.startMin = request.startMin;
  if (request.endMin >= 0) next.endMin = request.endMin;
  if (request.idleSec > 0) {
    // Clamped BEFORE the multiply: atoi of a garbled line yields INT_MAX, and
    // INT_MAX * 1000 is undefined behaviour rather than a large number.
    int seconds = request.idleSec;
    if (seconds > kMaxIdleMs / 1000) seconds = kMaxIdleMs / 1000;
    next.idleMs = seconds * 1000;
  }
  // The device does not trust the wire, even though the service validates: this
  // is the only place a console value becomes something the panel obeys.
  *config = sanitizeSleepConfig(next);
  return true;
}

std::string formatSleepWindow(const SleepConfig& config, bool clockUsable) {
  if (!config.enabled) return "\xE5\x85\xB3\xE9\x97\xAD";              // 关闭

  const SleepConfig cfg = sanitizeSleepConfig(config);
  std::string window;
  if (cfg.startMin == cfg.endMin) {
    window = "\xE5\x85\xA8\xE5\xA4\xA9";                               // 全天
  } else {
    char buf[24];
    if (cfg.startMin % 60 == 0 && cfg.endMin % 60 == 0) {
      ::snprintf(buf, sizeof(buf), "%02d-%02d", cfg.startMin / 60, cfg.endMin / 60);
    } else {
      // Only when an endpoint is off the hour, which only a console can produce —
      // so the user who has to read a marqueeing 23:30-06:45 is the user who
      // typed it.
      ::snprintf(buf, sizeof(buf), "%02d:%02d-%02d:%02d", cfg.startMin / 60, cfg.startMin % 60,
                 cfg.endMin / 60, cfg.endMin % 60);
    }
    window = buf;
  }

  // BOTH facts, not one instead of the other. 等待校时 used to REPLACE the
  // window, which made every setting on this row render identically on a clock
  // that has not synced — the state every freshly flashed unit is in while its
  // owner is poking at 设置 waiting for Wi-Fi. Four windows, one string: the row
  // became write-only, with no way to see what was selected or how many presses
  // led back to 关闭.
  //
  // ~84 px against the 50 px clip, so it marquees. Accepted: this is the
  // abnormal state, the user needs both halves of it, and drawRow marquees any
  // value that does not fit anyway.
  if (!clockUsable) {
    window += " \xE7\xAD\x89\xE5\xBE\x85\xE6\xA0\xA1\xE6\x97\xB6";     // 等待校时
  }
  return window;
}

std::string formatSleepIdle(const SleepConfig& config) {
  const SleepConfig cfg = sanitizeSleepConfig(config);
  char buf[24];
  if (cfg.idleMs % 60000 != 0) {
    // A console may ask for 45 s. Rounding that to 1分钟 would be a readout that
    // disagrees with the behaviour, so the row says seconds instead.
    ::snprintf(buf, sizeof(buf), "%d\xE7\xA7\x92", cfg.idleMs / 1000);          // 秒
  } else {
    ::snprintf(buf, sizeof(buf), "%d\xE5\x88\x86\xE9\x92\x9F", cfg.idleMs / 60000);  // 分钟
  }
  return std::string(buf);
}

SleepConfig cycleSleepWindow(const SleepConfig& config) {
  const SleepConfig cfg = sanitizeSleepConfig(config);

  // The lap, built fresh each press: 关闭, the presets, and — LAST, immediately
  // before 关闭 comes round again — a window the console set that is not one of
  // the presets.
  //
  // THE ORDER OF THAT LAST ENTRY IS THE WHOLE DESIGN. The config holds exactly
  // one window, so whatever the press moves to is what replaces it: a custom
  // window can survive at most the press that leaves it, and only if that press
  // lands somewhere that KEEPS it. 关闭 is that place — it keeps the window in
  // the config, so telemetry still reports 23:30-06:45 and a console
  // `{enabled:true}` brings it straight back. Putting the custom entry first
  // instead (right after 关闭) reversed that: the search found it, the press
  // stepped past it onto 22-07, and a console-set window died on press one with
  // no way back from the device. Putting it first AND making 关闭 return to it
  // is the other tempting shape, and it is a trap — 自定义 → 关闭 → 自定义 is a
  // two-stop ring with the presets unreachable.
  //
  // So the ring is 关闭 → 22-07 → 23-07 → 00-08 → [自定义] → 关闭. One press off
  // a custom window is recoverable; the press after that does replace it, in
  // full view of the user, because revealValue puts the new value on the row
  // immediately.
  SleepConfig lap[5];
  int count = 0;
  lap[count] = cfg;
  lap[count].enabled = false;  // 关闭 KEEPS the window, so it can come back
  ++count;
  for (int i = 0; i < kWindowPresetCount; ++i) {
    lap[count] = cfg;
    lap[count].enabled = true;
    lap[count].startMin = kWindowPresets[i].startMin;
    lap[count].endMin = kWindowPresets[i].endMin;
    ++count;
  }
  const bool custom = !isWindowPreset(cfg.startMin, cfg.endMin);
  if (custom) {
    lap[count] = cfg;
    lap[count].enabled = true;
    ++count;
  }

  int at = 0;
  if (cfg.enabled) {
    for (int i = 1; i < count; ++i) {
      if (lap[i].startMin == cfg.startMin && lap[i].endMin == cfg.endMin) {
        at = i;
        break;
      }
    }
  }
  return lap[(at + 1) % count];
}

SleepConfig cycleSleepIdle(const SleepConfig& config) {
  SleepConfig out = sanitizeSleepConfig(config);
  // Strictly greater, so a console-set value between two presets advances to
  // the next one rather than being snapped onto a preset it never chose.
  for (int i = 0; i < kIdlePresetCount; ++i) {
    if (kIdlePresets[i] > out.idleMs) {
      out.idleMs = kIdlePresets[i];
      return out;
    }
  }
  out.idleMs = kIdlePresets[0];
  return out;
}

}  // namespace tcos
