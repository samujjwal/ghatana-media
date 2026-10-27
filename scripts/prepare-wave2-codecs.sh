#!/usr/bin/env bash
# Opt-in source-pinned FFmpeg 8.1.2 test provisioning. Never runtime/release admission.
set -euo pipefail

runtime_profile=''
runtime_arch=''
runtime_triplet=''
runtime_archive_root=''
runtime_sidecar_image=''
runtime_package_count=0
runtime_packages=()

select_runtime_packages() {
  case "$1" in
    linux-arm64)
      runtime_profile='ubuntu-24.04-noble'
      runtime_arch=arm64
      runtime_triplet=aarch64-linux-gnu
      runtime_archive_root='https://ports.ubuntu.com/ubuntu-ports'
      runtime_sidecar_image='ubuntu:24.04@sha256:19cad59657037cffa0ac9a48107019b768900ff1071140965827513ac866bd5e'
      runtime_package_count=6
      runtime_packages=(
        'libgnutls30t64|3.8.3-1.1ubuntu3.6|pool/main/g/gnutls28/libgnutls30t64_3.8.3-1.1ubuntu3.6_arm64.deb|18482c85067bcc8e2b3802d7c3bb87bd54acf4da228e760054e88ef1e125d80a'
        'libopenh264-7|2.4.1+dfsg-1|pool/universe/o/openh264/libopenh264-7_2.4.1+dfsg-1_arm64.deb|f52fec7317fedf0ce08ec7622ca62ce9ffa01aa76ca2f804e811d0b76b6f3941'
        'libhogweed6t64|3.9.1-2.2build1.1|pool/main/n/nettle/libhogweed6t64_3.9.1-2.2build1.1_arm64.deb|1c252dfe2c1e458c47c6e674285c043e7940555581574a96c49defae26126883'
        'libidn2-0|2.3.7-2build1.1|pool/main/libi/libidn2/libidn2-0_2.3.7-2build1.1_arm64.deb|5d21e1ff26d44b762efc8f94df2e1e1944c1d288a29059b3cf5e76e3bfdf2968'
        'libnettle8t64|3.9.1-2.2build1.1|pool/main/n/nettle/libnettle8t64_3.9.1-2.2build1.1_arm64.deb|c2943b87811fe1f35b7e67869810226652caf43a31bd32c8d3ce1b331700b008'
        'libunistring5|1.1-2build1.1|pool/main/libu/libunistring/libunistring5_1.1-2build1.1_arm64.deb|faa0cea6bf19c57cace839f7184c070f2f0f4efc41258b39625b0ed988f68100'
      )
      ;;
    linux-amd64)
      runtime_profile='ubuntu-24.04-noble'
      runtime_arch=amd64
      runtime_triplet=x86_64-linux-gnu
      runtime_archive_root='https://archive.ubuntu.com/ubuntu'
      runtime_sidecar_image='ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d'
      runtime_package_count=10
      runtime_packages=(
        'libgnutls30t64|3.8.3-1.1ubuntu3.6|pool/main/g/gnutls28/libgnutls30t64_3.8.3-1.1ubuntu3.6_amd64.deb|b8944756260c5ea6b7fac019745f931f905aa7a4df0763676b1b25c911b692e2'
        'libopenh264-7|2.4.1+dfsg-1|pool/universe/o/openh264/libopenh264-7_2.4.1+dfsg-1_amd64.deb|1042d48b6827906ae689ec18db944c689beca9eb563d23b4fa8f06ce80cb9a45'
        'libhogweed6t64|3.9.1-2.2build1.1|pool/main/n/nettle/libhogweed6t64_3.9.1-2.2build1.1_amd64.deb|a9b5f7e9d49ba9060e1c933567046fbc6feab6096799cbf550b7214dc9b0f49b'
        'libidn2-0|2.3.7-2build1.1|pool/main/libi/libidn2/libidn2-0_2.3.7-2build1.1_amd64.deb|46bfd10df095a23b65f58115de47a547c9a2d14627749bd0423ae78c14be77d3'
        'libnettle8t64|3.9.1-2.2build1.1|pool/main/n/nettle/libnettle8t64_3.9.1-2.2build1.1_amd64.deb|6d97fbc1972633083f08f51ccab433606c97bbceb897c631c66495117ca3406f'
        'libunistring5|1.1-2build1.1|pool/main/libu/libunistring/libunistring5_1.1-2build1.1_amd64.deb|203d7657b5f54633fba1a9c9b784d556ef83c9f6787b3185ba55a88e07b865a3'
        'libva2|2.20.0-2ubuntu0.2|pool/universe/libv/libva/libva2_2.20.0-2ubuntu0.2_amd64.deb|a8ff8d3d16dba715cd24d67c0f8787016194fcee0dee20344a92d057577c0b40'
        'libva-drm2|2.20.0-2ubuntu0.2|pool/universe/libv/libva/libva-drm2_2.20.0-2ubuntu0.2_amd64.deb|7919c889e0bc8221dcfb595bc0707959354a5404cc1d9b818f85fc43914ca0d4'
        'libdrm2|2.4.125-1ubuntu0.1~24.04.2|pool/main/libd/libdrm/libdrm2_2.4.125-1ubuntu0.1~24.04.2_amd64.deb|4d3e858dd57be617c49d87c5ddcdb35df744a4f0a559981256ae2ba174718584'
        'libdrm-common|2.4.125-1ubuntu0.1~24.04.2|pool/main/libd/libdrm/libdrm-common_2.4.125-1ubuntu0.1~24.04.2_all.deb|0b60996bc18fa1545e60a47bb0fe1a7f360ec06fe62ba35fb8d8ba2a54e62166'
      )
      ;;
    *) echo 'Unknown Linux runtime profile' >&2; exit 2 ;;
  esac
}

