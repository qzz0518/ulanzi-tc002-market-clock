#ifndef PLATFORM_BATTERYMONITOR_H_
#define PLATFORM_BATTERYMONITOR_H_

#include <pthread.h>

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
 */
class BatteryMonitor {
 public:
  static BatteryMonitor& instance();

  /** Starts the poll thread. Safe to call once, after the MCU is up. */
  void start();
  void stop();

  /** 0..100, or -1 before the first successful reading. */
  int percent() const;
  /** True while the charger is supplying power. */
  bool charging() const;
  /** Seconds until an automatic shutdown, or -1 when none is pending. */
  int shutdownInSeconds() const;

  // Thresholds. The stock firmware works in millivolts and warns at 3550 mV;
  // the MCU only reports a percentage to us, so these are OUR numbers rather
  // than recovered constants, chosen to sit above where a protection circuit
  // would cut in. Charging cancels both, because a device on the charger is
  // not in danger however low it reads.
  static const int kWarnPercent = 8;
  static const int kShutdownPercent = 3;
  /** Grace before the shutdown, so a user holding it can reach the charger. */
  static const int kCountdownSeconds = 30;
  /** Poll period. Every reading costs the MCU two blocking round trips. */
  static const int kPollSeconds = 10;

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
  bool mCharging;
  int mCountdown;
};

}  // namespace tcos

#endif  // PLATFORM_BATTERYMONITOR_H_
