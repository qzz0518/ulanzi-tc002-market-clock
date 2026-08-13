#include "platform/DeviceWifi.h"

#include <dirent.h>
#include <fcntl.h>
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
#include "platform/ProvisionLog.h"

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
// One name for the conf, owned by the header so the host check pins the same
// path the device writes.
const char* kHostapdConf = DeviceWifi::hostapdConfPath();
const char* kHostapdConfBackup = "/data/misc/wifi/hostapd.conf.zos-bak";

// Absolute paths, and no shell. The device's PATH is `/sbin:/bin:/tmp:`, so
// these would resolve anyway, but exec'ing the path we mean means a stray
// binary dropped in /tmp — the directory a sideload writes to — cannot end up
// holding the radio.
const char* kHostapdBin = "/bin/hostapd";
const char* kDnsmasqBin = "/bin/dnsmasq";
const char* kIfconfigBin = "/sbin/ifconfig";

const char* kInterface = "wlan0";

// How long to leave the radio alone after a hotspot bring-up failed.
//
// Without a floor the policy's supervision would ask again every three seconds,
// and every attempt stops wpa_supplicant on its way in — a device whose hostapd
// is broken would then flap the supplicant faster than an association can
// complete, and would never rejoin its network even when the router came back.
// Thirty seconds is longer than WifiPolicy::kConnectTimeoutMs, so the station
// path gets one whole honest attempt between hotspot attempts.
const int kApRetryFloorMs = 30000;
// The same floor for dnsmasq, which fails much faster than hostapd — a rejected
// argument is an exit inside a millisecond — and would otherwise be re-spawned
// on every supervision round for as long as the hotspot is up.
const int kDhcpRetryFloorMs = 30000;

// How often the hotspot worker reconciles while the hotspot is wanted.
//
// The worker used to exit as soon as the AP was up, which meant dnsmasq got
// exactly ONE attempt per hostapd lifetime: WifiPolicy supervises
// softApRunning(), that predicate is hostapd alone by design, and nothing
// anywhere watched the DHCP server. A dnsmasq that never started — or one the
// kernel reaped an hour in — stayed dead until the next reboot. That is why the
// missing-pid-file bug below presented as permanent rather than intermittent.
//
// Three seconds matches WifiPolicy::kSoftApSuperviseMs: the cost is a walk of
// /proc, and asking more often than the policy already does buys nothing.
const int kApSuperviseMs = 3000;
// Granularity of that wait. stopSoftAp() only records the wish and trusts a
// running worker to notice, so this is also the worst case between "give the
// radio back" and the ctl.start that does it — deliberately far below the
// supervision period.
const int kApWantPollMs = 250;

// How long a hotspot bring-up waits for an outstanding lease request to finish
// before it takes wlan0.
//
// libzknet's dhcpRequestIp() runs on a detached thread that cannot be cancelled
// and whose timeout is not published, and when it returns it WRITES wlan0 — the
// router's address on success, 0.0.0.0 on failure. Either lands on top of the
// hotspot's gateway if it arrives after the bring-up, and a hotspot whose
// interface has no gateway hands out nothing while looking perfectly healthy.
//
// Five seconds is a courtesy rather than a guarantee: it covers the tail of a
// negotiation that is nearly done, and refuses to hold the one way back into a
// stranded device hostage to a library call that may never return. What makes
// stopping safe is that the supervision round reconciles the address every three
// seconds afterwards — see DeviceWifi::applyApAddress.
const int kDhcpSettleMs = 5000;

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

// Whether a pid still has a /proc entry. Used for processes that are not our
// children (the layer-3 daemon), where waitpid can say nothing.
bool processAlive(int pid) {
  char path[32];
  ::snprintf(path, sizeof(path), "/proc/%d", pid);
  return fileExists(path);
}

// /proc/<pid>/cmdline with the NUL separators turned into spaces, or "" when
// the process is gone. This is the identity a pid is verified against: pids
// are recycled, and on a box this small "still alive" and "still the process I
// started" genuinely diverge.
std::string readCmdline(int pid) {
  char path[64];
  ::snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
  FILE* f = ::fopen(path, "rb");
  if (f == 0) return std::string();
  char buf[512];
  const size_t n = ::fread(buf, 1, sizeof(buf), f);
  ::fclose(f);
  std::string out(buf, n);
  for (size_t i = 0; i < out.size(); ++i) {
    if (out[i] == '\0') out[i] = ' ';
  }
  while (!out.empty() && out[out.size() - 1] == ' ') out.erase(out.size() - 1);
  return out;
}

