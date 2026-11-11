import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSourceVideoReadback } from "./preview.mjs";

const script = fileURLToPath(new URL("./preview.mjs", import.meta.url));
const ffmpeg = process.env.GHATANA_MEDIA_FFMPEG;
const ffprobe = process.env.GHATANA_MEDIA_FFPROBE;
const pinnedPairConfigured = Boolean(ffmpeg && ffprobe);
const OUTPUT_SHA256 = "79b58fff905c943b39181b6cf868a29e7c172b76c17f35bfd9f383470bab9ac9";

async function tempDir() {
  return mkdtemp(join(os.tmpdir(), "media-multitrack-preview-test-"));
}

function runPreview(outputDir, env = {}) {
  return spawnSync(process.execPath, [script, outputDir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedSourceTime(frameIndex) {
  let a = frameIndex;
  let b = 30;
  while (b !== 0) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${frameIndex / divisor}/${30 / divisor}`;
}

test("source-time readback binds every output PTS and decoded pixel to the exact fixture frame", () => {
  const width = 64;
  const height = 64;
  const frameCount = 30;
  const decoded = Buffer.alloc(width * height * 3 * frameCount);
  const frameBytes = width * height * 3;
  const x = 5;
  const y = 50;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * frameBytes + (y * width + x) * 3;
    decoded[offset] = 22 + ((x + frame) % 16);
    decoded[offset + 1] = 46 + ((y * 2) % 18);
    decoded[offset + 2] = 94 + ((x + y + frame) % 24);
  }
  const timestamps = Array.from({ length: frameCount }, (_, frame) => ({ best_effort_timestamp: String(frame * 512) }));

  const mappings = assertSourceVideoReadback(decoded, timestamps, "1/15360");
  assert.equal(mappings.length, frameCount);
  assert.deepEqual(mappings[15], {
    outputFrameIndex: 15,
    outputPtsTicks: 7_680,
    sourceLayerId: "video-layer-1",
    sourceVersionRef: "synthetic:video:v1",
    sourceFrameIndex: 15,
    sourceTime: "1/2",
  });
  assert.throws(
    () => assertSourceVideoReadback(decoded, timestamps.map((stamp, frame) => frame === 7 ? { ...stamp, best_effort_timestamp: "4000" } : stamp), "1/15360"),
    /PTS/u,
  );
  for (const missingPts of [undefined, null, "", "00", "0x0", false]) {
    const firstFrame = missingPts === undefined ? {} : { best_effort_timestamp: missingPts };
    assert.throws(
      () => assertSourceVideoReadback(decoded, [firstFrame, ...timestamps.slice(1)], "1/15360"),
      /no canonical non-negative integer PTS/u,
      `frame zero must reject ${String(missingPts)} rather than coerce it to PTS zero`,
    );
  }
  assert.throws(
    () => assertSourceVideoReadback(decoded.subarray(0, decoded.length - 1), timestamps, "1/15360"),
    /decoded video had/u,
  );
  const wrongPixel = Buffer.from(decoded);
  wrongPixel[(15 * frameBytes) + (y * width + x) * 3] = 255;
  assert.throws(
    () => assertSourceVideoReadback(wrongPixel, timestamps, "1/15360"),
    /did not match its versioned source pixel/u,
  );
});

test("pinned FFmpeg composes all four synthetic layers into the exact bounded MP4 and manifest", {
  skip: !pinnedPairConfigured,
}, async () => {
  const parent = await tempDir();
  const outputDir = join(parent, "output");
  try {
    const result = runPreview(outputDir, {
      GHATANA_MEDIA_FFMPEG: ffmpeg,
      GHATANA_MEDIA_FFPROBE: ffprobe,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`LOCAL_PREVIEW_ONLY .*sha256=${OUTPUT_SHA256}`, "u"));
    assert.equal(result.stderr, "");
    assert.deepEqual((await readdir(outputDir)).sort(), [
      "local-multitrack-preview.mp4",
      "multitrack-preview-manifest.json",
    ]);

    const outputBytes = await readFile(join(outputDir, "local-multitrack-preview.mp4"));
    assert.equal(outputBytes.length, 18_617);
    assert.equal(sha256(outputBytes), OUTPUT_SHA256);
    assert.equal(outputBytes.toString("ascii", 4, 8), "ftyp");

    const manifestBytes = await readFile(join(outputDir, "multitrack-preview-manifest.json"));
    assert.ok(manifestBytes.length <= 16 * 1024);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const expected = {
      kind: "LOCAL_PREVIEW_ONLY",
      capabilityId: "media.dev.multitrack-composition-render",
      requestedOutcomeId: "media.dev.outcome-multitrack-finished-master",
      profile: "local-multitrack-overlay-mpeg4-aac-mov_text.v1",
      composition: {
        duration: "1/1",
        frameRate: "30/1",
        frameCount: 30,
        outputBudgetBytes: 2_097_152,
        manifestBudgetBytes: 16_384,
        layers: [
          { id: "video-layer-1", modality: "VIDEO", versionRef: "synthetic:video:v1", start: "0/1", end: "1/1", byteLength: 368_640, sha256: "0709c856685cbb1e999cf84d74ebbade0dee75ed21792ec45966683246c67c99" },
          { id: "graphic-layer-1", modality: "GRAPHIC", versionRef: "synthetic:graphic:v1", start: "0/1", end: "1/1", byteLength: 491_520, sha256: "c6753275a955e7aa28b4de70e6cc0990ae03794946b926814a36a81c31d5cb57" },
          { id: "audio-layer-1", modality: "AUDIO", versionRef: "synthetic:audio:v1", start: "0/1", end: "1/1", byteLength: 96_000, sha256: "bce25f7f1203d951e928a89f7bc8425a1410f394fea69b0028adb12ffb410a44" },
          { id: "caption-layer-1", modality: "CAPTION", versionRef: "synthetic:caption:v1", start: "1/10", end: "9/10", byteLength: 98, sha256: "c1126796c3090ba956077fb0070fe39c1bbda463c1224c8ff16c742d0eec94da" },
        ],
        graphicOperation: "overlay graphic-layer-1 over video-layer-1 at (0,0); moving opaque card authored in independent RGBA layer",
      },
      toolchain: {
        ffmpegVersion: "8.1.2",
        ffprobeVersion: "8.1.2",
        videoEncoder: "mpeg4 (native software encoder)",
        audioEncoder: "aac (native software encoder)",
        subtitleCodec: "mov_text",
        compositor: "overlay filter (synthetic RGBA graphic over synthetic RGB video)",
        container: "mp4",
      },
      output: {
        file: "local-multitrack-preview.mp4",
        byteLength: 18_617,
        sha256: OUTPUT_SHA256,
        contentType: "video/mp4",
        ffprobe: {
          format: "mov,mp4,m4a,3gp,3g2,mj2",
          durationSeconds: 1,
          video: { codec: "mpeg4", width: 64, height: 64, frameRate: "30/1", timeBase: "1/15360", decodedFrames: 30 },
          audio: { codec: "aac", sampleRateHz: 48_000, channels: 1 },
          caption: { codec: "mov_text", trackCount: 1 },
        },
        readback: {
          videoDecoded: true,
          videoFrameCount: 30,
          sourceFrameMappings: Array.from({ length: 30 }, (_, frameIndex) => ({
            outputFrameIndex: frameIndex,
            outputPtsTicks: frameIndex * 512,
            sourceLayerId: "video-layer-1",
            sourceVersionRef: "synthetic:video:v1",
            sourceFrameIndex: frameIndex,
            sourceTime: expectedSourceTime(frameIndex),
          })),
          graphicPixelRgbAtFrame15XY45x12: [241, 192, 38],
          audioDecoded: true,
          audioPcmBytes: 96_256,
          captionTextAndClockMatched: true,
        },
      },
      limitations: [
        "All four layers are generated synthetic fixtures; no source media, licensed graphic, real narration, or production project is consumed.",
        "The local FFmpeg 8.1.2 LGPL software build demonstrates only this bounded preview path; it is not a qualified production codec, host, quality, or Studio pipeline.",
        "The manifest and output checksum are local files only; they do not establish durable project lineage, canonical artifact registration, source rights, delivery, or task completion.",
      ],
    };
    assert.deepEqual(manifest, expected);
    assert.equal(manifestBytes.toString("utf8"), `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(manifest.output.sha256, sha256(outputBytes));

    const probe = spawnSync(ffprobe, [
      "-v", "error", "-count_frames", "-show_entries",
      "format=format_name,duration:stream=index,codec_type,codec_name,width,height,channels,sample_rate,r_frame_rate,avg_frame_rate,time_base,duration,duration_ts,nb_read_frames",
      "-of", "json", join(outputDir, "local-multitrack-preview.mp4"),
    ], { encoding: "utf8", maxBuffer: 256 * 1024, timeout: 10_000 });
    assert.equal(probe.status, 0, probe.stderr);
    const probed = JSON.parse(probe.stdout);
    assert.equal(probed.format.format_name, "mov,mp4,m4a,3gp,3g2,mj2");
    assert.equal(probed.format.duration, "1.000000");
    assert.deepEqual(probed.streams, [
      { index: 0, codec_name: "mpeg4", codec_type: "video", width: 64, height: 64, r_frame_rate: "30/1", avg_frame_rate: "30/1", time_base: "1/15360", duration_ts: 15360, duration: "1.000000", nb_read_frames: "30" },
      { index: 1, codec_name: "aac", codec_type: "audio", sample_rate: "48000", channels: 1, r_frame_rate: "0/0", avg_frame_rate: "0/0", time_base: "1/48000", duration_ts: 48000, duration: "1.000000", nb_read_frames: "47" },
      { index: 2, codec_name: "mov_text", codec_type: "subtitle", r_frame_rate: "0/0", avg_frame_rate: "0/0", time_base: "1/1000000", duration_ts: 900000, duration: "0.900000", nb_read_frames: "1" },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing pinned tools fail closed and leave no preview files", async () => {
  const parent = await tempDir();
  const outputDir = join(parent, "output");
  try {
    const result = runPreview(outputDir, {
      GHATANA_MEDIA_FFMPEG: join(parent, "missing-ffmpeg"),
      GHATANA_MEDIA_FFPROBE: join(parent, "missing-ffprobe"),
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /^CODEC_UNAVAILABLE:/u);
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });
    assert.deepEqual(await readdir(parent), [], "failed codec preflight leaves no output, stage, or render lock");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an existing output is never overwritten, even when codec tools are missing", async () => {
  const parent = await tempDir();
  const outputDir = join(parent, "output");
  try {
    const sentinelPath = join(outputDir, "keep.txt");
    await mkdir(outputDir);
    await writeFile(sentinelPath, "preserve-existing-output", { flag: "wx" });
    const result = runPreview(outputDir, {
      GHATANA_MEDIA_FFMPEG: join(parent, "missing-ffmpeg"),
      GHATANA_MEDIA_FFPROBE: join(parent, "missing-ffprobe"),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /output directory must be empty/u);
    assert.deepEqual(await readdir(outputDir), ["keep.txt"]);
    assert.equal(await readFile(sentinelPath, "utf8"), "preserve-existing-output");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
