#include "net/WifiPolicy.h"

namespace tcos {

WifiPolicy::WifiPolicy(Actuator* actuator)
    : mActuator(actuator),
      mState(kIdle),
      mStateSinceMs(0),
      mLastRetryMs(0),
      mLastSoftApCheckMs(0),
      mLastScanIssueMs(0),
      mProvisionReason(""),
      mSupplicantRestarts(0),
      mSoftApRestarts(0),
      mHaveCredentials(false),
      mAdopted(false),
      mHotspotHeld(false),
      mPendingPersist(false) {}

void WifiPolicy::enter(State state, int nowMs) {
  mState = state;
  mStateSinceMs = nowMs;
  // Entering provisioning has just asked for the hotspot. hostapd is started
  // with -B and daemonises, so it is not in /proc yet; stamping the supervision
  // clock here gives it a full period to appear instead of being declared dead
  // on the very next tick.
  if (state == kProvisioning) mLastSoftApCheckMs = nowMs;
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

  // Not adoptable YET is not the same as not adoptable. On a flashed install the
  // framework has already asked for the network but is still associating when
  // this runs, so wait before touching anything — see kAdoptGraceMs.
  enter(kAdopting, nowMs);
}

void WifiPolicy::applyCredentials(const std::string& ssid, const std::string& psk,
                                  int nowMs) {
  mSsid = ssid;
  mPsk = psk;
  mHaveCredentials = !ssid.empty();
  // These came from a person, so they are the ONLY credentials in this class
  // that are not already on disk — and losing them is the failure that makes a
  // flashed device unreachable, because the next power cycle would put it back
  // in provisioning with nothing to try. Marked here, written once an address
  // proves them; see Actuator::persistCredentials.
  mPendingPersist = mHaveCredentials;
  if (mActuator != 0) mActuator->stopSoftAp();
  beginConnect(nowMs);
}

void WifiPolicy::setHotspotHold(bool held, int nowMs) {
  if (mHotspotHeld == held) return;
  mHotspotHeld = held;
  if (mActuator == 0) return;

  if (held) {
    if (mState == kProvisioning) {
      // The one trip nothing else in this firmware can make: back off the
      // hotspot and onto the station radio. Safe to do exactly here and nowhere
      // else, because the person whose session it would interrupt is the person
      // asking — they are on the BLE link, not on the hotspot's web page.
      mActuator->stopSoftAp();
      mActuator->startSupplicant();
      enter(kStartingWpa, nowMs);
    } else if (mState == kScanning) {
      // The sweep was gathered for a hotspot that is now not going up.
      mLastRetryMs = nowMs;
      enter(kStandby, nowMs);
    }
    return;
  }

  // Released. A device parked in standby has nobody driving it any more, so the
  // hotspot fallback is owed to whoever comes next.
  if (mState == kStandby) beginProvisioning(nowMs, mProvisionReason);
}

// Scan first, hotspot second. Always in that order — see Actuator::startScan.
void WifiPolicy::beginProvisioning(int nowMs, const char* reason) {
  mProvisionReason = reason;
  mScanned.clear();
  if (mHotspotHeld) {
    // No sweep either: the console does its own, on demand, over a link that
    // does not cost the radio. Gathering one here would only be a SCAN nobody
    // reads.
    mLastRetryMs = nowMs;
    enter(kStandby, nowMs);
    return;
  }
  mActuator->startScan();
  mLastScanIssueMs = nowMs;
  enter(kScanning, nowMs);
}

void WifiPolicy::beginConnect(int nowMs) {
  if (mActuator == 0) return;
  if (!mHaveCredentials) {
    beginProvisioning(nowMs, "no-creds");
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
  //
  // kStandby is in the list and kProvisioning is not, and that difference is the
  // whole point of the two states: standby keeps the station radio because a
  // console is about to ask it to scan, while a real hotspot has deliberately
  // stopped the supplicant and reviving it there would fight hostapd for wlan0.
  if (mState == kConnecting || mState == kObtainingIp || mState == kOnline ||
      mState == kStandby) {
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

    case kAdopting:
      if (mActuator->supplicantRunning() && mActuator->hasAddress()) {
        mAdopted = true;
        enter(kOnline, nowMs);
      } else if (inState >= kAdoptGraceMs) {
        // Nobody else is going to bring this up. Now it is ours.
        mActuator->startSupplicant();
        enter(kStartingWpa, nowMs);
      }
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
        beginProvisioning(nowMs, "connect-timeout");
      }
      break;

    case kScanning:
      // Wait for the sweep to PRODUCE something, re-asking while it stays
      // empty, and only then raise the hotspot — or raise it anyway once the
      // budget is spent, because a device that never offers a way in is worse
      // than an empty list. The actuator answers false for an empty sweep (see
      // Actuator::scanResults for the year this ordering was broken), so the
      // exit here is "first non-empty result, or timeout" and nothing else.
      if (mActuator->scanResults(&mScanned) || inState >= kScanTimeoutMs) {
        mActuator->startSoftAp();
        mLastRetryMs = nowMs;
        enter(kProvisioning, nowMs);
      } else if ((nowMs - mLastScanIssueMs) >= kScanRetryMs) {
        // The first SCAN can be swallowed whole — FAIL-BUSY from a supplicant
        // mid-start is routine — and nothing else ever asks again. Re-issuing
        // into a sweep already running is harmless: the supplicant answers
        // FAIL-BUSY and keeps sweeping.
        mLastScanIssueMs = nowMs;
        mActuator->startScan();
      }
      break;

    case kObtainingIp:
      if (mActuator->hasAddress()) {
        // An address is the proof, and this is the only place that decides the
        // credentials are worth keeping. Association alone is not enough: it
        // says the password was right, not that the network is usable, and the
        // write it triggers lands on the one partition a power cycle cannot
        // undo.
        if (mPendingPersist) {
          mPendingPersist = false;
          mActuator->persistCredentials();
        }
        enter(kOnline, nowMs);
      } else if (inState >= kDhcpTimeoutMs) {
        // Ask again, and keep asking. There is deliberately no escape from this
        // state — see kDhcpTimeoutMs's comment for why a lease budget that falls
        // back to the hotspot is a worse device than one that waits.
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
      //
      // ON A TIMER, though, and only here. This is the state a stranded device
      // never leaves, and softApRunning() is the one predicate in the Actuator
      // that costs a walk of /proc — asking six times a second, forever, is the
      // most expensive thing this class could possibly do in the situation it
      // exists to survive. See kSoftApSuperviseMs for the floor on the period.
      if ((nowMs - mLastSoftApCheckMs) >= kSoftApSuperviseMs) {
        mLastSoftApCheckMs = nowMs;
        if (!mActuator->softApRunning()) {
          ++mSoftApRestarts;
          mActuator->startSoftAp();
        }
      }
      // Keep trying the stored network in the background. Note the guard: with
      // a real hotspot on the air the supplicant is STOPPED — this radio has no
      // concurrent AP+station mode — so this branch only fires while the AP is
      // absent or still coming up. Cycling the radio off the hotspot to test a
      // router that is probably still down is deliberately not done: it would
      // drop a user halfway through typing their password, and that user is the
      // one recovery path a flashed device has.
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

    case kStandby:
      // kProvisioning's background retry, without the hotspot to supervise. The
      // guard on supplicantRunning() that kProvisioning needs is gone too: in
      // this state the supplicant is supposed to be up, and the block above has
      // already revived it if it was not.
      if (mHaveCredentials && (nowMs - mLastRetryMs) >= kBackgroundRetryMs) {
        mLastRetryMs = nowMs;
        if (mActuator->connect(mSsid, mPsk) && mActuator->associated()) {
          mActuator->requestDhcp();
          enter(kObtainingIp, nowMs);
        }
      }
      break;

    default:
      break;
  }
}

}  // namespace tcos
