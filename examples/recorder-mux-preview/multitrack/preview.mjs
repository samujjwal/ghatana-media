#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPreviewOutputTransaction } from "../preview-output-transaction.mjs";

const execFile = promisify(execFileCallback);
const PROFILE = "local-multitrack-overlay-mpeg4-aac-mov_text.v1";
const TOOL_VERSION = "8.1.2";
const WIDTH = 64;
const HEIGHT = 64;
const FPS = 30;
const FRAME_COUNT = 30;
const RATE = 48_000;
const DURATION_SECONDS = 1;
const OUTPUT_BUDGET_BYTES = 2 * 1024 * 1024;
const MANIFEST_BUDGET_BYTES = 16 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const CAPTION = "Synthetic multitrack preview. No authorized source content.";
const COMMENT = "LOCAL_PREVIEW_ONLY";
const PROFILE_TITLE = PROFILE;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function rationalFrameTime(frameIndex, framesPerSecond) {
  let a = frameIndex;
  let b = framesPerSecond;
  while (b !== 0) [a, b] = [b, a % b];
  const divisor = a || 1;
  return `${frameIndex / divisor}/${framesPerSecond / divisor}`;
}

function rgbVideoLayer() {
  const frameBytes = WIDTH * HEIGHT * 3;
  const bytes = Buffer.alloc(frameBytes * FRAME_COUNT);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = frame * frameBytes + (y * WIDTH + x) * 3;
        bytes[offset] = 22 + ((x + frame) % 16);
        bytes[offset + 1] = 46 + ((y * 2) % 18);
        bytes[offset + 2] = 94 + ((x + y + frame) % 24);
      }
    }
  }
  return bytes;
}

function rgbaGraphicLayer() {
  const frameBytes = WIDTH * HEIGHT * 4;
  const bytes = Buffer.alloc(frameBytes * FRAME_COUNT);
  // A separately authored animated yellow card with transparent pixels elsewhere.
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const left = 38 - Math.floor(frame / 10);
    for (let y = 7; y < 23; y += 1) {
      for (let x = left; x < left + 18; x += 1) {
        const offset = frame * frameBytes + (y * WIDTH + x) * 4;
        bytes[offset] = 232;
        bytes[offset + 1] = 196;
        bytes[offset + 2] = 44;
        bytes[offset + 3] = 255;
      }
    }
  }
  return bytes;
}

function pcmAudioLayer() {
  const samples = RATE * DURATION_SECONDS;
  const bytes = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 660 * sample) / RATE) * 7_000);
    bytes.writeInt16LE(value, sample * 2);
  }
  return bytes;
}

async function runTool(executable, args, label, encoding = "utf8") {
  try {
    const result = await execFile(executable, args, {
      encoding,
      maxBuffer: OUTPUT_BUDGET_BYTES,
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "tool invocation failed").slice(0, 512);
    const failure = new Error(`${label}: ${detail}`);
    failure.code = ["ENOENT", "EACCES", "EPERM"].includes(error?.code) ? "CODEC_UNAVAILABLE" : "PREVIEW_FAILED";
    throw failure;
  }
}

async function requirePinnedToolchain(ffmpeg, ffprobe) {
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    runTool(ffmpeg, ["-version"], "ffmpeg version check"),
    runTool(ffprobe, ["-version"], "ffprobe version check"),
  ]);
  for (const [name, text] of [["ffmpeg", ffmpegVersion], ["ffprobe", ffprobeVersion]]) {
    const version = text.match(new RegExp(`^${name} version ([0-9.]+)`, "mu"))?.[1];
    if (version !== TOOL_VERSION) {
      const failure = new Error(`${name} ${TOOL_VERSION} is required; found ${version ?? "unknown"}`);
      failure.code = "CODEC_UNAVAILABLE";
      throw failure;
    }
  }
  const [encoders, filters] = await Promise.all([
    runTool(ffmpeg, ["-hide_banner", "-encoders"], "ffmpeg encoder inspection"),
    runTool(ffmpeg, ["-hide_banner", "-filters"], "ffmpeg filter inspection"),
  ]);
  for (const encoder of ["mpeg4", "aac"]) {
    if (!new RegExp(`\\b${encoder}\\b`, "u").test(encoders)) throw new Error(`pinned build lacks ${encoder}`);
  }
  if (!/^\s*[A-Z.]{2,3}\s+overlay\s/mu.test(filters)) throw new Error("pinned build lacks the overlay filter");
  return {
    ffmpegVersion: TOOL_VERSION,
    ffprobeVersion: TOOL_VERSION,
    videoEncoder: "mpeg4 (native software encoder)",
    audioEncoder: "aac (native software encoder)",
    subtitleCodec: "mov_text",
    compositor: "overlay filter (synthetic RGBA graphic over synthetic RGB video)",
    container: "mp4",
  };
}