// The pid dnsmasq wrote to its own pid file (layer 3 daemonises, so the child
// this app spawned is not the daemon that survives). -1 when unreadable.
int readDnsmasqPidFile() {
  FILE* f = ::fopen(DeviceWifi::dnsmasqPidFile(), "r");
  if (f == 0) return -1;
  int pid = -1;
  if (::fscanf(f, "%d", &pid) != 1) pid = -1;
  ::fclose(f);
  return pid > 0 ? pid : -1;
}

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
//
// `stderrPath`, when given, is where the CHILD's own words go. That channel had
// to be invented: posix_spawn hands the child zkgui's stderr, which lands
// nowhere a human reads, and logcat wedges adbd on this unit so it is not an
// option either. dnsmasq spent the life of this feature printing "failed to open
// pidfile /var/run/dnsmasq.pid: No such file or directory" into that void while
// the only surviving signal was a bare false. The file is on tmpfs, so it costs
// no flash and is gone on the next power cycle — but it survives the hotspot,
// which means it is still there to read over adb once the device is back on a
// network, and that is the whole point.
bool spawnAndWait(const char* path, char* const argv[], int timeoutMs,
                  const char* stderrPath = 0) {
  pid_t pid = -1;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_t* actionsPtr = 0;
  if (stderrPath != 0 && ::posix_spawn_file_actions_init(&actions) == 0) {
    if (::posix_spawn_file_actions_addopen(&actions, 2, stderrPath,
                                           O_WRONLY | O_CREAT | O_TRUNC, 0644) == 0) {
      actionsPtr = &actions;
    } else {
      ::posix_spawn_file_actions_destroy(&actions);
    }
  }
  const int spawned = ::posix_spawn(&pid, path, actionsPtr, 0, argv, environ);
  if (actionsPtr != 0) ::posix_spawn_file_actions_destroy(actionsPtr);
  if (spawned != 0) {
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
    if (done == pid) {
      if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return true;
      // SAY THE STATUS. This used to be one line collapsing four different
      // failures into a bare false, and the one it hid was the most informative
      // of them: an exit code means the binary ran and rejected its own
      // ARGUMENTS, which is a different bug from a binary that is missing or one
      // that hung. dnsmasq spent months exiting 3 here — "failed to open pidfile
      // /var/run/dnsmasq.pid" — while the caller logged "would not start", which
      // points at the wrong hypothesis entirely. The child's own explanation is
      // unreachable (posix_spawn inherits zkgui's stderr, which lands nowhere a
      // human reads), so this number is all there is.
      if (WIFEXITED(status)) {
        LOGE_TRACE("wifi: %s exited %d", path, WEXITSTATUS(status));
      } else if (WIFSIGNALED(status)) {
        LOGE_TRACE("wifi: %s killed by signal %d", path, WTERMSIG(status));
      }
      return false;
    }
    if (done < 0) {
      LOGE_TRACE("wifi: waitpid on %s failed", path);
      return false;
    }
    sleepMs(20);
  }
  LOGE_TRACE("wifi: %s did not exit within %d ms", path, timeoutMs);
  return false;
}

