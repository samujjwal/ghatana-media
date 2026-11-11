import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertAlignedClocks, createVideoRestorationComparison, verifyClock } from "./compare.mjs";

const ffmpeg = process.env.GHATANA_MEDIA_FFMPEG;
const ffprobe = process.env.GHATANA_MEDIA_FFPROBE;
const havePinnedPair = Boolean(ffmpeg && ffprobe);

const tempDir = () => mkdtemp(join(os.tmpdir(), "media-video-restoration-test-"));

test("clock verification retains observed PTS and rejects candidate-baseline drift", () => {
  const probe = (timestamps) => ({
    streams: [{ codec_type: "video", codec_name: "mpeg4", width: 96, height: 64, r_frame_rate: "10/1", nb_read_frames: "8" }],
    frames: timestamps.map((pts) => ({ media_type: "video", best_effort_timestamp_time: pts })),
  });
  const exactPts = Array.from({ length: 8 }, (_, i) => (i / 10).toFixed(6));
  const candidate = verifyClock(probe(exactPts));
  const baseline = verifyClock(probe(exactPts));
  assert.deepEqual(candidate.ptsSeconds, Array.from({ length: 8 }, (_, i) => i / 10));
  assert.doesNotThrow(() => assertAlignedClocks(candidate, baseline));
  const shiftedBaseline = { ...baseline, ptsSeconds: [...baseline.ptsSeconds] };
  shiftedBaseline.ptsSeconds[3] += 5e-10;
  assert.throws(() => assertAlignedClocks(candidate, shiftedBaseline), /clocks do not align/u);
});

test("clock verification rejects sub-nanosecond schedule drift and malformed PTS", () => {
  const probe = (timestamps) => ({
    streams: [{ codec_type: "video", codec_name: "mpeg4", width: 96, height: 64, r_frame_rate: "10/1", nb_read_frames: "8" }],
    frames: timestamps.map((pts) => ({ media_type: "video", best_effort_timestamp_time: pts })),
  });
  const drifted = Array.from({ length: 8 }, (_, i) => (i / 10).toFixed(6));
  drifted[0] = "0.0000000005";
  assert.throws(() => verifyClock(probe(drifted)), /unexpected frame PTS at ordinal 0/u);

  const malformed = Array.from({ length: 8 }, (_, i) => (i / 10).toFixed(6));
  malformed[4] = "N/A";
  assert.throws(() => verifyClock(probe(malformed)), /unexpected frame PTS at ordinal 4/u);
});

test("pinned codec pair produces independently decoded candidate and synthetic PSNR comparison", { skip: !havePinnedPair }, async () => {
  const parent = await tempDir();
  const output = join(parent, "output");
  try {
    const result = await createVideoRestorationComparison({ outputDir: output, ffmpeg, ffprobe });
    const { manifest } = result;
    assert.equal(manifest.kind, "SYNTHETIC_METRIC_ONLY");
    assert.equal(manifest.clock.frameCount, 8);
    assert.equal(manifest.clock.framePtsSeconds.length, 8);
    assert.deepEqual(manifest.clock.baselineFramePtsSeconds, manifest.clock.framePtsSeconds);
    assert.equal(manifest.clock.independentlyDecodedByteCount, 96 * 64 * 3 * 8);
    assert.ok(Number.isFinite(manifest.comparison.candidateDb));
    assert.ok(Number.isFinite(manifest.comparison.unfilteredBaselineDb));
    const { createHash } = await import("node:crypto");
    for (const key of ["candidate", "baseline"]) {
      const bytes = await readFile(join(output, manifest.outputs[key].file));
      assert.equal(manifest.outputs[key].sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.match(manifest.outputs[key].reopenedRgbSha256, /^[a-f0-9]{64}$/u);
    }
    assert.deepEqual((await readdir(output)).sort(), ["comparison-manifest.json", "restored-candidate.mp4", "unfiltered-baseline.mp4"]);
    assert.match(manifest.limitations.join(" "), /no real-world restoration quality/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("published outputs are removed when the persisted candidate cannot be reopened", { skip: !havePinnedPair }, async () => {
  const parent = await tempDir();
  const output = join(parent, "output");
  const failingProbe = join(parent, "ffprobe-fail-published.mjs");
  try {
    await writeFile(failingProbe, `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nif (process.argv.at(-1)?.endsWith("restored-candidate.mp4")) process.exit(23);\nconst result = spawnSync(${JSON.stringify(ffprobe)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
    await assert.rejects(
      createVideoRestorationComparison({ outputDir: output, ffmpeg, ffprobe: failingProbe }),
      (error) => error.code === "CODEC_UNAVAILABLE" && /published candidate probe failed/u.test(error.message),
    );
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("output collision is rejected without modifying existing files", async () => {
  const parent = await tempDir();
  try {
    await writeFile(join(parent, "existing.txt"), "keep", { flag: "wx" });
    await assert.rejects(createVideoRestorationComparison({ outputDir: parent, ffmpeg: "/missing", ffprobe: "/missing" }), /output directory must be empty/u);
    assert.equal(await readFile(join(parent, "existing.txt"), "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing pinned codec is typed and leaves no generated files", async () => {
  const parent = await tempDir();
  const output = join(parent, "output");
  try {
    await assert.rejects(
      createVideoRestorationComparison({ outputDir: output, ffmpeg: "/does/not/exist/ffmpeg", ffprobe: "/does/not/exist/ffprobe" }),
      (error) => error.code === "CODEC_UNAVAILABLE",
    );
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
