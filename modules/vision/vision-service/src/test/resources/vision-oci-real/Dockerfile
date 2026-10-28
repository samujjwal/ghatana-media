# Opt-in isolated Linux ARM64 FFmpeg development/qualification image ONLY.
# Context: verified output of scripts/prepare-wave2-codecs.sh linux-arm64.
# Its PROVISION.json pins the release archive, binary hashes and six native
# runtime dependency packages. No model, codec binary or package is committed.
FROM ubuntu:24.04@sha256:19cad59657037cffa0ac9a48107019b768900ff1071140965827513ac866bd5e

COPY native-runtime-packages/ /tmp/codec-runtime/
RUN cd /tmp/codec-runtime \
    && sha256sum -c SHA256SUMS \
    && dpkg -i ./*.deb \
    && cd / \
    && rm -rf /tmp/codec-runtime

COPY --chmod=0555 ffmpeg /usr/bin/ffmpeg
COPY --chmod=0555 ffprobe /usr/bin/ffprobe

# The host OCI supervisor chooses the exact binary entrypoint, immutable
# local sha256:image ID and strict sandbox. This image never runs privileged.
