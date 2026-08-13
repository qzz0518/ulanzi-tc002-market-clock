#ifndef NET_BLEPROVISIONSESSION_H_
#define NET_BLEPROVISIONSESSION_H_

#include <stdint.h>

#include <string>
#include <vector>

#include "net/BleProtocol.h"

namespace tcos {

/**
 * What a connected console may ask this device to do, and what it is told back.
 *
 * Pure, and driven entirely by injected facts: the link's state arrives through
 * noteLink(), scan results through deliverScan(), time as a parameter. Nothing
 * here opens a socket, reads a file or touches the radio — the caller executes
 * the requests this object hands back. That split is the same one WifiPolicy
 * makes and for the same reason: the interesting states (a wrong password, a
 * lockout, a router that associates and never leases) are close to impossible to
 * stage on hardware on demand, and every one of them is a state a user will
 * reach.
 *
 * THE ONE RULE ABOUT THE RADIO. Both mutating requests — scan and join — are
 * refused here, before they are ever emitted, when the link guard is closed.
 * The console is told `link-locked` at that moment rather than after a timeout,
 * because a submit that is silently dropped leaves a user waiting for a
 * reconnection that was never going to happen. Same lesson as
 * SetupPortal::Backend::submit.
 *
 * THE PSK. It lives in this object for exactly as long as it takes the caller to
 * pick it up: takeRequest() moves it out and overwrites the member. It is never
 * a field of any `evt`, never a parameter to ProvisionLog, and never reaches the
 * panel — buildState has no slot for it and this class never formats one.
 *
 * AUTHORISATION IS NOT CONFIDENTIALITY. The six-digit code stops the neighbour
 * from reconfiguring the clock. It does not stop a sniffer: this link runs at
 * BT_SECURITY_LOW with no pairing, exactly as the vendor's own firmware does, so
 * the passphrase crosses the air in cleartext for the ~30 s a provisioning
 * session lasts. That is written down rather than papered over — raising the ATT
 * security level pulls in SMP pairing, which is unproven on this radio, and a
 * failed pairing on the only remaining provisioning path is a brick.
 */
class BleProvisionSession {
 public:
  /** Work the caller must perform against the real radio. */
  enum Request { kRequestNone, kRequestScan, kRequestJoin };

  /** What the caller observed about the link on this poll. */
  struct Link {
    Link() : online(false), joining(false), locked(false) {}
    bool online;
    // The policy is actively associating or asking for a lease. Distinguishing
    // this from "not online" is what makes a failure a failure rather than a
    // slow success.
    bool joining;
    // install::linkChangesAllowed() is false — sideloaded with no guard file.
    bool locked;
    std::string ssid;
    std::string ip;
    // wpa_supplicant's own wpa_state, the only evidence there is for WHY a join
    // failed. See classifyFailure.
    std::string wpaState;
  };

  struct Network {
    Network() : rssi(0), secured(false) {}
    std::string ssid;
    int rssi;
    bool secured;
  };

  // Five tries then a minute off. A six-digit code is 900,000 wide and every
  // attempt costs a GATT round trip, so this is not about entropy — it is about
  // a device that stops answering someone who is clearly guessing, and says so
  // on the panel instead of silently ignoring them.
  static const int kMaxCodeAttempts = 5;
  static const int kLockoutMs = 60000;
  // 20 networks is 60 notifications at ~30 ms — under two seconds. A longer list
  // is a longer wait for a user who has already seen their network go past.
  static const int kMaxScanNetworks = 20;
  // WifiPolicy::kConnectTimeoutMs (25 s) plus a DHCP margin. The policy has no
  // escape from kObtainingIp on purpose, so without a deadline of our own a
  // router that associates and never leases would leave the console on a
  // progress bar forever.
  static const int kJoinBudgetMs = 40000;
  // Beyond this the console is not draining and something is wrong; further
  // messages are dropped rather than grown into the heap of a 36 MB device.
  static const int kMaxOutbound = 64;

  BleProvisionSession();

  /** Identity for `evt hello`. Safe to call before anything else. */
  void configure(const std::string& name, const std::string& build, const std::string& mac);

  /**
   * A new advertising session: mints the code the panel shows.
   *
   * Called when advertising is (re-)enabled, not when a central connects — the
   * panel shows the code before anyone has connected, which is the whole point
   * of showing it. Refused while a lockout is running, so reconnecting cannot
   * roll a fresh code and start the guessing over.
   */
  void beginAdvertising(uint32_t seed, int nowMs);
  const std::string& code() const { return mCode; }