// Starts a binary that is meant to STAY — the vendor's execution model for
// dnsmasq — and returns its pid without waiting, or -1.
//
// The counterpart to spawnAndWait above, which exists for children that exit
// (ifconfig) or daemonise (hostapd -B). A foreground dnsmasq is deliberately
// neither: the pid returned here is the server itself, so supervision can
// waitpid it — which both proves identity beyond any /proc heuristic and hands
// back the exit status when it dies, the single most informative number this
// subsystem has ever had. The child's stderr goes to `stderrPath` (O_TRUNC:
// newest attempt wins), which for the hotspot layers is a file on /data — the
// only storage that still exists after the power cycle that lets adb back in.
pid_t spawnDaemon(const char* path, char* const argv[], const char* stderrPath) {
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_t* actionsPtr = 0;
  if (stderrPath != 0 && ::posix_spawn_file_actions_init(&actions) == 0) {
    if (::posix_spawn_file_actions_addopen(&actions, 2, stderrPath,
                                           O_WRONLY | O_CREAT | O_TRUNC, 0644) == 0) {
      actionsPtr = &actions;
    } else {
      ::posix_spawn_file_actions_destroy(&actions);
    }
  }
  pid_t pid = -1;
  const int spawned = ::posix_spawn(&pid, path, actionsPtr, 0, argv, environ);
  if (actionsPtr != 0) ::posix_spawn_file_actions_destroy(actionsPtr);
  if (spawned != 0) {
    LOGE_TRACE("wifi: cannot spawn %s", path);
    return -1;
  }
  return pid;
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
      mApDhcpFailed(false),
      mApFailedAtMs(-1),
      mDhcpFailedAtMs(-1),
      mDnsmasqPid(-1),
      mDnsmasqLayer(0),
      mDhcpRespawns(0),
      // "true" = no sweep in flight, so the first startScan() stamps a fresh one.
      mScanIssuedMs(-1),
      mScanDoneLogged(true),
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

  // CONTRACT (WifiPolicy::Actuator::scanResults): an empty list is "not done",
  // never "done, nothing there". SCAN_RESULTS reads the supplicant's cache,
  // which answers instantly and is a bare header for the first seconds of a
  // fresh daemon's life — returning true for it let the policy declare the
  // sweep finished on its first 160 ms tick, raise the hotspot, stop the
  // supplicant, and kill the real sweep mid-air. The scan budget was dead code
  // and the setup page's dropdown was empty for every first boot there was.
  // scanSweepComplete is the pinned, host-checked form of this rule.
  if (!scanSweepComplete(true, out->size())) return false;

  if (!mScanDoneLogged) {
    mScanDoneLogged = true;
    char fields[64];
    ::snprintf(fields, sizeof(fields), "n=%d t=%d exit=result", static_cast<int>(out->size()),
               mScanIssuedMs >= 0 ? monotonicMs() - mScanIssuedMs : -1);
    ProvisionLog::device().log("SCAN_DONE", fields);
  }
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
  // The supplicant's raw answer, kept for the breadcrumb: OK means a sweep is
  // now running, FAIL-BUSY means one already was (fine either way), and
  // no-socket means there was nobody to ask — three different explanations for
  // an empty dropdown, indistinguishable after the fact without this line.
  std::string reply = "no-socket";
  ::pthread_mutex_lock(&mCtrlLock);
  if (mCtrl.isOpen() || mCtrl.open(kInterface)) {
    if (!mCtrl.request("SCAN", &reply)) reply = "no-reply";
  }
  ::pthread_mutex_unlock(&mCtrlLock);
  while (!reply.empty() && (reply[reply.size() - 1] == '\n' || reply[reply.size() - 1] == '\r')) {
    reply.erase(reply.size() - 1);
  }

  // A fresh sweep starts the SCAN_DONE clock; a re-issue into a sweep already
  // running (WifiPolicy::kScanRetryMs) keeps the original start time, because
  // the duration worth knowing is "SCAN to first non-empty cache".
  if (mScanDoneLogged) {
    mScanDoneLogged = false;
    mScanIssuedMs = monotonicMs();
  }
  ProvisionLog::device().log("SCAN_CMD", "reply=" + reply);
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
  //
  // And then STAY, for as long as the hotspot is wanted. Only a teardown ends
  // this thread. The reason is dnsmasq: hostapd has a supervisor (WifiPolicy
  // watches softApRunning() every kSoftApSuperviseMs) and the DHCP server has
  // never had one, so a single failed spawn was permanent for the boot. See
  // kApSuperviseMs.
  for (;;) {
    ::pthread_mutex_lock(&me->mLock);
    const bool wanted = me->mSoftApWanted;
    ::pthread_mutex_unlock(&me->mLock);

    bool up = false;
    if (wanted) {
      up = me->bringUpSoftAp();
    } else {
      me->tearDownSoftAp();
    }

    ::pthread_mutex_lock(&me->mLock);
    const bool changed = me->mSoftApWanted != wanted;
    // Stay only while there is a hotspot to watch. A bring-up that was refused
    // or failed ends this thread exactly as it always did, so the retry floor
    // and the policy's own supervision keep driving it — a resident worker
    // looping on a guard file that is never going to appear would be a thread
    // held for the life of a sideloaded install.
    const bool done = !changed && !(wanted && up);
    if (done) me->mSoftApWorking = false;
    ::pthread_mutex_unlock(&me->mLock);
    if (done) return 0;
    if (changed) continue;  // someone moved the goalposts; reconcile at once

    // Hotspot up and still wanted. Sleep out the supervision period in slices,
    // so a stopSoftAp() that arrives mid-wait gets the radio back promptly
    // rather than after a full period.
    for (int waited = 0; waited < kApSuperviseMs; waited += kApWantPollMs) {
      ::pthread_mutex_lock(&me->mLock);
      const bool stillWanted = me->mSoftApWanted;
      ::pthread_mutex_unlock(&me->mLock);
      if (!stillWanted) break;
      sleepMs(kApWantPollMs);
    }
  }
}

// Puts the AP-side address back on wlan0.
//
// 192.168.100.1 is the stock firmware's gateway for this mode (libzknet.so calls
// ifc_set_addr with it), so a phone that has configured one of these clocks
// before finds the page where it expects. ifconfig rather than
// NetUtils::configure: ADR 0006 keeps this firmware down to a single libzknet
// symbol, and configure() would be a second one.
bool DeviceWifi::applyApAddress() {
  char* argv[6];
  argv[0] = const_cast<char*>(kIfconfigBin);
  argv[1] = const_cast<char*>(kInterface);
  argv[2] = const_cast<char*>(kSoftApAddress);
  argv[3] = const_cast<char*>("netmask");
  argv[4] = const_cast<char*>("255.255.255.0");
  argv[5] = 0;
  const bool ok = spawnAndWait(kIfconfigBin, argv, 4000);
  // rc AND readback, always. The bring-up used to ignore this function's
  // return value, and the audit found no other reporter: a silent ifconfig
  // failure produced a hotspot whose dnsmasq matched no DHCP context, looked
  // healthy to every process check, and left nothing to read afterwards. The
  // readback is the ground truth the rc is checked against — ifconfig can exit
  // 0 and the address still be gone a moment later (libzknet's late lease
  // write), which ADDR_CHANGE in the supervision round then catches.
  const std::string readback = netinfo::ipAddress();
  ProvisionLog::device().log("AP_ADDR", std::string("rc=") + (ok ? "ok" : "fail") +
                                            " readback=" +
                                            (readback.empty() ? "none" : readback));
  if (ok) return true;
  LOGE_TRACE("wifi: could not address %s as %s", kInterface, kSoftApAddress);
  return false;
}

