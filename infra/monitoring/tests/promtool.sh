#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_IMAGE='prom/prometheus@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2'

if [[ $# -eq 0 ]]; then
  printf '%s\n' 'Usage: promtool <promtool arguments...>' >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI is required; install or configure Docker for this user.' >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'A Docker daemon accessible to this user is required.' >&2
  exit 2
fi

if ! docker image inspect "$PROMETHEUS_IMAGE" >/dev/null 2>&1; then
  printf 'Pulling the pinned Prometheus image: %s\n' "$PROMETHEUS_IMAGE" >&2
  docker pull "$PROMETHEUS_IMAGE"
fi

working_directory="$(pwd -P)"
if [[ "$working_directory" == *','* ]]; then
  printf '%s\n' 'The current directory contains a comma and cannot be mounted safely.' >&2
  exit 2
fi

user_id="$(id -u)"
group_id="$(id -g)"
if [[ ! "$user_id" =~ ^[0-9]+$ || ! "$group_id" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'Could not determine numeric current-user and group IDs.' >&2
  exit 2
fi

exec docker run \
  --pull=never \
  --rm \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --user "$user_id:$group_id" \
  --memory=512m \
  --cpus=2 \
  --pids-limit=128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --mount "type=bind,source=$working_directory,target=$working_directory,readonly" \
  --workdir "$working_directory" \
  --entrypoint /bin/promtool \
  "$PROMETHEUS_IMAGE" \
  "$@"
