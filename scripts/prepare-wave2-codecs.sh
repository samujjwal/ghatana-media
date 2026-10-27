#!/usr/bin/env bash
# Opt-in source-pinned FFmpeg 8.1.2 test provisioning. Never runtime/release admission.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: prepare-wave2-codecs.sh mac-arm64|linux-arm64|linux-amd64 [output-root]' >&2; exit 2
fi
case "$1" in
  mac-arm64) triple=aarch64-apple-darwin; expected=ac0babf65798bf681da1dc81c4fe4ae049d0d26e161410174b0e120e3e783332 ;;
  linux-arm64) triple=aarch64-unknown-linux-gnu; expected=ead92446d2d51015500843fa70a3ead35391898fe9850b7471c042f11d533586 ;;
  linux-amd64) triple=x86_64-unknown-linux-gnu; expected=233ba61cec5c7056698c963b67b2a4a04f1bfe67783948eb9f68b2ec9b0e2199 ;;
  *) echo 'Unknown platform profile' >&2; exit 2 ;;
esac
for required in curl python3; do
  command -v "$required" >/dev/null || { echo "Missing $required" >&2; exit 3; }
done
root='/tmp/ghatana-media-codecs'
if [[ $# -eq 2 ]]; then root="$2"; fi
mkdir -p "$root"; root="$(cd "$root" && pwd -P)"
name="ffmpeg-8.1.2-$triple.tar.gz"
target="$root/v8.1.2-27-$triple"
if [[ -e "$target" ]]; then echo "Refusing to replace: $target" >&2; exit 4; fi
scratch="$(mktemp -d "$root/.codec-provision.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
url="https://github.com/serversideup/ffmpeg-lgpl-builds/releases/download/v8.1.2-27/$name"
curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
  --max-filesize 65000000 --silent --show-error "$url" -o "$scratch/$name"
python3 - "$scratch/$name" "$scratch" "$target" "$expected" "$name" "$url" <<'PY'
import hashlib, json, os, pathlib, shutil, sys, tarfile
archive, scratch, target, expected, name, url = sys.argv[1:]
archive = pathlib.Path(archive)
if not archive.is_file() or archive.stat().st_size > 65_000_000:
    raise SystemExit('Pinned archive missing or oversized')
def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()
if sha(archive) != expected: raise SystemExit('FAIL_CLOSED_ARCHIVE_SHA256_MISMATCH')
out=pathlib.Path(scratch)/'verified'
out.mkdir(mode=0o700)
files={}
with tarfile.open(archive,'r:gz') as tf:
    entries=tf.getmembers()
    if len(entries)>32: raise SystemExit('Too many archive entries')
    total=0
    for entry in entries:
        filename=entry.name[2:] if entry.name.startswith('./') else entry.name
        if entry.isdir() and filename in ('','.'): continue
        if filename in ('','.','..') or '/' in filename or '\\' in filename or not entry.isfile() or filename in files:
            raise SystemExit('Unsafe archive member')
        total+=entry.size
        if entry.size>100_000_000 or total>140_000_000: raise SystemExit('Oversized codec archive')
        source=tf.extractfile(entry)
        if source is None: raise SystemExit('Unreadable codec archive member')
        dest=out/filename
        with dest.open('xb') as sink:
            pending=entry.size
            while pending:
                blob=source.read(min(pending,1024*1024))
                if not blob: raise SystemExit('Truncated codec archive member')
                sink.write(blob); pending-=len(blob)
        files[filename]=dest
for item in ('ffmpeg','ffprobe','SOURCE.txt','COPYING.LGPLv2.1'):
    if item not in files: raise SystemExit('Missing expected release asset '+item)
for item in ('ffmpeg','ffprobe'): os.chmod(files[item],0o700)
binary={item:sha(files[item]) for item in ('ffmpeg','ffprobe')}
(out/'PROVISION.json').write_text(json.dumps(dict(
    schemaVersion='ghatana.media.test-codecs.v1',release='v8.1.2-27',
    source='serversideup/ffmpeg-lgpl-builds',archiveUrl=url,
    archiveSha256=expected,binarySha256=binary,
    disposition='DEVELOPMENT_TEST_ONLY_NOT_RUNTIME_OR_RELEASE'),indent=2)+'\n')
shutil.copyfile(archive,out/name)
os.replace(out,target)
print('Verified release digest '+expected)
print('Verified binary digests '+json.dumps(binary,sort_keys=True))
PY
printf 'GHATANA_MEDIA_FFMPEG=%s/ffmpeg\nGHATANA_MEDIA_FFPROBE=%s/ffprobe\nGHATANA_MEDIA_CODEC_ARCHIVE=%s/%s\nMEDIA_LINUX_CODECS_DIR=%s\n' "$target" "$target" "$target" "$name" "$target"
