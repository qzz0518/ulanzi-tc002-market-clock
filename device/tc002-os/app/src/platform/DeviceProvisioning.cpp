#include "platform/DeviceProvisioning.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <os/SystemProperties.h>

#include "base/log.h"
#include "platform/DeviceWifi.h"
#include "platform/InstallMode.h"
#include "platform/ProvisionLog.h"
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

// The scan cache: SSIDs only, one per line, on the partition a power cycle
// does not clear. See DeviceProvisioning::setScannedNetworks for why it
// exists; the .tmp sibling is for the atomic rename (same directory, same
// jffs2 — rename cannot cross filesystems).
const char* kScanCachePath = "/data/zos-scan-cache.txt";
const char* kScanCacheTmpPath = "/data/zos-scan-cache.txt.tmp";
// A dropdown longer than this is not a dropdown anymore, and the cache is a
// bounded write to the credentials partition, not an archive.
const size_t kScanCacheMaxSsids = 32;

}  // namespace

DeviceProvisioning::DeviceProvisioning()
    : mHasPending(false),
      mRefusedForGuard(false),
      mApplying(false),
      mAttemptFailed(false),
      mCacheLoaded(false),
      mScannedFromCache(false),
      mServedFromCache(false),
      mLastLoggedScanCount(-1) {
  ::pthread_mutex_init(&mLock, 0);
}

DeviceProvisioning::~DeviceProvisioning() { ::pthread_mutex_destroy(&mLock); }

bool DeviceProvisioning::linkChangesAllowed() { return install::linkChangesAllowed(); }

void DeviceProvisioning::ensureCacheLoadedLocked() {
  if (mCacheLoaded) return;
  mCacheLoaded = true;
  if (!mScanned.empty()) return;  // this boot's radio already answered; it wins
  FILE* f = ::fopen(kScanCachePath, "r");
  if (f == 0) return;
  char line[128];  // an SSID is at most 32 bytes; the margin absorbs junk safely
  std::vector<std::string> ssids;
  while (::fgets(line, sizeof(line), f) != 0 && ssids.size() < kScanCacheMaxSsids) {
    std::string text(line);
    while (!text.empty() && (text[text.size() - 1] == '\n' || text[text.size() - 1] == '\r')) {
      text.erase(text.size() - 1);
    }
    if (!text.empty()) ssids.push_back(text);
  }
  ::fclose(f);
  if (!ssids.empty()) {
    mScanned = ssids;
    mScannedFromCache = true;
  }
}

void DeviceProvisioning::persistScanCacheLocked() {
  // Atomic on purpose: a power cut mid-write must leave the previous list, not
  // half of this one — the reader is the NEXT boot's dropdown.
  FILE* f = ::fopen(kScanCacheTmpPath, "w");
  if (f == 0) return;
  bool ok = true;
  size_t written = 0;
  for (size_t i = 0; i < mScanned.size() && written < kScanCacheMaxSsids; ++i) {
    // SSIDs only — never a PSK, never the flags: this file is read back into a
    // page anyone who joins the hotspot can see. A name carrying a line break
    // would corrupt the line-per-entry format, so it is skipped, not mangled.
    if (mScanned[i].find('\n') != std::string::npos ||
        mScanned[i].find('\r') != std::string::npos) {
      continue;
    }
    if (::fprintf(f, "%s\n", mScanned[i].c_str()) < 0) ok = false;
    ++written;
  }
  if (::fflush(f) != 0) ok = false;
  // fsync before the rename: jffs2 keeps the rename atomic, but only the data
  // that reached it. The reader is a boot AFTER a power cycle by definition.
  if (ok) ok = ::fsync(::fileno(f)) == 0;
  ::fclose(f);
  if (!ok || written == 0) {
    ::unlink(kScanCacheTmpPath);
    return;
  }
  ::rename(kScanCacheTmpPath, kScanCachePath);
}

