#ifndef PLATFORM_BATTERYMONITOR_H_
#define PLATFORM_BATTERYMONITOR_H_

#include <pthread.h>

#include "platform/BatteryPolicy.h"

namespace tcos {

/**
 * Battery watch, and the shutdown that protects the cell.
 *
 * This exists because ZOS is now the only firmware on a battery-powered device.
 * The stock app carries awtrix::BatteryMonitor — checkBatteryStatus,
 * handleLowBattery, setLowBatteryMode — and flashing ZOS deleted all of it. A
 * sideloaded session never needed one: it lasted minutes, someone was watching,
 * and a power cycle brought the stock protection straight back. Flashed, there
 * is nothing else left to notice a flat cell, and over-discharging a LiPo is
 * the one failure in this whole firmware that damages hardware rather than
 * annoying a user.
 *
 * The MCU queries block for well over a second each (the arcade firmware
 * documents the same measurement), so this owns a thread and the UI only ever
 * reads a cached value. Nothing here may be called from the render tick.
 *
 * The RULE — which reading means low, empty, or charging — is not here. It is
 * in platform/BatteryPolicy.{h,cpp}, because this file cannot be compiled by a
 * host check (McuManager drags in the FlyThings MCU headers) and the rule was
 * wrong for the whole life of the firmware as a direct result. This class is
 * now only the thread, the cache, and the countdown's one-second steps.
 */
class BatteryMonitor {
 public:
  static BatteryMonitor& instance();

  /** Starts the poll thread. Safe to call once, after the MCU is up. */
  void start();
  void stop();

  /** 0..100, or -1 before the first successful reading. DISPLAY ONLY. */
  int percent() const;
  /**
   * Cell voltage in millivolts, or -1 before the first reading that carried one.
   *
   * This is the quantity the protection actually runs on, and it is reported to
   * the console for exactly that reason: 「is the percentage right?」 is not a
   * question anyone can answer from a percentage.
   */
  int millivolts() const;
  /** True while the charger is supplying power. USB presence, nothing else. */
  bool charging() const;
  /** Below kBatteryWarnMv on its own cell. False while charging. */
  bool low() const;
  /** Seconds until an automatic shutdown, or -1 when none is pending. */
  int shutdownInSeconds() const;

 private:
  BatteryMonitor();
  BatteryMonitor(const BatteryMonitor&);
  BatteryMonitor& operator=(const BatteryMonitor&);

  static void* threadMain(void* self);
  void run();

  mutable pthread_mutex_t mLock;
  pthread_t mThread;
  bool mRunning;
  bool mStarted;
  int mPercent;
  int mMillivolts;
  bool mCharging;
  bool mLow;
  int mCountdown;
};

}  // namespace tcos

#endif  // PLATFORM_BATTERYMONITOR_H_
