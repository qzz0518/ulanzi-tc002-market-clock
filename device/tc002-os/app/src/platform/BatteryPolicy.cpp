#include "platform/BatteryPolicy.h"

namespace tcos {

BatteryDecision decideBattery(const BatteryReading& reading, int countdown) {
  BatteryDecision out;

  // USB presence, and only USB presence. The pair's second field is a voltage,
  // so `> 0` on it was true on every device that had a battery in it at all.
  out.charging = reading.usb > 0;

  if (out.charging) {
    // The stock app's own words: 「USB power detected, skipping low battery
    // protection」. A device on the charger is not in danger however low it
    // reads, and while it charges the reading is the charger's rail anyway.
    out.low = false;
    out.countdown = -1;
    return out;
  }

  if (reading.millivolts > 0) {
    out.low = reading.millivolts < kBatteryWarnMv;
    // THE TWO READINGS MUST AGREE BEFORE ANYTHING IS TURNED OFF.
    //
    // Measured on the real clock: 3010 mV alongside 55 %, both climbing on the
    // charger. Those cannot both describe one cell — 55 % of a single LiPo is
    // about 3.8 V — so one of them is not what we think it is, and the stock
    // firmware would have shut this device down long ago if 3010 were really
    // the cell. Until somebody has watched a full charge and discharge on
    // hardware, arming an automatic power-off on the voltage alone means the
    // first unplug turns the clock off with the battery half full.
    //
    // Shutting down late costs some cell life. Shutting down wrongly turns off
    // a device nobody asked to turn off, and is the failure the user sees. So
    // the countdown needs both numbers pointing the same way; the WARNING does
    // not, because a warning that is early is just a warning.
    const bool percentAgrees =
        reading.percent < 0 || reading.percent <= kBatteryBackstopWarnPercent;
    if (reading.millivolts < kBatteryEmergencyMv && percentAgrees) {
      // Start one, or leave the running one alone — restarting it every poll
      // would make the 30 s grace unreachable.
      out.countdown = countdown >= 0 ? countdown : kBatteryCountdownSeconds;
    } else {
      // 「Emergency voltage cleared」. A cell that came back above the line —
      // or a percentage that never agreed it was empty — cancels outright
      // rather than pausing: the next real dip starts a fresh 30 s, which is
      // the grace the user was promised.
      out.countdown = -1;
    }
    return out;
  }

  if (reading.percent >= 0) {
    out.low = reading.percent <= kBatteryBackstopWarnPercent;
    if (reading.percent <= kBatteryBackstopShutdownPercent) {
      out.countdown = countdown >= 0 ? countdown : kBatteryCountdownSeconds;
    } else if (reading.percent > kBatteryBackstopWarnPercent) {
      out.countdown = -1;
    } else {
      // Between the two backstop numbers: hold whatever is running. Clearing
      // here would let a percentage hovering at 5% restart the countdown from
      // 30 forever and never actually protect anything.
      out.countdown = countdown;
    }
    return out;
  }

  // Nothing to act on.
  out.low = false;
  out.countdown = -1;
  return out;
}

}  // namespace tcos
