#include "platform/DeviceWifi.h"

#include <dirent.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <os/SystemProperties.h>

#include <net/NetUtils.h>

#include "base/log.h"
#include "platform/InstallMode.h"
#include "platform/NetInfo.h"

// posix_spawn's environment argument. Declared here rather than relied on from
// <unistd.h> because it must be the global one, not a namespace member.
extern char** environ;

namespace tcos {

const char* DeviceWifi::kSoftApAddress = "192.168.100.1";

namespace {

const char* kWpaConf = "/data/misc/wifi/wpa_supplicant.conf";
// Backups live beside the originals, in /data, on purpose: /tmp is tmpfs and a
// copy there would be gone by the time it is needed — the failure this guards
// against is a device that boots with a broken config, and boot is exactly when
// /tmp is empty.
const char* kWpaConfBackup = "/data/misc/wifi/wpa_supplicant.conf.zos-bak";
const char* kHostapdConf = "/data/misc/wifi/hostapd.conf";
const char* kHostapdConfBackup = "/data/misc/wifi/hostapd.conf.zos-bak";

// Absolute paths, and no shell. The device's PATH is `/sbin:/bin:/tmp:`, so
// these would resolve anyway, but exec'ing the path we mean means a stray
// binary dropped in /tmp — the directory a sideload writes to — cannot end up
// holding the radio.
const char* kHostapdBin = "/bin/hostapd";
const char* kDnsmasqBin = "/bin/dnsmasq";
const char* kIfconfigBin = "/sbin/ifconfig";

const char* kInterface = "wlan0";
// The AP-side DHCP pool, both endpoints lifted from libzknet.so's own strings
// (`192.168.100.100`, `192.168.100.200`, `--dhcp-range=%s,%s,1h`). Staying on
// the stock firmware's numbers means a phone that has connected to this clock
// before does not have to be talked out of a cached lease from the other
// firmware.
const char* kDhcpRangeArg =
    "--dhcp-range=192.168.100.100,192.168.100.200,1h";
// Answer every name with our own address. A phone with no route to the
// internet shows a "no internet" warning and often silently drops back to
// mobile data; resolving everything here is what makes the captive-portal
// prompt appear instead.
const char* kDnsCatchAllArg = "--address=/#/192.168.100.1";

// How long to leave the radio alone after a hotspot bring-up failed.
//
// Without a floor the policy's supervision would ask again every three seconds,
// and every attempt stops wpa_supplicant on its way in — a device whose hostapd
// is broken would then flap the supplicant faster than an association can
// complete, and would never rejoin its network even when the router came back.
// Thirty seconds is longer than WifiPolicy::kConnectTimeoutMs, so the station
// path gets one whole honest attempt between hotspot attempts.
const int kApRetryFloorMs = 30000;

void sleepMs(int ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = static_cast<long>(ms % 1000) * 1000000L;
  ::nanosleep(&ts, 0);
}

int monotonicMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int>(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

bool fileExists(const char* path) {
  struct stat info;
  return ::stat(path, &info) == 0;
}

// Reads the first `ssid=` / `psk=` pair out of a wpa_supplicant.conf.
//
// Hand-parsed rather than borrowed from base-utility on purpose: that library's
// wifi object pulls in NetManager and WifiManager symbols, and linking those is
// exactly what hostcheck/link-audit.sh now fails the build over.
bool parseWpaConf(const char* path, std::string* ssid, std::string* psk) {
  FILE* f = ::fopen(path, "r");
  if (f == 0) return false;
  char line[256];
  std::string foundSsid;
  std::string foundPsk;
  while (::fgets(line, sizeof(line), f) != 0) {
    std::string text(line);
    // Trim leading whitespace; the file indents network block members with tabs.
    size_t at = text.find_first_not_of(" \t");
    if (at == std::string::npos) continue;
    text = text.substr(at);
    while (!text.empty() && (text[text.size() - 1] == '\n' || text[text.size() - 1] == '\r')) {
      text.erase(text.size() - 1);
    }

    const char* keys[2] = {"ssid=", "psk="};
    std::string* targets[2] = {&foundSsid, &foundPsk};
    for (int k = 0; k < 2; ++k) {
      const size_t len = ::strlen(keys[k]);
      if (text.compare(0, len, keys[k]) != 0) continue;
      std::string value = text.substr(len);
      // Quoted values are plaintext; an unquoted psk is a 64-char PSK hash,
      // which the supplicant also accepts verbatim on the way back in.
      if (value.size() >= 2 && value[0] == '"' && value[value.size() - 1] == '"') {
        value = value.substr(1, value.size() - 2);
      }
      if (targets[k]->empty()) *targets[k] = value;
    }
  }
  ::fclose(f);
  if (foundSsid.empty()) return false;
  *ssid = foundSsid;
  *psk = foundPsk;
  return true;
}

// The pid of a running process named `name`, or -1. Used to supervise hostapd
// and dnsmasq, which init does not manage — there is no service entry for
// either in /etc/init.rc, so nothing else would ever notice one dying.
//
// This opens and reads a file per process on the box. It is NOT cheap, which is
// why WifiPolicy supervises the hotspot on a timer rather than every tick.
int findProcess(const char* name) {
  DIR* dir = ::opendir("/proc");
  if (dir == 0) return -1;
  int found = -1;
  struct dirent* entry;
  while (found < 0 && (entry = ::readdir(dir)) != 0) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char path[64];
    // Bounded at 16: a pid is at most ten digits, and without the precision the
    // compiler has to assume a 255-byte directory name and warns about a
    // truncation that cannot happen under /proc.
    ::snprintf(path, sizeof(path), "/proc/%.16s/comm", entry->d_name);
    FILE* f = ::fopen(path, "r");
    if (f == 0) continue;
    char comm[64];
    comm[0] = '\0';
    if (::fgets(comm, sizeof(comm), f) != 0) {
      size_t len = ::strlen(comm);
      while (len > 0 && (comm[len - 1] == '\n' || comm[len - 1] == '\r')) comm[--len] = '\0';
      if (::strcmp(comm, name) == 0) found = ::atoi(entry->d_name);
    }
    ::fclose(f);
  }
  ::closedir(dir);
  return found;
}

bool processRunning(const char* name) { return findProcess(name) >= 0; }

// Stops a daemon by NAME, because there is no pid to remember: hostapd is
// started with -B, so the process this app spawned forks and exits immediately
// and the daemon that survives is a different pid. The device has no killall,
// no pidof and no pkill (see docs/research/tc002-device-probe.md).
void terminateProcess(const char* name) {
  int pid = findProcess(name);
  if (pid < 0) return;
  ::kill(pid, SIGTERM);
  // hostapd deauthenticates its clients and takes the interface out of AP mode
  // on SIGTERM. Waiting for it to actually go is what lets wpa_supplicant have
  // wlan0 back; killing it outright leaves the driver in AP mode and the
  // supplicant then fails to start with no obvious reason.
  for (int waited = 0; waited < 2000; waited += 50) {
    if (findProcess(name) < 0) return;
    sleepMs(50);
  }
  pid = findProcess(name);
  if (pid >= 0) ::kill(pid, SIGKILL);
}

// Runs a binary to completion and reports a zero exit.
//
// posix_spawn rather than fork+exec: glibc implements it with
// clone(CLONE_VM|CLONE_VFORK), so it never duplicates this process's page
// tables. The app is loaded into zkgui, whose address space measured ~230 MB on
// a box with 36 MB of RAM and ~1 MB free — a plain fork() there is a real
// allocation failure, and it would fail in the middle of a hotspot bring-up.
bool spawnAndWait(const char* path, char* const argv[], int timeoutMs) {
  pid_t pid = -1;
  if (::posix_spawn(&pid, path, 0, 0, argv, environ) != 0) {
    LOGE_TRACE("wifi: cannot spawn %s", path);
    return false;
  }
  // Bounded, and polled rather than blocking: hostapd -B and dnsmasq both
  // daemonise, so the direct child exits in milliseconds. A build that did not
  // daemonise would otherwise park this worker thread forever, and the hotspot
  // could then never be torn down again.
  for (int waited = 0; waited < timeoutMs; waited += 20) {
    int status = 0;
    const pid_t done = ::waitpid(pid, &status, WNOHANG);
    if (done == pid) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (done < 0) return false;
    sleepMs(20);
  }
  LOGE_TRACE("wifi: %s did not exit within %d ms", path, timeoutMs);
  return false;
}

// Copies `path` to `backup` unless a backup is already there.
//
// ONCE is the whole point. /data survives a power cycle, so it is the one place
// this firmware can leave damage that outlives the universal rescue; the copy
// worth keeping is the one taken before ZOS ever wrote to the file, and a
// refresh on every write would overwrite that with our own output the first
// time we got it wrong. Nothing to copy is success, not failure: a device that
// has never had a hotspot has no hostapd.conf to lose.
bool backupOnce(const char* path, const char* backup) {
  if (fileExists(backup)) return true;
  FILE* src = ::fopen(path, "rb");
  if (src == 0) return true;

  FILE* dst = ::fopen(backup, "wb");
  if (dst == 0) {
    ::fclose(src);
    LOGE_TRACE("wifi: cannot write %s", backup);
    return false;
  }
  char buf[512];
  size_t n;
  bool ok = true;
  while ((n = ::fread(buf, 1, sizeof(buf), src)) > 0) {
    if (::fwrite(buf, 1, n, dst) != n) ok = false;
  }
  // Flush before claiming success: jffs2 is the only writable persistent store
  // on this unit and a backup that is still in a buffer is not a backup.
  if (::fflush(dst) != 0) ok = false;
  ::fclose(dst);
  ::fclose(src);
  if (!ok) {
    ::unlink(backup);
    return false;
  }
  ::chmod(backup, 0600);
  LOGD("wifi: backed up %s -> %s", path, backup);
  return true;
}

// Writes `body` to `path` only when it is not already what is there.
//
// The read is the point. A hostapd that crash-loops is restarted by the policy
// every kSoftApSuperviseMs, and an unconditional write would then be a jffs2
// write every three seconds for as long as the fault lasts — on the one
// partition a power cycle does not clear, on the device that is already in
// trouble. Comparing first turns that into a read.
bool writeFileIfChanged(const char* path, const std::string& body) {
  FILE* existing = ::fopen(path, "rb");
  if (existing != 0) {
    std::string current;
    char buf[512];
    size_t n;
    while ((n = ::fread(buf, 1, sizeof(buf), existing)) > 0) current.append(buf, n);
    ::fclose(existing);
    if (current == body) return true;
  }

  FILE* f = ::fopen(path, "wb");
  if (f == 0) {
    LOGE_TRACE("wifi: cannot write %s", path);
    return false;
  }
  const bool ok = ::fwrite(body.data(), 1, body.size(), f) == body.size();
  ::fclose(f);
  if (ok) ::chmod(path, 0600);
  return ok;
}

}  // namespace

DeviceWifi::DeviceWifi()
    : mEverRefused(false),
      mDhcpInFlight(false),
      mSoftApWanted(false),
      mSoftApWorking(false),
      mPersistInFlight(false),
      mApFailedAtMs(-1),
      mNetworkId(-1) {
  ::pthread_mutex_init(&mCtrlLock, 0);
  ::pthread_mutex_init(&mLock, 0);
}

DeviceWifi::~DeviceWifi() {
  ::pthread_mutex_destroy(&mLock);
  ::pthread_mutex_destroy(&mCtrlLock);
}

bool DeviceWifi::linkChangesAllowed() {
  // One rule, in one place: see platform/InstallMode.h. The short version is
  // that the guard protects a link we did not create — which is only true while
  // sideloaded. A flashed ZOS owns the radio and must be allowed to start it,
  // because /etc/init.rc leaves wpa_supplicant `disabled` + `oneshot` and there
  // is no stock app left to bring it up.
  return install::linkChangesAllowed();
}

// --- read-only half: always live --------------------------------------------

bool DeviceWifi::supplicantRunning() {
  // The framework's getString writes into a caller-supplied buffer rather than
  // returning a string; PROP_VALUE_MAX is 92 on this platform and a service
  // state is one short word, so 64 is ample.
  char value[64];
  value[0] = '\0';
  SystemProperties::getString("init.svc.wpa_supplicant", value, "");
  return ::strcmp(value, "running") == 0;
}

bool DeviceWifi::storedCredentials(std::string* ssid, std::string* psk) {
  return parseWpaConf(kWpaConf, ssid, psk);
}

bool DeviceWifi::associated() {
  std::string state;
  std::string ssid;
  std::string ip;
  ::pthread_mutex_lock(&mCtrlLock);
  if (!mCtrl.isOpen() && !mCtrl.open(kInterface)) {
    ::pthread_mutex_unlock(&mCtrlLock);
    return false;
  }
  const bool ok = mCtrl.status(&state, &ssid, &ip);
  if (!ok) {
    // A dead socket is not "disconnected": the supplicant may have been stopped
    // for the hotspot. Drop the descriptor so the next call reopens, and forget
    // the network id with it — a restarted supplicant numbers from zero again.
    mCtrl.close();
    mNetworkId = -1;
  }
  ::pthread_mutex_unlock(&mCtrlLock);
  if (!ok) return false;

  ::pthread_mutex_lock(&mLock);
  mLastState = state;
  ::pthread_mutex_unlock(&mLock);
  return state == "COMPLETED";
}

bool DeviceWifi::hasAddress() {
  const std::string ip = netinfo::ipAddress();
  if (ip.empty()) return false;
  // 0.0.0.0 is an interface with its address cleared, which is exactly what the
  // hotspot teardown leaves behind for a moment. getifaddrs reports it as a
  // perfectly good AF_INET address, so without this the policy would read a
  // half-torn-down radio as "online" and stop driving it. libzknet calls the
  // same value INVALID_IP_ADDR.
  if (ip == "0.0.0.0") return false;
  // The hotspot's own address must NOT count as being online. While the AP is
  // up wlan0 carries 192.168.100.1, and reporting that as an address would tell
  // the policy the device had joined a network — ending provisioning before the
  // user has typed anything, and tearing down the very hotspot they are
  // connected to.
  return ip != kSoftApAddress;
}

bool DeviceWifi::softApRunning() {
  // hostapd only. dnsmasq handing out leases with no radio behind it is not a
  // hotspot, and hostapd is the process whose death makes the device
  // unreachable — a phone that cannot see the SSID never gets far enough to
  // need an address.
  return processRunning("hostapd");
}

bool DeviceWifi::scanResults(std::vector<std::string>* out) {
  out->clear();
  std::vector<WpaCtrl::Network> nets;
  ::pthread_mutex_lock(&mCtrlLock);
  bool ok = mCtrl.isOpen() || mCtrl.open(kInterface);
  if (ok) ok = mCtrl.scanResults(&nets);
  ::pthread_mutex_unlock(&mCtrlLock);
  if (!ok) return false;
  for (size_t i = 0; i < nets.size(); ++i) out->push_back(nets[i].ssid);
  return true;
}

// --- mutating half: refused unless the guard file exists ---------------------

void DeviceWifi::startSupplicant() {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: startSupplicant refused; sideloaded and /tmp/zos-allow-link absent");
    return;
  }
  // ctl.start on an already-running service is a no-op in init; ctl.restart is
  // the one that would drop the link, and it is deliberately never used.
  SystemProperties::setString("ctl.start", "wpa_supplicant");
}

