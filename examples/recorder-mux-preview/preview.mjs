#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPreviewOutputTransaction } from "./preview-output-transaction.mjs";

const execFile = promisify(execFileCallback);
const PROFILE = "local-mp4-mpeg4-aac-mov_text.v1";
const PINNED_TOOL_VERSION = "8.1.2";
const SOURCE_VERSION = "local-fixture:recorder-mux-preview:v1";
const WIDTH = 64;
const HEIGHT = 64;
const FPS = 30;
const VIDEO_FRAMES = 30;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_SAMPLES = 48_000;
const OUTPUT_BUDGET_BYTES = 2 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const CAPTION = "Synthetic local preview. This is not authorized source content.";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeRgbFixture() {
  const frameBytes = WIDTH * HEIGHT * 3;
  const bytes = Buffer.alloc(frameBytes * VIDEO_FRAMES);
  for (let frame = 0; frame < VIDEO_FRAMES; frame += 1) {
    const left = (frame * 2) % (WIDTH - 12);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = frame * frameBytes + (y * WIDTH + x) * 3;
        const moving = x >= left && x < left + 12 && y >= 24 && y < 36;
        bytes[offset] = moving ? 64 : 12;
        bytes[offset + 1] = moving ? 220 : 24;
        bytes[offset + 2] = moving ? 180 : 40;
      }
    }
  }
  return bytes;
}

function makePcmFixture() {
  const bytes = Buffer.alloc(AUDIO_SAMPLES * 2);
  for (let sample = 0; sample < AUDIO_SAMPLES; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * sample) / AUDIO_SAMPLE_RATE) * 6_000);
    bytes.writeInt16LE(value, sample * 2);
  }
  return bytes;
}

