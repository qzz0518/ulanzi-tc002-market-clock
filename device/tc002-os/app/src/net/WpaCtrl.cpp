#include "net/WpaCtrl.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

namespace tcos {

namespace {

// The supplicant's ctrl_interface on this unit, read from
// /data/misc/wifi/wpa_supplicant.conf: `ctrl_interface=/dev/socket/`, so the
// per-interface socket is /dev/socket/wlan0.
const char* kCtrlDir = "/dev/socket/";

std::string trimCr(const std::string& value) {
  std::string out = value;
  while (!out.empty() && (out[out.size() - 1] == '\r' || out[out.size() - 1] == '\n')) {
    out.erase(out.size() - 1);
  }
  return out;
}

// Splits on a single character. wpa_supplicant's line formats are strictly
// positional, so this stays a split loop rather than anything cleverer.
void splitOn(const std::string& line, char sep, std::vector<std::string>* out) {
  out->clear();
  size_t start = 0;
  while (true) {
    const size_t at = line.find(sep, start);
    if (at == std::string::npos) {
      out->push_back(line.substr(start));
      return;
    }
    out->push_back(line.substr(start, at - start));
    start = at + 1;
  }
}

}  // namespace

WpaCtrl::WpaCtrl() : mFd(-1) {}

WpaCtrl::~WpaCtrl() { close(); }

bool WpaCtrl::open(const std::string& iface) {
  close();

  const int fd = ::socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) return false;

  // The supplicant replies to the address we bound, so a client socket with no
  // path of its own gets no answer at all. /tmp is tmpfs, which is also where
  // the whole sideload lives, so the stale-socket problem clears on power cycle.
  //
  // The counter is not decoration. Keyed on the pid alone, the two WpaCtrl
  // instances this firmware really has — DeviceWifi's, and the one the setup
  // page's backend opens per /scan — bound the SAME path, and open()'s unlink
  // took the name out from under whichever got there first: its replies then
  // went nowhere, associated() read a live supplicant as disconnected, and the
  // policy spent a 25 s connect timeout recovering. The window is exactly the
  // one that matters, a phone polling the page while the radio reassociates.
  static int sInstance = 0;
  const int instance = __sync_fetch_and_add(&sInstance, 1);
  char local[64];
  ::snprintf(local, sizeof(local), "/tmp/zos-wpa-%d-%d", static_cast<int>(::getpid()), instance);
  ::unlink(local);

  struct sockaddr_un self;
  ::memset(&self, 0, sizeof(self));
  self.sun_family = AF_UNIX;
  ::snprintf(self.sun_path, sizeof(self.sun_path), "%s", local);
  if (::bind(fd, reinterpret_cast<struct sockaddr*>(&self), sizeof(self)) < 0) {
    ::close(fd);
    return false;
  }

  struct sockaddr_un peer;
  ::memset(&peer, 0, sizeof(peer));
  peer.sun_family = AF_UNIX;
  ::snprintf(peer.sun_path, sizeof(peer.sun_path), "%s%s", kCtrlDir, iface.c_str());
  if (::connect(fd, reinterpret_cast<struct sockaddr*>(&peer), sizeof(peer)) < 0) {
    ::close(fd);
    ::unlink(local);
    return false;
  }

  mFd = fd;
  mLocalPath = local;
  return true;
}

void WpaCtrl::close() {
  if (mFd >= 0) {
    ::close(mFd);
    mFd = -1;
  }
  if (!mLocalPath.empty()) {
    ::unlink(mLocalPath.c_str());
    mLocalPath.clear();
  }
}

