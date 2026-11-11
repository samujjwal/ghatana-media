# Video restoration comparison

This local example creates deterministic pristine and noisy RGB frame sequences, applies one fixed `atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08:s=5` filter to the noisy sequence, encodes a filtered candidate and an unfiltered baseline with the pinned FFmpeg 8.1.2 MPEG-4 Part 2 encoder, then independently decodes both. This is a restrained fixed five-frame temporal window; it has temporal lookahead and is not a zero-latency operation. FFprobe verifies both files have exactly eight frames at 10 fps with PTS 0.0 through 0.7 seconds and that their observed PTS arrays match exactly. Before writing the manifest, the example reopens each published MP4, rechecks the frame clock, decodes the persisted RGB frames, computes PSNR from those decoded pixels, and records both the encoded-file SHA-256 and decoded-RGB SHA-256. If that published-output readback fails, files created by the run are removed. The reference remains the generated pristine pixels; no real-source quality claim is made.

Provision the source-pinned codec pair from the repository root:

```bash
codec_root="$(mktemp -d)"
bash scripts/prepare-wave2-codecs.sh mac-arm64 "$codec_root"
export GHATANA_MEDIA_FFMPEG="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffmpeg"
export GHATANA_MEDIA_FFPROBE="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffprobe"
node examples/video-restoration-comparison/compare.mjs build/video-restoration-comparison
node --test examples/video-restoration-comparison/compare.test.mjs
```

When the exact release archive is already cached locally, use this command in
place of the provisioning command above with a fresh output root. It avoids a
network fetch but keeps the same source-pinned digest verification:

```bash
GHATANA_MEDIA_CODEC_ARCHIVE_SOURCE=/path/to/ffmpeg-8.1.2-aarch64-apple-darwin.tar.gz \
  bash scripts/prepare-wave2-codecs.sh mac-arm64 "$codec_root"
```

The output directory must be empty. The script requires the pinned pair and the MPEG-4 encoder plus `atadenoise` filter. Results are labeled `SYNTHETIC_METRIC_ONLY`: generated pixels are not a lawful or representative reference, and PSNR here establishes no real restoration or perceptual quality, source rights, production codec qualification, canonical artifact, delivery receipt, or J-08 completion. Task status stays OPEN pending measured work against qualified authorized inputs.
