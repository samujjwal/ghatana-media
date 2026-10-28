#!/usr/bin/env bash
# Explicitly separate stub isolation and real codec qualification JVMs.
# Reusing one globally set worker image across both suites is invalid.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash scripts/qualification/run-wave2-vision-oci-checks.sh stub | real MEDIA_LINUX_CODECS_DIR" >&2
  exit 2
fi
mode="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
test_dir="$root/modules/vision/vision-service/src/test/resources/vision-oci"
test -f "$test_dir/Dockerfile" || { echo "Missing source-controlled OCI test image" >&2; exit 3; }
command -v docker >/dev/null || { echo "Docker required on trusted host" >&2; exit 3; }

if [[ "$mode" == "stub" ]]; then
  [[ $# -eq 1 ]] || { echo "Stub mode takes no codec directory" >&2; exit 2; }
  # The test-only image must be built locally from the exact fixture image;
  # its Docker image ID, not a mutable tag, authorizes the subprocess.
  docker build --platform linux/arm64 --network none -f "$test_dir/Dockerfile" \
    -t ghatana-media-vision-oci-fixture:local-test "$test_dir"
  image="$(docker image inspect --format '{{.Id}}' ghatana-media-vision-oci-fixture:local-test)"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Pinned OCI fixture image unavailable" >&2; exit 4; }
  export GHATANA_MEDIA_VISION_WORKER_IMAGE="$image"
  unset GHATANA_MEDIA_VISION_REAL_CODEC_TEST
  selection="com.ghatana.audio.video.vision.video.HostOciVisionWorkerDockerIntegrationTest"
elif [[ "$mode" == "real" ]]; then
  [[ $# -eq 2 ]] || { echo "Real mode requires verified Linux ARM64 codec directory" >&2; exit 2; }
  info="$(bash "$root/scripts/qualification/build-wave2-vision-real-oci-image.sh" "$2")"
  image="$(printf '%s\n' "$info" | sed -n 's/^GHATANA_MEDIA_VISION_WORKER_IMAGE=//p' | tail -n 1)"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Pinned real-codec OCI image unavailable" >&2; exit 4; }
  export GHATANA_MEDIA_VISION_WORKER_IMAGE="$image"
  export GHATANA_MEDIA_VISION_REAL_CODEC_TEST=RUN
  selection="com.ghatana.audio.video.vision.video.HostOciVisionRealCodecIntegrationTest"
else
  echo "Unknown mode, use stub or real" >&2
  exit 2
fi

./gradlew \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=vision \
  :services:media:modules:vision:vision-service:test \
  --tests "$selection" \
  --rerun-tasks --no-daemon --no-parallel --max-workers=2 --console=plain

printf 'Verified dedicated OCI test JVM mode=%s (image SHA %s)\n' "$mode" "$image"
