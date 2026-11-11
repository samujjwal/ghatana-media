# Local synthetic multitrack preview

This separate preview builds one short MP4 from four independently authored
synthetic layers: RGB video, an animated RGBA graphic overlaid onto that video,
mono PCM audio, and a WebVTT caption track. It uses the locally provisioned,
source-pinned FFmpeg/FFprobe 8.1.2 pair, confirms the encoded streams with
FFprobe, decodes video and audio, samples the decoded graphic pixels, and
decodes the caption back to WebVTT. It also reads all output-frame PTS values
and checks an unobscured decoded pixel against each versioned synthetic source
frame. The MP4 is capped at 2 MiB and the manifest at 16 KiB; each codec
invocation has a 15-second timeout.

Provision the pinned macOS ARM64 pair as described in the parent
[`recorder-mux-preview` README](../README.md), then run:

```bash
node examples/recorder-mux-preview/multitrack/preview.mjs build/media-recorder-multitrack-preview
```

The focused `node:test` selector checks the exact artifact/manifest digests and
readback contract, plus always-running missing-tool and no-overwrite negatives:

```bash
GHATANA_MEDIA_FFMPEG="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffmpeg" \
GHATANA_MEDIA_FFPROBE="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffprobe" \
  node --test examples/recorder-mux-preview/multitrack/preview.test.mjs
```

The shared transaction and base profile checks can be run with the same
source-pinned environment:

```bash
GHATANA_MEDIA_FFMPEG="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffmpeg" \
GHATANA_MEDIA_FFPROBE="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffprobe" \
  node --test examples/recorder-mux-preview/preview-output-transaction.test.mjs examples/recorder-mux-preview/preview.test.mjs examples/recorder-mux-preview/multitrack/preview.test.mjs
```

Only the pinned-codec case is skipped when either environment variable is
unset. The negative cases always run.

The generated `multitrack-preview-manifest.json` records four synthetic layer
identities, version labels, rational intervals, byte lengths and SHA-256
digests, exact encoded stream observations, decoded-readback observations,
and an output-frame-to-source-frame map. The map checks integer PTS ticks and
the decoded source pixel for each frame against its synthetic source frame;
the manifest also carries the output digest and output budget. The capability
and requested outcome IDs identify the development scope only; they do not
indicate canonical task completion.

The output directory is published as one complete bundle by the shared
`preview-output-transaction.mjs` helper. A same-destination process receives
`RENDER_IN_PROGRESS`. A hard process stop can leave a sidecar fence and
private staging directory; follow the recovery steps in the parent README
after verifying the recorded process is no longer running.

All input layers are synthetic and local-only. This output establishes no
source rights, capture authority, narration consent, real-project lineage,
production Studio integration, codec or perceptual quality qualification,
durable artifact registration, delivery, or task completion. The LGPL codec
build is an explicitly pinned development dependency, not a production codec
selection or distribution/legal approval.