void DeviceWifi::startScan() {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    return;
  }
  ::pthread_mutex_lock(&mCtrlLock);
  if (mCtrl.isOpen() || mCtrl.open(kInterface)) {
    std::string reply;
    mCtrl.request("SCAN", &reply);
  }
  ::pthread_mutex_unlock(&mCtrlLock);
}

bool DeviceWifi::connect(const std::string& ssid, const std::string& psk) {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: connect refused; sideloaded and /tmp/zos-allow-link absent");
    return false;
  }

  ::pthread_mutex_lock(&mCtrlLock);
  bool ok = mCtrl.isOpen() || mCtrl.open(kInterface);
  std::string reply;
  char cmd[512];

  // Reuse the id we were given for these same credentials rather than adding
  // another network. WifiPolicy re-attempts the stored network every 20 s for
  // as long as it stays unprovisioned, so on a device whose router is off for a
  // day that would be four thousand network blocks — all of them in the
  // supplicant's memory, and all of them in the file the persist step writes.
  int id = -1;
  if (ok) {
    if (mNetworkId >= 0 && mNetworkSsid == ssid && mNetworkPsk == psk) {
      id = mNetworkId;
    } else {
      if (!mCtrl.request("ADD_NETWORK", &reply)) {
        ok = false;
      } else {
        id = ::atoi(reply.c_str());
        if (id < 0 || reply.compare(0, 4, "FAIL") == 0) ok = false;
      }
    }
  }

  if (ok) {
    ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d ssid \"%s\"", id, ssid.c_str());
    ok = mCtrl.request(cmd, &reply) && reply.compare(0, 2, "OK") == 0;
    // A remembered id the supplicant no longer knows — it was restarted for the
    // hotspot, and ids start again from zero — answers FAIL here. Forget it and
    // let the next call add the network fresh rather than failing the connect.
    if (!ok) mNetworkId = -1;
  }

  if (ok) {
    if (psk.empty()) {
      ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d key_mgmt NONE", id);
    } else {
      ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d psk \"%s\"", id, psk.c_str());
    }
    ok = mCtrl.request(cmd, &reply) && reply.compare(0, 2, "OK") == 0;
  }

  if (ok) {
    ::snprintf(cmd, sizeof(cmd), "SELECT_NETWORK %d", id);
    ok = mCtrl.request(cmd, &reply) && reply.compare(0, 2, "OK") == 0;
  }

  if (ok) {
    mNetworkId = id;
    mNetworkSsid = ssid;
    mNetworkPsk = psk;
  }
  ::pthread_mutex_unlock(&mCtrlLock);

  // SAVE_CONFIG is NOT sent here. Writing the credentials the instant they are
  // selected would write /data on every one of those 20 s retries, and it would
  // persist a network nothing has yet shown to work. persistCredentials() is
  // the explicit step, and WifiPolicy calls it once the link actually carries
  // an address.
  return ok;
}