  void onConnect(int nowMs);
  void onDisconnect(int nowMs);
  bool connected() const { return mConnected; }
  bool authorised() const { return mAuthorised; }

  /** One complete, reassembled message from the central. */
  void onMessage(const std::string& body, int nowMs);
  /** The transport rejected a chunk; `why` is BleProtocol's static reason. */
  void onFrameError(const char* why, int nowMs);

  void noteLink(const Link& link, int nowMs);
  void deliverScan(const std::vector<Network>& nets, bool cached, int nowMs);
  /** The sweep produced nothing within the caller's budget, or was refused. */
  void noteScanFailed(int nowMs);

  bool takeOutbound(std::string* message);
  /** Moves the pending request out. `psk` is cleared from this object by it. */
  Request takeRequest(std::string* ssid, std::string* psk);

  /**
   * One redacted audit line per handled message, for the breadcrumb log.
   *
   * The caller never sees the message itself, and that is the point: the only
   * inbound document that ever carries a passphrase would otherwise be sitting
   * in a `log(tag, fields)` call in osLogic, one careless edit away from /data.
   * This builder is given the command word and the outcome and nothing else, so
   * — like ProvisionLog's own API — it structurally cannot receive the secret.
   */
  bool takeAudit(std::string* fields);

  /** The wire word for the current phase: locked/idle/scanning/joining/online/failed. */
  const char* phase() const;
  /** The last error code, or "" — the same vocabulary the wire uses. */
  const char* lastError() const { return mError; }
  /** The SSID the last join named, for the panel. */
  const std::string& targetSsid() const { return mTargetSsid; }
  bool scanning() const { return mPhase == kPhaseScanning; }
  bool joining() const { return mPhase == kPhaseJoining; }
  bool failed() const { return mPhase == kPhaseFailed; }
  bool online() const { return mPhase == kPhaseOnline; }
  int lockoutRemainingMs(int nowMs) const;

  /**
   * Why a join failed, from the supplicant states actually observed.
   *
   * Three answers, never guessed between:
   *
   *   COMPLETED but no address — the four-way handshake succeeded, so the key
   *     was right and the AP is real; what is missing is a lease. `dhcp`.
   *   ASSOCIATED or 4WAY_HANDSHAKE but never COMPLETED — association succeeded,
   *     which means the AP exists and accepted us at the 802.11 layer. The only
   *     step between there and COMPLETED is the key exchange. `bad-psk`.
   *   never associated at all — nothing with that name answered. `no-ap`.
   *
   * The temptation is to collapse these into one "connection failed", and it is
   * the console-side twin of a bug this firmware has already shipped once: a
   * plausible message that sends the user to fix the wrong thing.
   */
  static const char* classifyFailure(bool sawAssociated, bool sawHandshake,
                                     bool sawCompleted, bool hasAddress);

 private:
  enum Phase { kPhaseLocked, kPhaseIdle, kPhaseScanning, kPhaseJoining, kPhaseOnline,
               kPhaseFailed };

  BleProvisionSession(const BleProvisionSession&);
  BleProvisionSession& operator=(const BleProvisionSession&);

  void queue(const std::string& message);
  void emitState();
  void setPhase(Phase phase, const char* error);
  bool requireAuthorised(int nowMs);
  bool requireUnlocked();
  void checkCode(const std::string& supplied, int nowMs);
  void observeWpaState(const std::string& state);
  void audit(const char* cmd, const char* outcome);

  std::string mName;
  std::string mBuild;
  std::string mMac;
  std::string mCode;

  bool mConnected;
  bool mAuthorised;
  int mAttempts;
  // -1 when no lockout is running; otherwise when it started.
  int mLockedAtMs;

  Phase mPhase;
  Phase mPhaseBeforeScan;
  const char* mError;  // static strings only
  std::string mTargetSsid;
  std::string mIp;
  bool mLocked;

  // The join in flight: when it started, and what the supplicant was seen doing.
  int mJoinStartedMs;
  // Has the policy ever been seen actually working on this join? Until it has,
  // "not joining" means "not yet" — see noteLink.
  bool mSawJoining;
  bool mSawAssociated;
  bool mSawHandshake;
  bool mSawCompleted;

  Request mRequest;
  std::string mRequestSsid;
  std::string mRequestPsk;

  std::vector<std::string> mOutbound;
  std::vector<std::string> mAudit;
  // What emitState last published, so a 6 Hz poll does not become 6
  // notifications a second on an unchanged link.
  std::string mLastStateDoc;
};

}  // namespace tcos

#endif  // NET_BLEPROVISIONSESSION_H_