void DeviceWifi::awaitDhcpQuiet(int timeoutMs) {
  bool announced = false;
  for (int waited = 0; waited < timeoutMs; waited += 100) {
    ::pthread_mutex_lock(&mLock);
    const bool busy = mDhcpInFlight;
    ::pthread_mutex_unlock(&mLock);
    if (!busy) return;
    if (!announced) {
      announced = true;
      LOGD("wifi: hotspot waiting out a lease request still in flight on %s", kInterface);
    }
    sleepMs(100);
  }
  ::pthread_mutex_lock(&mLock);
  const bool stillBusy = mDhcpInFlight;
  ::pthread_mutex_unlock(&mLock);
  if (stillBusy) {
    LOGE_TRACE("wifi: lease request still in flight after %d ms; raising the hotspot anyway, "
               "the address will be reconciled",
               timeoutMs);
  }
}

// Spawns dnsmasq with one argument list and reports whether a daemon is actually
// there afterwards.
//
// The second half is not paranoia. dnsmasq daemonises, so this call returns as
// soon as the PARENT exits; a build that got past option parsing and then died
// on something else exits 0 here and is gone by the time anything looks. That
// reads as a healthy spawn followed, three seconds later, by a process check
// that finds nothing and spawns another one — forever, on a device with ~1 MB
// free. Confirming the daemon exists is what lets the retry floor apply.
bool DeviceWifi::spawnDnsmasq(const std::vector<std::string>& args, const char* errPath) {
  std::vector<char*> argv;
  argv.push_back(const_cast<char*>(kDnsmasqBin));
  for (size_t i = 0; i < args.size(); ++i) {
    // The strings outlive the spawn because `args` does.
    argv.push_back(const_cast<char*>(args[i].c_str()));
  }
  argv.push_back(0);

  if (!spawnAndWait(kDnsmasqBin, &argv[0], 4000, errPath)) return false;
  for (int waited = 0; waited < 1000; waited += 50) {
    if (processRunning("dnsmasq")) return true;
    sleepMs(50);
  }
  LOGE_TRACE("wifi: dnsmasq exited 0 and is not running; see %s", errPath);
  return false;
}

// Whether the DHCP server this object started is still the one serving.
//
// Never by bare process name: that check once claimed ANY dnsmasq — including
// one started by init off the vendor conf, whose 192.168.1.x pool can never
// match this AP — and reported the shipped bug as a healthy hotspot. Identity
// comes from waitpid (a foreground child is ours beyond argument) backed by
// the cmdline fingerprint for pids that are not our children.
bool DeviceWifi::dnsmasqHealthy() {
  char fields[128];
  if (mDnsmasqPid > 0) {
    int status = 0;
    const pid_t done = ::waitpid(mDnsmasqPid, &status, WNOHANG);
    if (done == mDnsmasqPid) {
      // Our foreground child died, and the exit status is the whole story —
      // the number the daemonised model threw away for a year.
      ++mDhcpRespawns;
      if (WIFEXITED(status)) {
        ::snprintf(fields, sizeof(fields), "pid=%d exit=%d respawn=%d",
                   static_cast<int>(mDnsmasqPid), WEXITSTATUS(status), mDhcpRespawns);
      } else if (WIFSIGNALED(status)) {
        ::snprintf(fields, sizeof(fields), "pid=%d signal=%d respawn=%d",
                   static_cast<int>(mDnsmasqPid), WTERMSIG(status), mDhcpRespawns);
      } else {
        ::snprintf(fields, sizeof(fields), "pid=%d exit=unknown respawn=%d",
                   static_cast<int>(mDnsmasqPid), mDhcpRespawns);
      }
      ProvisionLog::device().log("DNSMASQ_DEAD", fields);
      mDnsmasqPid = -1;
      return false;
    }
    if (done == 0) return true;  // still running, still our child
    // Not our child: the layer-3 daemon, or a server adopted after a firmware
    // restart. Alive means a /proc entry whose cmdline still claims to be OUR
    // dnsmasq — pid recycling is real on a box that respawns this much.
    if (processAlive(mDnsmasqPid) &&
        cmdlineClaimsOurDnsmasq(readCmdline(mDnsmasqPid), kSoftApAddress)) {
      return true;
    }
    ++mDhcpRespawns;
    ::snprintf(fields, sizeof(fields), "pid=%d exit=unknown respawn=%d",
               static_cast<int>(mDnsmasqPid), mDhcpRespawns);
    ProvisionLog::device().log("DNSMASQ_DEAD", fields);
    mDnsmasqPid = -1;
    return false;
  }

  // No pid on record — first round, or the firmware restarted under a live
  // hotspot. Adopt a server only when its command line proves it is ours; a
  // stranger serving the wrong pool must read as "no DHCP", because that is
  // what it is.
  const int pid = findProcess("dnsmasq");
  if (pid > 0 && cmdlineClaimsOurDnsmasq(readCmdline(pid), kSoftApAddress)) {
    mDnsmasqPid = pid;
    if (mDnsmasqLayer <= 0) mDnsmasqLayer = kDnsmasqLayers;  // provenance unknown; assume least
    ::snprintf(fields, sizeof(fields), "pid=%d", pid);
    ProvisionLog::device().log("DNSMASQ_ADOPT", fields);
    return true;
  }
  return false;
}

