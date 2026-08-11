# ADR 0006: ZOS drives the radio itself and never links the FlyThings network managers

- Status: Accepted
- Date: 2026-08-12

## Context

ZOS (`device/tc002-os/`) replaces the official app rather than sitting beside it, so it inherits
the official app's networking duties: `/etc/init.rc` declares `wpa_supplicant` `disabled` +
`oneshot`, meaning nothing starts it at boot and nothing respawns it when it dies. The official
firmware does that through `libzknet.so`, and the FlyThings SDK ships the obvious answer —
`NetManager`, `WifiManager`, `SoftApManager` — which the official Z21 demo uses.

Those managers cannot be used here. They reach the radio through a power path that reloads the
Wi-Fi driver with `insmod`/`rmmod` against module directories baked into the library, and on this
unit **those directories do not exist**: `/late/lib/modules` and `/config/lib/modules` are absent,
the real modules live in `/lib/modules/4.9.84`. One trip through the `rmmod` branch unloads
`aic8800_fdrv` with no path back — `wlan0` disappears, and adb, which rides that same link, dies
with it. The failure is unobservable while it happens and the only recovery is a physical power
cycle.

That risk is asymmetric in a way no other subsystem here is. A bad renderer draws a wrong pixel; a
bad network call removes the only debug channel the device has.

## Decision

1. ZOS links `libzknet` for **exactly one symbol**, `NetUtils::dhcpRequestIp` — this unit ships no
   DHCP client binary at all and that function is the same libnetutils code the stock firmware has
   used on this chip for years. Only `include/net/NetUtils.h` (pure statics, zero includes) is
   vendored; `NetManager.h` / `WifiManager.h` / `SoftApManager.h` are deliberately absent from the
   build tree (`device/tc002-lyrics-player/flythings-build/Makefile`, `EXTRA_PKGS`).
2. Everything the managers would have answered comes from **wpa_supplicant's control socket**
   instead (`net/WpaCtrl.h`): about two hundred lines over a datagram socket. That class exposes
   read-only commands (`STATUS`, `SCAN_RESULTS` — the last sweep's cache, which does not start a
   sweep) so it is safe to call from a device that is online and carrying the only debug channel
   there is. Commands that change the link are a separate, guarded step.
3. The rule is enforced in the **binary**, not in a comment. `device/tc002-os/hostcheck/link-audit.sh`
   fails the build on any undefined symbol matching `NetManager|WifiManager|SoftApManager|
   LTE4GManager|EthernetManager|WifiCtrl`. The manager classes are C++, so a future
   `#include <net/NetManager.h>` leaves its mangled name in the dynamic symbols and the build breaks
   at the audit rather than on the bench.
4. Policy is separated from actuation. `net/WifiPolicy.h` is a pure state machine over injected
   side effects with time as a parameter, so the timeouts that matter most — a moved router leaving
   valid-looking credentials behind — are asserted under clang++ on the host, where they can be
   triggered on demand.
5. Link-changing code ships **inert behind a guard file**. The actuator
   (`platform/DeviceWifi.h`) is split along exactly that line: its read-only half is always live,
   and its mutating half — start the supplicant, connect, request DHCP, start/stop the hotspot,
   start a scan — plus the portal's submit (`platform/DeviceProvisioning.h`) re-read
   `/tmp/zos-allow-link` and refuse without it, reporting `link-locked` at the moment of refusal
   rather than accepting credentials and doing nothing. The sideload installer does not create
   that file, so on a normal install the code is compiled in, reachable from the UI, and
   physically incapable of acting. `adb shell touch /tmp/zos-allow-link` arms an experiment; a
   power cycle disarms it.
6. The provisioning page is served on the device's **normal address** (port 8080), not only while a
   hotspot is up, so the page, `/scan`, `/status` and the `POST /connect` round trip can all be
   exercised from a laptop on the LAN without touching the radio at all.

## Consequences

- Supervision is ours: ZOS issues `ctl.start wpa_supplicant`, polls `init.svc.wpa_supplicant`, and
  restarts the daemon when it dies. `WifiPolicy::supplicantRestarts()` surfaces flapping instead of
  hiding it.
- Association alone leaves the device with no address, so a DHCP lease is requested explicitly after
  every successful connect — and the request is issued asynchronously, because
  `NetUtils::dhcpRequestIp` blocks for seconds and the UI tick runs at 25 fps.
- SoftAP is **not implemented**. `WifiPolicy` has the states and the actuator has the entry
  points, but `startSoftAp()` / `stopSoftAp()` log and return: the recipe (stop wpa_supplicant,
  write hostapd.conf, run hostapd, hand out addresses) touches the link adb rides on at every
  step, and `SoftApManager` is exactly what this ADR forbids. A device with no stored credentials
  therefore cannot currently be provisioned by ZOS itself.
- The universal rescue for anything the network layer gets wrong is a power cycle: `/tmp` is wiped,
  the framework falls back to `/res/etc/EasyUI.cfg`, and the official firmware returns with its own
  Wi-Fi setup page. That is precisely the safety net 固化 (writing the app into `/res`) would remove,
  so persisting ZOS to flash stays gated on the guarded connect path being proven on hardware —
  without a network there is no adb, and no port 5555 either.
- The audit doubles as the size budget (1.2 MB) and the ffmpeg gate, so one script covers every
  failure whose only symptom on the device is `initLib error: undefined symbol` and a black panel.