void DeviceWifi::persistCredentials() {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: persistCredentials refused; sideloaded and /tmp/zos-allow-link absent");
    return;
  }
  ::pthread_mutex_lock(&mLock);
  if (mPersistInFlight) {
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  mPersistInFlight = true;
  ::pthread_mutex_unlock(&mLock);

  // On a thread: the backup is a read-then-write of jffs2, the only writable
  // persistent store here, and SAVE_CONFIG makes the supplicant rewrite the
  // same file before it answers. Neither belongs on the 25 fps UI timer that
  // drives WifiPolicy::tick().
  pthread_t thread;
  if (::pthread_create(&thread, 0, &DeviceWifi::persistMain, this) != 0) {
    ::pthread_mutex_lock(&mLock);
    mPersistInFlight = false;
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  ::pthread_detach(thread);
}

void* DeviceWifi::persistMain(void* self) {
  DeviceWifi* me = static_cast<DeviceWifi*>(self);

  // BACKUP FIRST, and refuse to save without one. This is the whole reason the
  // step exists separately at all: /data is the one partition a power cycle
  // does NOT clear, so a wpa_supplicant.conf we corrupt here outlives the
  // rescue that fixes everything else — and with no working config there is no
  // network, with no network there is no adb, and adb over TCP is the only
  // channel this unit has (no USB for WiFi models, no recovery partition, and
  // mmc0 is the WiFi chip's SDIO, not a card slot).
  if (backupOnce(kWpaConf, kWpaConfBackup)) {
    std::string reply;
    ::pthread_mutex_lock(&me->mCtrlLock);
    bool ok = me->mCtrl.isOpen() || me->mCtrl.open(kInterface);
    if (ok) {
      // SAVE_CONFIG answers FAIL unless the loaded config carries
      // `update_config=1`, and whether this unit's does is not something the
      // firmware can assume. SET writes the flag in the supplicant's memory
      // only; nothing reaches the disk until the next line, so this cannot make
      // the file worse on its own.
      me->mCtrl.request("SET update_config 1", &reply);
      ok = me->mCtrl.request("SAVE_CONFIG", &reply) && reply.compare(0, 2, "OK") == 0;
    }
    ::pthread_mutex_unlock(&me->mCtrlLock);
    LOGD("wifi: SAVE_CONFIG -> %d", ok ? 1 : 0);
    // A supplicant built with -DCONFIG_NO_CONFIG_WRITE answers FAIL. That is
    // worth saying out loud rather than swallowing: it means credentials
    // entered on the setup page will be gone after the next power cycle, and
    // the panel has no other way to find that out.
    if (!ok) LOGE_TRACE("wifi: SAVE_CONFIG refused; credentials will not survive a power cycle");
  }

  ::pthread_mutex_lock(&me->mLock);
  me->mPersistInFlight = false;
  ::pthread_mutex_unlock(&me->mLock);
  return 0;
}

void* DeviceWifi::dhcpMain(void* self) {
  DeviceWifi* me = static_cast<DeviceWifi*>(self);
  // The only DHCP client on this device. There is no udhcpc, no dhcpcd, and
  // busybox has no dhcp applet — the lease code lives inside libzknet, which is
  // linked for this one function and nothing else (see link-audit.sh).
  const bool ok = NetUtils::dhcpRequestIp("wlan0");
  LOGD("wifi: dhcpRequestIp -> %d", ok ? 1 : 0);
  ::pthread_mutex_lock(&me->mLock);
  me->mDhcpInFlight = false;
  ::pthread_mutex_unlock(&me->mLock);
  return 0;
}

bool DeviceWifi::requestDhcp() {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: requestDhcp refused; sideloaded and /tmp/zos-allow-link absent");
    return false;
  }
  ::pthread_mutex_lock(&mLock);
  if (mDhcpInFlight) {
    ::pthread_mutex_unlock(&mLock);
    return true;  // already asking; saying so is not a failure
  }
  mDhcpInFlight = true;
  ::pthread_mutex_unlock(&mLock);

  // On a thread because dhcpRequestIp blocks for seconds up to its own timeout,
  // and WifiPolicy::tick() runs on the 25 fps UI timer. Calling it inline froze
  // the entire panel for the length of a lease negotiation.
  pthread_t thread;
  if (::pthread_create(&thread, 0, &DeviceWifi::dhcpMain, this) != 0) {
    ::pthread_mutex_lock(&mLock);
    mDhcpInFlight = false;
    ::pthread_mutex_unlock(&mLock);
    return false;
  }
  ::pthread_detach(thread);
  return true;
}

