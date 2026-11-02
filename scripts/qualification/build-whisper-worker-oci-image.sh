#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker_cli="${MEDIA_WHISPER_WORKER_DOCKER_CLI:-docker}"
base_image="${MEDIA_WHISPER_WORKER_BASE_IMAGE:-}"
image_tag="${MEDIA_WHISPER_WORKER_BUILD_TAG:-ghatana/media-whisper-worker:local}"
platform="linux/arm64"
dockerfile="$repo_root/modules/speech/stt-service/src/main/oci/whisper-worker/Dockerfile"

if [[ ! "$base_image" =~ ^[^[:space:],@]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "MEDIA_WHISPER_WORKER_BASE_IMAGE must be an already available digest-pinned image reference" >&2
  exit 2
fi
if [[ ! "$image_tag" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]]; then
  echo "MEDIA_WHISPER_WORKER_BUILD_TAG must be a local image tag" >&2
  exit 2
fi
if ! command -v "$docker_cli" >/dev/null 2>&1; then
  echo "Docker CLI is unavailable" >&2
  exit 2
fi
if ! "$docker_cli" image inspect "$base_image" >/dev/null 2>&1; then
  echo "The digest-pinned base image must already be present locally; this build performs no pull" >&2
  exit 2
fi

"$repo_root/gradlew" :services:media:modules:speech:stt-service:installDist
distribution="$repo_root/modules/speech/stt-service/build/install/stt-service"
if [[ ! -d "$distribution/lib" || ! -d "$distribution/bin" ]]; then
  echo "The stt-service installDist output is incomplete" >&2
  exit 3
fi
worker_found=false
while IFS= read -r worker_jar; do
  if jar tf "$worker_jar" | grep -qx 'com/ghatana/stt/provider/WhisperComputeWorkerMain.class'; then
    worker_found=true
    break
  fi
done < <(find "$distribution/lib" -maxdepth 1 -type f -name '*.jar' -print)
if [[ "$worker_found" != true ]]; then
  echo "The installDist artifact does not contain WhisperComputeWorkerMain" >&2
  exit 3
fi

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/install"
cp -R "$distribution/." "$context/install/"
"$docker_cli" build --pull=false --network=none --platform "$platform" \
  --build-arg "BASE_IMAGE=$base_image" \
  --file "$dockerfile" --tag "$image_tag" "$context"

image_id="$("$docker_cli" image inspect --format '{{.Id}}' "$image_tag")"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Docker did not return a content-addressed worker image ID" >&2
  exit 4
fi
printf '%s\n' "$image_id"
echo "This local image ID is not an OCI registry manifest digest and does not admit broker execution." >&2
