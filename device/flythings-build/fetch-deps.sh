#!/bin/sh
# Fetch the FlyThings cross toolchain and the z21 dependency packages needed to
# cross-compile a FlyThings app headlessly. Idempotent; large outputs are
# gitignored. Requires curl + unzip on the host.
set -e
cd "$(dirname "$0")"

TOOLCHAIN_URL="https://download.flythings.cn/toolchain/ssd.tar.gz"
API="https://package.flythings.cn/api/platforms/z21/packages"
# Versions pinned to pixel-pet-display's .deps.lock. Add audio/net packages here
# (mi_ao, zkaudio, audio-utility, curl-cxx, mqtt-cxx, …) when the real player
# needs them.
DEPS="easyui:2.6.0 log:0.0.0 zkhardware:0.0.0 base-utility:10.9.3 transfer-protocols:3.0.0"

if [ ! -x toolchain/toolchain/bin/arm-linux-gnueabihf-g++ ]; then
  echo "downloading toolchain (~133 MB)…"
  curl -L "$TOOLCHAIN_URL" -o toolchain.tar.gz
  mkdir -p toolchain && tar xzf toolchain.tar.gz -C toolchain && rm -f toolchain.tar.gz
fi

mkdir -p packages
for spec in $DEPS; do
  pkg=${spec%%:*}; ver=${spec##*:}
  echo "fetching $pkg@$ver…"
  curl -fL "$API/$pkg/versions/$ver/archive" -o "packages/$pkg.zip"
  rm -rf "packages/$pkg"
  unzip -oq "packages/$pkg.zip" -d "packages/$pkg"
  rm -f "packages/$pkg.zip"
done

echo "toolchain + $(echo $DEPS | wc -w | tr -d ' ') packages ready under $(pwd)"
