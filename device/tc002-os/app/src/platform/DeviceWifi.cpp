#include "platform/DeviceWifi.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include <os/SystemProperties.h>

#include <net/NetUtils.h>

#include "base/log.h"
#include "platform/NetInfo.h"

namespace tcos {

const char* DeviceWifi::kSoftApAddress = "192.168.100.1";

namespace {

const char* kGuardPath = "/tmp/zos-allow-link";
const char* kWpaConf = "/data/misc/wifi/wpa_supplicant.conf";

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

// True when any running process is named `name`. Used to supervise hostapd,
// which init does not manage — there is no service entry for it in /etc/init.rc,
// so nothing else would ever notice it dying.
bool processRunning(const char* name) {
  DIR* dir = ::opendir("/proc");
  if (dir == 0) return false;
  bool found = false;
  struct dirent* entry;
  while (!found && (entry = ::readdir(dir)) != 0) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char path[64];
    ::snprintf(path, sizeof(path), "/proc/%s/comm", entry->d_name);
    FILE* f = ::fopen(path, "r");
    if (f == 0) continue;
    char comm[64];
    comm[0] = '\0';
    if (::fgets(comm, sizeof(comm), f) != 0) {
      size_t len = ::strlen(comm);
      while (len > 0 && (comm[len - 1] == '\n' || comm[len - 1] == '\r')) comm[--len] = '\0';
      if (::strcmp(comm, name) == 0) found = true;
    }
    ::fclose(f);
  }
  ::closedir(dir);
  return found;
}

}  // namespace

DeviceWifi::DeviceWifi() : mEverRefused(false), mDhcpInFlight(false), mSoftApWanted(false) {
  ::pthread_mutex_init(&mLock, 0);
}

DeviceWifi::~DeviceWifi() { ::pthread_mutex_destroy(&mLock); }

bool DeviceWifi::linkChangesAllowed() {
  struct stat info;
  return ::stat(kGuardPath, &info) == 0;
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
  if (!mCtrl.isOpen() && !mCtrl.open("wlan0")) return false;
  if (!mCtrl.status(&state, &ssid, &ip)) {
    // A dead socket is not "disconnected": the supplicant may have been stopped
    // for the hotspot. Drop the descriptor so the next call reopens.
    mCtrl.close();
    return false;
  }
  ::pthread_mutex_lock(&mLock);
  mLastState = state;
  ::pthread_mutex_unlock(&mLock);
  return state == "COMPLETED";
}

bool DeviceWifi::hasAddress() {
  const std::string ip = netinfo::ipAddress();
  if (ip.empty()) return false;
  // The hotspot's own address must NOT count as being online. While the AP is
  // up wlan0 carries 192.168.100.1, and reporting that as an address would tell
  // the policy the device had joined a network — ending provisioning before the
  // user has typed anything, and tearing down the very hotspot they are
  // connected to.
  return ip != kSoftApAddress;
}

bool DeviceWifi::softApRunning() { return processRunning("hostapd"); }

bool DeviceWifi::scanResults(std::vector<std::string>* out) {
  out->clear();
  if (!mCtrl.isOpen() && !mCtrl.open("wlan0")) return false;
  std::vector<WpaCtrl::Network> nets;
  if (!mCtrl.scanResults(&nets)) return false;
  for (size_t i = 0; i < nets.size(); ++i) out->push_back(nets[i].ssid);
  return true;
}

// --- mutating half: refused unless the guard file exists ---------------------

void DeviceWifi::startSupplicant() {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: startSupplicant refused, %s absent", kGuardPath);
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
  if (!mCtrl.isOpen() && !mCtrl.open("wlan0")) return;
  std::string reply;
  mCtrl.request("SCAN", &reply);
}

bool DeviceWifi::connect(const std::string& ssid, const std::string& psk) {
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: connect refused, %s absent", kGuardPath);
    return false;
  }
  if (!mCtrl.isOpen() && !mCtrl.open("wlan0")) return false;

  std::string reply;
  if (!mCtrl.request("ADD_NETWORK", &reply)) return false;
  const int id = ::atoi(reply.c_str());
  if (id < 0) return false;

  char cmd[512];
  ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d ssid \"%s\"", id, ssid.c_str());
  if (!mCtrl.request(cmd, &reply) || reply.compare(0, 2, "OK") != 0) return false;

  if (psk.empty()) {
    ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d key_mgmt NONE", id);
  } else {
    ::snprintf(cmd, sizeof(cmd), "SET_NETWORK %d psk \"%s\"", id, psk.c_str());
  }
  if (!mCtrl.request(cmd, &reply) || reply.compare(0, 2, "OK") != 0) return false;

  ::snprintf(cmd, sizeof(cmd), "SELECT_NETWORK %d", id);
  if (!mCtrl.request(cmd, &reply) || reply.compare(0, 2, "OK") != 0) return false;

  // SAVE_CONFIG is deliberately NOT sent. It rewrites
  // /data/misc/wifi/wpa_supplicant.conf, and /data is the one partition a power
  // cycle does not clear — a bad write there survives the rescue that recovers
  // everything else. Persisting credentials is a separate, explicit step that
  // takes a backup first.
  return true;
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
    LOGE_TRACE("wifi: requestDhcp refused, %s absent", kGuardPath);
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

void DeviceWifi::startSoftAp() {
  mSoftApWanted = true;
  if (!linkChangesAllowed()) {
    mEverRefused = true;
    LOGE_TRACE("wifi: startSoftAp refused, %s absent", kGuardPath);
    return;
  }
  // NOT IMPLEMENTED YET, and failing loudly is the honest state.
  //
  // The recipe is known (stop wpa_supplicant, write hostapd.conf, run hostapd,
  // address wlan0 as 192.168.100.1, run dnsmasq) but every step of it is
  // unrecoverable-by-software on this unit: raising the AP drops the link that
  // adb rides on, and writing hostapd.conf touches /data, the one partition a
  // power cycle does NOT clear. Shipping an unexercised version of that would
  // be shipping a way to lose the device with no way to look at it.
  //
  // softApRunning() will keep reporting false, so WifiPolicy supervises and
  // retries rather than believing a hotspot is on the air when none is.
  LOGE_TRACE("wifi: startSoftAp not implemented; provisioning AP is a later step");
}

void DeviceWifi::stopSoftAp() {
  mSoftApWanted = false;
  if (!linkChangesAllowed()) return;
  LOGE_TRACE("wifi: stopSoftAp not implemented");
}

}  // namespace tcos
