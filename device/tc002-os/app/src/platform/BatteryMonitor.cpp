#include "platform/BatteryMonitor.h"

#include <unistd.h>

#include <utility>

#include "base/log.h"
#include "managers/McuManager.h"

namespace tcos {

BatteryMonitor::BatteryMonitor()
    : mRunning(false), mStarted(false), mPercent(-1), mMillivolts(-1), mCharging(false),
      mLow(false), mCountdown(-1) {
  ::pthread_mutex_init(&mLock, 0);
}

BatteryMonitor& BatteryMonitor::instance() {
  static BatteryMonitor single;
  return single;
}

void BatteryMonitor::start() {
  if (mStarted) return;
  mStarted = true;
  mRunning = true;
  ::pthread_create(&mThread, 0, &BatteryMonitor::threadMain, this);
}

void BatteryMonitor::stop() {
  if (!mStarted) return;
  mRunning = false;
  ::pthread_join(mThread, 0);
  mStarted = false;
}

void* BatteryMonitor::threadMain(void* self) {
  static_cast<BatteryMonitor*>(self)->run();
  return 0;
}

void BatteryMonitor::run() {
  while (mRunning) {
    // McuManager answers from its own cache once set, so invalidate first or
    // every cycle after the first would read the same stale pair forever. The
    // arcade firmware learned this the same way.
    McuManager::getInstance().setBatteryState(std::make_pair(-1, -1));
    const std::pair<int, int> battery = McuManager::getInstance().queryBatteryPower();
    McuManager::getInstance().setUsbState(-1);
    const int usb = McuManager::getInstance().queryUsbState();

    BatteryReading reading;
    reading.percent = battery.first;
    // `.second` is the cell voltage in millivolts, NOT a charge flag — the
    // whole rule lives in BatteryPolicy, which explains where that is from.
    reading.millivolts = battery.second;
    reading.usb = usb;

    ::pthread_mutex_lock(&mLock);
    const int wasCountdown = mCountdown;
    const BatteryDecision decision = decideBattery(reading, wasCountdown);
    if (reading.percent >= 0) mPercent = reading.percent;
    if (reading.millivolts > 0) mMillivolts = reading.millivolts;
    mCharging = decision.charging;
    mLow = decision.low;
    mCountdown = decision.countdown;
    if (wasCountdown >= 0 && decision.countdown < 0) {
      LOGD("battery: shutdown cancelled (charging=%d, %dmV)", decision.charging ? 1 : 0,
           reading.millivolts);
    } else if (wasCountdown < 0 && decision.countdown >= 0) {
      LOGE_TRACE("battery: %dmV (%d%%), shutting down in %ds", reading.millivolts,
                 reading.percent, decision.countdown);
    }
    const int countdown = mCountdown;
    ::pthread_mutex_unlock(&mLock);

    if (countdown >= 0) {
      // Count down in one-second steps so the panel can show it, and ASK THE
      // MCU about the charger every step. Reading the cached mCharging here was
      // the same class of mistake as the one this file was fixed for: nothing
      // writes that field while this loop runs — the only writer is the poll at
      // the top, which is exactly what the loop is standing in for — so the
      // grace period could not be interrupted by the one act it exists to give
      // the user time for. USB alone, not the battery pair: one blocking round
      // trip rather than two, which keeps the step near its second. The query
      // makes each step slightly LONGER than a second, which lengthens the
      // grace rather than shortening it — the safe direction for a countdown
      // that ends in a power cut.
      for (int left = countdown; left >= 0 && mRunning; --left) {
        McuManager::getInstance().setUsbState(-1);
        const bool plugged = McuManager::getInstance().queryUsbState() > 0;
        ::pthread_mutex_lock(&mLock);
        mCountdown = plugged ? -1 : left;
        if (plugged) mCharging = true;
        ::pthread_mutex_unlock(&mLock);
        if (plugged) {
          LOGD("battery: shutdown cancelled, charger in with %ds left", left);
          break;
        }
        if (left == 0) {
          LOGE_TRACE("battery: powering off to protect the cell");
          // The MCU cuts power; this call does not return in any useful sense.
          McuManager::getInstance().powerOff();
          return;
        }
        ::sleep(1);
      }
      continue;  // re-poll immediately rather than waiting out the full period
    }

    for (int i = 0; i < kBatteryPollSeconds && mRunning; ++i) ::sleep(1);
  }
}

int BatteryMonitor::percent() const {
  ::pthread_mutex_lock(&mLock);
  const int value = mPercent;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

int BatteryMonitor::millivolts() const {
  ::pthread_mutex_lock(&mLock);
  const int value = mMillivolts;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

bool BatteryMonitor::charging() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mCharging;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

bool BatteryMonitor::low() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mLow;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

int BatteryMonitor::shutdownInSeconds() const {
  ::pthread_mutex_lock(&mLock);
  const int value = mCountdown;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

}  // namespace tcos
