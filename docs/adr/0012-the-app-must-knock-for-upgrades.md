# ADR 0012: The app is what asks for an upgrade — the framework never will

- Status: Accepted
- Date: 2026-08-14
- Applies to: `device/tc002-os/` (ZOS). Written after a flashed ZOS turned out to
  have no way to install its own successor.

## Context

ZOS lives in `mtd3 res`. Installing a new build means writing that partition,
and the only writer on the device is the vendor updater in
`/lib/libzkupgrade.so`. The vendor's documented procedure is four properties and
a service restart:

```
adb push update.img /tmp/update.img
setprop sys.zkupgrade.flag 255
setprop sys.zkupgrade.dir /tmp
setprop ctl.restart zkswe
```

That procedure installed ZOS over the stock firmware on 2026-08-12. Run again on
a device already running ZOS, it does **nothing**: the device reboots and comes
back on the old build, with `/res` byte-identical, no `/data/.zkupgraderec`, and
`sys.zkupgrade.state` empty.

The difference is not the image and not the properties. It is **who is running**.

Reading the binaries settles it:

- `zk_upgrade_perform()` — the function that opens `/dev/mtd/mtd3`, erases and
  writes — is reached only from `UpgradeMonitor::threadLoop()`, which only
  `UpgradeMonitor::startUpgrade()` starts.
- Nothing in `libeasyui.so` or `/bin/zkgui` calls `startUpgrade()` or
  `checkUpgradeFile()` unprompted. The framework contains the whole machine and
  never turns the key.
- The stock Ulanzi app does. Its `libzkgui.so` is the only object on the device
  that references `UpgradeMonitor::getInstance` and
  `UpgradeMonitor::checkUpgradeFile`. It calls them itself.

So the four properties are read by `zk_upgrade_check()` — which the app has to
call. On stock, the app called it. Once ZOS replaced `/res`, the door was still
there and nobody was knocking. **We had shipped a firmware that could be
installed but never upgraded**, and the only way in was a sideload that a power
cycle undoes.

(Two plausible-sounding explanations were investigated and are false, recorded
here so they are not re-investigated: the upgrade does **not** go through
`UpgradeActivity` — its layout `zkupgrade.ftu` is in no `/res` on this unit,
stock included, so that activity has never been creatable here; and type-3 `res`
is **not** handed to u-boot — the disassembly shows a direct MTD write, and
`zk_upgrade_ready()` sets no state that `perform()` reads.)

## Decision

**ZOS calls `UpgradeMonitor::checkUpgradeFile()` itself, and only when asked.**

- `tcos::upgradeEntryPoint()` (`logic/osLogic.cc`) does the knocking, trying
  `/tmp/zkimg/` — where we stage — then `/mnt/storage/zkimg/`, where we used to,
  so a hand-pushed image still installs.
- **`/mnt/storage/` itself is not a candidate, and must never become one.** That
  is where the factory stock `update.img` lives: every unit has one, the mtd3
  write does not touch it, and this repo pulls it as the round-trip reference
  for its own packer. A loop that falls through to it turns "the image I asked
  for was refused" into "ZOS was replaced by the firmware it replaced", with the
  request recorded as installed on the way out. A refused image must be a
  visible failure, never a substitution.
- It is **not** called from the startup path. It was, once, and the panel froze:
  the updater does not delete the image it installed, so every boot re-entered
  the chain and the app never reached its first `Screen`. The device heartbeated
  forever and drew nothing. That failure is the reason the trigger is explicit.
- The trigger is a new key in the pull document: `upgrade\t<seq>`, produced by
  `OsLinkHub.requestUpgrade()` as **seconds since the epoch**. A given sequence
  is honoured once, across reboots, against the record on `/data` — and the
  once-per-boot latch closes only on a chain that actually **started**, because
  a knock that never reached the updater has taken nothing over and there is no
  reason for it to cost the device its only attempt.
- **Every failure exits the install state.** No record, no updater, no image,
  a refusal from `startUpgrade()`, and a chain that neither reboots nor returns
  within four minutes all end on 更新失败 with a distinguishable reason. Each of
  those was once a bare `return` that left the panel reading 安装中 until
  someone pulled the plug — which is the worst thing this screen can say,
  because it is indistinguishable from an install that is still working, and
  nobody interrupts one of those.
- Whatever the console asks for, the install itself stays the vendor's:
  `check → ready → perform → end`, with its own magic/CRC-32/model-id/flash-type
  gates and a per-item MD5 re-read after the write. We supply the knock, not the
  validation.

## Consequences

- **This one call is what makes ZOS upgradeable at all.** Deleting it does not
  break a feature; it strands every device running that build on the firmware it
  shipped with. Treat it the way the MCU handshake is treated — as load-bearing
  glue that looks like it does nothing.
- Any future firmware that replaces `/res` inherits the same duty. A fork that
  drops the call is a fork that cannot be updated.
- **The request the device installed is recorded on `/data`, and the staged
  image is swept at startup.** Both halves are needed and both were learned the
  hard way. The install ends in a reboot, so an in-memory "already handled"
  guard is cleared by the very event it exists to survive: the device comes
  back with its counter at zero, the console is still publishing the same
  request, and it installs again — forever, with the panel dark, because the
  reboot comes before the first frame. So `HostLink` compares the document's id
  against `/data/zos-upgrade.seq` (mtd6, untouched by the mtd3 write), and
  `onUI_init` calls `FirmwareUpdate::discardStaged()` — the vendor chain does
  not remove what it flashed, and a staged image is the only thing it needs to
  flash it again.
- **The ids are seconds-since-epoch, not a count.** The hub's counter is
  ordinary state in a Bun process and returns to zero when the service
  restarts; a restarted counter would collide with an id the device had already
  recorded, and that device could never be asked again. The guard is therefore
  "newer than what I installed", which also lets a device be seeded with the id
  it is about to take — the only way to move a build that predates this record
  onto one that keeps it without looping on the way.
- **Images stage on tmpfs (`/tmp/zkimg/`), not on the UDISK partition.** The
  original choice was `/mnt/storage/zkimg/` — real storage, the vendor's own
  directory — and the hardware overruled it. This unit's UDISK (mtd7, 8.5 MB
  vfat) developed a bad region exactly where a 1 MB image lands: a staged
  `update.img` failed to read back at the same 6 % offset on two attempts while
  an older 2.7 MB file elsewhere on the volume read fine, and the read error
  tripped the volume's `errors=remount-ro`. Downstream, that is a rename AND a
  fallback unlink both failing (`kWriteFailed`), and a vendor updater holding an
  image it cannot read while the panel says 安装中 forever.
  The objection to tmpfs — it is RAM on a 36 MB device — is answered by the
  numbers (~1 MB against 16.5 MB of `/tmp`, held for seconds) and inverted by
  the reboot: **tmpfs is cleared by the very event the install ends in**, so the
  spent image cannot outlive the install that consumed it. That is the "delete
  the staged image" rule enforced by the filesystem rather than by our code.
  `/mnt/storage/zkimg/` stays a candidate directory so a hand-pushed image still
  installs, and startup sweeps both.
- `/mnt/storage` is mounted `ro` at boot; staging a file there needs an explicit
  `mount -o remount,rw` and a `sync` before the install runs.
- The recovery argument that made flashing acceptable still holds and is why a
  bad install is survivable: `adbd`, `wlan0` and the WiFi credentials live on
  other partitions (`mtd2` rootfs, `mtd6` data), so a broken `/res` leaves a dark
  panel and a reachable device. Both a stock image and a `--restore` image built
  from the live `/res` are kept for that case.