// One start attempt with one layer's argument list. True when a server is up
// and owned; every outcome lands in the breadcrumb log either way.
bool DeviceWifi::attemptDnsmasqLayer(int layer) {
  const std::vector<std::string> args = dnsmasqArgsForLayer(layer, kSoftApAddress);
  const char* errPath = dnsmasqErrFile(layer);
  char fields[160];

  if (layer >= kDnsmasqLayers) {
    // The measured invocation, executed exactly as it was measured: the parent
    // daemonises, success is a named process appearing, and the pid worth
    // holding is the one dnsmasq wrote to its own pid file.
    const bool up = spawnDnsmasq(args, errPath);
    if (up) {
      mDnsmasqPid = readDnsmasqPidFile();  // -1 degrades to the cmdline walk above
      mDnsmasqLayer = layer;
      ::snprintf(fields, sizeof(fields), "layer=%d pid=%d outcome=alive", layer,
                 static_cast<int>(mDnsmasqPid));
    } else {
      ::snprintf(fields, sizeof(fields), "layer=%d outcome=down see=%s", layer, errPath);
    }
    ProvisionLog::device().log("DNSMASQ_TRY", fields);
    return up;
  }

  std::vector<char*> argv;
  argv.push_back(const_cast<char*>(kDnsmasqBin));
  for (size_t i = 0; i < args.size(); ++i) {
    argv.push_back(const_cast<char*>(args[i].c_str()));
  }
  argv.push_back(0);

  const pid_t pid = spawnDaemon(kDnsmasqBin, &argv[0], errPath);
  if (pid < 0) {
    ::snprintf(fields, sizeof(fields), "layer=%d outcome=spawn-fail", layer);
    ProvisionLog::device().log("DNSMASQ_TRY", fields);
    return false;
  }
  // 700 ms covers option parsing and both binds; a rejected argument or an
  // occupied port 67 exits well inside it, and the exit code below then names
  // the layer that was refused — the line the original bug never wrote.
  sleepMs(700);
  int status = 0;
  const pid_t done = ::waitpid(pid, &status, WNOHANG);
  if (done == pid) {
    if (WIFEXITED(status)) {
      ::snprintf(fields, sizeof(fields), "layer=%d pid=%d outcome=exit:%d see=%s", layer,
                 static_cast<int>(pid), WEXITSTATUS(status), errPath);
    } else if (WIFSIGNALED(status)) {
      ::snprintf(fields, sizeof(fields), "layer=%d pid=%d outcome=signal:%d see=%s", layer,
                 static_cast<int>(pid), WTERMSIG(status), errPath);
    } else {
      ::snprintf(fields, sizeof(fields), "layer=%d pid=%d outcome=exit:unknown see=%s", layer,
                 static_cast<int>(pid), errPath);
    }
    ProvisionLog::device().log("DNSMASQ_TRY", fields);
    return false;
  }

  mDnsmasqPid = pid;
  mDnsmasqLayer = layer;
  ::snprintf(fields, sizeof(fields), "layer=%d pid=%d outcome=alive", layer,
             static_cast<int>(pid));
  ProvisionLog::device().log("DNSMASQ_TRY", fields);
  return true;
}

