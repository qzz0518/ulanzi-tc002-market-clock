# Headless FlyThings cross-build

Reproduces the FlyThings IDE's managed build **without the Windows GUI**, so a
TC002 native app can be cross-compiled to `libzkgui.so` in Docker on any host.
Proven by cross-compiling the official `pixel-pet-display` app to a valid
ELF32-ARM shared object.

## What's here

- `Dockerfile` — amd64 Debian + `make` + isolated Boost headers. The FlyThings
  toolchain is an x86-64 Linux ELF, so the build runs in an amd64 container
  (emulated on Apple Silicon).
- `Makefile` — the `.cproject` managed build reversed into plain GNU Make:
  cross `g++`, C++11 `-fPIC -O3`, the documented compile/link flags, per-package
  include/lib paths, output `libzkgui.so`.
- `fetch-deps.sh` — downloads the toolchain + the five base z21 packages
  (easyui / log / zkhardware / base-utility / transfer-protocols). The extra
  packages the lyrics player links against (`audio-utility`, `base-json`,
  `ffmpeg`, `z` — see the Makefile's `DEP_INC`) are fetched manually from the
  same registry API, and `packages/device-audio/lib` holds MI/media `.so`s
  pulled from a real device (`libmi_ao` etc.).
- `capture.js` — Playwright script that reverse-engineered the package
  registry's real API (`/api/platforms/z21/packages/<pkg>/versions/<ver>/archive`).
- `upstream/` — clone of `UlanziTechnology/Ulanzi-U-Clock-TC002` (gitignored).
- `toolchain/`, `packages/` — fetched artifacts (gitignored).

## Build

```sh
./fetch-deps.sh                              # toolchain + base packages（播放器额外包见 What's here）
[ -d upstream ] || git clone --depth 1 \
  https://github.com/UlanziTechnology/Ulanzi-U-Clock-TC002 upstream
docker build --platform linux/amd64 -t flythings-build .
# Mount the PARENT dir (device/): the Makefile's APP defaults to
# ../tc002-lyrics-player/app and tc002-os builds pass APP=../tc002-os/app, so the
# firmware trees must be visible inside the container. Mounting only "$PWD"
# leaves them outside the mount → find matches nothing → an empty (code-less) .so.
docker run --rm --platform linux/amd64 -v "$PWD/..":/work -w /work/flythings-build flythings-build make
# → libzkgui.so  (ELF 32-bit ARM, NEEDED libeasyui/libzkhardware/liblog)
```

If `make` stops with "No rule to make target '../../<something>.cpp'", the object
directory's `.d` dependency records still name a path from before a tree move
(the toolchain moved from under the music player to `device/` in ADR 0014, and
`APP` with it). They are a cache: `rm -rf build-os` (or the app's `BUILD_DIR`)
and build again.

Build a different app by overriding `APP`:

```sh
docker run --rm --platform linux/amd64 -v "$PWD/..":/work -w /work/flythings-build flythings-build \
  make APP=upstream/Z21_TC002_Demo
```

## Key facts learned

- Toolchain: `download.flythings.cn/toolchain/ssd.tar.gz`,
  `arm-linux-gnueabihf-g++` (x86-64 host → armv7 target).
- Registry API (platform id is lowercase **`z21`**, not `Z21`):
  - `GET /api/platforms` — platforms
  - `GET /api/platforms/z21/packages[?pageSize=100]` — 68 packages incl. the
    audio/net ones the real player needs: `mi_ao`, `mi_aio`, `mi_ai`, `zkaudio`,
    `audio-utility`, `curl-cxx`, `mqtt-cxx`, `ffmpeg`, `openh264`, `opus`.
  - `GET …/packages/<pkg>/versions[/<ver>[/files[/<path>]]]`
  - `GET …/versions/<ver>/archive` — the package as a zip.
- FlyThings build model:
  - App is a shared object **`libzkgui.so`** loaded by the framework, not a
    standalone executable.
  - `.cproject` carries no `-D` defines; the IDE injects **`LOG_TAG`** globally —
    the Makefile defines it.
  - `base-utility` needs header-only **Boost** (not in the registry) — the image
    supplies it.
  - `activity/*.cpp` (IDE-generated, `gen auto by zuitools`) `#include`s
    `logic/*.cc`; **logic files are not their own translation units** and are
    excluded from `SRCS`.
- Install (non-persistent): `adb push update.img /tmp` + `setprop
  sys.zkupgrade.flag 255` + `sys.zkupgrade.dir /tmp` + `ctl.restart zkswe`;
  power cycle returns to official firmware.

## Two IDE-injected globals the headless build must set (in the Makefile)

- `-DLOG_TAG='"..."'` — the log framework references it unconditionally.
- `-D__PLATFORM_Z21__` — selects the Z21 code paths in the dependency headers,
  most importantly `base::function = std::function` (not boost). Omitting it
  flips every `base::function` signature to boost and the app fails to load with
  `undefined symbol: …base…function…`. Plus `-Wl,--start-group` around the libs
  so the static `.a`s (base-utility, transfer-protocols) cross-resolve.

## Non-persistent sideload — VERIFIED END-TO-END on real hardware (2026-08-08)

The compiled `pixel-pet-display` app ran on a real TC002 with no flashing:

```sh
ADB=adb; T=<device-ip>:5555; $ADB connect $T
# stop the LAN clock service first if it holds the single adb channel
$ADB -s $T push libzkgui.so /tmp/libzkgui.so
$ADB -s $T push upstream/apps/flythings/pixel-pet-display/ui /tmp/ui
# EasyUI.cfg with startupLibPath=/tmp/libzkgui.so, resPath=/tmp/ui/,
# languagePath=/res/tr/  → write to /tmp/EasyUI.cfg
$ADB -s $T shell "echo '<cfg-json>' > /tmp/EasyUI.cfg"
$ADB -s $T shell 'setprop ctl.restart zkswe'          # framework loads from /tmp
```

The framework logs `load /tmp/EasyUI.cfg ok!`, `registerActivity
petAnimationActivity OK!`, and cycles CatPetPage/DogPetPage/RabbitPetPage.
Restore: `rm -f /tmp/EasyUI.cfg /tmp/libzkgui.so; rm -rf /tmp/ui; setprop
ctl.restart zkswe` — or just power-cycle (tmpfs is wiped).

## The lyrics player builds here too

The real player (`../tc002-lyrics-player/app`) is compiled by this same
environment — `make` with the default `APP`. tc002-os builds through
`mise run os-build` at the repo root, which passes `APP=../tc002-os/app`.
Facts learned while bringing the player up:

- **Strip is mandatory** (the Makefile does it): the unstripped `.so` is
  ~6.7MB and OOM-reboots the 36MB device; stripped it is ~1.8MB.
- The `OBJS` rule uses `$(patsubst $(APP)/%,build/%.o,$(SRCS))` so objects land
  under `build/` — an earlier `build/../app/...` path escape left stale `.o`
  files that `make clean` never removed and silently shipped old code.
- Push order matters on device: `rm /tmp/track.mp3` **before** pushing a new
  `.so`, or adbd wedges mid-transfer (tmpfs full: "device online but shell
  reports error:closed").
- `update.img` packaging is only needed for **persistent** 固化, which we are
  intentionally not doing.
