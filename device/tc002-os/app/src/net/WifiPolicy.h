#ifndef NET_WIFIPOLICY_H_
#define NET_WIFIPOLICY_H_

#include <string>

namespace tcos {

/**
 * Decides what the network layer should be doing, without touching it.
 *
 * Every side effect is an injected call and time is a parameter, so the whole
 * policy — including the timeouts that matter most and are hardest to trigger on
 * demand — runs under clang++ on the host. That split exists because the failure
 * this class is built around (a moved router leaving valid-looking credentials
 * behind) is close to impossible to stage on real hardware repeatedly.
 *
 * Two device facts shape it, both verified on the unit:
 *
 *   1. /etc/init.rc declares wpa_supplicant `disabled` + `oneshot`. Nothing
 *      starts it at boot and nothing respawns it when it dies — the app does,
 *      exactly as libzknet does for the official firmware. Supervision is
 *      therefore ours, not init's.
 *   2. The DHCP client is in-process (NetUtils::dhcpRequestIp). Association
 *      alone leaves the device with no address, so a lease has to be requested
 *      explicitly after every successful connect.
 */
class WifiPolicy {
 public:
  enum State {
    kIdle,          // nothing attempted yet
    kStartingWpa,   // ctl.start issued, waiting for init.svc.wpa_supplicant
    kConnecting,    // associating with stored or supplied credentials
    kObtainingIp,   // associated; asking for a DHCP lease
    kOnline,        // has an address
    kProvisioning,  // SoftAP up, waiting for the user
  };

  // Injected side effects. The adapter that implements this is the only code in
  // the firmware that talks to zknet.
  class Actuator {
   public:
    virtual ~Actuator() {}
    // Ask init to (re)start the supplicant.
    virtual void startSupplicant() = 0;
    // "running" when init reports the service up.
    virtual bool supplicantRunning() = 0;
    // Credentials stored on the device, if any.
    virtual bool storedCredentials(std::string* ssid, std::string* psk) = 0;
    // Begin association. Returns false if the request could not even be issued.
    virtual bool connect(const std::string& ssid, const std::string& psk) = 0;
    virtual bool associated() = 0;
    // Request a DHCP lease; nothing else on the device will.
    virtual bool requestDhcp() = 0;
    virtual bool hasAddress() = 0;
    virtual void startSoftAp() = 0;
    virtual void stopSoftAp() = 0;
  };

  // Budgets. Association plus DHCP on a weak 2.4 GHz link has been observed
  // past 15 s, so 25 s leaves room without leaving the user staring at a panel
  // that looks broken.
  static const int kSupplicantStartMs = 4000;
  static const int kConnectTimeoutMs = 25000;
  static const int kDhcpTimeoutMs = 12000;
  // While provisioning, keep retrying the stored network: the usual cause is a
  // router that is merely slow to come back, and recovering by itself beats
  // making the user configure a network that already works.
  static const int kBackgroundRetryMs = 20000;

  explicit WifiPolicy(Actuator* actuator);

  // Kicks the state machine off. Safe to call once per boot.
  void begin(int nowMs);

  // Drive from the UI tick. Cheap: it only reads the actuator's predicates.
  void tick(int nowMs);

  // Credentials from the provisioning page.
  void applyCredentials(const std::string& ssid, const std::string& psk, int nowMs);

  State state() const { return mState; }
  bool isOnline() const { return mState == kOnline; }
  bool isProvisioning() const { return mState == kProvisioning; }
  const std::string& ssid() const { return mSsid; }

  // Counts how many times the supplicant had to be revived, so the settings
  // screen can show that something is wrong rather than silently flapping.
  int supplicantRestarts() const { return mSupplicantRestarts; }

 private:
  void enter(State state, int nowMs);
  void beginConnect(int nowMs);

  Actuator* mActuator;
  State mState;
  int mStateSinceMs;
  int mLastRetryMs;
  int mSupplicantRestarts;
  std::string mSsid;
  std::string mPsk;
  bool mHaveCredentials;
};

}  // namespace tcos

#endif  // NET_WIFIPOLICY_H_
