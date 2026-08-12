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
 *   MUTATING half — startSupplicant, connect, requestDhcp, persistCredentials,
 *   startSoftAp, stopSoftAp, startScan — refuses unless /tmp/zos-allow-link
 *   exists. The sideload installer does not create it, so on a sideloaded
 *   install this code is compiled in, reachable, and physically inert. Arming
 *   an experiment is `adb shell touch /tmp/zos-allow-link`; a power cycle
 *   disarms it, because /tmp is tmpfs. On a FLASHED install the same half is
 *   always live — see platform/InstallMode.h for why that inversion is the
 *   only survivable reading.
 *
 * Two of those mutators write /data, the one partition a power cycle does NOT
 * clear, so a bad write there outlives the rescue that fixes everything else:
 * persistCredentials rewrites wpa_supplicant.conf and startSoftAp rewrites
 * hostapd.conf. Both copy the file they are about to replace to
 * `<name>.zos-bak` first, once, and neither ever touches an existing backup —
 * the first copy is the one taken while the device was still working.
 *
 * Everything that shells out or waits runs on a detached worker thread.
 * WifiPolicy::tick() is driven from the UI timer, and a hotspot bring-up stops
 * the supplicant, writes a file to jffs2 and spawns two daemons.
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
  void persistCredentials();
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

  /** The passphrase printed on the panel. Same as the stock firmware's. */
  static const char* softApPassphrase() { return "12345678"; }

  /** The hotspot's SSID for the panel and the setup page. */
  static std::string softApSsid();

  /**
   * `ZOS-` plus the last four hex digits of the WiFi MAC, e.g. `ZOS-A772`.
   *
   * Eight characters, and that is the measurement the name is chosen for:
   * 8 x 6 px = 48 px, the widest label that still fits the 52 px panel without
   * a marquee. A user copying a hotspot name off a scrolling line mistypes it,
   * and a mistyped SSID looks exactly like a wrong password.
   *
   * Derived rather than fixed because the stock firmware calls every unit
   * `U-Clock`: two clocks in one room are then indistinguishable, and a hotspot
   * sharing the stock name would leave the user unable to tell which of the two
   * systems they are configuring.
   *
   * Pure and inline so the host check can pin it; netinfo::macAddress() needs
   * an ioctl that does not exist on the build host.
   */
  static std::string apSsidFromMac(const std::string& mac) {
    std::string hex;
    for (size_t i = 0; i < mac.size(); ++i) {
      const char c = mac[i];
      if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
        hex.push_back(c);
      } else if (c >= 'a' && c <= 'f') {
        hex.push_back(static_cast<char>(c - 'a' + 'A'));
      }
    }
    // A MAC we could not read must not silently change the name's WIDTH: the
    // 48 px fit above is what the setup screen's layout is built on.
    if (hex.size() < 4) return std::string("ZOS-0000");
    return std::string("ZOS-") + hex.substr(hex.size() - 4);
  }

  /**
   * The hostapd.conf this firmware writes.
   *
   * Every key is copied from the template inside the device's own libzknet.so —
   * `interface=%s`, `driver=nl80211`, `ctrl_interface=/data/misc/wifi/hostapd`,
   * `ssid=%s`, `channel=6`, `ieee80211n=1`, `hw_mode=g`,
   * `ignore_broadcast_ssid=0`, then `wpa=2` / `rsn_pairwise=CCMP` — so this is
   * the configuration the stock firmware's own hotspot ran with on this exact
   * radio, not a guess. `hw_mode=g` is a literal in that binary, matching the
   * vendor's "2.4G only".
   *
   * ONE deliberate substitution: the stock path writes `wpa_psk=<64 hex>` and
   * derives that hash with PBKDF2 out of libssl. hostapd derives the identical
   * key itself from `wpa_passphrase=`, so the passphrase form keeps libssl out
   * of a firmware with a 1.2 MB link budget and changes nothing on the air.
   *
   * Pure and inline because it is the only half of the hotspot recipe a host
   * can check at all; everything else in it needs the radio.
   */
  static std::string hostapdConf(const std::string& ssid, const std::string& passphrase) {
    std::string out;
    out += "interface=wlan0\n";
    out += "driver=nl80211\n";
    out += "ctrl_interface=/data/misc/wifi/hostapd\n";
    out += "ssid=" + ssid + "\n";
    out += "channel=6\n";
    out += "ieee80211n=1\n";
    out += "hw_mode=g\n";
    out += "ignore_broadcast_ssid=0\n";
    out += "wpa=2\n";
    out += "wpa_key_mgmt=WPA-PSK\n";
    out += "rsn_pairwise=CCMP\n";
    out += "wpa_passphrase=" + passphrase + "\n";
    return out;
  }

 private:
  DeviceWifi(const DeviceWifi&);
  DeviceWifi& operator=(const DeviceWifi&);

  static void* dhcpMain(void* self);
  static void* persistMain(void* self);
  static void* softApMain(void* self);

  // Both run on softApMain's thread, never on the caller's.
  void bringUpSoftAp();
  void tearDownSoftAp();

  WpaCtrl mCtrl;
  // Guards mCtrl alone. The supplicant's control socket is a single datagram
  // descriptor with a bound path of its own, so a second WpaCtrl in this
  // process would unlink the first one's socket (see WpaCtrl::open) and the two
  // would fight. One instance, one lock, and the worker threads queue behind
  // the UI thread's STATUS the same way its own calls already do.
  mutable pthread_mutex_t mCtrlLock;
  mutable pthread_mutex_t mLock;
  std::string mLastState;
  bool mEverRefused;
  bool mDhcpInFlight;
  bool mSoftApWanted;
  bool mSoftApWorking;
  bool mPersistInFlight;
  // Monotonic ms of the last failed hotspot bring-up, or -1. Worker-thread
  // only. Rate-limits the retry, because every attempt stops the supplicant on
  // its way in and a broken hostapd would otherwise flap the radio forever.
  int mApFailedAtMs;
  // The network id the supplicant handed back for the credentials we are
  // currently trying. Reused instead of ADD_NETWORKing again on every retry:
  // the policy re-attempts the stored network every 20 s while provisioning,
  // and a fresh id per attempt would be a fresh network block per attempt in
  // the file SAVE_CONFIG eventually writes.
  int mNetworkId;
  std::string mNetworkSsid;
  std::string mNetworkPsk;
};

}  // namespace tcos

#endif  // PLATFORM_DEVICEWIFI_H_
