#ifndef PLATFORM_DEVICEWIFI_H_
#define PLATFORM_DEVICEWIFI_H_

#include <pthread.h>
#include <sys/types.h>

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

  /**
   * The same sweep as scanResults(), with the signal and the security flag kept.
   *
   * scanResults() is the SSID-only projection of THIS — one read of the
   * supplicant's cache, one place where "an empty list is not a finished sweep"
   * is decided. A second scan path was the obvious way to give the BLE console
   * its RSSI column and would have been a second place for that contract to be
   * got wrong, which is exactly how the setup page's dropdown shipped empty.
   */
  bool scanNetworks(std::vector<WpaCtrl::Network>* out);

  /** True when the guard file is present. Re-read every time, never cached. */
  static bool linkChangesAllowed();

  /** Set once a mutator was refused, so the settings screen can say why. */
  bool everRefused() const { return mEverRefused; }

  /**
   * True while the hotspot is up but cannot hand out an address, i.e. a phone
   * can associate and will never be leased one.
   *
   * TWO ways to be in that state, and the panel has to say the same thing about
   * both, because they look identical from the phone:
   *
   *   - dnsmasq is not running. The original bug: it exited on its own arguments
   *     before it ever answered a DISCOVER.
   *   - dnsmasq is running but wlan0 does not carry kSoftApAddress. A DHCP
   *     context only matches when it covers the address the request arrived on,
   *     so an interface that lost its gateway leaves dnsmasq alive, silent, and
   *     reported healthy by every process check there is. wlan0 can lose it: the
   *     bring-up sets the address once, and libzknet's own DHCP client — which
   *     runs on a detached thread this class cannot cancel — writes that same
   *     interface when it finally returns.
   *
   * Reporting only the first would mean the second is announced as a working
   * hotspot, which is exactly how the shipped bug stayed invisible.
   *
   * Deliberately NOT folded into softApRunning(): that predicate drives
   * WifiPolicy's supervision and its answer is about the radio (see its comment),
   * while this one is only ever a message for the panel. A user in this state
   * sees a network that associates and then dead-ends, which reads as a weak AP
   * or a wrong password — the one thing that turns it back into a usable
   * fallback is the panel telling them to set an address by hand.
   *
   * Written on the hotspot worker, read from the UI thread, same plain-bool
   * convention as mEverRefused: a stale read costs one 500 ms settings rebuild.
   */
  bool softApDhcpFailed() const { return mApDhcpFailed; }

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

  /**
   * The hotspot conf hostapd is pointed at, and the entropy file it seeds its
   * random pool from.
   *
   * The entropy file is the vendor's own recipe, byte for byte:
   * `soft_ap_enable` in this device's libzknet.so calls
   * `ensure_entropy_file_exists("/data/misc/wifi/entropy.bin")` — create with
   * 0660 and a 21-byte seed when absent — and then runs
   * `hostapd -e /data/misc/wifi/entropy.bin <conf>`. A headless box with no
   * input devices fills its kernel entropy pool at a crawl, and a hostapd left
   * to that pool can refuse the WPA handshake outright ("Not enough entropy in
   * random pool"); the file is how the stock firmware sidesteps that on this
   * exact hardware. It is a regenerable cache, not user data, so it is NOT
   * covered by backupOnce.
   */
  static const char* hostapdConfPath() { return "/data/misc/wifi/hostapd.conf"; }
  static const char* entropyFile() { return "/data/misc/wifi/entropy.bin"; }

  /**
   * hostapd's argv, minus the binary itself. Two shapes:
   *
   *   withEntropy — `-B -e <entropy> <conf>`, the vendor's own invocation (see
   *     entropyFile) with our -B kept: hostapd itself was never the component
   *     observed failing, so its execution model is not the thing to change.
   *   plain — `-B <conf>`, the invocation this firmware has always used, the
   *     one that put the SSID on the air in every session so far. The bring-up
   *     falls back to it if the build rejects -e, because an unverified flag
   *     may cost a spawn but must never cost the hotspot.
   */
  static std::vector<std::string> hostapdArgs(bool withEntropy) {
    std::vector<std::string> args;
    args.push_back("-B");
    if (withEntropy) {
      args.push_back("-e");
      args.push_back(entropyFile());
    }
    args.push_back(hostapdConfPath());
    return args;
  }

  /**
   * Where the hotspot's DHCP server keeps its leases, its (layer-3) pid, and
   * its complaints.
   *
   * The leases and the pid stay on tmpfs: the lease file is rewritten on every
   * lease and /data is jffs2 — the one partition a power cycle does not clear,
   * and the one holding the user's credentials.
   *
   * The stderr captures moved to /data, and that is a lesson, not a taste. The
   * first generation of these files lived in /tmp, and the only way to read
   * them — power-cycle the device back onto WiFi and come in over adb — is
   * precisely the operation that erases tmpfs: a year of diagnoses self-
   * destructed on the way to their only reader. One file per layer, truncated
   * on each attempt, so the newest failure of each SHAPE is kept and a device
   * stuck retrying cannot grow a log on the credentials partition. Layer 1
   * additionally runs --log-dhcp into its file, which is what turns "no lease"
   * into one of three distinct bugs (see dnsmasqArgsForLayer).
   */
  static const char* dnsmasqPidFile() { return "/tmp/zos-dnsmasq.pid"; }
  static const char* dnsmasqLeaseFile() { return "/tmp/zos-dnsmasq.leases"; }
  static const char* dnsmasqErrFile(int layer) {
    if (layer <= 1) return "/data/zos-dnsmasq.l1.log";
    if (layer == 2) return "/data/zos-dnsmasq.l2.log";
    return "/data/zos-dnsmasq.l3.log";
  }

  static const int kDnsmasqLayers = 3;

  /**
   * dnsmasq's arguments: THREE LAYERS, tried in order by superviseDhcp().
   *
   * The ladder exists because dnsmasq exits EC_BADCONF on any argument it does
   * not accept, and on this unit a dnsmasq that does not start is
   * indistinguishable from the shipped bug: SSID on the air, phone associates,
   * no lease ever arrives. Each layer is more modest than the one before it,
   * and each stands on a different kind of evidence:
   *
   *   LAYER 1 — everything spelled out, REASONED. The vendor conf neutralised
   *     (--conf-file=/dev/null) and each setting it supplied repeated
   *     explicitly, plus --dhcp-authoritative (a phone with a cached foreign
   *     lease is NAKed instead of ignored into 169.254.x) and --log-dhcp,
   *     whose output lands in the /data stderr capture. That log is the
   *     payoff: after a failed session it separates "the phone never sent a
   *     DISCOVER" (driver or phone side) from "we sent an OFFER that never
   *     arrived" (driver dropping broadcast) from "no DHCP context matched"
   *     (address hole) — three different bugs, three different fixes,
   *     indistinguishable from outside.
   *   LAYER 2 — the VENDOR'S argv, character for character out of this
   *     device's own libzknet.so (`soft_ap_enable`, the fork+execv branch):
   *     `--no-daemon --no-resolv --no-poll --dhcp-range=…`. /etc/dnsmasq.conf
   *     is read implicitly, exactly as the vendor runs it, and supplies
   *     user=root, no-hosts, interface=wlan0 and a /data lease path; its own
   *     dhcp-range on 192.168.1.x rides along and is inert, because a DHCP
   *     context only matches when it covers the address the request arrived
   *     on. This is the invocation every stock unit of this platform family
   *     serves its production hotspot with. No --address catch-all, so the
   *     captive-portal sheet may not auto-open — the panel's printed address
   *     is the fallback path, and a lease with no sheet beats a sheet with no
   *     lease.
   *   LAYER 3 — the invocation MEASURED on this unit (adb, by hand): the
   *     argument list this firmware always shipped plus --pid-file, which
   *     turned exit 3 into exit 0 and a resident daemon. The only layer that
   *     daemonises, kept verbatim as the last resort precisely because it is
   *     the only one ever seen working here.
   *
   * Layers 1 and 2 carry --no-daemon, and that is the deeper fix, not a
   * detail. The vendor keeps dnsmasq as a FOREGROUND child and supervises the
   * pid it holds. This firmware used to force daemonisation and re-identify
   * the daemon BY NAME, which (a) made the compiled-in pidfile default under
   * the nonexistent /var fatal — the original bug — and (b) let ANY dnsmasq on
   * the box satisfy the health check, including one started by init off the
   * vendor conf whose 192.168.1.x pool can never match this AP. A foreground
   * child cannot have a pidfile problem, cannot be confused with a stranger,
   * and hands back its exit status through waitpid instead of vanishing.
   *
   * Flag provenance, for the next person who has to shrink or grow these:
   * --pid-file is MEASURED (no /var here; exit 3 without it, exit 0 with).
   * --user=root repeats the vendor conf: dnsmasq's compiled-in default is
   * `nobody`, resolved with getpwnam and fatal when absent, and every start
   * ever observed on this unit was as root. --no-hosts keeps /etc/hosts from
   * answering ahead of the --address=/#/ catch-all. --dhcp-leasefile moves the
   * lease churn off jffs2. The pool is DERIVED from the gateway rather than
   * written twice, because a pool outside the interface's address matches no
   * DHCP context — dnsmasq then stays up, answers nothing, and looks healthy
   * to every process check, which is exactly the mistake the vendor conf
   * itself ships. .100–.200 are libzknet's endpoints, so a phone that met this
   * clock under the stock firmware keeps the address it cached.
   *
   * Pure and inline because the host check cannot link anything that talks to
   * the radio, and these lists are otherwise only answerable on hardware —
   * which is how the original shipped wrong.
   */
  static std::vector<std::string> dnsmasqLayer1Args(const std::string& gateway) {
    std::vector<std::string> args;
    args.push_back("--no-daemon");
    args.push_back("--log-dhcp");
    args.push_back("--conf-file=/dev/null");
    args.push_back("--user=root");
    args.push_back("--no-hosts");
    args.push_back("--dhcp-authoritative");
    args.push_back(std::string("--dhcp-leasefile=") + dnsmasqLeaseFile());
    args.push_back("--interface=wlan0");
    args.push_back("--dhcp-range=" + poolPrefix(gateway) + "100," + poolPrefix(gateway) +
                   "200,1h");
    args.push_back("--address=/#/" + gateway);
    args.push_back("--no-resolv");
    args.push_back("--no-poll");
    return args;
  }

  static std::vector<std::string> dnsmasqLayer2Args(const std::string& gateway) {
    // Character for character the vendor's own invocation, with only the pool
    // derived instead of a second literal — see the layer table above.
    std::vector<std::string> args;
    args.push_back("--no-daemon");
    args.push_back("--no-resolv");
    args.push_back("--no-poll");
    args.push_back("--dhcp-range=" + poolPrefix(gateway) + "100," + poolPrefix(gateway) +
                   "200,1h");
    return args;
  }

  static std::vector<std::string> dnsmasqProvenArgs(const std::string& gateway) {
    std::vector<std::string> args;
    appendProvenDnsmasqArgs(gateway, &args);
    return args;
  }

  /** The one dispatch superviseDhcp() walks, so the ORDER of the ladder is a
   *  fact the host check pins rather than a comment. */
  static std::vector<std::string> dnsmasqArgsForLayer(int layer, const std::string& gateway) {
    if (layer <= 1) return dnsmasqLayer1Args(gateway);
    if (layer == 2) return dnsmasqLayer2Args(gateway);
    return dnsmasqProvenArgs(gateway);
  }

  static void appendProvenDnsmasqArgs(const std::string& gateway,
                                      std::vector<std::string>* args) {
    args->push_back("--interface=wlan0");
    args->push_back("--dhcp-range=" + poolPrefix(gateway) + "100," + poolPrefix(gateway) +
                    "200,1h");
    args->push_back("--address=/#/" + gateway);
    args->push_back("--no-resolv");
    args->push_back("--no-poll");
    args->push_back(std::string("--pid-file=") + dnsmasqPidFile());
  }

  static std::string poolPrefix(const std::string& gateway) {
    const size_t lastDot = gateway.rfind('.');
    return lastDot == std::string::npos ? gateway : gateway.substr(0, lastDot + 1);
  }

  /**
   * Whether a /proc/<pid>/cmdline (NULs already turned to spaces) names a
   * dnsmasq THIS firmware started, as opposed to somebody else's.
   *
   * The old health check asked only "is any process named dnsmasq alive?", and
   * a dnsmasq started by init off the vendor conf — serving a 192.168.1.x pool
   * that can never match this AP — satisfied it perfectly while not one lease
   * went out. Identity is therefore claimed by content: layers 1 and 3 carry a
   * zos-dnsmasq path in their argv, and layer 2 (the vendor-verbatim argv,
   * which has no zos path by definition) is fingerprinted by the pool derived
   * from OUR gateway, which the vendor conf's own pool does not share. A bare
   * `/bin/dnsmasq` — exactly what an init-spawned one looks like — matches
   * nothing here on purpose.
   */
  static bool cmdlineClaimsOurDnsmasq(const std::string& cmdline, const std::string& gateway) {
    const std::string bin = "/bin/dnsmasq";
    if (cmdline.compare(0, bin.size(), bin) != 0) return false;
    // Exactly the binary, not /bin/dnsmasq-something.
    if (cmdline.size() > bin.size() && cmdline[bin.size()] != ' ') return false;
    if (cmdline.find("zos-dnsmasq") != std::string::npos) return true;
    return cmdline.find("--dhcp-range=" + poolPrefix(gateway) + "100,") != std::string::npos;
  }

  /**
   * Whether a parsed SCAN_RESULTS reply means "the sweep is done".
   *
   * The answer is NO for an empty list, and this predicate exists because the
   * opposite answer is precisely how the setup page's dropdown shipped empty:
   * SCAN_RESULTS reads the supplicant's CACHE, which answers instantly and is
   * legitimately bare (header only) for the first seconds after the daemon
   * starts. Treating that as a finished sweep let the policy leave kScanning
   * on its first 160 ms tick, raise the hotspot, and thereby stop the
   * supplicant — killing the real 2–4 s sweep mid-air, every time. An empty
   * cache is indistinguishable from a sweep still running, so it must be
   * reported the same way; the scan TIMEOUT in WifiPolicy is what bounds the
   * wait.
   */
  static bool scanSweepComplete(bool parsedOk, size_t networks) {
    return parsedOk && networks > 0;
  }

 private:
  DeviceWifi(const DeviceWifi&);
  DeviceWifi& operator=(const DeviceWifi&);

  static void* dhcpMain(void* self);
  static void* persistMain(void* self);
  static void* softApMain(void* self);

  // All three run on softApMain's thread, never on the caller's.
  //
  // bringUpSoftAp returns whether the hotspot is on the air, which is what
  // decides if the worker stays resident: there is only something to supervise
  // while hostapd is actually holding wlan0. A refused guard file or a failed
  // bring-up ends the thread instead and leaves the retry to WifiPolicy, which
  // is where the retry has always lived.
  bool bringUpSoftAp();
  void tearDownSoftAp();
  void superviseDhcp();
  // Puts kSoftApAddress back on wlan0. Split out of the bring-up because the
  // resident supervision round has to be able to re-assert it: see
  // softApDhcpFailed() for what carries it away.
  bool applyApAddress();
  // Blocks until no libzknet lease request is outstanding on wlan0, or the
  // budget runs out. Bounded on purpose — dhcpRequestIp() is a library call on a
  // detached thread with no cancel and no published timeout, so waiting for it
  // is a courtesy, not a guarantee, and the address reconciliation above is what
  // makes it safe to stop waiting.
  void awaitDhcpQuiet(int timeoutMs);
  // Whether the DHCP server this object started is still serving — by PID for
  // the foreground layers (waitpid also reaps and reports HOW it died), by pid
  // file plus cmdline for layer 3, and never by bare process name: that check
  // once claimed init's own dnsmasq as ours. Reports deaths to the breadcrumb
  // log on the way through.
  bool dnsmasqHealthy();
  // One attempt with one layer's argument list. Foreground layers spawn and
  // then confirm the child survived 700 ms (a rejected argument or an occupied
  // port 67 exits well inside that); layer 3 daemonises exactly as measured.
  // Every outcome — alive, exit code, spawn failure — lands in the breadcrumb
  // log, which is the entire point of the layering being observable.
  bool attemptDnsmasqLayer(int layer);
  // Stops OUR dnsmasq: the held pid first (reaped, so a foreground child never
  // zombies), then any survivor whose cmdline claims to be ours. A dnsmasq
  // that is not ours predates this hotspot and is left alone.
  void stopDnsmasq();
  // The vendor's entropy-file recipe (see entropyFile). Returns a static
  // status word — "exists" / "created" / "fail" — for the breadcrumb line.
  static const char* ensureEntropyFile();
  // Layer-3 only: one dnsmasq start attempt with one argument list, confirmed
  // to have left a daemon behind by name — the daemonised model gives nothing
  // better to hold.
  static bool spawnDnsmasq(const std::vector<std::string>& args, const char* errPath);

  WpaCtrl mCtrl;
  // Guards mCtrl alone. The supplicant's control socket is a single datagram
  // descriptor: two threads with a request in flight on it read each other's
  // replies, and a STATUS answered with a SCAN_RESULTS is not a parse error,
  // it is a wrong answer. One instance, one lock, and the worker threads queue
  // behind the UI thread's STATUS the same way its own calls already do.
  // (DeviceProvisioning holds a second WpaCtrl for the setup page. That is safe
  // only because WpaCtrl::open now binds a per-instance path — keyed on the pid
  // alone, the two unlinked each other's sockets.)
  mutable pthread_mutex_t mCtrlLock;
  mutable pthread_mutex_t mLock;
  std::string mLastState;
  bool mEverRefused;
  bool mDhcpInFlight;
  bool mSoftApWanted;
  bool mSoftApWorking;
  bool mPersistInFlight;
  // The hotspot is on the air but has no DHCP server. Written on the worker,
  // read by the panel; see softApDhcpFailed().
  bool mApDhcpFailed;
  // Monotonic ms of the last failed hotspot bring-up, or -1. Worker-thread
  // only. Rate-limits the retry, because every attempt stops the supplicant on
  // its way in and a broken hostapd would otherwise flap the radio forever.
  int mApFailedAtMs;
  // The same floor for dnsmasq, and it needs its own: a dnsmasq that rejects
  // its own arguments fails in milliseconds, and the supervision round that now
  // watches it would otherwise be a process spawn every three seconds forever
  // on a device with ~1 MB free.
  int mDhcpFailedAtMs;
  // The DHCP server this object is supervising: its pid (a direct child for
  // the foreground layers; the daemon's own, read back from its pid file, for
  // layer 3; -1 when none) and which argument layer produced it. Worker-thread
  // only, like the failure stamps above.
  pid_t mDnsmasqPid;
  int mDnsmasqLayer;
  // How many times the supervised dnsmasq died and was replaced, for the
  // DNSMASQ_DEAD breadcrumb — a counter because "died once at boot" and "dies
  // every round" are different bugs wearing the same line.
  int mDhcpRespawns;
  // wlan0's address as last observed by the supervision round, so the
  // ADDR_CHANGE breadcrumb fires on transitions only: jffs2 gets a line when
  // libzknet's late DHCP write steals the gateway, not one per round forever.
  std::string mLastApAddr;
  // The sweep the SCAN_DONE breadcrumb times: when the first SCAN of the
  // current sweep went out, and whether this sweep's completion was already
  // logged. UI-thread only (startScan/scanResults both run on the policy
  // tick).
  int mScanIssuedMs;
  bool mScanDoneLogged;
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
