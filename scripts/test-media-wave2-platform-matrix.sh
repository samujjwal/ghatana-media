#!/usr/bin/env bash
# Ghatana Media Wave 2 portable source-test entrypoint.
# Run on macOS with JDK 27 and Docker Desktop. Windows is intentionally outside this matrix.
# Linux runs from clean, separately archived Media/Shared source checkouts to avoid
# cross-OS Gradle output reuse. The native lane requires externally qualified codecs.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: test-media-wave2-platform-matrix.sh MODE
  mac-core           macOS JVM core suite (host)
  mac-integration    macOS launcher/PostgreSQL/Media integration suite (host; requires Docker)
  mac-native         macOS pinned FFmpeg/FFprobe native Vision suite (host)
  linux-arm64-core   Linux ARM64 JVM core suite (Docker on Mac)
  linux-arm64-native Linux ARM64 pinned FFmpeg native Vision suite (Docker on Mac)
  linux-amd64-core   Linux AMD64 JVM core suite (emulated on Apple Silicon; functional only)
  linux-amd64-native Linux AMD64 Vision suite (emulated; functional only)

Required: Git checkout of ghatana-media and sibling ghatana-shared, JDK 27 for macOS,
          Docker Desktop for Linux lanes. Run from any directory.

Environment:
  MEDIA_MATRIX_IMAGE          Linux Java image. Default: eclipse-temurin:27-jdk.
                              For qualification, set an immutable @sha256 digest.
  MEDIA_MATRIX_MEMORY         Docker memory cap, default 8g.
  MEDIA_MATRIX_CPUS           Docker CPU cap, default 4.
  MEDIA_MATRIX_PIDS           Docker PID cap, default 512.
  MEDIA_MATRIX_GRADLE_CACHE  Optional persistent host directory for the Linux Gradle user cache.
                              Defaults to a report-directory cache isolated by Linux architecture.
  MEDIA_LINUX_CODECS_DIR     Host directory with platform-correct ffmpeg and ffprobe
                              binaries, required for Linux native lanes.
  GHATANA_MEDIA_FFMPEG        Mac ffmpeg binary, required for mac-native.
  GHATANA_MEDIA_FFPROBE       Mac ffprobe binary, required for mac-native.
  MEDIA_MATRIX_REPORT_DIR    Output summary folder; default under /tmp.
  MEDIA_MATRIX_KEEP_SCRATCH  Set to 1 to retain Linux source-test scratch after run.

All modes retain the exact 58 Wave 2 task inventory. Test pass is not provider,
rights, model, corpus, performance, release, or PDP acceptance. A skipped native
or Compose test must not be counted as verified for its platform.
USAGE
}

MODE="${1:-}"
case "$MODE" in
  mac-core|mac-integration|mac-native|linux-arm64-core|linux-arm64-native|linux-amd64-core|linux-amd64-native) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

has() { command -v "$1" >/dev/null 2>&1; }
for tool in git tar; do
  if ! has "$tool"; then printf 'Missing required command: %s\n' "$tool" >&2; exit 3; fi
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# When copied as a standalone artifact instead of checked into scripts/, use cwd.
if [[ ! -e "$ROOT/settings.gradle.kts" ]]; then
  ROOT="$(pwd -P)"
fi
if [[ ! -e "$ROOT/settings.gradle.kts" ]] || [[ ! -e "$ROOT/gradlew" ]]; then
  echo 'Run inside the ghatana-media checkout, or install this script at scripts/.' >&2; exit 3
fi
SHARED="$(cd "$ROOT/../ghatana-shared" && pwd -P)" || {
  echo 'Missing sibling ghatana-shared checkout' >&2; exit 3;
}

REPORT_DIR="${MEDIA_MATRIX_REPORT_DIR:-${TMPDIR:-/tmp}/ghatana-media-wave2-platform-results}"
mkdir -p "$REPORT_DIR"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd -P)"
START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
PROFILE_ARTIFACT_NAME="${MODE}-${RUN_ID}.resource-profile.tsv"
PROFILE_ARTIFACT="$REPORT_DIR/$PROFILE_ARTIFACT_NAME"
MEDIA_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHARED_SHA="$(git -C "$SHARED" rev-parse HEAD)"

