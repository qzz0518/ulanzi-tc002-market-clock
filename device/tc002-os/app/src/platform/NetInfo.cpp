#include "platform/NetInfo.h"

// NOT alphabetical, and it cannot be. <linux/wireless.h> pulls in the kernel's
// <linux/if.h>, which redefines IFF_*, struct ifreq and struct ifconf on top of
// glibc's <net/if.h>. The kernel header guards against a glibc header that
// arrived first (__UAPI_DEF_IF_*); glibc's has no such guard the other way
// round. So <net/if.h> must precede it, and sorting these includes would break
// the ARM build while leaving the host build perfectly happy.
#include <net/if.h>
#include <linux/wireless.h>

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

namespace tcos {
namespace netinfo {

namespace {

// wlan0 on this unit, confirmed against ifconfig on the device. The loop still
// falls back to any non-loopback interface, because a firmware that shows no
// address at all when the interface is renamed is worse than one that shows the
// address of whatever it did find.
const char* kPreferred = "wlan0";

}  // namespace

std::string ipAddress() {
  struct ifaddrs* list = 0;
  if (::getifaddrs(&list) != 0 || list == 0) return std::string();

  std::string preferred;
  std::string fallback;
  for (struct ifaddrs* it = list; it != 0; it = it->ifa_next) {
    if (it->ifa_addr == 0 || it->ifa_addr->sa_family != AF_INET) continue;
    if ((it->ifa_flags & IFF_LOOPBACK) != 0) continue;
    char buf[INET_ADDRSTRLEN];
    const struct sockaddr_in* addr = reinterpret_cast<const struct sockaddr_in*>(it->ifa_addr);
    if (::inet_ntop(AF_INET, &addr->sin_addr, buf, sizeof(buf)) == 0) continue;
    if (it->ifa_name != 0 && ::strcmp(it->ifa_name, kPreferred) == 0) {
      preferred = buf;
      break;
    }
    if (fallback.empty()) fallback = buf;
  }
  ::freeifaddrs(list);
  return preferred.empty() ? fallback : preferred;
}

std::string ssid() {
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return std::string();

  struct iwreq request;
  char buffer[IW_ESSID_MAX_SIZE + 1];
  ::memset(&request, 0, sizeof(request));
  ::memset(buffer, 0, sizeof(buffer));
  ::snprintf(request.ifr_name, IFNAMSIZ, "%s", kPreferred);
  request.u.essid.pointer = buffer;
  request.u.essid.length = IW_ESSID_MAX_SIZE;
  request.u.essid.flags = 0;

  std::string out;
  if (::ioctl(fd, SIOCGIWESSID, &request) == 0) {
    // The driver reports the length; the buffer is not guaranteed terminated.
    const int length = request.u.essid.length < IW_ESSID_MAX_SIZE
                           ? static_cast<int>(request.u.essid.length)
                           : IW_ESSID_MAX_SIZE;
    out.assign(buffer, static_cast<size_t>(length));
    // An unassociated interface answers with a zero-length or NUL-filled essid
    // rather than an error, which would otherwise render as a blank row that
    // looks like a bug.
    while (!out.empty() && out[out.size() - 1] == '\0') out.erase(out.size() - 1);
  }
  ::close(fd);
  return out;
}

std::string macAddress() {
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return std::string();

  struct ifreq request;
  ::memset(&request, 0, sizeof(request));
  ::snprintf(request.ifr_name, IFNAMSIZ, "%s", kPreferred);

  std::string out;
  if (::ioctl(fd, SIOCGIFHWADDR, &request) == 0) {
    const unsigned char* mac =
        reinterpret_cast<const unsigned char*>(request.ifr_hwaddr.sa_data);
    char buf[18];
    ::snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2],
               mac[3], mac[4], mac[5]);
    out = buf;
  }
  ::close(fd);
  return out;
}

}  // namespace netinfo
}  // namespace tcos