std::string DeviceWifi::softApSsid() { return apSsidFromMac(netinfo::macAddress()); }

// --- the hotspot -------------------------------------------------------------
//
// Desired state in, reconciled by one worker. startSoftAp/stopSoftAp only
// record what is wanted and make sure a worker is running, because every step
// of the real sequence blocks: stopping the supplicant is a poll on a property,
// writing hostapd.conf is a jffs2 write, and three binaries have to be spawned
// and waited on. WifiPolicy::tick() runs on the UI thread and calls
// startSoftAp() again on every supervision round, so this has to be safe to ask
// for repeatedly and cheap to ask for redundantly.

void DeviceWifi::startSoftAp() {
  ::pthread_mutex_lock(&mLock);
  mSoftApWanted = true;
  ::pthread_mutex_unlock(&mLock);
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: startSoftAp refused; sideloaded and /tmp/zos-allow-link absent");
    return;
  }

  ::pthread_mutex_lock(&mLock);
  if (mSoftApWorking) {
    // A worker is already applying a state; it re-reads mSoftApWanted before it
    // exits, so it will pick this up. Spawning a second would race it for
    // wlan0.
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  mSoftApWorking = true;
  ::pthread_mutex_unlock(&mLock);

  pthread_t thread;
  if (::pthread_create(&thread, 0, &DeviceWifi::softApMain, this) != 0) {
    ::pthread_mutex_lock(&mLock);
    mSoftApWorking = false;
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  ::pthread_detach(thread);
}

void DeviceWifi::stopSoftAp() {
  ::pthread_mutex_lock(&mLock);
  const bool wasWanted = mSoftApWanted;
  mSoftApWanted = false;
  ::pthread_mutex_unlock(&mLock);

  if (!linkChangesAllowed()) return;

  // Nothing was ever raised, so there is nothing to take down. This matters:
  // WifiPolicy::applyCredentials() calls stopSoftAp() unconditionally, and on
  // the ordinary path — a user submitting credentials from a laptop on the LAN,
  // with no hotspot anywhere in the picture — killing hostapd and restarting
  // the supplicant would drop a working link for no reason at all. The /proc
  // walk is only paid on that one call, never on a tick.
  if (!wasWanted && !processRunning("hostapd")) return;

  ::pthread_mutex_lock(&mLock);
  if (mSoftApWorking) {
    ::pthread_mutex_unlock(&mLock);
    return;  // the running worker re-reads mSoftApWanted and will tear down
  }
  mSoftApWorking = true;
  ::pthread_mutex_unlock(&mLock);

  pthread_t thread;
  if (::pthread_create(&thread, 0, &DeviceWifi::softApMain, this) != 0) {
    ::pthread_mutex_lock(&mLock);
    mSoftApWorking = false;
    ::pthread_mutex_unlock(&mLock);
  } else {
    ::pthread_detach(thread);
  }
}

void* DeviceWifi::softApMain(void* self) {
  DeviceWifi* me = static_cast<DeviceWifi*>(self);
  // Reconcile until the wanted state stops moving. A user can submit
  // credentials while the AP is still coming up, and leaving hostapd holding
  // wlan0 after that would strand the device with a hotspot nobody is on.
  for (;;) {
    ::pthread_mutex_lock(&me->mLock);
    const bool wanted = me->mSoftApWanted;
    ::pthread_mutex_unlock(&me->mLock);

    if (wanted) {
      me->bringUpSoftAp();
    } else {
      me->tearDownSoftAp();
    }

    ::pthread_mutex_lock(&me->mLock);
    const bool changed = me->mSoftApWanted != wanted;
    if (!changed) me->mSoftApWorking = false;
    ::pthread_mutex_unlock(&me->mLock);
    if (!changed) return 0;
  }
}

void DeviceWifi::bringUpSoftAp() {
  // Re-checked on the worker, not just at the call: the guard file is meant to
  // be created and removed by hand between experiments, and this thread can
  // outlive the tick that started it.
  if (!linkChangesAllowed()) return;

  // Only ever touched from softApMain's thread, and there is at most one of
  // those (mSoftApWorking), so this needs no lock.
  if (mApFailedAtMs >= 0 && (monotonicMs() - mApFailedAtMs) < kApRetryFloorMs) return;

  // 1. THE CONFIG FIRST, while the device is still on the network and still
  //    reachable over adb. Nothing here touches the radio, so a failed backup
  //    or a full /data ends the attempt with the link intact and something in
  //    the log to read. Doing it after `ctl.stop` would mean discovering it
  //    with no way in.
  if (!backupOnce(kHostapdConf, kHostapdConfBackup)) return;
  const std::string ssid = softApSsid();
  if (!writeFileIfChanged(kHostapdConf, hostapdConf(ssid, softApPassphrase()))) return;

  // 2. The radio cannot be a station and an access point at once, and this
  //    driver has no concurrent mode. wpa_supplicant is `oneshot` in
  //    /etc/init.rc, so init will not bring it back on its own — that is
  //    exactly why the teardown below has to.
  SystemProperties::setString("ctl.stop", "wpa_supplicant");
  ::pthread_mutex_lock(&mCtrlLock);
  mCtrl.close();
  mNetworkId = -1;  // ids restart from zero with the daemon
  ::pthread_mutex_unlock(&mCtrlLock);
  for (int waited = 0; waited < 3000 && supplicantRunning(); waited += 100) sleepMs(100);

  // 3. hostapd. -B daemonises, so the process spawned here forks and exits;
  //    what survives is supervised by name (see softApRunning), because init
  //    has no service entry for it and nothing else would notice it dying.
  if (!processRunning("hostapd")) {
    char* argv[4];
    argv[0] = const_cast<char*>(kHostapdBin);
    argv[1] = const_cast<char*>("-B");
    argv[2] = const_cast<char*>(kHostapdConf);
    argv[3] = 0;
    if (!spawnAndWait(kHostapdBin, argv, 4000)) {
      // GIVE THE RADIO BACK. The supplicant was stopped two steps ago, so
      // returning here without this leaves the device with no station link AND
      // no hotspot — no network at all, and therefore no adb. That is the exact
      // brick this file exists to prevent, and it is reachable by nothing worse
      // than a hostapd that will not take this driver.
      mApFailedAtMs = monotonicMs();
      SystemProperties::setString("ctl.start", "wpa_supplicant");
      LOGE_TRACE("wifi: hostapd would not start; no hotspot, supplicant restored");
      return;
    }
    // The interface is torn out of station mode and rebuilt as an AP; giving it
    // an address before that settles loses the address.
    sleepMs(300);
  }

  // 4. The AP-side address. 192.168.100.1 is the stock firmware's gateway for
  //    this mode (libzknet.so calls ifc_set_addr with it), so a phone that has
  //    configured one of these clocks before finds the page where it expects.
  //    ifconfig rather than NetUtils::configure: ADR 0006 keeps this firmware
  //    down to a single libzknet symbol, and configure() would be a second one.
  {
    char* argv[6];
    argv[0] = const_cast<char*>(kIfconfigBin);
    argv[1] = const_cast<char*>(kInterface);
    argv[2] = const_cast<char*>(kSoftApAddress);
    argv[3] = const_cast<char*>("netmask");
    argv[4] = const_cast<char*>("255.255.255.0");
    argv[5] = 0;
    if (!spawnAndWait(kIfconfigBin, argv, 4000)) {
      LOGE_TRACE("wifi: could not address wlan0 as %s", kSoftApAddress);
    }
  }

  // 5. dnsmasq, for the lease and for the captive-portal prompt. The vendor's
  //    own docs say a phone joining U-Clock gets an address, so something on
  //    the device hands them out; this is that something, with the same pool
  //    the stock firmware uses.
  if (!processRunning("dnsmasq")) {
    char* argv[7];
    argv[0] = const_cast<char*>(kDnsmasqBin);
    argv[1] = const_cast<char*>("--interface=wlan0");
    argv[2] = const_cast<char*>(kDhcpRangeArg);
    argv[3] = const_cast<char*>(kDnsCatchAllArg);
    // --no-resolv / --no-poll are in libzknet's own argument list. They matter
    // here for a reason the stock app did not have: there is no upstream to
    // forward to while the hotspot is up, and without them dnsmasq wants
    // /etc/resolv.conf and re-reads it on a timer.
    argv[4] = const_cast<char*>("--no-resolv");
    argv[5] = const_cast<char*>("--no-poll");
    argv[6] = 0;
    if (!spawnAndWait(kDnsmasqBin, argv, 4000)) {
      // Not fatal, and deliberately not a reason to abandon the hotspot: a user
      // who sets a static address on their phone can still reach the page, and
      // an SSID on the air with no DHCP is strictly better than no SSID.
      LOGE_TRACE("wifi: dnsmasq would not start; the hotspot has no DHCP");
    }
  }
  mApFailedAtMs = -1;
  LOGD("wifi: hotspot %s up on %s", ssid.c_str(), kSoftApAddress);
}

void DeviceWifi::tearDownSoftAp() {
  if (!linkChangesAllowed()) return;

  // Reverse order. dnsmasq first so no phone is handed a lease on a network
  // that is about to disappear.
  terminateProcess("dnsmasq");

  // Drop the AP address before the supplicant comes back, or wlan0 keeps
  // 192.168.100.1 alongside whatever DHCP hands it and the routing table has
  // two answers. hasAddress() rejects the 0.0.0.0 this leaves behind.
  {
    char* argv[4];
    argv[0] = const_cast<char*>(kIfconfigBin);
    argv[1] = const_cast<char*>(kInterface);
    argv[2] = const_cast<char*>("0.0.0.0");
    argv[3] = 0;
    spawnAndWait(kIfconfigBin, argv, 4000);
  }

  terminateProcess("hostapd");

  // And give the radio back. Nothing else will: /etc/init.rc declares
  // wpa_supplicant `disabled` + `oneshot`, so if this line is not reached the
  // device has neither a hotspot nor a way to join a network — which is the
  // single failure this whole file exists to avoid.
  SystemProperties::setString("ctl.start", "wpa_supplicant");
  LOGD("wifi: hotspot down, supplicant restarting");
}

}  // namespace tcos
