#!/usr/bin/env bash
set -Eeuo pipefail

readonly MACOS_LABEL="com.zerah.ulanzi-market-clock"

usage() {
  cat <<'USAGE'
Remove the native macOS Zerah Ulanzi TC002 Pixel Studio background service.

Usage:
  scripts/uninstall.sh

The project, compiled files, logs, and saved content workspace are preserved.
For Docker deployment, use scripts/uninstall-docker.sh instead.
USAGE
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Error: unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Error: native uninstallation is supported only on macOS; use scripts/uninstall-docker.sh\n' >&2
  exit 1
fi

domain="gui/$(id -u)"
target="$HOME/Library/LaunchAgents/$MACOS_LABEL.plist"
launchctl bootout "$domain/$MACOS_LABEL" >/dev/null 2>&1 || true
rm -f "$target"
printf 'Removed macOS LaunchAgent: %s\n' "$MACOS_LABEL"

printf 'Preserved project data and .runtime workspace.\n'
