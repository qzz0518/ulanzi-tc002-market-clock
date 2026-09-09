# FlyThings native player: build & install path (2026-08-08)

Sourced from the official repo `UlanziTechnology/Ulanzi-U-Clock-TC002` (which
the user pointed out contains the full projects) plus the FlyThings IDE docs.
This is the blueprint for building the native lyrics player without the
Windows GUI.

## What the repo already gives us

- `Z21_TC002_Demo/` — official demo with the reference implementations we need:
  - `src/managers/AudioManager.{h,cpp}` — `playAudio(const std::string& path)`,
    `stop/pause/resume`, `setVolume(0..6)`, wraps `base::MediaPlayer`
    (`media_player.h`). **Local-file playback only** → network audio must be
    downloaded to local storage first, then `playAudio(localPath)`.
  - `src/pages/RgbTestPage.*`, `src/logic/rgbTestLogic.cc` — LED path.
  - `src/uart/*`, `src/managers/McuManager.*` — MCU/key protocol.
  - `src/utils/Surface.*`, `Painter.*` — drawing.
  - `resources/1KHZ.MP3` — audio test asset.
- `apps/flythings/pixel-pet-display/` — a **complete custom app template** that
  matches our approach exactly: "uses `PageBase::sendLedData()` to refresh the
  52×16 RGB LED matrix; frames are pre-rendered 52×16 GIF converted to
  non-black pixel lists compiled into `src/assets/PetAnimationFrames.h`." It
  has no WebUI dependency. Verified on SN B0D191008U3670007, MCU T1.0.13.
- `IDE使用说明/说明文档.md` — IDE + install docs.

## Build system (from `.cproject`)

- Eclipse CDT **managed build → GNU Make**, toolchain `flythings.managedbuild.
  toolchain.gnu` (superClass; the real gcc path is configured by the FlyThings
  Eclipse plugin, pointing at the platform cross-GCC).
- **Artifact: a shared library** — `artifactExtension="so"`,
  `artifactName="zkgui"` ⇒ `libzkgui.so`. The app is a `.so` loaded by the
  framework, not a standalone executable (matches the device probe finding).
- C++ compiler: **C++11**, `-fPIC`, optimization "most",
  `-c -fmessage-length=0 -pipe -Wformat -Werror=format-security
  -fstack-protector -fno-caller-saves -fexceptions`.
- Linker: `-shared`, `-Wl,-z,now -Wl,-z,relro -Wl,-z,defs -Wl,--warn-common
  -Wl,-z,combreloc -Wl,--warn-once`, strip all symbols.
- Target arch (from device probe): **armv7-a / Cortex-A7**, `arm-linux-gnueabihf`.

## Dependencies (from `Manifest.xml` / `.deps.lock`)

Fetched from **`https://package.flythings.cn`**, platform `Z21`:
`easyui ^2.2.0 (rev 2.6.0)`, `log`, `zkhardware`, `base-utility 10.9.3`,
`transfer-protocols 3.0.0`. These carry the headers/libs for EasyUI,
`sendLedData`, `MediaPlayer`, MCU, and networking. Not in Git (IDE downloads
them via "update dependencies").

## Cross-compile toolchain

FlyThings Linux GCC toolchain `ssd.tar.gz` (developer.flythings.cn), covers
SSD/Z20/Z21/Z261 — matches our `ssd21x`.

## Install / non-persistent mechanism — reverse-engineered on the real device

**`update.img` is NOT needed for non-persistent sideload.** It only exists for
固化 (writing flash, persistent). The debug-download path uses a plain file
bundle, confirmed by dumping the device:

- The official app lives in **`/res`** (squashfs, **read-only**, mtdblock3):
  `/res/etc/EasyUI.cfg`, `/res/lib/libzkgui.so` (7.4 MB), `/res/ui/`,
  `/res/font/`, `/res/tr/`, `/res/bin/`. This is exactly the IDE's
  `EasyUI.cfg + ui + lib + font` output.
- `EasyUI.cfg` is the master config; it points the framework at everything:
  `startupLibPath=/res/lib/libzkgui.so`, `resPath=/res/ui/`,
  `languagePath=/res/tr/`, plus baud/uart/touch. The app `.so` we build IS
  `libzkgui.so`.
