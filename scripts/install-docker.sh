#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_file="$project_dir/compose.yaml"
runtime_dir="$project_dir/.runtime"
environment_file="$runtime_dir/docker.env"

clock_host="${CLOCK_HOST:-}"
app_name="${APP_NAME:-btc}"
request_timeout_ms="${REQUEST_TIMEOUT_MS:-5000}"
source_stale_ms="${SOURCE_STALE_MS:-120000}"
display_duration_seconds="${DISPLAY_DURATION_SECONDS:-90}"
health_port="${HEALTH_PORT:-43820}"

usage() {
  cat <<'USAGE'
Build and start the Zerah Ulanzi TC002 Pixel Studio with Docker Compose.

Usage:
  scripts/install-docker.sh [options]

Options:
  --host HOST                 TC002 IPv4 address or hostname (prompted if omitted)
  --app-name NAME             TC002 Custom App name (default: btc)
  --health-port PORT          Host control-panel port (default: 43820)
  --request-timeout-ms MS     Device and market request timeout
  --source-stale-ms MS        Maximum age of cached market data
  --display-duration SEC      Minimum TC002 Custom App duration
  -h, --help                  Show this help

The Docker host must be able to route to the TC002 address. A public VPS cannot
reach a clock behind home NAT unless a VPN or routed private network is present.
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

validate_app_name() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || \
    die "APP_NAME must contain 1-32 ASCII letters, numbers, underscores, or hyphens"
}

validate_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  local number
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  number=$((10#$value))
  ((number >= minimum && number <= maximum)) || \
    die "$name must be between $minimum and $maximum"
}

prompt_for_clock_host
validate_clock_host "$clock_host"
validate_app_name "$app_name"
validate_integer "REQUEST_TIMEOUT_MS" "$request_timeout_ms" 1000 30000
validate_integer "SOURCE_STALE_MS" "$source_stale_ms" 60000 3600000
validate_integer "DISPLAY_DURATION_SECONDS" "$display_duration_seconds" 30 86400
validate_integer "HEALTH_PORT" "$health_port" 1024 65535

command -v docker >/dev/null 2>&1 || die "Docker is not installed"
docker compose version >/dev/null 2>&1 || die "Docker Compose is not available"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"

mkdir -p "$runtime_dir"
[[ -w "$runtime_dir" ]] || die "runtime directory is not writable: $runtime_dir"

umask 077
temporary="$(mktemp "$runtime_dir/docker.env.XXXXXX")"
{
  printf 'CLOCK_HOST=%s\n' "$clock_host"
  printf 'APP_NAME=%s\n' "$app_name"
  printf 'REQUEST_TIMEOUT_MS=%s\n' "$request_timeout_ms"
  printf 'SOURCE_STALE_MS=%s\n' "$source_stale_ms"
  printf 'DISPLAY_DURATION_SECONDS=%s\n' "$display_duration_seconds"
  printf 'HEALTH_PORT=%s\n' "$health_port"
  printf 'DOCKER_UID=%s\n' "$(id -u)"
  printf 'DOCKER_GID=%s\n' "$(id -g)"
} > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$environment_file"

compose() {
  docker compose --env-file "$environment_file" --file "$compose_file" "$@"
}

compose config --quiet
printf 'Building and starting the Docker service...\n'
compose up --detach --build --remove-orphans

container_id="$(compose ps --all --quiet market-clock)"
[[ -n "$container_id" ]] || die "Docker Compose did not create the market-clock container"

health=""
for _ in {1..30}; do
  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  if [[ "$state" == "exited" || "$state" == "dead" ]]; then
    compose logs --no-color --tail 30 market-clock >&2 || true
    die "Docker service exited before becoming healthy"
  fi
  sleep 1
done

if [[ "$health" != "healthy" ]]; then
  compose logs --no-color --tail 30 market-clock >&2 || true
  die "Docker service did not become healthy"
fi

compose ps
printf 'Control panel: http://127.0.0.1:%s/\n' "$health_port"
printf 'Saved Docker configuration: .runtime/docker.env\n'