function validateProbe(probe) {
  const streams = probe?.streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  const captions = streams.filter((stream) => stream.codec_type === "subtitle");
  const formatNames = String(probe?.format?.format_name ?? "").split(",");
  if (!formatNames.includes("mp4") || probe?.format?.tags?.comment !== COMMENT
      || probe?.format?.tags?.title !== PROFILE_TITLE
      || video.length !== 1 || audio.length !== 1 || captions.length !== 1
      || video[0]?.codec_name !== "mpeg4" || Number(video[0]?.width) !== WIDTH
      || Number(video[0]?.height) !== HEIGHT || video[0]?.r_frame_rate !== `${FPS}/1`
      || Number(video[0]?.nb_read_frames) !== FRAME_COUNT
      || audio[0]?.codec_name !== "aac" || Number(audio[0]?.sample_rate) !== RATE
      || Number(audio[0]?.channels) !== 1 || captions[0]?.codec_name !== "mov_text"
      || Number(probe?.format?.duration) < DURATION_SECONDS) {
    throw new Error("ffprobe observations did not match the declared local multitrack profile");
  }
  return { video, audio, captions };
}

function checkGraphicPixel(frame) {
  const offset = (12 * WIDTH + 45) * 3;
  const [red, green, blue] = [frame[offset], frame[offset + 1], frame[offset + 2]];
  if (!(red >= 155 && green >= 115 && blue <= 115)) {
    throw new Error(`decoded frame did not contain the authored graphic at the expected sample (rgb ${red},${green},${blue})`);
  }
}

export function assertSourceVideoReadback(decodedFrames, frameTimestamps, timeBase) {
  const frameBytes = WIDTH * HEIGHT * 3;
  if (decodedFrames.length !== frameBytes * FRAME_COUNT) {
    throw new Error(`decoded video had ${decodedFrames.length} bytes; expected ${frameBytes * FRAME_COUNT}`);
  }
  if (frameTimestamps.length !== FRAME_COUNT) {
    throw new Error(`ffprobe returned ${frameTimestamps.length} video timestamps; expected ${FRAME_COUNT}`);
  }
  const [numerator, denominator] = String(timeBase).split("/").map(Number);
  if (!(numerator > 0) || !(denominator > 0) || denominator % (numerator * FPS) !== 0) {
    throw new Error(`video time base ${timeBase} cannot exactly represent ${FPS} fps`);
  }
  const ticksPerFrame = denominator / (numerator * FPS);
  const mappings = [];
  // Sample an unobscured source pixel from every decoded frame. The MPEG-4
  // profile is lossy, so compare within a fixed codec tolerance while keeping
  // the decoded frame index and integer PTS exact.
  const x = 5;
  const y = 50;
  const offset = (y * WIDTH + x) * 3;
  for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
    const rawTimestamp = frameTimestamps[frameIndex]?.best_effort_timestamp;
    // ffprobe emits decimal integer strings. Do not let Number() coerce a
    // missing/null/empty value to zero: that would make the first frame look
    // exactly timed despite having no timestamp observation at all.
    if (!(typeof rawTimestamp === "string" && /^(?:0|[1-9]\d*)$/u.test(rawTimestamp))
        && !(typeof rawTimestamp === "number" && Number.isSafeInteger(rawTimestamp) && rawTimestamp >= 0)) {
      throw new Error(`decoded frame ${frameIndex} has no canonical non-negative integer PTS`);
    }
    const timestamp = Number(rawTimestamp);
    const expectedTimestamp = frameIndex * ticksPerFrame;
    if (!Number.isSafeInteger(timestamp) || timestamp !== expectedTimestamp) {
      throw new Error(`decoded frame ${frameIndex} PTS ${frameTimestamps[frameIndex]?.best_effort_timestamp} did not equal expected ${expectedTimestamp}`);
    }
    const moving = [22 + ((x + frameIndex) % 16), 46 + ((y * 2) % 18), 94 + ((x + y + frameIndex) % 24)];
    const decoded = [0, 1, 2].map((channel) => decodedFrames[frameIndex * frameBytes + offset + channel]);
    if (decoded.some((value, channel) => Math.abs(value - moving[channel]) > 20)) {
      throw new Error(`decoded frame ${frameIndex} did not match its versioned source pixel at ${x},${y}`);
    }
    mappings.push({
      outputFrameIndex: frameIndex,
      outputPtsTicks: timestamp,
      sourceLayerId: "video-layer-1",
      sourceVersionRef: "synthetic:video:v1",
      sourceFrameIndex: frameIndex,
      sourceTime: rationalFrameTime(frameIndex, FPS),
    });
  }
  return mappings;
}

