#ifndef PLATFORM_DEVICEPROVISIONING_H_
#define PLATFORM_DEVICEPROVISIONING_H_

#include <pthread.h>

#include <string>
#include <vector>

#include "net/SetupPortal.h"
#include "net/WpaCtrl.h"

namespace tcos {

/**
 * The provisioning page's view of this device.
 *
 * Lives under platform/ rather than net/ because it reads the real radio: the
 * SDK ships no usable network API for us (see net/WpaCtrl.h for why the
 * managers are off limits), so the answers come from wpa_supplicant's control
 * socket and from getifaddrs.
 *
 * THE GUARD FILE. Every method that would change the link checks for
 * /tmp/zos-allow-link and refuses without it. The sideload installer does not
 * create that file, so on a normal install this code is compiled in, reachable
 * from the UI, and physically inert. That is the mechanism behind "a sideloaded
 * device that is already online never has its link touched" — not a promise in
 * a comment, a file that has to exist.
 *
 * It lives in tmpfs on purpose: `adb shell touch /tmp/zos-allow-link` arms an
 * experiment, and a power cycle disarms it with no way to forget.
 */
class DeviceProvisioning : public SetupPortal::Backend {
 public:
  DeviceProvisioning();
  ~DeviceProvisioning();

  /** True when /tmp/zos-allow-link exists. Re-read each time, never cached. */
  static bool linkChangesAllowed();

  // --- SetupPortal::Backend -------------------------------------------------
  std::vector<std::string> scanResults();
  bool submit(const std::string& ssid, const std::string& psk, std::string* reason);
  std::string status();
  std::string ipAddress();

  /**
   * Credentials the user submitted but which have NOT been applied, because
   * applying them means reassociating the radio — the step that takes adb down
   * with it. Held here for the guarded connect path to pick up.
   */
  bool takePending(std::string* ssid, std::string* psk);
  bool hasPending() const;

  /** Last submission, for the settings screen. Empty when there was none. */
  std::string lastSubmittedSsid() const;

  /**
   * The sweep taken just before the hotspot went up.
   *
   * Raising the AP stops wpa_supplicant, and a stopped supplicant has no control
   * socket — so scanResults() below, which asks the live radio, returns NOTHING
   * for the entire time the page is actually being used. The page then sat on
   * "正在扫描…" forever with no way to name a network at all. WifiPolicy already
   * gathers this list before it starts the AP, exactly for this; it just had no
   * route to the page. This is that route.
   */
  void setScannedNetworks(const std::vector<std::string>& ssids);

  /**
   * What the WiFi policy made of the credentials this page submitted.
   *
   * Without it "failed" was unreachable for the only failure a user actually
   * hits — a wrong password — and the page reported success off nothing but the
   * presence of an address, which during provisioning is the hotspot's own
   * 192.168.100.1. It told every user their clock was online, in every case,
   * about 160 ms after they pressed 连接.
   */
  void noteLinkOutcome(bool online, bool backToProvisioning);

 private:
  DeviceProvisioning(const DeviceProvisioning&);
  DeviceProvisioning& operator=(const DeviceProvisioning&);

  mutable pthread_mutex_t mLock;
  WpaCtrl mCtrl;
  std::string mPendingSsid;
  std::string mPendingPsk;
  bool mHasPending;
  bool mRefusedForGuard;
  // Credentials handed to the policy and not yet judged, and the verdict once
  // there is one. Cleared by the next submit, so a second attempt starts clean.
  bool mApplying;
  bool mAttemptFailed;
  std::string mLastSsid;
  std::vector<std::string> mScanned;
};

}  // namespace tcos

#endif  // PLATFORM_DEVICEPROVISIONING_H_