print_baseline() {
  printf 'WAVE2_OS_MATRIX mode=%s started=%s media=%s shared=%s\n' \
    "$MODE" "$START_UTC" "$MEDIA_SHA" "$SHARED_SHA"
}

core_args=(
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE
  -Pghatana.media.compositeScope=FOCUSED
  -Pghatana.media.focusedModules=stt,tts,vision,multimodal,observability
  :verifyMediaJavaTargetAlignment
  :services:media:libs:java:common:test
  :services:media:modules:speech:stt-service:test
  :services:media:modules:speech:tts-service:test
  :services:media:modules:vision:vision-service:test
  :services:media:modules:intelligence:multimodal-service:test
  :services:media:audio-video-observability:test
  --no-daemon --no-parallel --max-workers=2 --console=plain
)
native_args=(
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE
  -Pghatana.media.compositeScope=FOCUSED
  -Pghatana.media.focusedModules=vision
  :services:media:modules:vision:vision-service:test
  --tests '*VisionNativeBoundedIT'
  --tests 'com.ghatana.audio.video.vision.video.VideoFrameExtractorProcessTest'
  --no-daemon --no-parallel --max-workers=2 --console=plain
)
integration_args=(
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE
  -Pghatana.media.compositeScope=FOCUSED
  -Pghatana.media.focusedModules=runtime-integration
  :verifyMediaJavaTargetAlignment
  :services:media:integration-tests:test
  :services:media:launcher:test
  :services:media:providers:aws-postgresql:test
  --no-daemon --no-parallel --max-workers=2 --console=plain
)