bool WpaCtrl::request(const std::string& command, std::string* reply, int timeoutMs) {
  if (mFd < 0) return false;
  reply->clear();

  if (::send(mFd, command.data(), command.size(), 0) < 0) return false;

  struct timeval tv;
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;
  ::setsockopt(mFd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

  // A scan cache with a couple of dozen networks runs to a few KB; the
  // supplicant truncates its own reply rather than fragmenting, so one
  // datagram is the whole answer.
  char buf[8192];
  const ssize_t n = ::recv(mFd, buf, sizeof(buf), 0);
  if (n <= 0) return false;
  reply->assign(buf, static_cast<size_t>(n));

  // Unsolicited event messages begin with '<' and a priority; they can arrive
  // between the send and the reply. One retry is enough in practice, and a
  // loop here would be a way to hang the caller.
  if (!reply->empty() && (*reply)[0] == '<') {
    const ssize_t again = ::recv(mFd, buf, sizeof(buf), 0);
    if (again <= 0) return false;
    reply->assign(buf, static_cast<size_t>(again));
  }
  return true;
}

bool WpaCtrl::parseStatus(const std::string& reply, std::string* wpaState,
                          std::string* ssid, std::string* ipAddress) {
  wpaState->clear();
  ssid->clear();
  ipAddress->clear();
  if (reply.empty() || reply.compare(0, 5, "FAIL\n") == 0 || reply == "FAIL") return false;

  bool sawState = false;
  size_t start = 0;
  while (start <= reply.size()) {
    size_t end = reply.find('\n', start);
    if (end == std::string::npos) end = reply.size();
    const std::string line = trimCr(reply.substr(start, end - start));
    start = end + 1;

    const size_t eq = line.find('=');
    if (eq != std::string::npos) {
      const std::string key = line.substr(0, eq);
      const std::string value = line.substr(eq + 1);
      if (key == "wpa_state") {
        *wpaState = value;
        sawState = true;
      } else if (key == "ssid") {
        *ssid = value;
      } else if (key == "ip_address") {
        *ipAddress = value;
      }
    }
    if (end >= reply.size()) break;
  }
  // A STATUS reply without wpa_state is not a status; treating it as one would
  // report "disconnected" for what is really a broken socket.
  return sawState;
}

bool WpaCtrl::flagsAreSecured(const std::string& flags) {
  return flags.find("WPA") != std::string::npos || flags.find("WEP") != std::string::npos ||
         flags.find("PSK") != std::string::npos || flags.find("SAE") != std::string::npos;
}

bool WpaCtrl::parseScanResults(const std::string& reply, std::vector<Network>* out) {
  out->clear();
  if (reply.empty() || reply.compare(0, 4, "FAIL") == 0) return false;

  bool sawHeader = false;
  size_t start = 0;
  std::vector<std::string> fields;
  while (start <= reply.size()) {
    size_t end = reply.find('\n', start);
    if (end == std::string::npos) end = reply.size();
    const std::string line = trimCr(reply.substr(start, end - start));
    start = end + 1;

    if (!line.empty()) {
      // Header: "bssid / frequency / signal level / flags / ssid"
      if (!sawHeader && line.find("bssid") != std::string::npos) {
        sawHeader = true;
      } else {
        splitOn(line, '\t', &fields);
        // Five columns exactly. A short row is a truncated datagram, not a
        // network — building a half entry from it would put a blank SSID on the
        // provisioning page.
        if (fields.size() >= 5) {
          Network net;
          net.ssid = fields[4];
          net.signalDbm = ::atoi(fields[2].c_str());
          net.secured = flagsAreSecured(fields[3]);
          // Hidden networks report an empty SSID; there is nothing a user could
          // pick from the list, so they are dropped rather than shown blank.
          if (!net.ssid.empty()) {
            bool duplicate = false;
            for (size_t i = 0; i < out->size(); ++i) {
              if ((*out)[i].ssid != net.ssid) continue;
              duplicate = true;
              // Keep the strongest sighting: a mesh reports one row per radio
              // and the page should offer the one the device would actually use.
              if (net.signalDbm > (*out)[i].signalDbm) (*out)[i] = net;
              break;
            }
            if (!duplicate) out->push_back(net);
          }
        }
      }
    }
    if (end >= reply.size()) break;
  }
  return sawHeader;
}

bool WpaCtrl::status(std::string* wpaState, std::string* ssid, std::string* ipAddress) {
  std::string reply;
  if (!request("STATUS", &reply)) return false;
  return parseStatus(reply, wpaState, ssid, ipAddress);
}

bool WpaCtrl::scanResults(std::vector<Network>* out) {
  std::string reply;
  // Note SCAN_RESULTS, never SCAN: this returns the supplicant's existing cache
  // and does not put the radio to work. Starting a sweep is a mutation and
  // belongs to the guarded path.
  if (!request("SCAN_RESULTS", &reply, 2500)) return false;
  return parseScanResults(reply, out);
}

}  // namespace tcos