verify_runtime_packages() {
  local package_dir="$1"
  python3 - "$package_dir" "${runtime_packages[@]}" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
total_bytes = 0
for row in sys.argv[2:]:
    package, version, relative, expected = row.split('|')
    path = root / pathlib.Path(relative).name
    if not path.is_file():
        raise SystemExit('Missing pinned runtime package: ' + package + '=' + version)
    size = path.stat().st_size
    if size > 5_000_000:
        raise SystemExit('Pinned runtime package exceeds 5 MiB: ' + path.name)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        raise SystemExit('FAIL_CLOSED_RUNTIME_PACKAGE_SHA256_MISMATCH: ' + path.name)
    total_bytes += size
if total_bytes > 20_000_000:
    raise SystemExit('Pinned runtime package set exceeds 20 MiB')
PY
}

if [[ "${1:-}" == '--verify-runtime' ]]; then
  if [[ $# -ne 3 ]]; then echo 'Usage: prepare-wave2-codecs.sh --verify-runtime linux-arm64|linux-amd64 PACKAGE_DIR' >&2; exit 2; fi
  select_runtime_packages "$2"
  verify_runtime_packages "$3"
  printf '%s\t%s\t%s\n' "$runtime_profile" "$runtime_arch" "$runtime_sidecar_image"
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: prepare-wave2-codecs.sh mac-arm64|linux-arm64|linux-amd64 [output-root]' >&2; exit 2
fi
case "$1" in
  mac-arm64) triple=aarch64-apple-darwin; expected=ac0babf65798bf681da1dc81c4fe4ae049d0d26e161410174b0e120e3e783332 ;;
  linux-arm64) triple=aarch64-unknown-linux-gnu; expected=ead92446d2d51015500843fa70a3ead35391898fe9850b7471c042f11d533586 ;;
  linux-amd64) triple=x86_64-unknown-linux-gnu; expected=233ba61cec5c7056698c963b67b2a4a04f1bfe67783948eb9f68b2ec9b0e2199 ;;
  *) echo 'Unknown platform profile' >&2; exit 2 ;;
esac
if [[ "$1" == linux-* ]]; then select_runtime_packages "$1"; fi
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
package_manifest=''
curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
  --max-filesize 65000000 --silent --show-error "$url" -o "$scratch/$name"