summarize_reports() {
  if ! has python3; then
    echo 'python3 is required to emit an auditable test-result summary.' >&2
    return 5
  fi
  python3 - "$1" "$2" "$MODE" "$MEDIA_SHA" "$SHARED_SHA" "$START_UTC" \
    "$TEST_PROJECTS" "$HOST_OS" "$HOST_ARCH" "$EXECUTION_OS" "$EXECUTION_ARCH" \
    "$JAVA_VERSION" "$IMAGE_REF" "$IMAGE_DIGEST" "$MEMORY" "$CPUS" "$PIDS" \
    "$FFMPEG_PATH" "$FFPROBE_PATH" "$MEDIA_CLEAN" "$SHARED_CLEAN" "$RUN_LOG" "$PROFILE_ARTIFACT" "$RUN_STATUS" "$CODEC_ARCHIVE_PATH" <<'PY'
import hashlib, json, pathlib, re, sys, xml.etree.ElementTree as ET
(source, output, mode, media_sha, shared_sha, start_utc, test_projects,
 host_os, host_arch, execution_os, execution_arch, java_version, image_ref,
 image_digest, memory, cpus, pids, ffmpeg_path, ffprobe_path,
 media_clean, shared_clean, run_log, profile_artifact, run_status, codec_archive_path) = sys.argv[1:]
root = pathlib.Path(source)
planned_projects = list(filter(None, test_projects.split(',')))
log_file = pathlib.Path(run_log)
log_text = log_file.read_text(errors='replace') if log_file.is_file() else ''
failed_gradle_tasks = []
for line in log_text.splitlines():
    match = re.match(r'^> Task (:\S+) FAILED\s*$', line)
    if match and match.group(1) not in failed_gradle_tasks:
        failed_gradle_tasks.append(match.group(1))
what_went_wrong = []
in_failure = False
for line in log_text.splitlines():
    if line.strip() == '* What went wrong:':
        in_failure = True
        continue
    if in_failure and (line.strip() == '* Try:' or line.startswith('BUILD FAILED')):
        break
    if in_failure and line.strip():
        what_went_wrong.append(line.strip())
gradle_failure = None
if run_status != '0':
    gradle_failure = dict(
        summary=' '.join(what_went_wrong)[:1200] or 'Gradle exited non-zero; see bounded failedTasks and gradleLog.',
        failedTasks=failed_gradle_tasks[:50],
        diagnosticKind='GRADLE_EXECUTION_FAILURE_NOT_TEST_RESULT')
executed_tasks = {}
for project in planned_projects:
    task_path = ':services:media:' + project.replace('/', ':') + ':test'
    for line in log_text.splitlines():
        match = re.match(r'^> Task ' + re.escape(task_path) + r'(?:\s+(.*))?$', line)
        if match:
            executed_tasks[project] = (match.group(1) or 'EXECUTED').strip()
counts = dict(tests=0, failures=0, errors=0, skipped=0, suiteFiles=0)
failures = []
skips = []
for project in executed_tasks:
  test_results = root / project / 'build/test-results/test'
  for path in test_results.glob('TEST-*.xml'):
    try:
        xml = ET.parse(path).getroot()
        if xml.tag != 'testsuite':
            continue
        for key in ('tests','failures','errors','skipped'):
            counts[key] += int(xml.attrib.get(key, 0))
        counts['suiteFiles'] += 1
        for case in xml.iter('testcase'):
            name = (case.attrib.get('classname') or '')+'.'+(case.attrib.get('name') or '')
            if case.find('failure') is not None or case.find('error') is not None:
                failures.append(name)
            skipped = case.find('skipped')
            if skipped is not None:
                skips.append(dict(test=name, reason=(skipped.attrib.get('message') or '')[:300]))
    except (OSError, ET.ParseError, ValueError) as ex:
        failures.append('INVALID_XML:'+str(path)+':'+str(ex))
def digest(path):
    if not path:
        return None
    p = pathlib.Path(path)
    if not p.is_file():
        return None
    h = hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
result = dict(mode=mode, startUTC=start_utc,
              source=dict(mediaCommit=media_sha, sharedCommit=shared_sha,
                          mediaWorkingTreeClean=media_clean == 'true',
                          sharedWorkingTreeClean=shared_clean == 'true'),
              environment=dict(hostOS=host_os, hostArchitecture=host_arch,
                               executionOS=execution_os, executionArchitecture=execution_arch,
                               javaVersion=java_version, dockerImage=image_ref or None,
                               dockerImageDigest=image_digest or None,
                               dockerLimits=dict(memory=memory or None, cpus=cpus or None, pids=pids or None),
                               ffmpegSha256=digest(ffmpeg_path), ffprobeSha256=digest(ffprobe_path),
                               codecSourceArchiveSha256=digest(codec_archive_path)),
              plannedTestProjects=planned_projects,
              executedTestProjects=executed_tasks,
              gradleFailure=gradle_failure,
              gradleLog=run_log,
              resourceProfileArtifact=profile_artifact if pathlib.Path(profile_artifact).is_file() else None,
              counts=counts, failedTestNames=failures, skippedTests=skips,
              nativeOptInRequired=mode.endswith('-native'),
              nativeLaneNoSkipRequired=mode.endswith('-native'),
              claim='EXECUTION_ONLY_NOT_TASK_ACCEPTANCE')
out = pathlib.Path(output); out.write_text(json.dumps(result, indent=2)+'\n')
print('WAVE2_RESULT_REPORT '+str(out)); print('WAVE2_JUNIT_COUNTS '+json.dumps(counts))
if skips:
    print('WAVE2_UNVERIFIED_SKIPS '+str(len(skips))+' (inspect skippedTests in JSON)')
if failures or counts['suiteFiles'] == 0 or (mode.endswith('-native') and skips):
    raise SystemExit('Invalid/failing/missing test report: '+str(len(failures))+' failures, '+str(counts['suiteFiles'])+' XML files')
PY
}

print_baseline
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
MEDIA_CLEAN=true
SHARED_CLEAN=true
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || MEDIA_CLEAN=false
[[ -z "$(git -C "$SHARED" status --porcelain)" ]] || SHARED_CLEAN=false
FFMPEG_PATH="${GHATANA_MEDIA_FFMPEG:-}"
FFPROBE_PATH="${GHATANA_MEDIA_FFPROBE:-}"
CODEC_ARCHIVE_PATH="${GHATANA_MEDIA_CODEC_ARCHIVE:-}"
IMAGE_REF=""
IMAGE_DIGEST=""
MEMORY=""
CPUS=""
PIDS=""
if [[ "$MODE" == mac-core ]]; then
  TEST_PROJECTS="libs/java/common,modules/speech/stt-service,modules/speech/tts-service,modules/vision/vision-service,modules/intelligence/multimodal-service,audio-video-observability"
