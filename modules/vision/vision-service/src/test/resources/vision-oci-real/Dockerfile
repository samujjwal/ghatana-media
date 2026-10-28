# Opt-in qualification image only. The build context contains independently
# SHA-256-qualified Linux ARM64 FFmpeg and FFprobe from the existing R7 codec
# provisioner. No binary is checked into Media or downloaded during build.
FROM ubuntu@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c

COPY --chmod=0555 ffmpeg /usr/bin/ffmpeg
COPY --chmod=0555 ffprobe /usr/bin/ffprobe

# The host OCI supervisor overrides the entrypoint and requires a local,
# separately pinned image ID at each execution. No network listener.
