#include "platform/BatteryMonitor.h"

#include <unistd.h>

#include <utility>

#include "base/log.h"
#include "managers/McuManager.h"

namespace tcos {

BatteryMonitor::BatteryMonitor()
    : mRunning(false), mStarted(false), mPercent(-1), mCharging(false), mCountdown(-1) {
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

    const int level = battery.first;
    // The MCU reports charge state twice — in the battery pair and as USB
    // presence. Either one counts: a device on the charger is not in danger
    // however low the cell reads, and disagreement between the two should fail
    // towards "safe", never towards a shutdown that surprises the user.
    const bool charging = battery.second > 0 || usb > 0;

    ::pthread_mutex_lock(&mLock);
    if (level >= 0) mPercent = level;
    mCharging = charging;

    if (charging || level < 0) {
      // Plugged in, or we have no reading to act on. Either cancels a pending
      // shutdown outright rather than pausing it.
      if (mCountdown >= 0) LOGD("battery: shutdown cancelled (charging=%d)", charging ? 1 : 0);
      mCountdown = -1;
    } else if (level <= kShutdownPercent) {
      if (mCountdown < 0) {
        mCountdown = kCountdownSeconds;
        LOGE_TRACE("battery: %d%%, shutting down in %ds", level, mCountdown);
      }
    } else if (level > kWarnPercent) {
      mCountdown = -1;
    }
    const int countdown = mCountdown;
    ::pthread_mutex_unlock(&mLock);

    if (countdown >= 0) {
      // Count down in one-second steps so the panel can show it, and re-check
      // the charger every step: plugging in during the countdown must stop it.
      for (int left = countdown; left >= 0 && mRunning; --left) {
        ::pthread_mutex_lock(&mLock);
        mCountdown = left;
        const bool stillDraining = !mCharging;
        ::pthread_mutex_unlock(&mLock);
        if (!stillDraining) break;
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

    for (int i = 0; i < kPollSeconds && mRunning; ++i) ::sleep(1);
  }
}

int BatteryMonitor::percent() const {
  ::pthread_mutex_lock(&mLock);
  const int value = mPercent;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

bool BatteryMonitor::charging() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mCharging;
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
