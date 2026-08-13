#ifndef NET_WIFIPOLICY_H_
#define NET_WIFIPOLICY_H_

#include <string>
#include <vector>

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
    kAdopting,      // waiting to see whether a link appears without our help
    kStartingWpa,   // ctl.start issued, waiting for init.svc.wpa_supplicant
    kConnecting,    // associating with stored or supplied credentials
    kObtainingIp,   // associated; asking for a DHCP lease
    kOnline,        // has an address
    kScanning,      // sweeping for networks BEFORE the hotspot goes up
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
    /**
     * Kick off a DHCP lease request and return immediately.
     *
     * MUST NOT BLOCK. tick() runs on the 25 fps UI timer, and the only DHCP
     * client available here (NetUtils::dhcpRequestIp) blocks for seconds up to
     * its own timeout — calling it inline froze the whole panel for the length
     * of a lease negotiation. The return value means "the request was issued",
     * never "an address was obtained"; hasAddress() is what reports the result.
     */
    virtual bool requestDhcp() = 0;
    virtual bool hasAddress() = 0;
    /**
     * Write the credentials now in use to the device's persistent config.
     *
     * Called exactly once per set of credentials, and only for credentials the
     * user supplied that have since been PROVEN by an address. Two reasons for
     * both halves of that rule, and they are the reason this is its own call
     * rather than something connect() does on the way past:
     *
     *   - The target is /data, the one partition a power cycle does not clear.
     *     A bad write there outlives the rescue that recovers everything else,
     *     so it happens as rarely as it possibly can and only after a backup.
     *   - The provisioning state retries the stored network every
     *     kBackgroundRetryMs for as long as the device stays stranded. Saving
     *     inside connect() would therefore write flash every twenty seconds,
     *     forever, on precisely the device that is already in trouble.
     *
     * MUST NOT BLOCK, for the same reason requestDhcp must not.
     */
    virtual void persistCredentials() = 0;
    virtual void startSoftAp() = 0;
    virtual void stopSoftAp() = 0;
    /**
     * True while the hotspot is actually up.
     *
     * Without this the policy cannot tell "hotspot serving" from "hostapd
     * failed to start" — and the second case is a brick: no home network, no
     * hotspot, no adb, and a panel cheerfully showing setup instructions for an
     * access point that does not exist.
     *
     * EXPENSIVE, unlike every other predicate here. The real implementation
     * walks /proc, because init has no service entry for hostapd and there is
     * therefore no property to read; that is a file open and read per process
     * on the box. Supervised on kSoftApSuperviseMs rather than every tick.
     */
    virtual bool softApRunning() = 0;
    /**
     * Begin a scan for nearby networks, and collect it.
     *
     * scanResults returns false until the sweep has PRODUCED something: still
     * running and "ran, found nothing yet" are the same answer, because the
     * supplicant cannot tell them apart either — SCAN_RESULTS reads its cache,
     * which answers instantly and is legitimately empty for the first seconds
     * of a fresh daemon's life. The real actuator once returned true for that
     * empty cache, and the whole scan budget below became dead code: the
     * policy read the empty cache on its first tick, declared the sweep done,
     * and raised the hotspot — killing the actual sweep mid-air and emptying
     * the setup page's dropdown for every first boot there ever was. The
     * timeout below is what bounds the wait; the actuator must never end it
     * early with nothing.
     *
     * The ordering is forced by the hardware, not by taste: bringing the
     * hotspot up stops wpa_supplicant, and a stopped supplicant cannot scan.
     * So the list the provisioning page offers has to be gathered BEFORE the
     * AP goes up, which is what the kScanning state exists for.
     */
    virtual void startScan() = 0;
    virtual bool scanResults(std::vector<std::string>* out) = 0;
  };

  // Budgets. Association plus DHCP on a weak 2.4 GHz link has been observed
  // past 15 s, so 25 s leaves room without leaving the user staring at a panel
  // that looks broken.
  static const int kSupplicantStartMs = 4000;
  static const int kConnectTimeoutMs = 25000;
  static const int kDhcpTimeoutMs = 12000;
  /**
   * kObtainingIp deliberately has NO escape to provisioning, and that is a
   * choice rather than an oversight.
   *
   * The tempting version — give up after N lease attempts and raise the hotspot
   * — was written, reviewed and removed. Two facts kill it. First, the fallback
   * is one-way: bringUpSoftAp() issues `ctl.stop wpa_supplicant` and /etc/init.rc
   * declares that service `disabled` + `oneshot`, so nothing brings it back; the
   * kProvisioning background retry below is gated on supplicantRunning() and
   * therefore cannot fire once a hotspot is actually on the air. A device that
   * escapes here stays a hotspot until a human submits credentials or pulls the
   * power. Second, the condition it fires on is common and transient: a clock
   * that boots faster than the router it is associated to sees exactly "no lease
   * yet", and a budget short enough to help a genuinely broken DHCP server is
   * short enough to strand a device whose router is merely mid-reboot.
   *
   * So this state waits, and re-asks every kDhcpTimeoutMs. A router that starts
   * leasing is joined with nobody doing anything; a router that never leases
   * leaves the device unreachable, which is a real gap and is written down in
   * docs/design/tc002-os-provisioning.md rather than closed by a timer. Closing
   * it needs a hotspot that can be torn back down and retested, which is a
   * change with its own evidence to gather.
   */
  // While provisioning, keep retrying the stored network: the usual cause is a
  // router that is merely slow to come back, and recovering by itself beats
  // making the user configure a network that already works.
  static const int kBackgroundRetryMs = 20000;
  // A sweep of the 2.4 GHz band takes 2-4 s on this radio, and the first SCAN
  // of a freshly started supplicant is routinely answered FAIL-BUSY and has to
  // be re-asked. Twelve seconds covers two full sweeps plus that retry, and the
  // price is honest: the WORST first boot reaches its hotspot 12 s later. The
  // alternative was a provisioning page with an empty network list — which is
  // not a slower page, it is a dead end that sends the user to typing an SSID
  // by hand on a phone keyboard, where one wrong character looks exactly like a
  // wrong password.
  static const int kScanTimeoutMs = 12000;
  // While the sweep stays empty, re-issue SCAN on this period. The first SCAN
  // can be swallowed (FAIL-BUSY, or the daemon still loading its config), and
  // nothing else would ever ask again — the budget above would then be 12 s of
  // waiting on a sweep that was never running.
  static const int kScanRetryMs = 4000;
  /**
   * How often the hotspot is checked, while provisioning, for still being up.
   *
   * A period rather than every tick, and this is the one state where that
   * matters: a device whose stored network is gone sits in kProvisioning
   * FOREVER, and Actuator::softApRunning() walks the whole of /proc because
   * hostapd has no init service entry to read a property from. tick() is driven
   * from the UI thread's link poll at roughly 6 Hz, so the old unconditional
   * check was a full process-table scan six times a second for the entire life
   * of a stranded device.
   *
   * Three seconds is bounded below by the bring-up, not by taste: hostapd is
   * started with -B, so it forks and the daemon takes a moment to appear under
   * /proc. A shorter period would read a hotspot that is still starting as one
   * that has died and start a second one on top of it.
   */
  static const int kSoftApSuperviseMs = 3000;
  /**
   * How long to wait for a link to appear before doing anything about it.
   *
   * Measured on a flashed install, where it matters: /bin/zkgui calls
   * NetManager::start() before it loads the app at all, but that call is
   * asynchronous — association and DHCP are still in flight when the app's
   * first tick runs. Deciding "no link, take over" at that instant produced
   * five supplicant restarts on a device that was about to be online anyway.
   *
   * Sideloaded the link is already up and this state is left on the first tick,
   * so the grace period costs nothing there.
   */
  static const int kAdoptGraceMs = 15000;

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

  /** Networks found by the last sweep, for the provisioning page to offer. */
  const std::vector<std::string>& scanned() const { return mScanned; }

  /**
   * Why the machine last headed for provisioning: "no-creds" (first boot,
   * nothing stored) or "connect-timeout" (stored credentials that stopped
   * working — a moved router, a changed password). Static strings, safe to
   * hold. The two are different investigations after a failed session, and the
   * breadcrumb line this feeds is the only place the distinction survives a
   * power cycle.
   */
  const char* provisionReason() const { return mProvisionReason; }

  /**
   * True when begin() found a working link and adopted it without issuing a
   * single command. Reported so the settings screen can say so, and so the
   * host check can assert that the adopt path really is side-effect free.
   */
  bool adopted() const { return mAdopted; }

  /** How many times the hotspot had to be revived after hostapd died. */
  int softApRestarts() const { return mSoftApRestarts; }

  // Counts how many times the supplicant had to be revived, so the settings
  // screen can show that something is wrong rather than silently flapping.
  int supplicantRestarts() const { return mSupplicantRestarts; }

 private:
  void enter(State state, int nowMs);
  void beginConnect(int nowMs);
  void beginProvisioning(int nowMs, const char* reason);

  Actuator* mActuator;
  State mState;
  int mStateSinceMs;
  int mLastRetryMs;
  int mLastSoftApCheckMs;
  // When SCAN was last issued, so an empty sweep is re-asked on kScanRetryMs
  // rather than waited on for the whole budget.
  int mLastScanIssueMs;
  // Static strings only — see provisionReason().
  const char* mProvisionReason;
  int mSupplicantRestarts;
  int mSoftApRestarts;
  std::string mSsid;
  std::string mPsk;
  bool mHaveCredentials;
  bool mAdopted;
  // True while credentials that came from the user are still unproven. Set by
  // applyCredentials and cleared the moment an address lands, which is the only
  // point at which they are worth writing to flash. Credentials that came out
  // of storedCredentials() never set it: they are already in the file.
  bool mPendingPersist;
  std::vector<std::string> mScanned;
};

}  // namespace tcos

#endif  // NET_WIFIPOLICY_H_