// Keeps the hotspot's DHCP server alive, and records whether the hotspot can
// hand out an address at all.
//
// Split out of the bring-up because it is the only step that has to be repeated:
// hostapd is watched by the policy, and this is the process that can die — or
// never start — without anything noticing.
void DeviceWifi::superviseDhcp() {
  // BOTH HALVES, or neither. A DHCP context only matches when it covers the
  // address the request arrived on, so a running dnsmasq on a wlan0 that has
  // lost its gateway is not a working DHCP server — it is the shipped bug
  // wearing a healthy process check. Read once per round; the caller has already
  // reconciled the address by the time this runs.
  const bool addressed = netinfo::ipAddress() == kSoftApAddress;

  if (dnsmasqHealthy()) {
    mApDhcpFailed = !addressed;
    if (addressed) mDhcpFailedAtMs = -1;
    return;
  }
  if (mDhcpFailedAtMs >= 0 && (monotonicMs() - mDhcpFailedAtMs) < kDhcpRetryFloorMs) {
    mApDhcpFailed = true;
    return;
  }

  // THE LADDER, most capable first, best evidence last. dnsmasq exits
  // EC_BADCONF on any argument it does not accept, and a rejected flag must
  // cost one spawn, never the hotspot — see dnsmasqArgsForLayer in the header
  // for what each layer is and what evidence stands behind it. Every attempt
  // writes a DNSMASQ_TRY breadcrumb, so a pulled log names the layer that
  // served, or the exit code of each one that refused.
  for (int layer = 1; layer <= kDnsmasqLayers; ++layer) {
    if (attemptDnsmasqLayer(layer)) {
      if (layer > 1) LOGD("wifi: dnsmasq up on argument layer %d", layer);
      mApDhcpFailed = !addressed;
      if (addressed) mDhcpFailedAtMs = -1;
      return;
    }
  }

  // Not fatal, and deliberately still not a reason to abandon the hotspot: the
  // supplicant is stopped by then, so giving up here would leave the device with
  // no station link AND no hotspot. An SSID on the air that a user can reach by
  // setting a static address is better than no SSID.
  //
  // But only if they are TOLD to. "Non-fatal" was read as "not worth mentioning"
  // and that is how a hotspot with no DHCP shipped: the SSID appears, the phone
  // associates, the lease never comes, and every visible surface — including the
  // panel's own 配网 row — kept showing a plausible address nobody could reach.
  // The flag below is what the settings screen turns into an instruction.
  mApDhcpFailed = true;
  mDhcpFailedAtMs = monotonicMs();
  LOGE_TRACE("wifi: dnsmasq did not start on any argument layer; the hotspot has no DHCP "
             "(see /data/zos-dnsmasq.l*.log)");
}