elif [[ "$MODE" == mac-integration ]]; then
  TEST_PROJECTS="integration-tests,launcher,providers/aws-postgresql"
else
  TEST_PROJECTS="modules/vision/vision-service"
fi
if [[ "$MODE" == mac-* ]]; then
  case "$(uname -s)" in
    Darwin) ;;
    *) echo 'mac-* modes must run natively on macOS; this process is not macOS.' >&2; exit 4 ;;
  esac
  if ! has java; then echo 'JDK 27 Java not found' >&2; exit 4; fi
  JAVA_VERSION="$(java -version 2>&1 | sed -n '1p')"
  printf '%s\n' "$JAVA_VERSION"
  if ! grep -Eq '(version "27|openjdk 27| 27[.])' <<<"$JAVA_VERSION"; then
    echo 'JDK 27 is required for this matrix; configure JAVA_HOME/PATH.' >&2; exit 4
  fi
  EXECUTION_OS="$HOST_OS"
  EXECUTION_ARCH="$HOST_ARCH"
  RUN_LOG="$REPORT_DIR/$MODE.gradle.log"
  RUN_STATUS=0
  if [[ "$MODE" == mac-core ]]; then
    export MEDIA_RESOURCE_PROFILE_OUTPUT="$PROFILE_ARTIFACT"
  fi
  if [[ "$MODE" == mac-native ]]; then
    : "${GHATANA_MEDIA_FFMPEG:?Set GHATANA_MEDIA_FFMPEG to a pinned executable}"
    : "${GHATANA_MEDIA_FFPROBE:?Set GHATANA_MEDIA_FFPROBE to a pinned executable}"
    [[ -x "$GHATANA_MEDIA_FFMPEG" && -x "$GHATANA_MEDIA_FFPROBE" ]] || { echo 'Missing executable FFmpeg/FFprobe' >&2; exit 4; }
    export PATH="$(dirname "$GHATANA_MEDIA_FFMPEG"):$(dirname "$GHATANA_MEDIA_FFPROBE"):$PATH" GHATANA_MEDIA_NATIVE_VISION_REQUIRED=true
    set +e
    (cd "$ROOT" && ./gradlew "${native_args[@]}") 2>&1 | tee "$RUN_LOG"
    RUN_STATUS=${PIPESTATUS[0]}
    set -e
  elif [[ "$MODE" == mac-integration ]]; then
    set +e
    (cd "$ROOT" && ./gradlew "${integration_args[@]}") 2>&1 | tee "$RUN_LOG"
    RUN_STATUS=${PIPESTATUS[0]}
    set -e
  else
    set +e
    (cd "$ROOT" && ./gradlew "${core_args[@]}") 2>&1 | tee "$RUN_LOG"
    RUN_STATUS=${PIPESTATUS[0]}
    set -e
  fi
  REPORT_STATUS=0
  if summarize_reports "$ROOT" "$REPORT_DIR/$MODE.json"; then :; else REPORT_STATUS=$?; fi
  if [[ "$RUN_STATUS" -ne 0 || "$REPORT_STATUS" -ne 0 ]]; then
    echo "Wave 2 lane failed: gradle=$RUN_STATUS summary=$REPORT_STATUS" >&2
    exit 1
  fi
  exit 0
fi

# Linux Docker test lanes. Only committed source is copied into an isolated
# directory; preexisting macOS compilation outputs/caches are not shared.
if ! has docker; then echo 'Docker Desktop is required for Linux-on-Mac lanes' >&2; exit 4; fi
if [[ "$MEDIA_CLEAN" != true || "$SHARED_CLEAN" != true ]]; then
  echo 'Linux lanes require clean Media and Shared worktrees because only committed HEAD is archived.' >&2
  echo "Media clean=$MEDIA_CLEAN Shared clean=$SHARED_CLEAN" >&2
  exit 4
fi
IMAGE="${MEDIA_MATRIX_IMAGE:-eclipse-temurin:27-jdk}"
MEMORY="${MEDIA_MATRIX_MEMORY:-8g}"
CPUS="${MEDIA_MATRIX_CPUS:-4}"
PIDS="${MEDIA_MATRIX_PIDS:-512}"
IMAGE_REF="$IMAGE"
case "$MODE" in
  linux-arm64-*) PLATFORM=linux/arm64 ;;
  linux-amd64-*) PLATFORM=linux/amd64 ;;
