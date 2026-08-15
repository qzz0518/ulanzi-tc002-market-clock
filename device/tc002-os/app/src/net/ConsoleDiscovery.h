#ifndef NET_CONSOLEDISCOVERY_H_
#define NET_CONSOLEDISCOVERY_H_

#include <pthread.h>
#include <stdint.h>

#include <string>

namespace tcos {

/**
 * Finding the console again after it moved.
 *
 * THE INCIDENT THIS EXISTS FOR. /data/zos-host holds one address and this
 * firmware polls it for the rest of its life. It is learned once — from a
 * sideload bundle's `host` file, or from a BLE join — and the console is a Bun
 * process on a laptop holding a DHCP lease. The day that lease moved from .108
 * to .114 the clock kept knocking on .108 forever. The panel still told the
 * time, so nothing looked wrong; telemetry stopped, the console could not see
 * the device, and an OTA request could never reach it. Silent from both ends,
 * and the only fix was a cable and `adb push`.
 *
 * A HINT, NOT A COMMAND. Rewriting /data/zos-host is the most sensitive thing
 * this firmware can be told to do — it is the URL it will poll forever — so a
 * UDP datagram from a stranger gets four gates before it becomes one:
 *
 *   1. THE DEVICE IS ALREADY LOST. No successful pull for kLostMs. A clock that
 *      is talking to its console does not even PARSE these — see poll(), where
 *      the check happens before the bytes are looked at.
 *   2. THE HINT IS ON THE DEVICE'S OWN /24, compared against wlan0's address.
 *      Not much of a boundary, but it stops a hint from another subnet
 *      redirecting the clock.
 *   3. THE HINT DIFFERS from the address already in use. Otherwise there is
 *      nothing to do, and doing it would restart the pull loop on every beacon.
 *   4. THE CANDIDATE ANSWERS AS A CONSOLE. Exactly one HTTP GET before anything
 *      is written. A host that merely shouts on the wire is not a console.
 *
 * NO CRYPTO, DELIBERATELY. No shared secret, no HMAC. The console's write API is
 * guarded only by a same-origin check, and a same-origin check stops browsers,
 * not `curl`: anyone already on this LAN can push firmware to this clock today
 * through the console's own upgrade route. The LAN is therefore ALREADY the
 * trust boundary and this does not widen it. What BleProvisionSession's pairing
 * code guards is a DIFFERENT attacker — someone in Bluetooth range who is *not*
 * on the WiFi — and nothing here touches that rule.
 *
 * Its own thread, because both halves block: recvfrom waits for a datagram that
 * may never come, and the probe is a whole HTTP exchange. The UI tick only calls
 * noteLink() (three assignments under a lock) and takeAdoption() (a one-shot
 * mailbox, the same shape as BleProvisionSession::takeConsoleHost).
 */
class ConsoleDiscovery {
 public:
  /** What one beacon line said. */
  struct Hint {
    std::string host;
    int port;

    Hint() : port(0) {}
  };

  /** What the device knows about itself, handed over by the UI tick. */
  struct Link {
    std::string deviceIp;   // wlan0, from platform/NetInfo
    std::string baseUrl;    // HostLink::baseUrl(), the address really polled
    uint64_t lastPullMs;    // monotonic ms of the last successful pull; 0 = never
    uint64_t nowMs;

    Link() : lastPullMs(0), nowMs(0) {}
  };

  // The console announces to this port. Compile-time, and deliberately not
  // derived from the console's own port: this firmware is flashed rarely and
  // updated over the very link the feature repairs, so the number the device
  // listens on cannot be allowed to float with a console-side setting. The
  // console's real port travels IN the payload.
  static const int kPort = 43821;
  // Six pull cycles of silence. Long enough that a router hiccup, a console
  // restart or a laptop lid closing for a moment is not "lost" — those recover
  // on their own and re-pointing the clock through them would be churn — and
  // short enough that a lease that moved is repaired before anyone notices.
  static const uint64_t kLostMs = 60000;
  // The probe is one request to a LAN peer that has just proven it is up by
  // sending a packet. Long enough for a Bun handler that is busy rendering a
  // channel, short enough that a black hole does not park the thread.
  static const int kProbeTimeoutMs = 4000;
  // A beacon is ~40 bytes. Anything larger is not one, and a device with ~1 MB
  // free does not buffer a stranger's datagram to find out.
  static const int kMaxDatagramBytes = 128;
  // Beacons arrive every ~10 s and the probe costs a socket. Without a floor a
  // hostile sender could make this device open one HTTP connection per datagram
  // for as long as it kept sending; with it, a flood costs one probe per
  // interval no matter how loud it is.
  static const uint64_t kProbeIntervalMs = 15000;

