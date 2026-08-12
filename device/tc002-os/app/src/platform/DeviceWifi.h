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
   * Where the hotspot's dnsmasq keeps its pid, its leases and its complaints.
   *
   * All four on tmpfs. The two `.err` paths are one per argument tier, and they
   * are separate files rather than one appended to: the fallback's message must
   * not overwrite the preferred list's, which is the one naming the argument
   * this build rejected, and an appended log on a device stuck in this state
   * grows for as long as it is stuck, on a box with ~1 MB free.
   */
  static const char* dnsmasqPidFile() { return "/tmp/zos-dnsmasq.pid"; }
  static const char* dnsmasqLeaseFile() { return "/tmp/zos-dnsmasq.leases"; }
  static const char* dnsmasqErrFile() { return "/tmp/zos-dnsmasq.err"; }
  static const char* dnsmasqProvenErrFile() { return "/tmp/zos-dnsmasq-proven.err"; }

  /**
   * dnsmasq's arguments for the hotspot, gateway address in, binary path out.
   *
   * TWO TIERS, and the second is the reason the first is allowed to be
   * ambitious. dnsmasq exits EC_BADCONF on any argument it does not accept, and
   * on this unit a dnsmasq that does not start is indistinguishable from the
   * shipped bug: the SSID goes on the air, a phone associates, and no lease ever
   * arrives. Only ONE change in the list below has been executed on the device's
   * own dnsmasq build; the rest is reasoning about a binary we have read the
   * strings of. So superviseDhcp() tries this list, and if this build rejects
   * any part of it, falls straight through to dnsmasqProvenArgs() — the exact
   * invocation measured working on the unit. An unverified flag can cost a
   * process spawn; it must not be able to cost the hotspot.
   *
   * MEASURED on the device, and the whole bug:
   *
   *   --pid-file — the compiled-in default is /var/run/dnsmasq.pid and this
   *     device has no /var at all: not /var, not /var/run, not /var/lib. Without
   *     this line dnsmasq exits 3 with "failed to open pidfile
   *     /var/run/dnsmasq.pid: No such file or directory"; with it, exit 0 and it
   *     stays up. That is the one measurement, and it is the one that matters.
   *
   * INFERRED, i.e. reasoned from the vendor's /etc/dnsmasq.conf and from
   * dnsmasq's documented behaviour, and never executed here:
   *
   *   --conf-file=/dev/null — dnsmasq reads /etc/dnsmasq.conf implicitly and
   *     this unit ships one. Read off the device it carries `user=root`,
   *     `no-hosts`, `no-resolv`, `no-poll`, `interface=wlan0`, a lease path
   *     under /data — and `dhcp-range=192.168.1.101,192.168.1.200,12h`, a second
   *     pool in a subnet this AP does not have. Which file wins for a scalar
   *     option is a claim about dnsmasq's parse order that nothing here can
   *     check, so the answer is not to depend on it either way: neutralise the
   *     file and repeat every setting it supplied. /dev/null rather than an
   *     empty argument, which would rely on the parser reading "" as "no file"
   *     rather than as the default path. If this build will not take the flag,
   *     dnsmasqProvenArgs() leaves the file exactly where the measurement found
   *     it — including the lease path that is the reason the observed failure
   *     was about the pid file and not about leases.
   *   --user=root — dnsmasq's compiled-in default user is `nobody`, resolved
   *     with getpwnam at startup and fatal (EC_BADCONF) when the lookup fails.
   *     The vendor conf set root, so every start ever measured on this unit was
   *     as root; neutralising that file without this line is the one change
   *     there is no evidence for at all.
   *   --no-hosts — also from the vendor conf. Without it /etc/hosts is loaded
   *     and a local record answers BEFORE the --address=/#/ catch-all, i.e. a
   *     hole in the wildcard the captive-portal prompt depends on.
   *   --dhcp-leasefile — the same trap one directory over: the compiled-in
   *     default is /var/lib/misc/dnsmasq.leases. The vendor conf pointed this at
   *     /data, which is why the observed failure was the pid file and not this.
   *     /tmp rather than /data because the file is rewritten on every lease and
   *     /data is jffs2 — the one partition a power cycle does not clear, and the
   *     one holding the user's credentials.
   *   --dhcp-authoritative — a phone arriving with a cached lease from another
   *     network DHCPREQUESTs that address; a non-authoritative server says
   *     nothing, and the phone retries for many seconds and then self-assigns
   *     169.254.x. Associated, no portal: indistinguishable from the bug this
   *     list exists to fix.
   *
   * From libzknet's own argument list, i.e. the shape the stock firmware runs on
   * this exact binary: --interface, --dhcp-range (three fields, no netmask —
   * dnsmasq takes the mask off the receiving interface, which step 5 of the
   * bring-up sets), --address=/#/<gw>, --no-resolv, --no-poll. The catch-all
   * matters as much as the lease: a phone with no route to the internet warns
   * about it and often drops silently back to mobile data, and resolving every
   * name here is what makes the captive-portal sheet open instead.
   *
   * The pool is DERIVED from the gateway rather than written out again. A range
   * outside the address wlan0 carries matches no DHCP context at DISCOVER time:
   * dnsmasq stays up, answers nothing, and every supervision check still reports
   * a healthy hotspot. That is precisely the mistake the vendor's own conf ships
   * (`dhcp-range=192.168.1.101,…` on a device whose AP is 192.168.100.1), and it
   * is why this is derived rather than a second literal. .100-.200 are
   * libzknet's endpoints, so a phone that met this clock under the stock
   * firmware keeps the address it cached.
   *
   * Pure and inline because the host check cannot link anything that talks to
   * the radio, and this list is otherwise only answerable on hardware — which is
   * how it shipped wrong.
   */
  static std::vector<std::string> dnsmasqArgs(const std::string& gateway) {
    std::vector<std::string> args;
    args.push_back("--conf-file=/dev/null");
    args.push_back("--user=root");
    args.push_back("--no-hosts");
    args.push_back("--dhcp-authoritative");
    args.push_back(std::string("--dhcp-leasefile=") + dnsmasqLeaseFile());
    appendProvenDnsmasqArgs(gateway, &args);
    return args;
  }

  /**
   * The invocation measured working on the device, and nothing else.
   *
   * Exactly the argument list this firmware always shipped plus --pid-file: run
   * on the unit it exits 0 and the daemon stays up. Every other flag in
   * dnsmasqArgs() above is an improvement on a state that was never observed to
   * fail, so this is what a rejected improvement falls back to.
   *
   * Note what is deliberately ABSENT: no --conf-file. /etc/dnsmasq.conf is left
   * to be read implicitly, exactly as it was when the measurement was taken, so
   * `user=root`, `no-hosts` and a writable lease path come from the vendor's own
   * file rather than from arguments this build may not accept. Its second
   * `dhcp-range` on 192.168.1.0/24 comes with them, and is inert: a context only
   * matches when it covers the address the request arrived on, and wlan0 carries
   * the gateway below.
   */
  static std::vector<std::string> dnsmasqProvenArgs(const std::string& gateway) {
    std::vector<std::string> args;
    appendProvenDnsmasqArgs(gateway, &args);
    return args;
  }

  static void appendProvenDnsmasqArgs(const std::string& gateway,
                                      std::vector<std::string>* args) {
    const size_t lastDot = gateway.rfind('.');
    const std::string prefix =
        lastDot == std::string::npos ? gateway : gateway.substr(0, lastDot + 1);
    args->push_back("--interface=wlan0");
    args->push_back("--dhcp-range=" + prefix + "100," + prefix + "200,1h");
    args->push_back("--address=/#/" + gateway);
    args->push_back("--no-resolv");
    args->push_back("--no-poll");
    args->push_back(std::string("--pid-file=") + dnsmasqPidFile());
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
  // One dnsmasq start attempt with one argument list, confirmed to have left a
  // daemon behind. Static because it needs no state — the tiering lives in
  // superviseDhcp, which is the only caller.
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
