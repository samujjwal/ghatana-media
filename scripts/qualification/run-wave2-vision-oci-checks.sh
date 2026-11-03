#!/usr/bin/env bash
# Explicitly separate stub isolation and real codec qualification JVMs.
# Reusing one globally set worker image across both suites is invalid.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash scripts/qualification/run-wave2-vision-oci-checks.sh stub | real MEDIA_LINUX_CODECS_DIR | png MEDIA_LINUX_PNG_CODECS_DIR | broker (external provisioned broker only)" >&2
  exit 2
fi
mode="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
test_dir="$root/modules/vision/vision-service/src/test/resources/vision-oci"

if [[ "$mode" == "stub" ]]; then
  [[ $# -eq 1 ]] || { echo "Stub mode takes no codec directory" >&2; exit 2; }
  test -f "$test_dir/Dockerfile" || { echo "Missing source-controlled OCI test image" >&2; exit 3; }
  command -v docker >/dev/null || { echo "Docker required on trusted host" >&2; exit 3; }
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
  command -v docker >/dev/null || { echo "Docker required on trusted host" >&2; exit 3; }
  info="$(bash "$root/scripts/qualification/build-wave2-vision-real-oci-image.sh" "$2")"
  image="$(printf '%s\n' "$info" | sed -n 's/^GHATANA_MEDIA_VISION_WORKER_IMAGE=//p' | tail -n 1)"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Pinned real-codec OCI image unavailable" >&2; exit 4; }
  export GHATANA_MEDIA_VISION_WORKER_IMAGE="$image"
  export GHATANA_MEDIA_VISION_REAL_CODEC_TEST=RUN
  selection="com.ghatana.audio.video.vision.video.HostOciVisionRealCodecIntegrationTest"
elif [[ "$mode" == "png" ]]; then
  [[ $# -eq 2 ]] || { echo "PNG mode requires verified Linux ARM64 PNG codec directory" >&2; exit 2; }
  command -v docker >/dev/null || { echo "Docker required on trusted host" >&2; exit 3; }
  info="$(bash "$root/scripts/qualification/build-wave2-vision-png-oci-image.sh" "$2")"
  image="$(printf '%s\n' "$info" | sed -n 's/^GHATANA_MEDIA_VISION_WORKER_IMAGE=//p' | tail -n 1)"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Pinned PNG-capable OCI image unavailable" >&2; exit 4; }
  export GHATANA_MEDIA_VISION_WORKER_IMAGE="$image"
  export GHATANA_MEDIA_VISION_PNG_CODEC_TEST=RUN
  selection="com.ghatana.audio.video.vision.video.HostOciVisionPngCodecIntegrationTest"
elif [[ "$mode" == "broker" ]]; then
  [[ $# -eq 1 ]] || { echo "Broker mode takes no codec directory" >&2; exit 2; }
  required=(
    GHATANA_MEDIA_VISION_OCI_BROKER_SOCKET
    GHATANA_MEDIA_VISION_OCI_BROKER_TOKEN_FILE
    GHATANA_MEDIA_VISION_WORKER_IMAGE
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_UID
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_GID
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_BROKER_USER
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_BROKER_UID
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_USER
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_GID
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_STAGE_ROOT
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_SOURCE_ROOT
    GHATANA_MEDIA_VISION_OCI_BROKER_TEST_OUTPUT_ROOT
  )
  missing=()
  for name in "${required[@]}"; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'External broker mode requires preprovisioned host inputs; missing: %s\n' "${missing[*]}" >&2
    echo 'Provision a distinct broker OS user, dedicated broker/peer/worker GID, peer-group 0660 socket, private broker token plus peer-owned client token, broker-owned 0700 stage root, and worker-owned shared-group mode-02750 source/output roots with mode-0440 source files.' >&2
    exit 3
  fi
  image="$GHATANA_MEDIA_VISION_WORKER_IMAGE"
  [[ "$image" =~ ^(([^[:space:],@]+@)?sha256:[a-f0-9]{64})$ ]] || { echo "Pinned OCI fixture image digest required" >&2; exit 4; }
  [[ "$(id -un)" == "$GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_USER" ]] || {
    echo "Run this selector as the configured peer OS account; user.name is not an identity substitute" >&2; exit 3;
  }
  export GHATANA_MEDIA_VISION_OCI_BROKER_TEST_EXTERNAL=1
  # Deliberately unusable: any direct Docker access from the Media JVM fails.
  export GHATANA_MEDIA_VISION_DOCKER_CLI="/nonexistent-media-jvm-must-not-exec-docker"
  selection="com.ghatana.audio.video.vision.video.HostOciVisionBrokerIntegrationTest"
  python3 - <<'PY'
import os, stat

def need(name):
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing required broker host input: {name}")
    return value

def number(name, positive=False):
    value = need(name)
    if not value.isdecimal() or (positive and int(value) <= 0):
        raise SystemExit(f"{name} must be a {'positive ' if positive else ''}numeric ID")
    return int(value)

def inspect(path, name):
    try:
        return os.lstat(path)
    except OSError as error:
        raise SystemExit(f"{name} is unavailable or not inspectable: {error.strerror}")

socket_path = need("GHATANA_MEDIA_VISION_OCI_BROKER_SOCKET")
token_path = need("GHATANA_MEDIA_VISION_OCI_BROKER_TOKEN_FILE")
stage_root = need("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_STAGE_ROOT")
source_root = need("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_SOURCE_ROOT")
output_root = need("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_OUTPUT_ROOT")
peer_gid = number("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_GID", positive=True)
worker_uid = number("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_UID", positive=True)
worker_gid = number("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_GID")
broker_uid = number("GHATANA_MEDIA_VISION_OCI_BROKER_TEST_BROKER_UID", positive=True)

if os.getuid() != worker_uid:
    raise SystemExit("Test peer UID must equal the pinned worker/source UID")
if worker_gid != peer_gid:
    raise SystemExit("Pinned worker GID must equal the configured broker/peer shared GID")
if worker_gid not in os.getgroups() and worker_gid != os.getgid():
    raise SystemExit("Test peer account is not a member of the configured broker/peer group")
if broker_uid == os.getuid():
    raise SystemExit("Broker and Media peer must be distinct OS identities")

sock = inspect(socket_path, "Broker socket")
if not stat.S_ISSOCK(sock.st_mode) or sock.st_uid != broker_uid or sock.st_gid != peer_gid or stat.S_IMODE(sock.st_mode) != 0o660:
    raise SystemExit("Broker socket must be broker-owned, peer-group-owned, and mode 0660")
parent = inspect(os.path.dirname(os.path.abspath(socket_path)), "Broker socket parent")
if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != broker_uid or parent.st_gid != peer_gid or stat.S_IMODE(parent.st_mode) != 0o2710:
    raise SystemExit("Broker socket parent must be broker-owned, peer-group-owned, and mode 02710")
token = inspect(token_path, "Peer client token")
if stat.S_ISLNK(token.st_mode) or not stat.S_ISREG(token.st_mode) or token.st_uid != os.getuid() or stat.S_IMODE(token.st_mode) != 0o600 or token.st_size < 32:
    raise SystemExit("Client token must be a separate peer-owned regular 0600 file of at least 32 bytes")

def private_root(path, expected_uid, expected_gid, name):
    if os.path.islink(path):
        raise SystemExit(f"{name} cannot be a symlink")
    value = inspect(path, name)
    if (not stat.S_ISDIR(value.st_mode) or value.st_uid != expected_uid
            or (expected_gid is not None and value.st_gid != expected_gid)
            or stat.S_IMODE(value.st_mode) != 0o700):
        raise SystemExit(f"{name} must be a real owner-only 0700 directory with the pinned UID/GID")
    return os.path.realpath(path)

stage = private_root(stage_root, broker_uid, None, "Broker stage root")
socket_parent = os.path.realpath(os.path.dirname(os.path.abspath(socket_path)))
if stage == socket_parent or stage.startswith(socket_parent + os.sep) or socket_parent.startswith(stage + os.sep):
    raise SystemExit("Broker stage root must be separate from the socket parent")

def shared_data_root(path, name):
    if os.path.islink(path):
        raise SystemExit(f"{name} cannot be a symlink")
    value = inspect(path, name)
    if (not stat.S_ISDIR(value.st_mode) or value.st_uid != worker_uid
            or value.st_gid != worker_gid or stat.S_IMODE(value.st_mode) != 0o2750):
        raise SystemExit(f"{name} must be worker-owned, shared-group-owned, and mode 02750")
    return os.path.realpath(path)

source = shared_data_root(source_root, "Worker source root")
output = shared_data_root(output_root, "Worker output root")
def overlaps(left, right):
    return left == right or left.startswith(right + os.sep) or right.startswith(left + os.sep)

if overlaps(source, output) or overlaps(source, stage) or overlaps(output, stage):
    raise SystemExit("Worker source/output roots and broker stage root must be disjoint")
PY
else
  echo "Unknown mode, use stub or real" >&2
  exit 2
fi

report="$root/modules/vision/vision-service/build/test-results/test/TEST-com.ghatana.audio.video.vision.video.HostOciVisionBrokerIntegrationTest.xml"
if [[ "$mode" == "broker" && ( -e "$report" || -L "$report" ) ]]; then rm -f -- "$report"; fi

./gradlew \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FOCUSED \
  -Pghatana.media.focusedModules=vision \
  :services:media:modules:vision:vision-service:test \
  --tests "$selection" \
  --rerun-tasks --no-daemon --no-parallel --max-workers=2 --console=plain

if [[ "$mode" == "broker" ]]; then
  python3 - "$report" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

report = Path(sys.argv[1])
if not report.is_file():
    raise SystemExit("Broker integration report is missing; no executed-test evidence")
root = ET.parse(report).getroot()
tests = int(root.attrib.get("tests", "0"))
skipped = int(root.attrib.get("skipped", "0"))
failures = int(root.attrib.get("failures", "0"))
errors = int(root.attrib.get("errors", "0"))
if tests <= 0 or skipped != 0 or failures != 0 or errors != 0:
    raise SystemExit(f"Broker integration selector did not execute cleanly: tests={tests} skipped={skipped} failures={failures} errors={errors}")
print(f"External broker integration selector executed {tests} tests with no skips/failures; host qualification remains separate.")
PY
else
  printf 'Executed dedicated OCI test JVM mode=%s (image SHA %s)\n' "$mode" "$image"
fi
