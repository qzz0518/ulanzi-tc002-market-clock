#ifndef PLATFORM_BATTERYPOLICY_H_
#define PLATFORM_BATTERYPOLICY_H_

namespace tcos {

/**
 * When the cell is low, when it is empty, and when the charger is in.
 *
 * WHY THIS IS A FILE AND NOT A BRANCH IN BatteryMonitor.cpp. BatteryMonitor
 * owns a thread and talks to McuManager, which drags in the FlyThings MCU
 * headers — so `mise run os-hostcheck` cannot compile it, and for the whole
 * life of this firmware the rule below was therefore never once executed
 * outside a device nobody could read a value back off. It was wrong the entire
 * time (see the charging rule). Everything here is a pure function of one
 * reading plus the countdown already running, so the self-check can drive it.
 *
 * WHAT THE MCU ACTUALLY SENDS. `McuParse::queyrBatteryPower` (the vendor's
 * typo) returns a pair: `.first` is the percentage, and `.second` is
 * `(data[1] << 8) | data[2]` — THE CELL VOLTAGE IN MILLIVOLTS. The vendor's own
 * header comments it as a charge flag ("0=未充电, 1=充电中"), and reading it as
 * one is how the console came to say 充电中 on a clock that was never plugged
 * in: a live battery always reads well above zero, so the flag was a constant
 * true. Charging is USB presence and nothing else.
 *
 * WHERE THE NUMBERS COME FROM. Recovered from the stock Ulanzi app's own log
 * format strings in `.runtime/tc002-stock/res-live/lib/libzkgui.so`:
 *
 *   BatteryMonitor: USB power detected, skipping low battery protection (vin=%dmV)
 *   BatteryMonitor: Low battery detected: %dmV (< 3600mV), vin=%dmV
 *   BatteryMonitor: Battery recovered: %dmV (>= 3600mV)
 *   BatteryMonitor: Emergency low voltage: %dmV (< 3550mV), starting 30s countdown
 *   BatteryMonitor: Emergency voltage cleared: %dmV (>= 3550mV)
 *
 * So the vendor protects the cell on VOLTAGE, not on the percentage — which
 * matters, because over-discharging a LiPo is the one failure in this firmware
 * that damages hardware rather than annoying a user, and we had built that
 * protection on a quantity we never validated while the real signal sat unread
 * in the same three bytes.
 */

// Below this the cell is low: worth saying so, not worth acting on. Same number
// both ways, exactly as the stock app has it — 「recovered」 is the same
// comparison, so there is no hysteresis gap to get wrong.
const int kBatteryWarnMv = 3600;
// Below this the cell is being damaged. This is what starts the countdown, and
// rising back above it clears one that is already running.
const int kBatteryEmergencyMv = 3550;
/** Grace before the shutdown, so a user holding it can reach the charger. */
const int kBatteryCountdownSeconds = 30;
/** Poll period. Every reading costs the MCU two blocking round trips. */
const int kBatteryPollSeconds = 10;

// The backstop, in percent, for an MCU that answers with a percentage but no
// voltage. These are OUR numbers rather than recovered ones and they are used
// only when there is no voltage to use instead — see decideBattery.
const int kBatteryBackstopWarnPercent = 8;
const int kBatteryBackstopShutdownPercent = 3;

/** One poll's worth of MCU answers, exactly as they come back. */
struct BatteryReading {
  /** 0..100, or -1 when the query failed. */
  int percent;
  /** Cell voltage. <= 0 means this MCU gave us no voltage to act on. */
  int millivolts;
  /** > 0 while the charger supplies power; 0 when it does not, -1 on failure. */
  int usb;

  BatteryReading() : percent(-1), millivolts(-1), usb(-1) {}
};

/** What the monitor should hold until the next poll. */
struct BatteryDecision {
  bool charging;
  /** Low enough to warn about. Always false while charging. */
  bool low;
  /** Seconds until the automatic shutdown, or -1 when none is pending. */
  int countdown;

  BatteryDecision() : charging(false), low(false), countdown(-1) {}
};

/**
 * The whole rule, as a pure function of this reading and the countdown already
 * running (-1 when none is).
 *
 * VOLTAGE WINS WHENEVER THERE IS ONE. The percentage is a display number here;
 * it only decides anything when `millivolts` is unusable, and then only through
 * the backstop constants above. That case is not hypothetical enough to leave
 * unprotected: percentage and voltage arrive in the same three-byte answer, so
 * a short or malformed frame can plausibly yield a sane `.first` and a zero
 * `.second`, and dropping protection entirely there would reopen the exact hole
 * this monitor exists to close. Never both at once — a device is judged by one
 * quantity or the other, so the two can never disagree into a shutdown.
 *
 * NO READING AT ALL CANCELS. A -1 percentage with no voltage is not evidence of
 * an empty cell, it is evidence of an MCU that did not answer, and powering a
 * device off on that is the one outcome nobody can undo from the couch.
 */
BatteryDecision decideBattery(const BatteryReading& reading, int countdown);

}  // namespace tcos

#endif  // PLATFORM_BATTERYPOLICY_H_