esac
if [[ "$MODE" == *-native ]]; then
  : "${MEDIA_LINUX_CODECS_DIR:?Set MEDIA_LINUX_CODECS_DIR to the platform-specific pinned Linux FFmpeg/FFprobe folder}"
  [[ -x "$MEDIA_LINUX_CODECS_DIR/ffmpeg" && -x "$MEDIA_LINUX_CODECS_DIR/ffprobe" ]] || {
    echo 'Pinned Linux ffmpeg and ffprobe executables are missing.' >&2; exit 4;
  }
  CODECS="$(cd "$MEDIA_LINUX_CODECS_DIR" && pwd -P)"
  FFMPEG_PATH="$CODECS/ffmpeg"
  FFPROBE_PATH="$CODECS/ffprobe"
  # Optional extra provenance: source-pinned LGPL archive distributed by
  # scripts/prepare-wave2-codecs.sh. The Java native test checks the fixed
  # release archive hash AND that both executing files match archive members.
  CODEC_ARCHIVE_NAME=''
  case "$PLATFORM" in
    linux/arm64) candidate='ffmpeg-8.1.2-aarch64-unknown-linux-gnu.tar.gz' ;;
    linux/amd64) candidate='ffmpeg-8.1.2-x86_64-unknown-linux-gnu.tar.gz' ;;
  esac
  if [[ -f "$CODECS/$candidate" ]]; then
    CODEC_ARCHIVE_NAME="$candidate"
    CODEC_ARCHIVE_PATH="$CODECS/$candidate"
  fi
fi
if [[ "$MODE" == *-core ]]; then
  TEST_PROJECTS="libs/java/common,modules/speech/stt-service,modules/speech/tts-service,modules/vision/vision-service,modules/intelligence/multimodal-service,audio-video-observability"
else
  TEST_PROJECTS="modules/vision/vision-service"
fi
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ghatana-media-matrix.XXXXXXXX")"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
GRADLE_CACHE="${MEDIA_MATRIX_GRADLE_CACHE:-$REPORT_DIR/gradle-home-${PLATFORM#linux/}}"
mkdir -p "$GRADLE_CACHE"
cleanup() {
  if [[ "${MEDIA_MATRIX_KEEP_SCRATCH:-0}" != 1 ]]; then rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT
mkdir -p "$SCRATCH/Development/ghatana-media" "$SCRATCH/Development/ghatana-shared"
git -C "$ROOT" archive HEAD | tar -xf - -C "$SCRATCH/Development/ghatana-media"
git -C "$SHARED" archive HEAD | tar -xf - -C "$SCRATCH/Development/ghatana-shared"

# Image must support Linux AMD64 and ARM64. Use a reviewed immutable digest for qualification.
docker pull --platform "$PLATFORM" "$IMAGE"
IMAGE_DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)"
printf 'WAVE2_LINUX_IMAGE platform=%s selected=%s inspected=%s\n' "$PLATFORM" "$IMAGE" "$IMAGE_DIGEST"
if [[ "$IMAGE" != *@sha256:* ]]; then
  echo 'WARNING: unpinned image is a smoke/compatibility run, not fully pinned qualification.' >&2
fi
if [[ "$PLATFORM" == linux/amd64 ]]; then
  echo 'NOTE: Linux AMD64 on Apple Silicon may be emulated; do not use these timings for performance qualification.' >&2
fi
EXECUTION_OS=Linux
EXECUTION_ARCH="${PLATFORM#linux/}"
JAVA_VERSION="$(docker run --rm --platform "$PLATFORM" "$IMAGE" java -version 2>&1 | sed -n '1p')"
printf 'WAVE2_LINUX_JAVA %s\n' "$JAVA_VERSION"
if ! grep -Eq '(version "27|openjdk 27| 27[.])' <<<"$JAVA_VERSION"; then
  echo 'Selected container image does not run JDK 27.' >&2; exit 4
fi

