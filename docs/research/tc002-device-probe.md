# TC002 real-device probe (2026-08-08)

Facts captured from a real TC002 over Wi-Fi ADB by the sideload probe bundle
(`device/tc002-lyrics-player/probe/player`). These are the ground truth for
cross-compiling the native player. Values are from one unit on firmware
`ro.system.version 2.6.2` / `ro.build.date 20260527`.

## Platform / toolchain target

- SoC: **SigmaStar/SStar SSD21x** (`ro.firmware ssd21x_ulanzi_I008`, `ro.hardware sstarsoc`)
- CPU: **ARMv7 dual-core Cortex-A7** (`ARMv7 Processor rev 5 (v7l)`, neon vfpv4)
  → cross-compile target `arm-linux-gnueabihf`, armv7-a + neon. Use the FlyThings
  Linux GCC toolchain `ssd.tar.gz` (covers SSD/Z20/Z21/Z261).
- Framework: **FlyThings V2.1 / EasyUI 2.4.0 / ZKOS** (`ro.build.description zkos`,
  `ro.build.version.release flythingsV2.1`, `ro.easyui.version 2.4.0`)
- **RAM: 36 MB total, ~1 MB free** (MemAvailable ~14 MB). The player must be tiny.
- `ro.debuggable 1`, `persist.sys.zkdebug 1`, `service.adb.tcp.port 5555`.

## Audio — no ALSA; SigmaStar MI_AO only

- **No `/dev/snd`, no `/proc/asound`, no aplay/amixer/tinyplay/tinymix.**
- Audio out is the SigmaStar MI device node **`/dev/mi_ao`** (also `/dev/mi_sys`).
  Sound must go through the SStar MI_AO API — exactly what the official
  `Z21_TC002_Demo` `AudioManager` wraps. There is no portable CLI audio path;
  the player must link the MI SDK (shipped with the FlyThings toolchain/demo).

## Display

- Framebuffer `/dev/fb0` + `/dev/sstarfb`; MI display `/dev/mi_disp`, `/dev/mi_panel`,
  `/dev/mdisp`, `/dev/mi_rgn`, `/dev/mi_gfx`.
- The 52×16 LED matrix is driven by the GUI stack: `/bin/zkgui` (`{zkgui_ui}`,
  ~230 MB VSZ) is the running official UI process; services `zkswe`, `zkdisp`,
  `zkdaemon` are up (`init.svc.zkswe running`, `sys.zkapp.state running`).

## Filesystem / storage

- `/` is **squashfs read-only** (`/dev/root`). Cannot write app into `/`.
- `/data` is **jffs2 read-write, persistent** (mtd) — the only writable persistent
  store. Holds `diy/`, `misc/`, `preferences.json`, `setting.ini`.
- `/tmp`, `/mnt`, `/dev`, `/misc` are tmpfs (~16 MB each, erased on power cycle).
- `/mnt/storage` is vfat **read-only** (mtdblock7); `/config`, `/res` squashfs RO.
- `/customer`, `/appconfigs` do **not** exist on this build.

## Shell / busybox toolset (what the session pipeline can rely on)

- Present: `sh`, `busybox`, `cat`, `kill`, `setprop`, `getprop`, `ps`, `mount`.
- **Missing**: `tar`, `unzip`, `gzip`, `sed`, `awk`, `grep`, `sleep`, `head`, `tail`,
  `uname`, `id`, `md5sum`, `sha256sum`, `wget`, `curl`, `nohup` (alias only, not a
  binary), `setsid`, `start-stop-daemon`, `daemonize`.
- Consequences already applied to the sideload pipeline:
  - No archiver → bundle is pushed as a **directory** (`adb push dir/. /tmp/...`),
    not a tarball.
  - No nohup/setsid → background detach uses a **subshell** `(... & echo $! > pid)`.
  - adbd allows essentially one session; the host service must not run adb
    concurrently with a session command.

## Runtime-model implication (why "standalone process" is wrong)

A FlyThings app is not a standalone Linux program: it links EasyUI/MI SDK and is
loaded by the `zkswe`/`zkgui` framework. Both the missing audio/display CLIs and
the FlyThings docs point the same way — the real player must be built as a
FlyThings app and installed the way the IDE's **download-debug** does: sync the
build output to the path `zkswe` loads from, then `setprop ctl.restart zkswe`.
That load path is the remaining unknown to reverse (observe one IDE
download-debug run, or inspect the `ssd.tar.gz` toolchain's download script).
Nothing here is written to flash, so a power cycle restores the official firmware.