/** Encode a bounded synthetic video/graphic/audio/caption composition; there is no source authority path. */
export async function createLocalMultitrackPreview({
  outputDir = "build/media-recorder-multitrack-preview",
  ffmpeg = process.env.GHATANA_MEDIA_FFMPEG ?? "ffmpeg",
  ffprobe = process.env.GHATANA_MEDIA_FFPROBE ?? "ffprobe",
} = {}) {
  return withPreviewOutputTransaction(outputDir, async (output) => {
    const toolchain = await requirePinnedToolchain(ffmpeg, ffprobe);
    const work = await mkdtemp(join(output, ".multitrack-"));
    const names = {
      videoLayer: "synthetic-video.rgb",
      graphicLayer: "synthetic-graphic.rgba",
      audioLayer: "synthetic-audio.pcm",
      captionLayer: "synthetic-captions.vtt",
      output: "local-multitrack-preview.mp4",
      manifest: "multitrack-preview-manifest.json",
    };
    const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, join(work, name)]));
    const video = rgbVideoLayer();
    const graphic = rgbaGraphicLayer();
    const audio = pcmAudioLayer();
    const caption = Buffer.from(`WEBVTT\n\n00:00:00.100 --> 00:00:00.900\n${CAPTION}\n`, "utf8");
    const layers = [
      { id: "video-layer-1", modality: "VIDEO", versionRef: "synthetic:video:v1", start: "0/1", end: "1/1", bytes: video, path: paths.videoLayer },
      { id: "graphic-layer-1", modality: "GRAPHIC", versionRef: "synthetic:graphic:v1", start: "0/1", end: "1/1", bytes: graphic, path: paths.graphicLayer },
      { id: "audio-layer-1", modality: "AUDIO", versionRef: "synthetic:audio:v1", start: "0/1", end: "1/1", bytes: audio, path: paths.audioLayer },
      { id: "caption-layer-1", modality: "CAPTION", versionRef: "synthetic:caption:v1", start: "1/10", end: "9/10", bytes: caption, path: paths.captionLayer },
    ];

    try {
      await Promise.all(layers.map(({ bytes, path }) => writeFile(path, bytes, { flag: "wx" })));
      await runTool(ffmpeg, [
        "-hide_banner", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${WIDTH}x${HEIGHT}`, "-r", `${FPS}/1`, "-i", paths.videoLayer,
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-r", `${FPS}/1`, "-i", paths.graphicLayer,
        "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", paths.audioLayer,
        "-f", "webvtt", "-i", paths.captionLayer,
        "-filter_complex", "[0:v][1:v]overlay=x=0:y=0:shortest=1:format=auto,format=yuv420p[composite]",
        "-map", "[composite]", "-map", "2:a:0", "-map", "3:s:0",
        "-frames:v", String(FRAME_COUNT),
        "-c:v", "mpeg4", "-q:v", "3", "-threads:v", "1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-c:s", "mov_text",
        "-metadata", `comment=${COMMENT}`, "-metadata", `title=${PROFILE_TITLE}`,
        "-movflags", "+faststart", "-fs", String(OUTPUT_BUDGET_BYTES), paths.output,
      ], "multitrack composition failed");

      const outputStat = await stat(paths.output);
      if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > OUTPUT_BUDGET_BYTES) {
        throw new Error("encoded candidate exceeded the declared output size bound");
      }
      const probeText = await runTool(ffprobe, [
        "-v", "error", "-count_frames", "-show_entries",
        "format=format_name,duration:format_tags=comment,title:stream=index,codec_type,codec_name,width,height,channels,sample_rate,nb_read_frames,r_frame_rate,time_base,duration",
        "-of", "json", paths.output,
      ], "multitrack output probe failed");
      const probe = JSON.parse(probeText);
      const { video: videoStreams, audio: audioStreams, captions: captionStreams } = validateProbe(probe);

      await Promise.all([
        runTool(ffmpeg, ["-v", "error", "-i", paths.output, "-map", "0:v:0", "-f", "null", "-"], "video decode failed"),
        runTool(ffmpeg, ["-v", "error", "-i", paths.output, "-map", "0:a:0", "-f", "null", "-"], "audio decode failed"),
      ]);
      const decodedFrames = await runTool(ffmpeg, [
        "-v", "error", "-i", paths.output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ], "video frame readback failed", "buffer");
      const frameProbeText = await runTool(ffprobe, [
        "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp,best_effort_timestamp_time",
        "-of", "json", paths.output,
      ], "video timestamp readback failed");
      const frameProbe = JSON.parse(frameProbeText);
      const sourceFrameMappings = assertSourceVideoReadback(decodedFrames, frameProbe.frames ?? [], videoStreams[0].time_base);
      const graphicFrame = decodedFrames.subarray(15 * WIDTH * HEIGHT * 3, 16 * WIDTH * HEIGHT * 3);
      checkGraphicPixel(graphicFrame);
      const decodedVtt = await runTool(ffmpeg, ["-v", "error", "-i", paths.output, "-map", "0:s:0", "-f", "webvtt", "-"], "caption decode failed");
      if (!decodedVtt.includes(CAPTION) || !decodedVtt.includes("00:00.100 --> 00:00.900")) {
        throw new Error("decoded caption did not preserve authored text and exact cue clock");
      }
      const decodedPcm = await runTool(ffmpeg, [
        "-v", "error", "-i", paths.output, "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le", "-",
      ], "audio sample readback failed", "buffer");
      if (decodedPcm.length < RATE * 2 || decodedPcm.length > RATE * 2 + 16_384
          || !decodedPcm.some((byte) => byte !== 0)) {
        throw new Error("decoded audio samples did not match the bounded synthetic audio readback");
      }

      const outputBytes = await readFile(paths.output);
      const manifest = {
        kind: "LOCAL_PREVIEW_ONLY",
        capabilityId: "media.dev.multitrack-composition-render",
        requestedOutcomeId: "media.dev.outcome-multitrack-finished-master",
        profile: PROFILE,
        composition: {
          duration: "1/1",
          frameRate: `${FPS}/1`,
          frameCount: FRAME_COUNT,
          outputBudgetBytes: OUTPUT_BUDGET_BYTES,
          manifestBudgetBytes: MANIFEST_BUDGET_BYTES,
          layers: layers.map((layer) => ({
            id: layer.id, modality: layer.modality, versionRef: layer.versionRef,
            start: layer.start, end: layer.end, byteLength: layer.bytes.length, sha256: sha256(layer.bytes),
          })),
          graphicOperation: "overlay graphic-layer-1 over video-layer-1 at (0,0); moving opaque card authored in independent RGBA layer",
        },
        toolchain,
        output: {
          file: "local-multitrack-preview.mp4",
          byteLength: outputBytes.length,
          sha256: sha256(outputBytes),
          contentType: "video/mp4",
          ffprobe: {
            format: probe.format.format_name,
            durationSeconds: Number(probe.format.duration),
            video: { codec: videoStreams[0].codec_name, width: Number(videoStreams[0].width), height: Number(videoStreams[0].height), frameRate: videoStreams[0].r_frame_rate, timeBase: videoStreams[0].time_base, decodedFrames: Number(videoStreams[0].nb_read_frames) },
            audio: { codec: audioStreams[0].codec_name, sampleRateHz: Number(audioStreams[0].sample_rate), channels: Number(audioStreams[0].channels) },
            caption: { codec: captionStreams[0].codec_name, trackCount: captionStreams.length },
          },
          readback: {
            videoDecoded: true,
            videoFrameCount: sourceFrameMappings.length,
            sourceFrameMappings,
            graphicPixelRgbAtFrame15XY45x12: [graphicFrame[(12 * WIDTH + 45) * 3], graphicFrame[(12 * WIDTH + 45) * 3 + 1], graphicFrame[(12 * WIDTH + 45) * 3 + 2]],
            audioDecoded: true,
            audioPcmBytes: decodedPcm.length,
            captionTextAndClockMatched: true,
          },
        },
        limitations: [
          "All four layers are generated synthetic fixtures; no source media, licensed graphic, real narration, or production project is consumed.",
          "The local FFmpeg 8.1.2 LGPL software build demonstrates only this bounded preview path; it is not a qualified production codec, host, quality, or Studio pipeline.",
          "The manifest and output checksum are local files only; they do not establish durable project lineage, canonical artifact registration, source rights, delivery, or task completion.",
        ],
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      if (manifestBytes.length > MANIFEST_BUDGET_BYTES) throw new Error("preview manifest exceeded its declared byte bound");
      await rename(paths.output, join(output, "local-multitrack-preview.mp4"));
      await writeFile(join(output, "multitrack-preview-manifest.json"), manifestBytes, { flag: "wx" });
      return { outputDir: output, manifest };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}

async function main() {
  try {
    const result = await createLocalMultitrackPreview({ outputDir: process.argv[2] ?? "build/media-recorder-multitrack-preview" });
    console.log(`LOCAL_PREVIEW_ONLY ${result.outputDir}/local-multitrack-preview.mp4 sha256=${result.manifest.output.sha256}`);
  } catch (error) {
    console.error(`${error?.code ?? "PREVIEW_FAILED"}: ${error?.message ?? error}`);
    process.exitCode = error?.code === "CODEC_UNAVAILABLE" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