- `/bin/zkgui` is a 9 KB launcher that dlopens `libeasyui.so` and calls
  `EasyUIContext::initEasyUI/runEasyUI`; the framework reads `EasyUI.cfg` and
  dlopens `startupLibPath`.
- `/etc/init.rc` sets **`LD_LIBRARY_PATH=/tmp:/res/lib:/lib`** — `/tmp` (tmpfs)
  wins over `/res/lib`. `libzkupgrade.so` contains the debug flow:
  `cp %s /tmp`, `echo {} > /tmp/EasyUI.cfg`, `chmod 777 /tmp/%s`, `/tmp/%s &`.
  So debug-download stages the app bundle under **`/tmp`** and the framework
  runs it from there; a power cycle wipes tmpfs → official firmware returns.
- This device has **no TF slot** (vold.fstab's `extsd` is commented out; only
  `usb1`), so the TF-card path is moot — the `/tmp` ADB path is the one to use.

**Non-persistent sideload — VERIFIED END-TO-END on real hardware (2026-08-08).**
Pushing `libzkgui.so` + a `/tmp/EasyUI.cfg` (with `startupLibPath=/tmp/
libzkgui.so`, `resPath=/tmp/ui/`) + the app's `ui/` to `/tmp`, then `setprop
ctl.restart zkswe`, made the framework log `load /tmp/EasyUI.cfg ok!` and run
our cross-compiled `pixel-pet-display` (registerActivity petAnimationActivity,
CatPet/DogPet/RabbitPet pages cycling). A plain `ctl.restart zkswe` is the whole
trigger — the framework prefers `/tmp/EasyUI.cfg`; no `sys.zkupgrade` needed.
`rm` the `/tmp` files + restart (or power-cycle) restores official firmware.

Two headless-build fixes were required (now in the Makefile): `-Wl,--start-group`
around the libs (static-lib cross-refs like `base::Serial::writable`), and
`-D__PLATFORM_Z21__` (selects `base::function = std::function`, matching the
device libs; without it every `base::function` signature flips to boost and the
app won't load).

## Open questions before a Docker build can produce a flashable image

1. Does `ssd.tar.gz` contain the exact `arm-linux-gnueabihf-g++` + sysroot the
   plugin uses? (download and inspect)
2. Reproduce the CDT managed-build command line as a Makefile (flags above +
   per-dependency include/lib paths from `package.flythings.cn` packages).
3. `update.img` packaging format / CLI packer.
4. App logic: dynamic lyrics need `transfer-protocols` networking → download
   audio locally → `AudioManager::playAudio` → runtime 52×16 lyric frames via
   `sendLedData` (vs pet app's compiled-in frames).

## First milestone — DONE (2026-08-08)

The headless Docker cross-build is working. `pixel-pet-display` cross-compiles
to a valid **ELF32-ARM `libzkgui.so`** (600 KB, NEEDED libeasyui/libzkhardware/
liblog, defines the app's `PetAnimationPage::*` symbols, leaves framework
symbols like `EasyUIContext::getInstance` undefined for load-time resolution —
exactly like an IDE build). Reproducible: `rm -rf build libzkgui.so && make`
rebuilds it. Full method + the reversed registry API are in
`device/flythings-build/` (`README.md`, `Makefile`,
`Dockerfile`, `fetch-deps.sh`).

Points nailed down along the way: registry platform id is lowercase `z21`; the
`/archive` endpoint returns each package as a zip; `LOG_TAG` is an IDE-injected
global; `base-utility` needs header-only Boost (absent from the registry);
`logic/*.cc` are `#include`d by the IDE-generated `activity/*.cpp`, not their
own translation units. Audio/net packages for the real player are in the
registry: `mi_ao`, `mi_aio`, `zkaudio`, `audio-utility`, `curl-cxx`, `mqtt-cxx`,
`ffmpeg`, `opus`, `openh264`.

## Remaining before a flashable player

1. `update.img` packaging (IDE "镜像编译": `.so` + resources + manifest → the
   FlyThings image). Needed for debug-download / flashing. Reverse the format or
   find a packer in the toolchain.
2. The lyrics app itself: dynamic network audio → local file →
   `AudioManager::playAudio` → runtime 52×16 lyric frames via
   `PageBase::sendLedData` (vs pet app's compiled-in frames), pulling the audio
   packages above.
