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

# Size is a budget, not a curiosity: the bundle is pushed into tmpfs (RAM) on a
# 36 MB box, and an unstripped .so has OOM-rebooted this device before.
size_bytes="$(wc -c < "$SO" | tr -d ' ')"
echo "  size: $size_bytes bytes"
if [ "$size_bytes" -gt 614400 ]; then
  echo "  FAIL over the 600 KB budget for tc002-os" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "link-audit: FAILED" >&2
  exit 1
fi
echo "link-audit: ok"
