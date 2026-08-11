#include "platform/DeviceProvisioning.h"

#include <sys/stat.h>

#include "base/log.h"
#include "platform/InstallMode.h"
#include "platform/NetInfo.h"

namespace tcos {

namespace {


}  // namespace

DeviceProvisioning::DeviceProvisioning() : mHasPending(false), mRefusedForGuard(false) {
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
  ::pthread_mutex_unlock(&mLock);

  return ssids;
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
  const bool pending = mHasPending;
  ::pthread_mutex_unlock(&mLock);

  if (refused) return "failed";
  if (pending) return "connecting";
  return netinfo::ipAddress().empty() ? "provisioning" : "online";
}

std::string DeviceProvisioning::ipAddress() { return netinfo::ipAddress(); }

}  // namespace tcos