async function runTool(executable, args, label, encoding = "utf8") {
  try {
    const result = await execFile(executable, args, {
      encoding,
      maxBuffer: 2 * 1024 * 1024,
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
  for (const [name, versionText] of [["ffmpeg", ffmpegVersion], ["ffprobe", ffprobeVersion]]) {
    const version = versionText.match(new RegExp(`^${name} version ([0-9.]+)`, "mu"))?.[1];
    if (version !== PINNED_TOOL_VERSION) {
      const failure = new Error(`${name} ${PINNED_TOOL_VERSION} is required; found ${version ?? "unknown"}`);
      failure.code = "CODEC_UNAVAILABLE";
      throw failure;
    }
  }
  const encoders = await runTool(ffmpeg, ["-hide_banner", "-encoders"], "ffmpeg encoder inspection");
  for (const encoder of ["mpeg4", "aac"]) {
    if (!new RegExp(`\\b${encoder}\\b`, "u").test(encoders)) {
      const failure = new Error(`the pinned ffmpeg build does not provide the ${encoder} encoder`);
      failure.code = "CODEC_UNAVAILABLE";
      throw failure;
    }
  }
  return {
    ffmpegVersion: PINNED_TOOL_VERSION,
    ffprobeVersion: PINNED_TOOL_VERSION,
    videoEncoder: "mpeg4 (native software encoder)",
    audioEncoder: "aac (native software encoder)",
    subtitleCodec: "mov_text",
    container: "mp4",
  };
}

function validateProbe(probe) {
  const streams = probe?.streams;
  const video = streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audio = streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const subtitles = streams?.filter((stream) => stream.codec_type === "subtitle") ?? [];
  if (!String(probe?.format?.format_name ?? "").split(",").includes("mp4")
      || probe?.format?.tags?.comment !== "LOCAL_PREVIEW_ONLY"
      || video.length !== 1 || audio.length !== 1 || subtitles.length !== 1
      || video[0]?.codec_name !== "mpeg4"
      || video[0]?.r_frame_rate !== `${FPS}/1`
      || Number(video[0]?.nb_read_frames) !== VIDEO_FRAMES
      || Number(video[0]?.duration) !== 1
      || audio[0]?.codec_name !== "aac"
      || Number(audio[0]?.sample_rate) !== AUDIO_SAMPLE_RATE
      || Number(audio[0]?.channels) !== 1
      || Number(audio[0]?.duration) < 0.99
      || subtitles[0]?.codec_name !== "mov_text") {
    throw new Error("ffprobe observations did not match the local fixture profile");
  }
  return { video, audio, subtitles };
}

export function buildSourceTimeMapping(outputTimeBase) {
  const [numerator, denominator] = outputTimeBase.split("/")
    .map((part) => /^\d+$/u.test(part) ? BigInt(part) : 0n);
  if (numerator <= 0n || denominator <= 0n) throw new Error("invalid output timebase");
  const frames = Array.from({ length: VIDEO_FRAMES }, (_, frameIndex) => {
    const outputTicks = BigInt(frameIndex) * denominator;
    const sourceTicksPerSecond = BigInt(FPS);
    const scaledNumerator = outputTicks;
    const scaledDenominator = numerator * sourceTicksPerSecond;
    if (scaledDenominator <= 0n || scaledNumerator % scaledDenominator !== 0n) {
      throw new Error("output timebase cannot represent the source frame clock exactly");
    }
    return {
      sourcePts: frameIndex,
      outputPts: Number(scaledNumerator / scaledDenominator),
      timeBase: outputTimeBase,
    };
  });
  return {
    sourceVersionRef: SOURCE_VERSION,
    sourceClockId: "fixture-video-clock-v1",
    sourceTimeBase: `1/${FPS}`,
    outputTimeBase,
    mapping: "frame-index-preserving-cfr.v1",
    frames,
  };
}

/** Creates a synthetic, local-only MP4; it has no source-authority or publication path. */
export async function createRecorderMuxPreview({
  outputDir = "build/media-recorder-preview",
  ffmpeg = process.env.GHATANA_MEDIA_FFMPEG ?? "ffmpeg",
  ffprobe = process.env.GHATANA_MEDIA_FFPROBE ?? "ffprobe",
} = {}) {
  return withPreviewOutputTransaction(outputDir, async (output) => {
    const toolchain = await requirePinnedToolchain(ffmpeg, ffprobe);
    const work = await mkdtemp(join(output, ".fixture-"));
    const frameInput = join(work, "frames.rgb");
    const audioInput = join(work, "audio.pcm");
    const captionInput = join(work, "captions.vtt");
    const videoOutput = join(work, "local-preview.mp4");
    const vtt = `WEBVTT\n\n00:00:00.000 --> 00:00:00.900\n${CAPTION}\n`;
    const frames = makeRgbFixture();
    const pcm = makePcmFixture();
    const captionBytes = Buffer.from(vtt, "utf8");

    try {
      await Promise.all([
        writeFile(frameInput, frames, { flag: "wx" }),
        writeFile(audioInput, pcm, { flag: "wx" }),
        writeFile(captionInput, captionBytes, { flag: "wx" }),
      ]);
      await runTool(ffmpeg, [
        "-hide_banner", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${WIDTH}x${HEIGHT}`,
        "-r", `${FPS}/1`, "-i", frameInput,
        "-f", "s16le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "1", "-i", audioInput,
        "-f", "webvtt", "-i", captionInput,
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0",
        "-frames:v", String(VIDEO_FRAMES),
        "-c:v", "mpeg4", "-q:v", "5", "-threads:v", "1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-c:s", "mov_text",
        "-metadata", "comment=LOCAL_PREVIEW_ONLY",
        "-metadata", `title=${PROFILE}`,
        "-movflags", "+faststart", "-fs", String(OUTPUT_BUDGET_BYTES), videoOutput,
      ], "fixture mux failed");

      const candidateStat = await stat(videoOutput);
      if (!candidateStat.isFile() || candidateStat.size <= 0 || candidateStat.size > OUTPUT_BUDGET_BYTES) {
        throw new Error("encoded preview exceeded its declared output size bound");
      }

      const probeText = await runTool(ffprobe, [
        "-v", "error", "-count_frames",
        "-show_entries", "format=format_name,duration:format_tags=comment:stream=index,codec_type,codec_name,channels,sample_rate,nb_frames,nb_read_frames,r_frame_rate,time_base,duration",
        "-of", "json", videoOutput,
      ], "fixture probe failed");
      const probe = JSON.parse(probeText);
      const { video, audio, subtitles } = validateProbe(probe);

      await Promise.all([
        runTool(ffmpeg, ["-v", "error", "-i", videoOutput, "-map", "0:v:0", "-f", "null", "-"], "video decode failed"),
        runTool(ffmpeg, ["-v", "error", "-i", videoOutput, "-map", "0:a:0", "-f", "null", "-"], "audio decode failed"),
      ]);
      const decodedVtt = await runTool(ffmpeg, [
        "-v", "error", "-i", videoOutput, "-map", "0:s:0", "-f", "webvtt", "-",
      ], "caption decode failed");
      if (!decodedVtt.includes(CAPTION) || !decodedVtt.includes("00:00.000 --> 00:00.900")) {
        throw new Error("decoded caption did not preserve the authored fixture cue and clock");
      }

      const videoBytes = await readFile(videoOutput);
      const names = {
        video: "local-preview.mp4",
        sourceCaptions: "fixture-captions.vtt",
        manifest: "preview-manifest.json",
      };
      await rename(videoOutput, join(output, names.video));
      await writeFile(join(output, names.sourceCaptions), captionBytes, { flag: "wx" });
      const manifest = {
        kind: "LOCAL_PREVIEW_ONLY",
        profile: PROFILE,
        source: {
          kind: "SYNTHETIC_FIXTURE",
          versionRef: SOURCE_VERSION,
          frameBytesSha256: sha256(frames),
          pcmSha256: sha256(pcm),
          captionsSha256: sha256(captionBytes),
        },
        clocks: {
          video: { clockId: "fixture-video-clock-v1", timeBase: "1/30", frameRate: "30/1", frameCount: VIDEO_FRAMES, durationTicks: VIDEO_FRAMES },
          audio: { clockId: "fixture-audio-clock-v1", sampleRateHz: AUDIO_SAMPLE_RATE, channels: 1, sampleCount: AUDIO_SAMPLES },
          caption: { clockId: "fixture-video-clock-v1", startTicks: 0, endTicks: 27, ticksPerSecond: FPS },
        },
        sourceTimeMapping: buildSourceTimeMapping(video[0].time_base),
        output: {
          file: names.video,
          sha256: sha256(videoBytes),
          contentType: "video/mp4",
          codecs: toolchain,
          ffprobe: {
            format: probe.format.format_name,
            durationSeconds: Number(probe.format.duration),
            videoFrames: Number(video[0].nb_read_frames),
            frameRate: video[0].r_frame_rate,
            audioSampleRateHz: Number(audio[0].sample_rate),
            audioChannels: Number(audio[0].channels),
            subtitleTrackCount: subtitles.length,
            independentlyDecoded: true,
          },
        },
        limitations: [
          "Generated RGB frames, a synthetic sine tone, and a locally authored caption fixture only.",
          "No source rights, capture authority, narration consent, model quality, or host recording is established.",
          "This local preview is not an authorized recording, canonical Media artifact, delivery receipt, or completed journey.",
          "The MPEG-4 Part 2/AAC profile demonstrates local mux and decode only; it is not a qualified production codec profile.",
        ],
      };
      await writeFile(join(output, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      return { outputDir: output, ...names, sha256: manifest.output.sha256, manifest };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}

async function main() {
  const outputDir = process.argv[2] ?? "build/media-recorder-preview";
  try {
    const result = await createRecorderMuxPreview({ outputDir });
    console.log(`LOCAL_PREVIEW_ONLY ${result.outputDir}/${result.video} sha256=${result.sha256}`);
  } catch (error) {
    console.error(`${error?.code ?? "PREVIEW_FAILED"}: ${error?.message ?? error}`);
    process.exitCode = error?.code === "CODEC_UNAVAILABLE" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
