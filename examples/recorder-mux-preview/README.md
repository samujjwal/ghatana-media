# Recorder mux preview

## Purpose and boundary

This Node ESM example is a local consumer for checking real decoder-playable
MP4 muxing. It generates its own RGB frames, PCM tone, and VTT cue, then uses
the pinned FFmpeg 8.1.2 software MPEG-4 Part 2 and AAC encoders plus
`mov_text`. FFprobe inspects the result; FFmpeg independently decodes video
and audio and reads the subtitle track back to WebVTT.

The intended consumers are developers validating local fixture mux output and
tests that exercise the example's manifest and bytes. The example does not
capture host media, request rights or consent, create approved narration,
select a production codec, upload, publish, or establish task completion. It
always labels its output `LOCAL_PREVIEW_ONLY`.

## Output transaction and duplicate-render fence

The positional output path may be new or an empty directory. Non-empty paths,
files, and symlinks are preserved and rejected. The example creates a sidecar
lock named `.<output-directory-name>.render-lock` in the output's parent using
exclusive creation. Another process targeting that path receives
`RENDER_IN_PROGRESS` before codec work starts. Each run writes its complete
media, caption, and manifest bundle to a private sibling staging directory;
only the finished bundle is promoted by one same-filesystem directory rename.
Ordinary tool, probe, readback, or manifest failures remove the stage and
release the lock. Any thrown producer value, including falsy non-`Error`
values, remains a failed render. If rollback cleanup also fails, the caller
receives both the primary failure and cleanup diagnostics. The MP4 is capped at
2 MiB and each FFmpeg/FFprobe invocation at 15 seconds.

A hard process termination can leave the lock and staging directory behind.
The lock file contains the destination, process ID, invocation ID, and start
time. The example deliberately does not break stale locks automatically. Check
that the recorded invocation is no longer running, then remove that exact lock
and its matching `.<output-directory-name>.stage-<invocation-id>-*` directory
before retrying. Do not remove the lock while a render may still be active.

Provision the source-pinned test codec pair from the repository root. The script verifies the FFmpeg 8.1.2 archive and writes it under a fresh temporary directory:

```bash
codec_root="$(mktemp -d)"
bash scripts/prepare-wave2-codecs.sh mac-arm64 "$codec_root"
export GHATANA_MEDIA_FFMPEG="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffmpeg"
export GHATANA_MEDIA_FFPROBE="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffprobe"
node examples/recorder-mux-preview/preview.mjs build/media-recorder-preview
```

When the exact release archive is already cached locally, use this command in
place of the provisioning command above with a fresh output root. It avoids a
network fetch but keeps the same source-pinned digest verification:

```bash
GHATANA_MEDIA_CODEC_ARCHIVE_SOURCE=/path/to/ffmpeg-8.1.2-aarch64-apple-darwin.tar.gz \
  bash scripts/prepare-wave2-codecs.sh mac-arm64 "$codec_root"
```

The example fails with `CODEC_UNAVAILABLE` if either tool is missing, has another version, or does not expose the required encoders. The local output is always labeled `LOCAL_PREVIEW_ONLY`; its generated fixtures establish neither lawful source rights nor real capture, narration consent, model quality, production codec qualification, a canonical artifact, a delivery receipt, or task completion.

With those environment variables set, run the focused integration check:

```bash
node --test examples/recorder-mux-preview/preview-output-transaction.test.mjs examples/recorder-mux-preview/preview.test.mjs examples/recorder-mux-preview/multitrack/preview.test.mjs
```

The provisioning script also supports its pinned Linux profiles; point both variables to the resulting `ffmpeg` and `ffprobe` binaries for that host.

## Architecture and verification

`preview-output-transaction.mjs` owns only local destination reservation and
atomic bundle publication. `preview.mjs` and `multitrack/preview.mjs` keep
their codec profiles, fixture generation, probing, and decode/readback
independent. Their tests cover rollback after staged writes, same-path
cross-process contention, a real renderer hard stop after staged output, a
retained stale fence after restart, existing-path preservation, actual MP4
stream/clock observations, independent decoding, and caption/source-time
readback. The hard-stop regression proves the lock and staged partial output
remain intact and a subsequent process is rejected without publishing or
cleaning them.

This surface has no separate build unit. Check Node syntax and run the focused
`node:test` command above with the pinned codec pair. The fixture tests expose
output SHA-256 and manifest hashes for reproducibility; these local results
are development evidence only and are not a repository lifecycle receipt.

## DEV_ONLY durable artifact journey

The integration check can carry the generated MP4 through the public headless SDK into the Media development host and prove exact artifact/job readback after the launcher restarts. It requires Docker/Testcontainers and the source-pinned codec pair prepared above:

```bash
pnpm --filter @audio-video/client build
GHATANA_MEDIA_FFMPEG="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffmpeg" \
GHATANA_MEDIA_FFPROBE="$codec_root/v8.1.2-27-aarch64-apple-darwin/ffprobe" \
  ./gradlew --no-daemon :services:media:integration-tests:test \
    --tests com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT.pinnedRecorderMuxPreviewUploadsThroughPublicSdkAndSurvivesHostRestart
```

The test verifies that the SDK upload matches the preview manifest digest and exact bytes in S3, that the artifact and diagnostic job remain readable after process restart, and that the job stays bound to the exact artifact and request. The focused integration class also retains the existing WAV upload/restart scenario. It is still a `LOCAL_PREVIEW_ONLY` synthetic frame/tone/caption fixture; the diagnostic provider reports `rawMediaRead=false`. This is not an authorized capture, narration, production codec profile, or completed recorder journey. The recorder-specific test is skipped when either codec variable is unset.
