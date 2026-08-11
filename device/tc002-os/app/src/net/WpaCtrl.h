#ifndef NET_WPACTRL_H_
#define NET_WPACTRL_H_

#include <string>
#include <vector>

namespace tcos {

/**
 * Client for wpa_supplicant's control socket.
 *
 * The FlyThings SDK ships a WifiManager that would answer all of this, and it
 * is deliberately not used: that class reaches the radio through NetManager,
 * whose power path reloads the WiFi driver via insmod/rmmod against module
 * directories that DO NOT EXIST on this unit (/late/lib/modules and
 * /config/lib/modules are absent; the modules are in /lib/modules/4.9.84). One
 * trip through that branch unloads aic8800_fdrv with no way back — wlan0
 * disappears and adb, which rides that link, dies with it.
 *
 * Talking to the supplicant directly costs about two hundred lines and touches
 * nothing but a datagram socket. hostcheck/link-audit.sh fails the build if the
 * manager symbols ever reappear.
 *
 * This class exposes READ-ONLY commands only. STATUS and SCAN_RESULTS cannot
 * change what the radio is doing — SCAN_RESULTS returns the last sweep's cache
 * rather than starting one. Commands that do change it (SCAN, ADD_NETWORK,
 * SELECT_NETWORK, SAVE_CONFIG) are a separate, guarded step; keeping them out
 * of this class is what makes it safe to call from a device that is online and
 * carrying the only debug channel there is.
 */
class WpaCtrl {
 public:
  struct Network {
    std::string ssid;
    int signalDbm;   // negative; 0 when the field was unparseable
    bool secured;    // any of WPA/WPA2/WEP in the flags
  };

  WpaCtrl();
  ~WpaCtrl();

  /**
   * Connects to the supplicant's socket for `iface`. Returns false when the
   * socket is absent, which is the normal state while the hotspot is up (the
   * supplicant is stopped then) and not an error worth surfacing.
   */
  bool open(const std::string& iface = "wlan0");
  void close();
  bool isOpen() const { return mFd >= 0; }

  /** Raw request/response. Only used by the two accessors below. */
  bool request(const std::string& command, std::string* reply, int timeoutMs = 1500);

  /** wpa_state from STATUS, e.g. "COMPLETED", "SCANNING", "DISCONNECTED". */
  bool status(std::string* wpaState, std::string* ssid, std::string* ipAddress);

  /** The last sweep's cache, strongest first, de-duplicated by SSID. */
  bool scanResults(std::vector<Network>* out);

  // Pure parsers, asserted on the host against real captured replies. The
  // socket half cannot be exercised there, but every way a reply can be
  // malformed can.
  static bool parseStatus(const std::string& reply, std::string* wpaState,
                          std::string* ssid, std::string* ipAddress);
  static bool parseScanResults(const std::string& reply, std::vector<Network>* out);

  /** True when a wpa_supplicant flags field means the network needs a key. */
  static bool flagsAreSecured(const std::string& flags);

 private:
  WpaCtrl(const WpaCtrl&);
  WpaCtrl& operator=(const WpaCtrl&);

  int mFd;
  std::string mLocalPath;  // our own bound socket; unlinked on close
};

}  // namespace tcos

#endif  // NET_WPACTRL_H_