bool DeviceWifi::bringUpSoftAp() {
  // Re-checked on the worker, not just at the call: the guard file is meant to
  // be created and removed by hand between experiments, and this thread can
  // outlive the tick that started it.
  if (!linkChangesAllowed()) return false;

  // ALREADY ON THE AIR. This is the path every supervision round after the
  // first takes, and it must not touch the RADIO: re-running the sequence below
  // would ctl.stop a supplicant that is already stopped and restart hostapd on
  // top of itself, three seconds at a time, for as long as a stranded device
  // sits in provisioning. What still needs reconciling is the address and the
  // DHCP server — neither of which touches the radio.
  if (processRunning("hostapd")) {
    // THE ADDRESS, not just the process. Step 5 below runs once per hostapd
    // lifetime and nothing used to check it again, but wlan0 can lose
    // kSoftApAddress after it: libzknet's dhcpRequestIp() runs on a detached
    // thread this class cannot cancel, and whenever it finally returns it writes
    // that same interface — the router's address on success, 0.0.0.0 on failure.
    // Either one stops every DHCP context matching, and dnsmasq answers nothing
    // while staying in /proc, which is the shipped bug with a healthy-looking
    // process check on top of it. A getifaddrs against the /proc walk this round
    // has already paid for is free.
    const std::string addr = netinfo::ipAddress();
    if (addr != mLastApAddr) {
      // Transitions only: this is the breadcrumb that pins (or clears) the
      // address-hole hypothesis, and a per-round line would be a jffs2 write
      // every three seconds for the life of a stranded device.
      ProvisionLog::device().log("ADDR_CHANGE",
                                 "old=" + (mLastApAddr.empty() ? "none" : mLastApAddr) +
                                     " new=" + (addr.empty() ? "none" : addr));
      mLastApAddr = addr;
    }
    if (addr != kSoftApAddress) {
      LOGE_TRACE("wifi: %s lost %s while the hotspot was up; re-applying", kInterface,
                 kSoftApAddress);
      applyApAddress();
    }
    superviseDhcp();
    return true;
  }

  // Only ever touched from softApMain's thread, and there is at most one of
  // those (mSoftApWorking), so this needs no lock.
  if (mApFailedAtMs >= 0 && (monotonicMs() - mApFailedAtMs) < kApRetryFloorMs) return false;

  // 1. THE CONFIG FIRST, while the device is still on the network and still
  //    reachable over adb. Nothing here touches the radio, so a failed backup
  //    or a full /data ends the attempt with the link intact and something in
  //    the log to read. Doing it after `ctl.stop` would mean discovering it
  //    with no way in.
  if (!backupOnce(kHostapdConf, kHostapdConfBackup)) return false;
  const std::string ssid = softApSsid();
  if (!writeFileIfChanged(kHostapdConf, hostapdConf(ssid, softApPassphrase()))) return false;

  // 2. LET ANY LEASE NEGOTIATION FINISH FIRST. A DHCP request outstanding on
  //    wlan0 ends by writing that interface, and if it lands after step 5 the
  //    hotspot is left with no gateway and no way to hand out an address. This
  //    is a bounded courtesy, not a guarantee — see kDhcpSettleMs and the
  //    reconciliation in the resident round above, which is what covers the case
  //    where the library never comes back at all.
  awaitDhcpQuiet(kDhcpSettleMs);

  // 3. The radio cannot be a station and an access point at once, and this
  //    driver has no concurrent mode. wpa_supplicant is `oneshot` in
  //    /etc/init.rc, so init will not bring it back on its own — that is
  //    exactly why the teardown below has to.
  SystemProperties::setString("ctl.stop", "wpa_supplicant");
  ::pthread_mutex_lock(&mCtrlLock);
  mCtrl.close();
  mNetworkId = -1;  // ids restart from zero with the daemon
  ::pthread_mutex_unlock(&mCtrlLock);
  for (int waited = 0; waited < 3000 && supplicantRunning(); waited += 100) sleepMs(100);
  {
    // Whether ctl.stop actually took. A supplicant that survived it would fight
    // hostapd for wlan0 with symptoms identical to every other DHCP failure —
    // this line is what rules that in or out from a pulled log.
    char svc[64];
    svc[0] = '\0';
    SystemProperties::getString("init.svc.wpa_supplicant", svc, "");
    ProvisionLog::device().log("SUPP_STOP", std::string("svc=") + (svc[0] != '\0' ? svc : "unset"));
  }

  // 4. hostapd. -B daemonises, so the process spawned here forks and exits;
  //    what survives is supervised by name (see softApRunning), because init
  //    has no service entry for it and nothing else would notice it dying.
  //
  //    TWO TIERS, like dnsmasq's ladder and for the same reason. The preferred
  //    shape is the vendor's own — `-e <entropy file>` with the file pre-seeded
  //    (see entropyFile() in the header): a headless box with no input devices
  //    fills its kernel entropy pool at a crawl, and a hostapd left to that
  //    pool can refuse WPA handshakes outright. The fallback is the bare
  //    invocation this firmware always used, the one that has demonstrably put
  //    the SSID on the air — a build that rejected -e must not cost the
  //    hotspot.
  {
    const char* entropy = ensureEntropyFile();
    bool spawned = false;
    // Built from the same hostapdArgs() the host check pins, so what is
    // asserted and what actually runs cannot drift apart — the exact drift
    // that let the dnsmasq argv ship broken.
    for (int tier = 0; tier < 2 && !spawned; ++tier) {
      const bool withEntropy = tier == 0;
      const std::vector<std::string> args = hostapdArgs(withEntropy);
      std::vector<char*> argv;
      argv.push_back(const_cast<char*>(kHostapdBin));
      for (size_t i = 0; i < args.size(); ++i) {
        argv.push_back(const_cast<char*>(args[i].c_str()));
      }
      argv.push_back(0);
      spawned = spawnAndWait(kHostapdBin, &argv[0], 4000);
      std::string fields = std::string("args=") + (withEntropy ? "entropy" : "plain") +
                           " rc=" + (spawned ? "ok" : "fail");
      if (withEntropy) fields += std::string(" entropy=") + entropy;
      ProvisionLog::device().log("HOSTAPD_SPAWN", fields);
    }
    if (!spawned) {
      // GIVE THE RADIO BACK. The supplicant was stopped two steps ago, so
      // returning here without this leaves the device with no station link AND
      // no hotspot — no network at all, and therefore no adb. That is the exact
      // brick this file exists to prevent, and it is reachable by nothing worse
      // than a hostapd that will not take this driver.
      mApFailedAtMs = monotonicMs();
      // "No hotspot" is not "a hotspot with no DHCP", and the panel says
      // different things about them. Leaving the flag set here would put 手动配网
      // on a device that has no access point to configure anything over.
      mApDhcpFailed = false;
      mDhcpFailedAtMs = -1;
      SystemProperties::setString("ctl.start", "wpa_supplicant");
      ProvisionLog::device().log("AP_ABORT", "step=hostapd supplicant=restored");
      LOGE_TRACE("wifi: hostapd would not start; no hotspot, supplicant restored");
      return false;
    }
    // The interface is torn out of station mode and rebuilt as an AP; giving it
    // an address before that settles loses the address.
    sleepMs(300);
  }

  // 5. The AP-side address. Re-asserted on every supervision round from here
  //    on, because it is what every DHCP context is matched against.
  applyApAddress();

  // 6. dnsmasq, for the lease and for the captive-portal prompt. The vendor's
  //    own docs say a phone joining U-Clock gets an address, so something on
  //    the device hands them out; this is that something, with the same pool
  //    the stock firmware uses. The three argument layers, what each one is
  //    for, and what evidence stands behind each are in
  //    DeviceWifi::dnsmasqArgsForLayer — this step is where one missing
  //    argument once made the whole hotspot useless.
  superviseDhcp();

  mApFailedAtMs = -1;
  // Baseline for the ADDR_CHANGE transitions the supervision rounds will log.
  mLastApAddr = netinfo::ipAddress();
  ProvisionLog::device().log("AP_UP", "ssid=" + ssid + " addr=" +
                                          (mLastApAddr.empty() ? "none" : mLastApAddr) +
                                          " dhcp=" + (mApDhcpFailed ? "down" : "up"));
  // Say what actually happened. This line used to claim success unconditionally
  // and was the last word on a hotspot that could not hand out a single address.
  LOGD("wifi: hotspot %s up on %s, DHCP %s", ssid.c_str(), kSoftApAddress,
       mApDhcpFailed ? "DOWN" : "up");
  return true;
}