  /** The wire's version tag. A future layout gets a new one rather than
   *  redefining this, so a device that only knows this one cannot misread it. */
  static const char* kMagic;
  /** The route the probe asks for, and the byte string a real console's answer
   *  contains. `/health` is WorkspaceRuntimeSnapshot, whose very first field is
   *  the service name — unambiguous, and no other daemon on a LAN answers it. */
  static const char* kProbePath;
  static const char* kConsoleMark;

  // --- the pure halves, asserted on the host ---------------------------------

  /**
   * `ZOSCON1\t<host>\t<port>\n` and nothing else.
   *
   * The trailing newline is the FRAME, not decoration: a datagram cut short is
   * rejected as truncated instead of being read as a shorter address. The magic
   * must match exactly, the port must be 1..65535 with no trailing junk, and the
   * host must pass ble::hostIsSafe — the value's destination is /data/zos-host,
   * so the same validator the over-the-air path uses applies here.
   */
  static bool parseBeacon(const char* bytes, int len, Hint* out);

  /** Gate 2. False when either side is not a dotted IPv4 — a hostname hint
   *  cannot be checked against a subnet, so it is refused rather than waved
   *  through. */
  static bool sameSlash24(const std::string& deviceIp, const std::string& host);

  /** Gate 1. `lastPullMs == 0` means no pull has ever succeeded, which after
   *  kLostMs of uptime is exactly the freshly flashed unit that has never been
   *  told where its console is. */
  static bool lost(uint64_t nowMs, uint64_t lastPullMs);

  /** The URL `hint` names, folded through the one normaliser this firmware has
   *  (ble::consoleUrl), so gate 3 compares like with like. */
  static std::string hintUrl(const Hint& hint);

  /** The `host:port` form — what goes into /data/zos-host. */
  static std::string hintHost(const Hint& hint);

  static std::string probeUrl(const std::string& baseUrl);

  /** Gate 4's verdict on a reply that came back. */
  static bool consoleReply(int status, const std::string& body);

  /**
   * Gates 1-3 as one function, returning the candidate URL or "" to ignore.
   *
   * Pure and public so the host check drives the real decision rather than a
   * re-implementation of it: this is the same discipline HostLink::adoptDocument
   * follows, and for the same reason — the thread body below cannot be reached
   * without a socket.
   */
  static std::string candidate(const Link& link, const Hint& hint);

  ConsoleDiscovery();
  ~ConsoleDiscovery();

  /** Binds the listener and starts the thread. Safe to call once. */
  void start(int port);
  void stop();

  /** Called from the UI tick at the link-poll cadence. Three assignments. */
  void noteLink(const Link& link);

  /**
   * Feeds one datagram through gates 1-3 and arms the probe.
   *
   * Public, like HostLink::adoptDocument, because the receive loop needs a
   * socket and a self-check that re-implemented these gates would agree with a
   * runListener that got them wrong.
   */
  void onDatagram(const char* bytes, int len);

  /**
   * Runs gate 4 for an armed candidate: one HTTP GET, and on a console-shaped
   * 200 the adoption is offered to the UI thread. Blocking; the thread's own
   * body calls it, and the host check calls it directly.
   *
   * Returns true when a candidate was probed (whatever the verdict).
   */
  bool pumpProbe();

  /** The UI thread's mailbox. True at most once per adoption. */
  bool takeAdoption(std::string* host);

  /** How many probes have been made. The only window onto a gate that would
   *  otherwise be able to never fire without anything noticing. */
  int probeCount() const;

 private:
  ConsoleDiscovery(const ConsoleDiscovery&);
  ConsoleDiscovery& operator=(const ConsoleDiscovery&);

  static void* listenMain(void* self);
  void runListener();

  mutable pthread_mutex_t mLock;
  pthread_t mThread;
  bool mRunning;
  bool mThreadStarted;
  int mSocket;

  Link mLink;
  // The candidate gates 1-3 accepted, waiting for its probe, and the address it
  // would replace — kept together so the breadcrumb can say old AND new, which
  // is the one line that explains a device that moved on its own.
  std::string mPendingUrl;
  std::string mPendingHost;
  std::string mPendingFrom;
  uint64_t mLastProbeMs;
  int mProbeCount;
  std::string mAdoptHost;
};

}  // namespace tcos

#endif  // NET_CONSOLEDISCOVERY_H_
