#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
promtool_runner="$script_dir/promtool.sh"

cd "$repo_root"
version="$("$promtool_runner" --version)"
if [[ ! "$version" =~ (^|[[:space:]])v?3\.15\.1([[:space:]]|$) ]]; then
  printf 'Expected pinned Prometheus promtool v3.15.1; got: %s\n' "$version" >&2
  exit 1
fi
printf '%s\n' "$version"

"$promtool_runner" check rules \
  monitoring/prometheus/rules/media.yml \
  infra/monitoring/alerts/audio-video.yml
"$promtool_runner" test rules infra/monitoring/tests/audio-video.rules.test.yml

printf '%s\n' 'PASS: Prometheus rule files and alert scenarios validated with the pinned v3.15.1 promtool.'
