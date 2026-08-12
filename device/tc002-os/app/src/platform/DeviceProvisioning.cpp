#include "platform/DeviceProvisioning.h"

#include <sys/stat.h>

#include "base/log.h"
#include "platform/DeviceWifi.h"
#include "platform/InstallMode.h"
#include "platform/NetInfo.h"

namespace tcos {

namespace {

// The same three exclusions DeviceWifi::hasAddress() applies, and for the same
// reasons: an empty string is no interface, 0.0.0.0 is an interface whose
// address has just been cleared (which is what the hotspot teardown leaves
// behind for a moment), and the SoftAP's own gateway is the address wlan0
// carries WHILE the user is still typing their password into this page.
bool isRealAddress(const std::string& ip) {
  if (ip.empty() || ip == "0.0.0.0") return false;
  return ip != DeviceWifi::kSoftApAddress;
}

}  // namespace

DeviceProvisioning::DeviceProvisioning()
    : mHasPending(false), mRefusedForGuard(false), mApplying(false), mAttemptFailed(false) {
  ::pthread_mutex_init(&mLock, 0);
}

DeviceProvisioning::~DeviceProvisioning() { ::pthread_mutex_destroy(&mLock); }

bool DeviceProvisioning::linkChangesAllowed() { return install::linkChangesAllowed(); }

std::vector<std::string> DeviceProvisioning::scanResults() {
  std::vector<std::string> ssids;

  ::pthread_mutex_lock(&mLock);
  // Reopened per call rather than held: while the hotspot is up the supplicant
  // is stopped and its socket is gone, so a cached descriptor would be dead
  // exactly when this matters most.
  if (mCtrl.open("wlan0")) {
    std::vector<WpaCtrl::Network> nets;
    if (mCtrl.scanResults(&nets)) {
      // Strongest first. Insertion sort: this list is a couple of dozen entries
      // and runs once per page load.
      for (size_t i = 1; i < nets.size(); ++i) {
        const WpaCtrl::Network key = nets[i];
        size_t j = i;
        while (j > 0 && nets[j - 1].signalDbm < key.signalDbm) {
          nets[j] = nets[j - 1];
          --j;
        }
        nets[j] = key;
      }
      for (size_t i = 0; i < nets.size(); ++i) ssids.push_back(nets[i].ssid);
    }
    mCtrl.close();
  }
  // Nothing live means the supplicant is gone, and while the hotspot is up it
  // always is — which is exactly when this page is being read. Fall back to the
  // sweep WifiPolicy took on the way in. A live answer still wins when there is
  // one: on the LAN path (a laptop opening this page while the device is online)
  // the radio is the fresher source.
  if (ssids.empty()) ssids = mScanned;
  ::pthread_mutex_unlock(&mLock);

  return ssids;
}

void DeviceProvisioning::setScannedNetworks(const std::vector<std::string>& ssids) {
  ::pthread_mutex_lock(&mLock);
  // An empty sweep never replaces a list that has something in it: the radio
  // finding nothing on one pass is not evidence that the networks went away, and
  // an emptied list is a page the user cannot use.
  if (!ssids.empty()) mScanned = ssids;
  ::pthread_mutex_unlock(&mLock);
}

void DeviceProvisioning::noteLinkOutcome(bool online, bool backToProvisioning) {
  ::pthread_mutex_lock(&mLock);
  if (online) {
    mApplying = false;
    mAttemptFailed = false;
  } else if (mApplying && backToProvisioning) {
    // The policy tried these credentials and gave up on them — a wrong
    // password, or a network that is not there. Either way the user has to be
    // told, and this is the only moment anything in the firmware knows.
    mApplying = false;
    mAttemptFailed = true;
  }
  ::pthread_mutex_unlock(&mLock);
}

bool DeviceProvisioning::submit(const std::string& ssid, const std::string& psk,
                                std::string* reason) {
  reason->clear();
  ::pthread_mutex_lock(&mLock);
  mLastSsid = ssid;
  if (!linkChangesAllowed()) {
    // Refused, and it says so AT THE MOMENT OF REFUSAL rather than pretending to
    // work and letting the status flip to "failed" a poll later. A page that
    // accepts credentials and silently does nothing is worse than one that
    // reports the refusal: the user would sit watching a device that was never
    // going to reconnect.
    mRefusedForGuard = true;
    mHasPending = false;
    ::pthread_mutex_unlock(&mLock);
    LOGE_TRACE("provisioning: refused; sideloaded and /tmp/zos-allow-link absent");
    *reason = install::refusalReason();
    return false;
  }
  mRefusedForGuard = false;
  mAttemptFailed = false;  // a fresh attempt starts without the last one's verdict
  mPendingSsid = ssid;
  mPendingPsk = psk;
  mHasPending = true;
  ::pthread_mutex_unlock(&mLock);
  return true;
}

bool DeviceProvisioning::takePending(std::string* ssid, std::string* psk) {
  ::pthread_mutex_lock(&mLock);
  const bool had = mHasPending;
  if (had) {
    *ssid = mPendingSsid;
    *psk = mPendingPsk;
    mHasPending = false;
    // Handed over and now unproven. Until the policy reports back, "connecting"
    // is the honest answer — not "online", which is what an address on wlan0
    // used to buy while that address was the hotspot's own.
    mApplying = true;
    // The password is not kept a moment longer than the handover needs. It is
    // the user's home network key and this process also serves an HTTP page.
    mPendingPsk.clear();
  }
  ::pthread_mutex_unlock(&mLock);
  return had;
}

bool DeviceProvisioning::hasPending() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mHasPending;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

std::string DeviceProvisioning::lastSubmittedSsid() const {
  ::pthread_mutex_lock(&mLock);
  const std::string value = mLastSsid;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

std::string DeviceProvisioning::status() {
  ::pthread_mutex_lock(&mLock);
  const bool refused = mRefusedForGuard;
  const bool failed = mAttemptFailed;
  const bool busy = mHasPending || mApplying;
  ::pthread_mutex_unlock(&mLock);

  if (refused || failed) return "failed";
  if (busy) return "connecting";
  // An address, but only one that means we joined somebody else's network. The
  // unqualified test this used to be answered "online" from the hotspot's own
  // gateway and from the 0.0.0.0 the teardown leaves behind — so the page
  // congratulated the user on connecting to their router while the device was
  // still its own access point, and never once said otherwise.
  return isRealAddress(netinfo::ipAddress()) ? "online" : "provisioning";
}

std::string DeviceProvisioning::ipAddress() { return netinfo::ipAddress(); }

}  // namespace tcos
