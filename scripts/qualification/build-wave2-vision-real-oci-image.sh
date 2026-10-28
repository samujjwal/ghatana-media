#!/usr/bin/env bash
# Opt-in source-pinned Linux ARM64 real FFmpeg worker. No binary vendoring.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash scripts/qualification/build-wave2-vision-real-oci-image.sh MEDIA_LINUX_CODECS_DIR" >&2
  exit 2
fi
root="$(cd "$1" && pwd -P)"
test -f "$root/PROVISION.json" || { echo "Pinned codec provenance missing" >&2; exit 3; }
for cmd in docker python3; do
  command -v "$cmd" >/dev/null || { echo "Required command unavailable: $cmd" >&2; exit 3; }
done
script_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash "$script_root/scripts/prepare-wave2-codecs.sh" --verify-runtime linux-arm64 "$root/native-runtime-packages" >/dev/null
python3 - "$root" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
provision = json.loads((root / "PROVISION.json").read_text())
expected = "ead92446d2d51015500843fa70a3ead35391898fe9850b7471c042f11d533586"
assert provision["schemaVersion"] == "ghatana.media.test-codecs.v1"
assert provision["source"] == "serversideup/ffmpeg-lgpl-builds"
assert provision["release"] == "v8.1.2-27"
assert provision["archiveSha256"] == expected
native = provision["nativeRuntime"]
assert native["profile"] == "ubuntu-24.04-noble"
assert native["architecture"] == "arm64"
assert len(native["packages"]) == 6
for name in ("ffmpeg", "ffprobe"):
    path = root / name
    assert path.is_file() and not path.is_symlink(), f"Missing pinned executable: {name}"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == provision["binarySha256"][name], f"FAIL_CLOSED_BINARY_SHA256: {name}"
archives = [p for p in root.iterdir() if p.name.startswith("ffmpeg-") and p.name.endswith(".tar.gz")]
assert len(archives) == 1, "Expected one exact original archive"
assert hashlib.sha256(archives[0].read_bytes()).hexdigest() == expected, "FAIL_CLOSED_ARCHIVE_SHA256"
print("Pinned Linux ARM64 archive, binaries and six-package runtime closure verified")
PY

tag="ghatana-media-vision-real-codec:local-test"
docker build --platform linux/arm64 --network none \
  --file "$script_root/modules/vision/vision-service/src/test/resources/vision-oci-real/Dockerfile" \
  --tag "$tag" "$root"
image="$(docker image inspect --format '{{.Id}}' "$tag")"
arch="$(docker image inspect --format '{{.Architecture}}' "$tag")"
if [[ ! "$image" =~ ^sha256:[a-f0-9]{64}$ || "$arch" != "arm64" ]]; then
  echo "Refusing unpinned or wrong-architecture OCI worker image" >&2
  exit 4
fi
printf 'GHATANA_MEDIA_VISION_WORKER_IMAGE=%s\n' "$image"
printf 'GHATANA_MEDIA_VISION_REAL_CODEC_TEST=RUN\n'
printf 'Run HostOciVisionRealCodecIntegrationTest separately from stub-based suites.\n'
