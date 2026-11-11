#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const VERSION = "8.1.2";
const WIDTH = 96;
const HEIGHT = 64;
const FPS = 10;
const FRAME_COUNT = 8;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const FILTER = "atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08:s=5";
const PROFILE = "synthetic-atadenoise-mpeg4.v1";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function fixtures() {
  const pristine = Buffer.alloc(FRAME_BYTES * FRAME_COUNT);
  const noisy = Buffer.alloc(pristine.length);
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const shift = frame * 2;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = frame * FRAME_BYTES + (y * WIDTH + x) * 3;
        const bar = x >= 16 + shift && x < 40 + shift && y >= 16 && y < 48;
        const grid = ((x >> 3) + (y >> 3)) % 2 === 0;
        const base = bar ? [220, 180, 48] : grid ? [42, 72, 108] : [76, 102, 132];
        for (let channel = 0; channel < 3; channel += 1) {
          pristine[offset + channel] = base[channel];
          const noise = random() % 41 - 20;
          noisy[offset + channel] = Math.max(0, Math.min(255, base[channel] + noise));
        }
      }
    }
  }
  return { pristine, noisy };
}

async function run(executable, args, label, encoding = "utf8") {
  try {
    const result = await execFile(executable, args, { encoding, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return result.stdout;
  } catch (error) {
    const failure = new Error(`${label}: ${String(error?.stderr ?? error?.message ?? "tool failed").slice(0, 512)}`);
    failure.code = "CODEC_UNAVAILABLE";
    throw failure;
  }
}

async function assertToolchain(ffmpeg, ffprobe) {
  for (const [tool, executable] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    const text = await run(executable, ["-version"], `${tool} version check`);
    if (!text.startsWith(`${tool} version ${VERSION} `)) throw new Error(`${tool} ${VERSION} is required`);
  }
  const encoders = await run(ffmpeg, ["-hide_banner", "-encoders"], "encoder inspection");
  const filters = await run(ffmpeg, ["-hide_banner", "-filters"], "filter inspection");
  if (!/\bmpeg4\b/u.test(encoders) || !/\batadenoise\b/u.test(filters)) throw new Error("pinned build lacks mpeg4 encoder or atadenoise filter");
}

function psnr(reference, sample) {
  if (reference.length !== sample.length || reference.length === 0) throw new Error("PSNR buffers must have equal nonzero size");
  let squaredError = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const delta = reference[i] - sample[i];
    squaredError += delta * delta;
  }
  const mse = squaredError / reference.length;
  return mse === 0 ? null : 10 * Math.log10((255 * 255) / mse);
}

export function verifyClock(probe) {
  const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const frames = probe.frames?.filter((frame) => frame.media_type === "video") ?? [];
  const observedPts = [];
  if (video.length !== 1 || video[0].codec_name !== "mpeg4" || video[0].width !== WIDTH || video[0].height !== HEIGHT
      || video[0].r_frame_rate !== `${FPS}/1` || Number(video[0].nb_read_frames) !== FRAME_COUNT || frames.length !== FRAME_COUNT) {
    throw new Error(`probe stream/frame observations do not match fixture profile: ${JSON.stringify({ video, frameCount: frames.length })}`);
  }
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    const rawPts = frames[i].best_effort_timestamp_time;
    const pts = Number(rawPts);
    if (!Number.isFinite(pts) || !decimalMatchesFrame(rawPts, i, FPS)) {
      throw new Error(`unexpected frame PTS at ordinal ${i}: ${String(rawPts)}`);
    }
    observedPts.push(pts);
  }
  return { frameRate: video[0].r_frame_rate, frameCount: frames.length, ptsSeconds: observedPts };
}