std::vector<std::string> DeviceProvisioning::scanResults() {
  std::vector<std::string> ssids;
  bool live = false;

  ::pthread_mutex_lock(&mLock);
  // Ask init before touching the socket: while the hotspot is up the
  // supplicant is STOPPED, and every open() was a guaranteed ECONNREFUSED paid
  // once per 2 s page poll for the whole session. A property read is free and
  // answers the same question first.
  char svc[64];
  svc[0] = '\0';
  SystemProperties::getString("init.svc.wpa_supplicant", svc, "");
  const bool supplicantUp = ::strcmp(svc, "running") == 0;
  // Reopened per call rather than held: while the hotspot is up the supplicant
  // is stopped and its socket is gone, so a cached descriptor would be dead
  // exactly when this matters most.
  if (supplicantUp && mCtrl.open("wlan0")) {
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
  live = !ssids.empty();
  // Nothing live means the supplicant is gone, and while the hotspot is up it
  // always is — which is exactly when this page is being read. Fall back to the
  // sweep WifiPolicy took on the way in, seeded from the previous boot's cache
  // when this boot never completed one. A live answer still wins when there is
  // one: on the LAN path (a laptop opening this page while the device is online)
  // the radio is the fresher source.
  if (!live) {
    ensureCacheLoadedLocked();
    ssids = mScanned;
  }
  mServedFromCache = !live && mScannedFromCache && !ssids.empty();

  // PORTAL_HIT, on CHANGE only: the page polls every 2 s and the breadcrumb
  // partition is jffs2. One line proves the phone reached the portal at all —
  // the half of a failed session no server-side check can otherwise show — and
  // what its dropdown was actually offered.
  if (static_cast<int>(ssids.size()) != mLastLoggedScanCount) {
    mLastLoggedScanCount = static_cast<int>(ssids.size());
    char fields[64];
    ::snprintf(fields, sizeof(fields), "path=/scan n=%d cached=%d",
               static_cast<int>(ssids.size()), mServedFromCache ? 1 : 0);
    ProvisionLog::device().log("PORTAL_HIT", fields);
  }
  ::pthread_mutex_unlock(&mLock);

  return ssids;
}

bool DeviceProvisioning::scanResultsAreCached() {
  ::pthread_mutex_lock(&mLock);
  const bool value = mServedFromCache;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

void DeviceProvisioning::setScannedNetworks(const std::vector<std::string>& ssids) {
  ::pthread_mutex_lock(&mLock);
  ensureCacheLoadedLocked();
  // An empty sweep never replaces a list that has something in it: the radio
  // finding nothing on one pass is not evidence that the networks went away, and
  // an emptied list is a page the user cannot use.
  if (!ssids.empty()) {
    const bool changed = mScannedFromCache || ssids != mScanned;
    mScanned = ssids;
    mScannedFromCache = false;  // fresh from this boot's radio
    // Persist only what changed: entering provisioning happens once per
    // stranding, but jffs2 writes are still counted, not assumed.
    if (changed) persistScanCacheLocked();
  }
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
    ProvisionLog::device().log("PROV_SUBMIT", "ssid=" + ssid + " psk=redacted accepted=0");
    *reason = install::refusalReason();
    return false;
  }
  mRefusedForGuard = false;
  mAttemptFailed = false;  // a fresh attempt starts without the last one's verdict
  mPendingSsid = ssid;
  mPendingPsk = psk;
  mHasPending = true;
  ::pthread_mutex_unlock(&mLock);
  // The literal `psk=redacted`, always. This call is the only place in the
  // firmware that holds the user's key next to a logger, and the redaction
  // happens HERE, before any string is built — ProvisionLog's API has no
  // argument a secret could arrive through, which is the property the host
  // check pins. The SSID is worth the line: it is what the user typed, and a
  // typo'd SSID and a wrong password are indistinguishable from the phone.
  ProvisionLog::device().log("PROV_SUBMIT", "ssid=" + ssid + " psk=redacted accepted=1");
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
