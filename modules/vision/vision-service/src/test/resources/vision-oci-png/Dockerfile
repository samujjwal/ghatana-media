# Opt-in isolated Linux ARM64 PNG-capable FFmpeg qualification image ONLY.
# Context: verified output of a pinned FFmpeg-Builds LGPL static release with
# PROVISION.json pinning the archive, binary hashes and bundled license.
# Fully static binaries need no native runtime package closure; zlib is linked
# statically inside each executable. No model, codec binary or package is committed.
FROM ubuntu:24.04@sha256:19cad59657037cffa0ac9a48107019b768900ff1071140965827513ac866bd5e

COPY --chmod=0555 ffmpeg /usr/bin/ffmpeg
COPY --chmod=0555 ffprobe /usr/bin/ffprobe
COPY LICENSE.txt /opt/media-codec/LICENSE.txt

# The host OCI supervisor chooses the exact binary entrypoint, immutable
# local sha256:image ID and strict sandbox. This image never runs privileged.
