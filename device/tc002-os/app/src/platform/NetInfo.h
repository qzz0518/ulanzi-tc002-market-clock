#ifndef PLATFORM_NETINFO_H_
#define PLATFORM_NETINFO_H_

#include <string>

namespace tcos {
namespace netinfo {

/**
 * What the device's own radio is doing, read from the kernel.
 *
 * This lives under platform/ rather than net/ because it is the one part of the
 * network story that is device-only: the FlyThings SDK we have ships no network
 * API at all (packages/zknet is an empty stub), so both answers come from Linux
 * interfaces that do not exist on the build host — getifaddrs for the address
 * and the wireless-extensions ioctl for the SSID.
 *
 * Both return an empty string rather than a placeholder when they cannot
 * answer, so the caller decides what "unknown" looks like on the panel.
 */

/** Dotted IPv4 of the wireless interface, or "" when it has no address. */
std::string ipAddress();

/** SSID currently associated, or "" when unassociated. */
std::string ssid();

/** MAC of the wireless interface, upper case and colon separated. */
std::string macAddress();

}  // namespace netinfo
}  // namespace tcos

#endif  // PLATFORM_NETINFO_H_
