#ifndef PLATFORM_DEVICEWIFI_H_
#define PLATFORM_DEVICEWIFI_H_

#include <pthread.h>

#include <string>
#include <vector>

#include "net/WifiPolicy.h"
#include "net/WpaCtrl.h"

namespace tcos {

/**
 * WifiPolicy's Actuator, against the real radio.
 *
 * Split down the middle on purpose:
 *
 *   READ-ONLY half — supplicantRunning, storedCredentials, associated,
 *   hasAddress, scanResults — always live. None of them can change what the
 *   radio is doing, so they are safe on a device whose only debug channel
 *   (adb over TCP) rides the link they are reporting on.
 *
 *   MUTATING half — startSupplicant, connect, requestDhcp, startSoftAp,
 *   stopSoftAp, startScan — refuses unless /tmp/zos-allow-link exists. The
 *   sideload installer does not create it, so on a normal install this code is
 *   compiled in, reachable, and physically inert. Arming an experiment is
 *   `adb shell touch /tmp/zos-allow-link`; a power cycle disarms it, because
 *   /tmp is tmpfs.
 *
 * The FlyThings WifiManager would implement all of this in a dozen lines and is
 * deliberately not used — see net/WpaCtrl.h and hostcheck/link-audit.sh for the
 * rmmod hazard that rules it out.
 */
class DeviceWifi : public WifiPolicy::Actuator {
 public:
  DeviceWifi();
  ~DeviceWifi();

  // --- WifiPolicy::Actuator -------------------------------------------------
  void startSupplicant();
  bool supplicantRunning();
  bool storedCredentials(std::string* ssid, std::string* psk);
  bool connect(const std::string& ssid, const std::string& psk);
  bool associated();
  bool requestDhcp();
  bool hasAddress();
  void startSoftAp();
  void stopSoftAp();
  bool softApRunning();
  void startScan();
  bool scanResults(std::vector<std::string>* out);

  /** True when the guard file is present. Re-read every time, never cached. */
  static bool linkChangesAllowed();

  /** Set once a mutator was refused, so the settings screen can say why. */
  bool everRefused() const { return mEverRefused; }

  /** wpa_state as of the last associated() call, for display. */
  const std::string& lastWpaState() const { return mLastState; }

  // The hotspot's own address. hasAddress() must NOT count it: while the AP is
  // up wlan0 carries this, and NetInfo would happily report it as "we have an
  // address", which reads to the policy as "we are online" and ends
  // provisioning before the user has typed anything.
  static const char* kSoftApAddress;

 private:
  DeviceWifi(const DeviceWifi&);
  DeviceWifi& operator=(const DeviceWifi&);

  static void* dhcpMain(void* self);

  WpaCtrl mCtrl;
  mutable pthread_mutex_t mLock;
  std::string mLastState;
  bool mEverRefused;
  bool mDhcpInFlight;
  bool mSoftApWanted;
};

}  // namespace tcos

#endif  // PLATFORM_DEVICEWIFI_H_
