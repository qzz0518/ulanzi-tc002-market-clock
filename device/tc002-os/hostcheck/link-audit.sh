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
# The original 600 KB was a design target, not a hardware limit: the arcade
# firmware runs on this unit at 1,766,760 bytes and the lyrics player at
# 1,840,452. Sound costs ~438 KB (base::AudioPlayer pulls the resampler, the
# mixer and the MI_AO glue) and is worth it. What this cap has to catch is a
# MISTAKE, and the mistakes are large: accidentally linking the full ffmpeg
# decode path, measured at roughly 1.9 MB, and shipping the .so unstripped.
#
# NOT A ROUND MiB, and that is the point. This used to be 1258291 (1.2 MiB),
# picked as a round number when the binary was 1,255,160 bytes — apparently
# 3,131 bytes of headroom. It was not: ld pads the read-only segment so the
# writable one keeps its page congruence, so THE FILE SIZE ONLY EVER MOVES IN
# 4,096 BYTE STEPS. Measured on the baseline by padding it with known amounts of
# .rodata: +200 bytes -> 1,255,160; +500 -> 1,259,256; +3,000 -> 1,259,256;
# +4,524 -> 1,263,352. The very next attainable size above the baseline was
# already 965 bytes over the old cap, so the real budget was the ~200-500 bytes
# that fit in the existing padding, and any feature at all failed the audit —
# which is what happened to the word-level lyric timing (ADR 0008): 3,096 bytes
# of compiled code spread evenly over four files, with no single item to remove.
#
# 1,400,000 restores what the number was for. It is 136 KB — 33 of those 4 KB
# steps — above the current binary, so a real change can be paid for; it is
# 366 KB below the smaller of the two firmwares this device already runs; and it
# is 500 KB below a measured ffmpeg link, which is the failure being guarded.
if [ "$size_bytes" -gt 1400000 ]; then
  echo "  FAIL over the 1,400,000 byte budget for tc002-os" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "link-audit: FAILED" >&2
  exit 1
fi
echo "link-audit: ok"
