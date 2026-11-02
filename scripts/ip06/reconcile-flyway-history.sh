#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <operator-supplied-flyway-history.csv>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
input_path="$1"
if [[ "$input_path" != /* ]]; then
  input_path="$(cd "$(dirname "$input_path")" && pwd)/$(basename "$input_path")"
fi
if [[ ! -f "$input_path" ]]; then
  echo "Input CSV does not exist: $input_path" >&2
  exit 2
fi

cd "$repo_root"
exec ./gradlew \
  -I scripts/ip06/reconcile-flyway-history.init.gradle \
  :services:media:providers:aws-postgresql:ip06HistoryCandidateReconcile \
  "-Pip06Csv=$input_path" \
  --no-daemon --no-parallel --max-workers=2 --console=plain
