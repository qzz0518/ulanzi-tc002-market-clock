#include "net/WifiPolicy.h"

namespace tcos {

WifiPolicy::WifiPolicy(Actuator* actuator)
    : mActuator(actuator),
      mState(kIdle),
      mStateSinceMs(0),
      mLastRetryMs(0),
      mSupplicantRestarts(0),
      mSoftApRestarts(0),
      mHaveCredentials(false),
      mAdopted(false) {}

void WifiPolicy::enter(State state, int nowMs) {
  mState = state;
  mStateSinceMs = nowMs;
}

void WifiPolicy::begin(int nowMs) {
  if (mActuator == 0) return;
  mHaveCredentials = mActuator->storedCredentials(&mSsid, &mPsk);

  // ADOPT a link that is already up rather than rebuilding it, and do it before
  // issuing any command at all — the two calls below are both predicates.
  //
  // This is the single most important line in the file. Every sideload starts
  // here: the firmware being replaced left wpa_supplicant associated, and a
  // sideload does not stop it. Reconnecting would drop a working network for
  // several seconds to arrive back exactly where it started, and it would take
  // adb down with it — adb reaches this device over TCP on that same link, so
  // the only recovery is someone physically power-cycling the clock.
  //
  // It is also simply correct for a flashed install: a warm restart whose
  // supplicant came up fine has nothing to reconnect. Deliberately NOT keyed on
  // /tmp/tc002-sideload.id — "a working link is not to be touched" needs no
  // mode flag to be true.
  if (mActuator->supplicantRunning() && mActuator->hasAddress()) {
    mAdopted = true;
    enter(kOnline, nowMs);
    return;
  }

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

// Scan first, hotspot second. Always in that order — see Actuator::startScan.
void WifiPolicy::beginProvisioning(int nowMs) {
  mScanned.clear();
  mActuator->startScan();
  enter(kScanning, nowMs);
}

void WifiPolicy::beginConnect(int nowMs) {
  if (mActuator == 0) return;
  if (!mHaveCredentials) {
    beginProvisioning(nowMs);
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
        mLastRetryMs = nowMs;
        beginProvisioning(nowMs);
      }
      break;

    case kScanning:
      // Collect what we can, then raise the hotspot whether or not the sweep
      // finished. An empty list costs the user a typed SSID; waiting forever
      // costs them a device that never offers a way in at all.
      if (mActuator->scanResults(&mScanned) || inState >= kScanTimeoutMs) {
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
      // Supervise hostapd the same way the supplicant is supervised. Nothing
      // else would notice it dying, and the result is a device with no home
      // network, no hotspot and no adb, showing setup instructions for an
      // access point that is not on the air.
      if (!mActuator->softApRunning()) {
        ++mSoftApRestarts;
        mActuator->startSoftAp();
      }
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
