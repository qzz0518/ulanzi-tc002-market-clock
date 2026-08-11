#ifndef PLATFORM_INSTALLMODE_H_
#define PLATFORM_INSTALLMODE_H_

namespace tcos {
namespace install {

/**
 * How this firmware got here, and what that means for the radio.
 *
 * ZOS runs two ways and the difference decides one safety question:
 *
 *   SIDELOADED — pushed into /tmp and started by restarting the framework. The
 *   stock firmware is still on flash underneath, and it is what brought the WiFi
 *   link up before we existed. That link is not ours: adb reaches this device
 *   over TCP on it, so reassociating or raising a hotspot takes away the only
 *   way to look at the device, and the only recovery is someone physically
 *   power-cycling the clock. So every link mutation is refused, and arming an
 *   experiment means creating /tmp/zos-allow-link by hand.
 *
 *   FLASHED — ZOS is the firmware. Nothing else will start wpa_supplicant:
 *   /etc/init.rc declares it `disabled` and `oneshot`, so it is the application's
 *   job, always was, and the stock app is no longer there to do it. Refusing
 *   link changes here would be a device that can never reach a network at all —
 *   the guard, applied to a flashed install, is not caution but a brick.
 *
 * The two are told apart by the file the sideload script writes
 * (/tmp/tc002-sideload.id). That is the same marker the installers already use
 * to tell sessions apart (ADR 0004), so there is exactly one notion of "which
 * app is loaded" rather than a second one invented here.
 */

/** True when this session was pushed into tmpfs rather than flashed. */
bool isSideloaded();

/**
 * The decision itself, separated from the filesystem so it can be asserted.
 *
 * Getting this backwards fails in both directions and neither is survivable in
 * the field: inverted one way a flashed device refuses to start its own radio
 * and can never reach a network; inverted the other way a sideloaded device
 * reassociates and takes adb — the only way to look at it — down with it.
 */
bool decide(bool sideloaded, bool guardPresent);

/**
 * True when this firmware may change the WiFi link.
 *
 * Flashed: always. Sideloaded: only when /tmp/zos-allow-link exists — tmpfs, so
 * a power cycle disarms it and there is no way to leave it armed by accident.
 */
bool linkChangesAllowed();

/** Why a refusal happened, for the panel and the provisioning page. */
const char* refusalReason();

}  // namespace install
}  // namespace tcos

#endif  // PLATFORM_INSTALLMODE_H_
