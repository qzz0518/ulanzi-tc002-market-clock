#!/bin/sh
# Link audit for a cross-built firmware .so. Runs INSIDE the flythings-build
# container (the toolchain's readelf is a Linux x86-64 binary and cannot run on
# the macOS host).
#
# Catches the one failure mode that is otherwise only discovered by pushing to
# the device and watching a black panel: the loader's sole report is
# "initLib error: undefined symbol", with no clue which library or symbol.
#
# GROUND TRUTH. The reference is a firmware that is *proven to load on the real
# unit* — libzkgui-arcade.so. Its DT_NEEDED set is empirically satisfiable, so
# any subset of it is too. The device's own module map is a weaker source and is
# used only to widen the set: it lists what the official app happened to load,
# not what exists, so a library present on the device but lazily unused by the
# official app (libzkmedia is exactly that) would otherwise read as a failure.
#
# Usage: link-audit.sh <candidate.so> [reference.so] [maps-baseline.txt]
set -e

SO="$1"
REF="${2:-libzkgui-arcade.so}"
MAPS="${3:-device-dump/maps-baseline.txt}"
READELF="${READELF:-toolchain/toolchain/bin/arm-linux-gnueabihf-readelf}"

if [ ! -f "$SO" ]; then
  echo "link-audit: no such file: $SO" >&2
  exit 1
fi

needed_of() {
  "$READELF" -d "$1" | sed -n 's/.*NEEDED.*\[\(.*\)\].*/\1/p' | sort -u
}

# Reduce a library filename to a comparable stem: the device stores glibc as
# libc-2.30.so while DT_NEEDED records the SONAME libc.so.6, so a plain basename
# comparison would reject the C library itself.
stem() {
  sed -e 's#.*/##' -e 's/\.so.*$//' -e 's/-[0-9][0-9.]*$//'
}

fail=0
echo "link-audit: $SO"

allowed=""
if [ -f "$REF" ]; then
  allowed="$(needed_of "$REF" | stem)"
  echo "  reference: $REF (proven to load on hardware)"
else
  echo "  WARNING no reference .so at $REF — falling back to the device map alone" >&2
fi
if [ -f "$MAPS" ]; then
  allowed="$allowed
$(awk '{print $NF}' "$MAPS" | grep '^/' | grep '\.so' | stem)"
fi
allowed="$(printf '%s\n' "$allowed" | grep -v '^$' | sort -u)"

needed="$(needed_of "$SO")"
echo "  NEEDED: $(echo "$needed" | tr '\n' ' ')"
for lib in $needed; do
  base="$(printf '%s\n' "$lib" | stem)"
  if ! printf '%s\n' "$allowed" | grep -qx "$base"; then
    echo "  FAIL $lib is neither in the proven reference nor in the device's module map" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "  every NEEDED library is known to exist on the device"

# Undefined media symbols. Linking audio-utility without the ffmpeg archives
# leaves ~38 undefined av_*/sws_*/swr_* symbols and the device ships no libav*,
# so the app loads to a black panel.
media="$("$READELF" -W --dyn-syms "$SO" \
  | awk '$7 == "UND" { print $8 }' \
  | grep -E '^(av_|ff_|sws_|swr_|avcodec_|avformat_|avfilter_|avdevice_)' \
  | sort -u || true)"
if [ -n "$media" ]; then
  count="$(printf '%s\n' "$media" | wc -l | tr -d ' ')"
  echo "  FAIL $count undefined ffmpeg/swscale symbols — the device ships no libav*" >&2
  printf '%s\n' "$media" | head -10 | sed 's/^/    /' >&2
  fail=1
else
  echo "  no undefined media symbols"
fi

# Forbidden network symbols. This is a SAFETY gate, not a hygiene one.
#
# libzknet.so exports both halves of the FlyThings network stack: the harmless
# NetUtils statics, and the NetManager/WifiManager/SoftApManager singletons that
# own the radio's power path. Those managers reload the WiFi driver through
# insmod/rmmod against module directories baked into the library — and on this
# unit those directories DO NOT EXIST (/late/lib/modules and /config/lib/modules
# are absent; the real modules live in /lib/modules/4.9.84). One trip through
# the rmmod branch unloads aic8800_fdrv with no path back: wlan0 disappears,
# and adb, which rides that link, dies with it. Recovery is a physical power
# cycle, and the failure is unobservable while it happens.
#
# tc002-os therefore links libzknet for NetUtils::dhcpRequestIp ONLY. This is
# what stops a later `#include <net/NetManager.h>` from quietly re-opening that
# door: the manager classes are C++, so touching one leaves its mangled name in
# the undefined symbols, and the build fails here instead of on the bench.
forbidden="$("$READELF" -W --dyn-syms "$SO" \
  | awk '$7 == "UND" { print $8 }' \
  | grep -E '(NetManager|WifiManager|SoftApManager|LTE4GManager|EthernetManager|WifiCtrl)' \
  | sort -u || true)"
if [ -n "$forbidden" ]; then
  echo "  FAIL references the FlyThings network managers, which own the radio power path" >&2
  printf '%s\n' "$forbidden" | head -10 | sed 's/^/    /' >&2
  echo "    only NetUtils (pure statics) may be used from libzknet — see the comment above" >&2
  fail=1
else
  echo "  no references to the radio-power-path managers"
fi

# Size is a budget, not a curiosity: the bundle is pushed into tmpfs (RAM) on a
# 36 MB box, and an unstripped .so has OOM-rebooted this device before.
size_bytes="$(wc -c < "$SO" | tr -d ' ')"
echo "  size: $size_bytes bytes"
# THE MP3 DECODE PATH IS NOW DELIBERATE. Until ADR 0014 this cap sat at
# 1,400,000 and existed to catch exactly one accident: linking the ffmpeg
# decode path, which the sideloaded music player needed and this firmware did
# not. Now this firmware plays NetEase itself (net/DeviceAudio) through
# base::MediaPlayer, and the archives it pulls in are the feature, not the
# mistake. Measured: 1,353,484 bytes before, 2,299,288 after — 945,804 bytes
# for the demuxer, the decoder and their tables.
#
# What the cap still has to catch: shipping the .so unstripped (~6.7 MB before
# ffmpeg, more now), and a second decode path arriving by accident — the video
# side of the same archives (swscale, avfilter) would be another megabyte and
# nothing here needs a pixel from ffmpeg. 2,600,000 is ~300 KB (73 of the
# 4,096-byte steps the file size actually moves in — see the git history of this
# line for why that granularity matters) above the current binary, so ordinary
# features can be paid for, and comfortably below where either failure lands.
#
# What it can no longer promise is the tmpfs argument the old number carried:
# the largest .so this unit has been SEEN to sideload is the music player's
# 1,840,452 bytes, and this firmware is now 25% past that. Flashed to `res`
# (device/tc002-os/README.md 「固化到 flash」) it is mmapped from squashfs and
# the stock app it replaces is 7,464,044 bytes, so flash is not the concern;
# a /tmp sideload of this build is the one configuration nobody has run yet.
if [ "$size_bytes" -gt 2600000 ]; then
  echo "  FAIL over the 2,600,000 byte budget for tc002-os" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "link-audit: FAILED" >&2
  exit 1
fi
echo "link-audit: ok"