// Stops OUR dnsmasq and nothing else's. The held pid first — and reaped, so a
// foreground child never zombies for the life of zkgui — then any survivor
// whose cmdline claims to be ours (a server whose pid was lost across a
// firmware restart). A dnsmasq that is not ours predates this hotspot and is
// deliberately left alone: killing init's daemon to clean up our own mess
// would be a new way to change system state nobody asked us to change.
void DeviceWifi::stopDnsmasq() {
  if (mDnsmasqPid > 0) {
    ::kill(mDnsmasqPid, SIGTERM);
    bool gone = false;
    for (int waited = 0; waited < 2000 && !gone; waited += 50) {
      int status = 0;
      const pid_t done = ::waitpid(mDnsmasqPid, &status, WNOHANG);
      if (done == mDnsmasqPid) {
        gone = true;
        break;
      }
      if (done < 0 && !processAlive(mDnsmasqPid)) {
        gone = true;  // not our child (layer 3); /proc is the truth
        break;
      }
      sleepMs(50);
    }
    if (!gone) {
      ::kill(mDnsmasqPid, SIGKILL);
      int status = 0;
      ::waitpid(mDnsmasqPid, &status, WNOHANG);
    }
    mDnsmasqPid = -1;
  }

  const int pid = findProcess("dnsmasq");
  if (pid > 0 && cmdlineClaimsOurDnsmasq(readCmdline(pid), kSoftApAddress)) {
    ::kill(pid, SIGTERM);
    for (int waited = 0; waited < 2000 && processAlive(pid); waited += 50) sleepMs(50);
    if (processAlive(pid)) ::kill(pid, SIGKILL);
  }
}

// Pre-seeds hostapd's entropy file, the vendor's own recipe byte for byte —
// see entropyFile() in the header for why a headless box needs it at all.
// Returns a static status word for the HOSTAPD_SPAWN breadcrumb. NOT covered
// by backupOnce: this is a regenerable cache with vendor semantics, not user
// data, and hostapd itself rewrites it as it runs.
const char* DeviceWifi::ensureEntropyFile() {
  if (fileExists(entropyFile())) return "exists";
  // 21 bytes is the vendor's own seed size (ensure_entropy_file_exists in
  // libzknet.so). The content only needs to be unpredictable, not perfect:
  // hostapd stirs it into its pool and keeps updating the file.
  unsigned char seed[21];
  bool filled = false;
  const int rfd = ::open("/dev/urandom", O_RDONLY);
  if (rfd >= 0) {
    filled = ::read(rfd, seed, sizeof(seed)) == static_cast<ssize_t>(sizeof(seed));
    ::close(rfd);
  }
  if (!filled) {
    // /dev/urandom missing would be its own surprise; a clock-derived seed
    // still beats an absent file, which pins hostapd to a kernel pool this
    // input-less box may never fill.
    struct timespec ts;
    ::clock_gettime(CLOCK_MONOTONIC, &ts);
    for (size_t i = 0; i < sizeof(seed); ++i) {
      seed[i] = static_cast<unsigned char>((ts.tv_nsec >> (i % 24)) ^ (0x5aU + i));
    }
  }
  const int fd = ::open(entropyFile(), O_WRONLY | O_CREAT | O_TRUNC, 0660);
  if (fd < 0) return "fail";
  const bool ok = ::write(fd, seed, sizeof(seed)) == static_cast<ssize_t>(sizeof(seed));
  ::close(fd);
  if (!ok) {
    ::unlink(entropyFile());
    return "fail";
  }
  return "created";
}

void DeviceWifi::tearDownSoftAp() {
  if (!linkChangesAllowed()) return;

  // The vendor's own teardown order (soft_ap_disable in libzknet.so): the DHCP
  // server first, so no phone is handed a lease on a network that is about to
  // disappear; then hostapd, which deauthenticates its clients and takes the
  // interface out of AP mode; then the address. Every path through here still
  // ends at the ctl.start below — that is the one invariant this function
  // exists to keep.
  stopDnsmasq();
  // The hotspot is going away, so "this hotspot has no DHCP" stops being true.
  // Cleared here rather than only on the next bring-up, because the panel reads
  // it and a stale warning on a device that has since joined a network is its
  // own kind of lie.
  mApDhcpFailed = false;
  mDhcpFailedAtMs = -1;

  terminateProcess("hostapd");

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
  mLastApAddr.clear();

  // And give the radio back. Nothing else will: /etc/init.rc declares
  // wpa_supplicant `disabled` + `oneshot`, so if this line is not reached the
  // device has neither a hotspot nor a way to join a network — which is the
  // single failure this whole file exists to avoid.
  SystemProperties::setString("ctl.start", "wpa_supplicant");
  ProvisionLog::device().log("AP_EXIT", "supplicant=restarting");
  LOGD("wifi: hotspot down, supplicant restarting");
}

}  // namespace tcos
