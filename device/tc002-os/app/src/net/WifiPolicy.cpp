#include "net/WifiPolicy.h"

namespace tcos {

WifiPolicy::WifiPolicy(Actuator* actuator)
    : mActuator(actuator),
      mState(kIdle),
      mStateSinceMs(0),
      mLastRetryMs(0),
      mSupplicantRestarts(0),
      mHaveCredentials(false) {}

void WifiPolicy::enter(State state, int nowMs) {
  mState = state;
  mStateSinceMs = nowMs;
}

void WifiPolicy::begin(int nowMs) {
  if (mActuator == 0) return;
  mHaveCredentials = mActuator->storedCredentials(&mSsid, &mPsk);
  mActuator->startSupplicant();
  enter(kStartingWpa, nowMs);
}

void WifiPolicy::applyCredentials(const std::string& ssid, const std::string& psk,
                                  int nowMs) {
  mSsid = ssid;
  mPsk = psk;
  mHaveCredentials = !ssid.empty();
  if (mActuator != 0) mActuator->stopSoftAp();
  beginConnect(nowMs);
}

void WifiPolicy::beginConnect(int nowMs) {
  if (mActuator == 0) return;
  if (!mHaveCredentials) {
    mActuator->startSoftAp();
    enter(kProvisioning, nowMs);
    return;
  }
  if (!mActuator->connect(mSsid, mPsk)) {
    // The request could not even be issued — usually the supplicant died between
    // the check and the call. Go back and revive it rather than sitting in a
    // state that will only ever time out.
    mActuator->startSupplicant();
    ++mSupplicantRestarts;
    enter(kStartingWpa, nowMs);
    return;
  }
  enter(kConnecting, nowMs);
}

void WifiPolicy::tick(int nowMs) {
  if (mActuator == 0) return;
  const int inState = nowMs - mStateSinceMs;

  // Supervision runs in every state except the ones already waiting on it:
  // init will not respawn a `oneshot` service, and when the supplicant dies
  // libzknet's event thread exits, leaving WifiManager blind rather than
  // reporting an error. Nothing else would ever notice.
  if (mState == kConnecting || mState == kObtainingIp || mState == kOnline) {
    if (!mActuator->supplicantRunning()) {
      ++mSupplicantRestarts;
      mActuator->startSupplicant();
      enter(kStartingWpa, nowMs);
      return;
    }
  }

  switch (mState) {
    case kIdle:
      break;

    case kStartingWpa:
      if (mActuator->supplicantRunning()) {
        beginConnect(nowMs);
      } else if (inState >= kSupplicantStartMs) {
        // Retry rather than give up: a failed start leaves the device with no
        // path back to the network at all.
        ++mSupplicantRestarts;
        mActuator->startSupplicant();
        enter(kStartingWpa, nowMs);
      }
      break;

    case kConnecting:
      if (mActuator->associated()) {
        mActuator->requestDhcp();
        enter(kObtainingIp, nowMs);
      } else if (inState >= kConnectTimeoutMs) {
        // The credentials look valid but the network is not there: a moved
        // router, a changed password, a different house. Waiting longer is a
        // black panel, so fall back to provisioning — while still retrying in
        // the background, because the usual cause is a slow reboot.
        mActuator->startSoftAp();
        mLastRetryMs = nowMs;
        enter(kProvisioning, nowMs);
      }
      break;

    case kObtainingIp:
      if (mActuator->hasAddress()) {
        enter(kOnline, nowMs);
      } else if (inState >= kDhcpTimeoutMs) {
        mActuator->requestDhcp();
        mStateSinceMs = nowMs;  // another lease attempt, same state
      }
      break;

    case kOnline:
      if (!mActuator->hasAddress()) {
        // Lease lost or the link dropped; re-associate from the top.
        beginConnect(nowMs);
      }
      break;

    case kProvisioning:
      if (mHaveCredentials && (nowMs - mLastRetryMs) >= kBackgroundRetryMs) {
        mLastRetryMs = nowMs;
        if (mActuator->supplicantRunning() && mActuator->connect(mSsid, mPsk)) {
          // Stay in provisioning until this actually lands: tearing the hotspot
          // down on a hopeful retry would strand a user mid-configuration.
          if (mActuator->associated()) {
            mActuator->requestDhcp();
            mActuator->stopSoftAp();
            enter(kObtainingIp, nowMs);
          }
        }
      }
      break;

    default:
      break;
  }
}

}  // namespace tcos