if [[ "$1" == linux-* ]]; then
  mkdir -p "$scratch/runtime-packages"
  package_manifest="$scratch/runtime-packages/manifest.tsv"
  : > "$scratch/runtime-packages/manifest.tsv"
  : > "$scratch/runtime-packages/SHA256SUMS"
  for row in "${runtime_packages[@]}"; do
    IFS='|' read -r package version relative expected_sha <<< "$row"
    filename="${relative##*/}"
    curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 \
      --max-filesize 5000000 --silent --show-error \
      "$runtime_archive_root/$relative" -o "$scratch/runtime-packages/$filename"
    printf '%s\t%s\t%s\t%s\t%s\n' "$package" "$version" "$filename" "$expected_sha" "$relative" \
      >> "$scratch/runtime-packages/manifest.tsv"
    printf '%s  %s\n' "$expected_sha" "$filename" >> "$scratch/runtime-packages/SHA256SUMS"
  done
fi
python3 - "$scratch/$name" "$scratch" "$target" "$expected" "$name" "$url" \
  "$package_manifest" "$runtime_profile" "$runtime_arch" "$runtime_triplet" \
  "$runtime_sidecar_image" "$runtime_package_count" <<'PY'
import hashlib, json, os, pathlib, shutil, sys, tarfile
archive, scratch, target, expected, name, url, package_manifest, runtime_profile, runtime_arch, runtime_triplet, runtime_sidecar_image, expected_package_count = sys.argv[1:]
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
runtime_packages=[]
if package_manifest:
    manifest=pathlib.Path(package_manifest)
    runtime_source=manifest.parent
    runtime_bytes=0
    for line in manifest.read_text().splitlines():
        package, version, filename, expected_sha, relative = line.split('\t')
        package_path=runtime_source/filename
        if not package_path.is_file() or sha(package_path) != expected_sha:
            raise SystemExit('FAIL_CLOSED_RUNTIME_PACKAGE_SHA256_MISMATCH: '+filename)
        runtime_bytes += package_path.stat().st_size
        runtime_packages.append(dict(package=package,version=version,filename=filename,
                                     sha256=expected_sha,archivePath=relative))
    expected_count = int(expected_package_count)
    if len(runtime_packages) != expected_count:
        raise SystemExit('Expected the complete '+str(expected_count)+'-package native runtime dependency closure')
    if runtime_bytes > 20_000_000:
        raise SystemExit('Pinned runtime package set exceeds 20 MiB')
    (out/'native-runtime-packages').mkdir()
    for item in runtime_packages:
        shutil.copyfile(runtime_source/item['filename'], out/'native-runtime-packages'/item['filename'])
    shutil.copyfile(runtime_source/'SHA256SUMS', out/'native-runtime-packages'/'SHA256SUMS')
    (out/'native-runtime-packages'/'manifest.tsv').write_text(manifest.read_text())
(out/'PROVISION.json').write_text(json.dumps(dict(
    schemaVersion='ghatana.media.test-codecs.v1',release='v8.1.2-27',
    source='serversideup/ffmpeg-lgpl-builds',archiveUrl=url,
    archiveSha256=expected,binarySha256=binary,
    nativeRuntime=(dict(profile=runtime_profile,architecture=runtime_arch,
                        triplet=runtime_triplet,sidecarImage=runtime_sidecar_image,
                        packages=runtime_packages) if runtime_packages else None),
    disposition='DEVELOPMENT_TEST_ONLY_NOT_RUNTIME_OR_RELEASE'),indent=2)+'\n')
shutil.copyfile(archive,out/name)
os.replace(out,target)
print('Verified release digest '+expected)
print('Verified binary digests '+json.dumps(binary,sort_keys=True))
PY
printf 'GHATANA_MEDIA_FFMPEG=%s/ffmpeg\nGHATANA_MEDIA_FFPROBE=%s/ffprobe\nGHATANA_MEDIA_CODEC_ARCHIVE=%s/%s\nMEDIA_LINUX_CODECS_DIR=%s\n' "$target" "$target" "$target" "$name" "$target"
