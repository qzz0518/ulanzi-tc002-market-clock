#!/usr/bin/env bash
set -Eeuo pipefail

readonly MACOS_LABEL="com.zerah.ulanzi-market-clock"
readonly REQUIRED_BUN_VERSION="1.3.14"

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
clock_host="${CLOCK_HOST:-}"
clock_http_proxy="${CLOCK_HTTP_PROXY:-}"
app_name="${APP_NAME:-btc}"
request_timeout_ms="${REQUEST_TIMEOUT_MS:-5000}"
source_stale_ms="${SOURCE_STALE_MS:-120000}"
display_duration_seconds="${DISPLAY_DURATION_SECONDS:-90}"
health_port="${HEALTH_PORT:-43820}"

usage() {
  cat <<'USAGE'
Install and start the native macOS Zerah Ulanzi TC002 Pixel Studio service.

Usage:
  scripts/install.sh [options]

Options:
  --host HOST                 TC002 IPv4 address or hostname (prompted if omitted)
  --proxy URL                 Optional unauthenticated loopback HTTP proxy
  --app-name NAME             TC002 Custom App name (default: btc)
  --health-port PORT          Local control-panel port (default: 43820)
  --request-timeout-ms MS     Device and market request timeout
  --source-stale-ms MS        Maximum age of cached market data
  --display-duration SEC      Minimum TC002 Custom App duration
  -h, --help                  Show this help

The same values can be supplied with CLOCK_HOST, CLOCK_HTTP_PROXY,
APP_NAME, HEALTH_PORT, REQUEST_TIMEOUT_MS, SOURCE_STALE_MS, and
DISPLAY_DURATION_SECONDS.

For Docker deployment, use scripts/install-docker.sh instead.
USAGE
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2-}"
  [[ -n "$value" ]] || die "$option requires a value"
}

while (($# > 0)); do
  case "$1" in
    --host)
      require_value "$1" "${2-}"
      clock_host="$2"
      shift 2
      ;;
    --proxy)
      require_value "$1" "${2-}"
      clock_http_proxy="$2"
      shift 2
      ;;
    --app-name)
      require_value "$1" "${2-}"
      app_name="$2"
      shift 2
      ;;
    --health-port)
      require_value "$1" "${2-}"
      health_port="$2"
      shift 2
      ;;
    --request-timeout-ms)
      require_value "$1" "${2-}"
      request_timeout_ms="$2"
      shift 2
      ;;
    --source-stale-ms)
      require_value "$1" "${2-}"
      source_stale_ms="$2"
      shift 2
      ;;
    --display-duration)
      require_value "$1" "${2-}"
      display_duration_seconds="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || \
  die "native installation is supported only on macOS; use scripts/install-docker.sh"

prompt_for_clock_host() {
  [[ -n "$clock_host" ]] && return
  if [[ ! -t 0 ]]; then
    die "CLOCK_HOST is required; pass --host HOST or set the CLOCK_HOST environment variable"
  fi
  printf 'Enter TC002 LAN IP or hostname / 请输入 TC002 局域网 IP 或主机名: ' >&2
  if ! IFS= read -r clock_host || [[ -z "$clock_host" ]]; then
    die "CLOCK_HOST cannot be empty"
  fi
}