DOCKER_ARGS=(
  run --rm --init --platform "$PLATFORM"
  --memory "$MEMORY" --cpus "$CPUS" --pids-limit "$PIDS"
  --user "$(id -u):$(id -g)"
  # OpenCV's pinned JNI library is extracted under java.io.tmpdir and must be mmap'd
  # executable by the Linux JVM. Keep that extraction inside the capped test container.
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=1g
  --volume "$SCRATCH:/work:rw"
  --volume "$GRADLE_CACHE:/gradle-home:rw"
  # Keep Media two directories below the writable mount. The standalone Gradle
  # build assigns its synthetic :services parent to rootDir.parentFile.parentFile.
  --workdir /work/Development/ghatana-media
  --env HOME=/work --env GRADLE_USER_HOME=/gradle-home
)
if [[ "$MODE" == linux-arm64-core || "$MODE" == linux-amd64-core ]]; then
  DOCKER_ARGS+=(--env "MEDIA_RESOURCE_PROFILE_OUTPUT=/work/Development/ghatana-media/$PROFILE_ARTIFACT_NAME")
fi
if [[ "$MODE" == *-native ]]; then
  DOCKER_ARGS+=(
    --volume "$CODECS:/opt/media-codecs:ro"
    --env GHATANA_MEDIA_FFMPEG=/opt/media-codecs/ffmpeg
    --env GHATANA_MEDIA_FFPROBE=/opt/media-codecs/ffprobe
    --env GHATANA_MEDIA_NATIVE_VISION_REQUIRED=true
    --env PATH=/opt/media-codecs:/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
  )
  if [[ -n "$CODEC_ARCHIVE_NAME" ]]; then
    DOCKER_ARGS+=(--env "GHATANA_MEDIA_CODEC_ARCHIVE=/opt/media-codecs/$CODEC_ARCHIVE_NAME")
  fi
  TASKS=("${native_args[@]}")
else
  TASKS=("${core_args[@]}")
fi

RUN_LOG="$REPORT_DIR/$MODE.gradle.log"
RUN_STATUS=0
set +e
docker "${DOCKER_ARGS[@]}" "$IMAGE" sh -c '
set -eu
native_tools_dir=/gradle-home/caches/modules-2/files-2.1
if [ -d "$native_tools_dir" ]; then
  # macOS Docker bind mounts can lose executable bits from Linux Gradle tool artifacts.
  find "$native_tools_dir" -type f -name "*-linux-*.exe" -exec chmod u+x {} +
fi
if ./gradlew "$@" >/tmp/media-wave2-gradle-first-attempt.log 2>&1; then
  cat /tmp/media-wave2-gradle-first-attempt.log
  exit 0
else
  first_status=$?
  cat /tmp/media-wave2-gradle-first-attempt.log
fi
if { grep -Fq "Exec failed, error: 13 (Permission denied)" /tmp/media-wave2-gradle-first-attempt.log \
     || grep -Fq "program not found or is not executable" /tmp/media-wave2-gradle-first-attempt.log; } \
    && grep -Eq "/gradle-home/.*/[^/]*-linux-[^/]*\\.exe" /tmp/media-wave2-gradle-first-attempt.log; then
  echo "Retrying once after correcting executable bits for cached Linux Gradle tools."
  find /gradle-home/caches/modules-2/files-2.1 -type f -name "*-linux-*.exe" -exec chmod u+x {} +
  exec ./gradlew "$@"
fi
exit "$first_status"
' sh "${TASKS[@]}" 2>&1 | tee "$RUN_LOG"
RUN_STATUS=${PIPESTATUS[0]}
set -e
if [[ -f "$SCRATCH/Development/ghatana-media/$PROFILE_ARTIFACT_NAME" ]]; then
  cp "$SCRATCH/Development/ghatana-media/$PROFILE_ARTIFACT_NAME" "$PROFILE_ARTIFACT"
fi
REPORT_STATUS=0
if summarize_reports "$SCRATCH/Development/ghatana-media" "$REPORT_DIR/$MODE.json"; then :; else REPORT_STATUS=$?; fi
if [[ "$RUN_STATUS" -ne 0 || "$REPORT_STATUS" -ne 0 ]]; then
  echo "Wave 2 lane failed: docker/gradle=$RUN_STATUS summary=$REPORT_STATUS" >&2
  exit 1
fi