/** Compare FFprobe's decimal timestamp to the exact expected rational frame clock. */
function decimalMatchesFrame(value, frameIndex, framesPerSecond) {
  const text = typeof value === "number" && Number.isFinite(value) ? value.toString() : value;
  if (typeof text !== "string" || text.length > 64) return false;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) return false;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 64) return false;
  const fractionDigits = match[3] ?? "";
  let numerator = BigInt(`${match[1]}${match[2]}${fractionDigits}`);
  let denominator = 1n;
  const decimalPlaces = fractionDigits.length - exponent;
  if (decimalPlaces > 0) denominator = 10n ** BigInt(decimalPlaces);
  else if (decimalPlaces < 0) numerator *= 10n ** BigInt(-decimalPlaces);
  if (numerator < 0n) return false;
  return numerator * BigInt(framesPerSecond) === BigInt(frameIndex) * denominator;
}

export function assertAlignedClocks(candidateClock, baselineClock) {
  if (baselineClock.frameRate !== candidateClock.frameRate
      || baselineClock.frameCount !== candidateClock.frameCount
      || baselineClock.ptsSeconds.length !== candidateClock.ptsSeconds.length
      || baselineClock.ptsSeconds.some((pts, index) => pts !== candidateClock.ptsSeconds[index])) {
    throw new Error("candidate and baseline frame clocks do not align");
  }
}

