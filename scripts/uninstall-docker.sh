#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_file="$project_dir/compose.yaml"
environment_file="$project_dir/.runtime/docker.env"

usage() {
  cat <<'USAGE'
Stop and remove the Zerah Ulanzi TC002 Docker Compose service.

Usage:
  scripts/uninstall-docker.sh

The local image, project, compiled files, logs, Docker configuration, and saved
content workspace settings are preserved.
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

command -v docker >/dev/null 2>&1 || {
  printf 'Error: Docker is not installed\n' >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  printf 'Error: Docker Compose is not available\n' >&2
  exit 1
}

if [[ -r "$environment_file" ]]; then
  docker compose \
    --env-file "$environment_file" \
    --file "$compose_file" \
    down --remove-orphans
else
  CLOCK_HOST="uninstall.invalid" docker compose \
    --file "$compose_file" \
    down --remove-orphans
fi
printf 'Removed Docker containers and network; preserved image and .runtime workspace.\n'