validate_clock_host() {
  local value="$1"
  [[ ${#value} -ge 1 && ${#value} -le 253 ]] || die "CLOCK_HOST has an invalid length"
  [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]] || \
    die "CLOCK_HOST must be an IPv4 address or hostname without a URL scheme or port"
}

prompt_for_clock_host
validate_clock_host "$clock_host"

assert_single_line() {
  local name="$1"
  local value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name cannot contain a newline"
}

for setting in \
  "CLOCK_HOST:$clock_host" \
  "CLOCK_HTTP_PROXY:$clock_http_proxy" \
  "APP_NAME:$app_name" \
  "REQUEST_TIMEOUT_MS:$request_timeout_ms" \
  "SOURCE_STALE_MS:$source_stale_ms" \
  "DISPLAY_DURATION_SECONDS:$display_duration_seconds" \
  "HEALTH_PORT:$health_port"; do
  assert_single_line "${setting%%:*}" "${setting#*:}"
done

resolve_bun() {
  local candidate
  local version
  if command -v mise >/dev/null 2>&1; then
    printf 'Ensuring the project-pinned Bun version with mise...\n' >&2
    (cd "$project_dir" && mise install bun)
    candidate="$(cd "$project_dir" && mise which bun)"
  elif command -v bun >/dev/null 2>&1; then
    candidate="$(command -v bun)"
  else
    die "Bun is not installed. Install mise or Bun $REQUIRED_BUN_VERSION, then run this script again."
  fi

  if [[ "$candidate" != /* ]]; then
    candidate="$(cd -- "$(dirname -- "$candidate")" && pwd -P)/$(basename -- "$candidate")"
  fi
  [[ -x "$candidate" ]] || die "Bun executable is not usable: $candidate"
  version="$("$candidate" --version 2>/dev/null || true)"
  [[ "$version" == "$REQUIRED_BUN_VERSION" ]] || \
    die "Bun $REQUIRED_BUN_VERSION is required; found ${version:-an unreadable version} at $candidate"
  printf '%s' "$candidate"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

replace_token() {
  local token="$1"
  local value="$2"
  local file="$3"
  local escaped
  escaped="$(sed_replacement "$value")"
  sed "s|$token|$escaped|g" "$file"
}

render_tokens() {
  local template="$1"
  local target="$2"
  local current="$template"
  local previous=""
  local next
  shift 2

  while (($# >= 2)); do
    next="$(mktemp "${target}.stage.XXXXXX")"
    replace_token "$1" "$2" "$current" > "$next"
    if [[ -n "$previous" ]]; then
      rm -f "$previous"
    fi
    previous="$next"
    current="$next"
    shift 2
  done

  mv -f "$current" "$target"
}

validate_configuration() {
  (
    cd "$project_dir"
    env \
      CLOCK_HOST="$clock_host" \
      CLOCK_HTTP_PROXY="$clock_http_proxy" \
      CONTROL_HOST="127.0.0.1" \
      APP_NAME="$app_name" \
      REQUEST_TIMEOUT_MS="$request_timeout_ms" \
      SOURCE_STALE_MS="$source_stale_ms" \
      DISPLAY_DURATION_SECONDS="$display_duration_seconds" \
      HEALTH_PORT="$health_port" \
      "$bun_bin" -e 'import { loadConfig } from "./src/config.ts"; loadConfig();'
  )
}

write_environment_file() {
  local runtime_dir="$project_dir/.runtime"
  local target="$runtime_dir/service.env"
  local temporary
  mkdir -p "$runtime_dir"
  umask 077
  temporary="$(mktemp "$runtime_dir/service.env.XXXXXX")"
  {
    if [[ "$bun_bin" == "$HOME/"* ]]; then
      printf 'BUN_HOME_RELATIVE=%q\n' "${bun_bin#"$HOME/"}"
    else
      printf 'BUN_BIN=%q\n' "$bun_bin"
    fi
    printf 'CLOCK_HOST=%q\n' "$clock_host"
    printf 'CLOCK_HTTP_PROXY=%q\n' "$clock_http_proxy"
    printf 'CONTROL_HOST=%q\n' "127.0.0.1"
    printf 'APP_NAME=%q\n' "$app_name"
    printf 'REQUEST_TIMEOUT_MS=%q\n' "$request_timeout_ms"
    printf 'SOURCE_STALE_MS=%q\n' "$source_stale_ms"
    printf 'DISPLAY_DURATION_SECONDS=%q\n' "$display_duration_seconds"
    printf 'HEALTH_PORT=%q\n' "$health_port"
  } > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$target"
}

render_macos_service() {
  local template="$project_dir/packaging/macos/$MACOS_LABEL.plist.template"
  local target="$1"
  render_tokens "$template" "$target" \
    '@@PROJECT_DIR_XML@@' "$(xml_escape "$project_dir")" \
    '@@BUN_BIN_XML@@' "$(xml_escape "$bun_bin")" \
    '@@ENTRYPOINT_XML@@' "$(xml_escape "$project_dir/dist/service.js")" \
    '@@CLOCK_HOST_XML@@' "$(xml_escape "$clock_host")" \
    '@@CLOCK_HTTP_PROXY_XML@@' "$(xml_escape "$clock_http_proxy")" \
    '@@APP_NAME_XML@@' "$(xml_escape "$app_name")" \
    '@@REQUEST_TIMEOUT_MS_XML@@' "$(xml_escape "$request_timeout_ms")" \
    '@@SOURCE_STALE_MS_XML@@' "$(xml_escape "$source_stale_ms")" \
    '@@DISPLAY_DURATION_SECONDS_XML@@' "$(xml_escape "$display_duration_seconds")" \
    '@@HEALTH_PORT_XML@@' "$(xml_escape "$health_port")" \
    '@@STDOUT_XML@@' "$(xml_escape "$project_dir/.runtime/service.log")" \
    '@@STDERR_XML@@' "$(xml_escape "$project_dir/.runtime/service.error.log")"
}

wait_for_health() {
  local attempt
  for attempt in {1..20}; do
    if HEALTH_PORT="$health_port" "$bun_bin" "$project_dir/dist/status.js" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

health_responds() {
  HEALTH_PORT="$health_port" "$bun_bin" "$project_dir/dist/status.js" >/dev/null 2>&1
}

install_macos() {
  local domain="gui/$(id -u)"
  local agent_dir="$HOME/Library/LaunchAgents"
  local target="$agent_dir/$MACOS_LABEL.plist"
  local temporary
  mkdir -p "$agent_dir"
  temporary="$(mktemp "$agent_dir/$MACOS_LABEL.plist.XXXXXX")"
  render_macos_service "$temporary"
  plutil -lint "$temporary" >/dev/null
  chmod 644 "$temporary"

  launchctl bootout "$domain/$MACOS_LABEL" >/dev/null 2>&1 || true
  sleep 1
  if health_responds; then
    rm -f "$temporary"
    die "port $health_port is already served by another process; stop it before installing"
  fi
  mv -f "$temporary" "$target"
  launchctl bootstrap "$domain" "$target"
  launchctl kickstart -k "$domain/$MACOS_LABEL"

  launchctl print "$domain/$MACOS_LABEL" >/dev/null

  if ! wait_for_health; then
    tail -n 20 "$project_dir/.runtime/service.error.log" 2>/dev/null || true
    die "service started but its local health endpoint did not respond"
  fi

  printf 'Installed macOS LaunchAgent: %s\n' "$MACOS_LABEL"
}

bun_bin="$(resolve_bun)"

printf 'Installing dependencies and building the service...\n'
(
  cd "$project_dir"
  "$bun_bin" install --frozen-lockfile
  "$bun_bin" run build
)

validate_configuration
write_environment_file

install_macos

printf 'Control panel: http://127.0.0.1:%s/\n' "$health_port"
printf 'Settings and generated service configuration remain in .runtime/.\n'