/** Build a bounded synthetic comparison; metrics are never real-source quality claims. */
export async function createVideoRestorationComparison({
  outputDir = "build/video-restoration-comparison",
  ffmpeg = process.env.GHATANA_MEDIA_FFMPEG ?? "ffmpeg",
  ffprobe = process.env.GHATANA_MEDIA_FFPROBE ?? "ffprobe",
} = {}) {
  const output = resolve(outputDir);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("output directory must be empty");
  await assertToolchain(ffmpeg, ffprobe);
  const { pristine, noisy } = fixtures();
  const work = await mkdtemp(join(output, ".work-"));
  const input = join(work, "noisy.rgb");
  const candidate = join(work, "candidate.mp4");
  const baseline = join(work, "baseline.mp4");
  const reopenedCandidate = join(work, "reopened-candidate.rgb");
  const reopenedBaseline = join(work, "reopened-baseline.rgb");
  const publishedFiles = [];
  try {
    await writeFile(input, noisy, { flag: "wx" });
    const common = ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", `${WIDTH}x${HEIGHT}`, "-framerate", `${FPS}/1`, "-i", input, "-frames:v", String(FRAME_COUNT), "-an"];
    await run(ffmpeg, [...common, "-c:v", "mpeg4", "-q:v", "2", "-threads:v", "1", "-pix_fmt", "yuv420p", "-metadata", "comment=SYNTHETIC_METRIC_ONLY", baseline], "baseline encode failed");
    await run(ffmpeg, [...common, "-vf", FILTER, "-c:v", "mpeg4", "-q:v", "2", "-threads:v", "1", "-pix_fmt", "yuv420p", "-metadata", "comment=SYNTHETIC_METRIC_ONLY", candidate], "candidate encode failed");
    const probeArgs = ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_frames", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:frame=media_type,best_effort_timestamp_time", "-of", "json"];
    const [candidateProbeText, baselineProbeText] = await Promise.all([
      run(ffprobe, [...probeArgs, candidate], "candidate probe failed"),
      run(ffprobe, [...probeArgs, baseline], "baseline probe failed"),
    ]);
    const clock = verifyClock(JSON.parse(candidateProbeText));
    const baselineClock = verifyClock(JSON.parse(baselineProbeText));
    assertAlignedClocks(clock, baselineClock);
    const names = { candidate: "restored-candidate.mp4", baseline: "unfiltered-baseline.mp4", manifest: "comparison-manifest.json" };
    const publishedCandidate = join(output, names.candidate);
    const publishedBaseline = join(output, names.baseline);
    await rename(candidate, publishedCandidate);
    publishedFiles.push(publishedCandidate);
    await rename(baseline, publishedBaseline);
    publishedFiles.push(publishedBaseline);
    const [publishedCandidateProbe, publishedBaselineProbe] = await Promise.all([
      run(ffprobe, [...probeArgs, publishedCandidate], "published candidate probe failed"),
      run(ffprobe, [...probeArgs, publishedBaseline], "published baseline probe failed"),
    ]);
    const publishedClock = verifyClock(JSON.parse(publishedCandidateProbe));
    const publishedBaselineClock = verifyClock(JSON.parse(publishedBaselineProbe));
    assertAlignedClocks(publishedClock, publishedBaselineClock);
    if (publishedClock.ptsSeconds.some((pts, index) => pts !== clock.ptsSeconds[index])) {
      throw new Error("published candidate frame clock changed after output publication");
    }
    await Promise.all([
      run(ffmpeg, ["-v", "error", "-i", publishedCandidate, "-f", "rawvideo", "-pix_fmt", "rgb24", reopenedCandidate], "published candidate reopen failed"),
      run(ffmpeg, ["-v", "error", "-i", publishedBaseline, "-f", "rawvideo", "-pix_fmt", "rgb24", reopenedBaseline], "published baseline reopen failed"),
    ]);
    const [candidatePixels, baselinePixels, candidateBytes, baselineBytes] = await Promise.all([
      readFile(reopenedCandidate), readFile(reopenedBaseline), readFile(publishedCandidate), readFile(publishedBaseline),
    ]);
    if (candidatePixels.length !== pristine.length || baselinePixels.length !== pristine.length) throw new Error("reopened decoded byte count differs from expected frame clock");
    const candidatePsnr = psnr(pristine, candidatePixels);
    const baselinePsnr = psnr(pristine, baselinePixels);
    const manifest = {
      kind: "SYNTHETIC_METRIC_ONLY",
      profile: PROFILE,
      codecToolVersion: VERSION,
      input: { kind: "DETERMINISTIC_SYNTHETIC_RGB", width: WIDTH, height: HEIGHT, frameCount: FRAME_COUNT, frameRate: `${FPS}/1`, pristineSha256: sha256(pristine), noisySha256: sha256(noisy) },
      operation: { filter: FILTER, filterApplication: "single fixed five-frame temporal filter window; thresholds are restrained fixture parameters" },
      clock: { timeBase: `1/${FPS}`, frameRate: `${FPS}/1`, frameCount: FRAME_COUNT, framePtsSeconds: clock.ptsSeconds, baselineFramePtsSeconds: baselineClock.ptsSeconds, probeFrameRate: clock.frameRate, independentlyDecodedByteCount: candidatePixels.length },
      comparison: {
        metric: "PSNR on decoded RGB bytes against generated pristine RGB reference",
        candidateDb: candidatePsnr,
        unfilteredBaselineDb: baselinePsnr,
        differenceDb: candidatePsnr - baselinePsnr,
        status: "SYNTHETIC_METRIC_ONLY",
      },
      outputs: {
        candidate: { file: names.candidate, sha256: sha256(candidateBytes), reopenedRgbSha256: sha256(candidatePixels) },
        baseline: { file: names.baseline, sha256: sha256(baselineBytes), reopenedRgbSha256: sha256(baselinePixels) },
      },
      limitations: [
        "The reference and noisy source are deterministic generated pixels, not authorized or representative real video.",
        "PSNR is a fixture self-comparison only; it establishes no real-world restoration quality, perceptual quality, or codec superiority.",
        "No source rights, model/provider admission, production codec qualification, canonical artifact, delivery receipt, or J-08 completion is established.",
      ],
    };
    await writeFile(join(output, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { outputDir: output, ...names, manifest };
  } catch (error) {
    await Promise.all(publishedFiles.map((file) => rm(file, { force: true })));
    await rm(join(output, "comparison-manifest.json"), { force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await createVideoRestorationComparison({ outputDir: process.argv[2] ?? "build/video-restoration-comparison" });
    console.log(`SYNTHETIC_METRIC_ONLY ${result.outputDir}/${result.candidate} PSNR=${result.manifest.comparison.candidateDb?.toFixed(3) ?? "infinite"} dB`);
  } catch (error) {
    console.error(`${error?.code ?? "COMPARISON_FAILED"}: ${error?.message ?? error}`);
    process.exitCode = error?.code === "CODEC_UNAVAILABLE" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
