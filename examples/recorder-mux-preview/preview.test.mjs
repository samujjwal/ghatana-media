import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSourceTimeMapping, createRecorderMuxPreview } from "./preview.mjs";

const ffmpeg = process.env.GHATANA_MEDIA_FFMPEG;
const ffprobe = process.env.GHATANA_MEDIA_FFPROBE;
const havePinnedPair = Boolean(ffmpeg && ffprobe);

async function tempDir() {
  return mkdtemp(join(os.tmpdir(), "media-recorder-preview-test-"));
}

test("source-frame to output PTS mapping preserves exact rational time", () => {
  const mapping = buildSourceTimeMapping("1/15360");
  assert.equal(mapping.frames.length, 30);
  assert.equal(mapping.frames[1].outputPts, 512);
  assert.equal(mapping.frames[29].outputPts, 14_848);
  for (const frame of mapping.frames) {
    assert.equal(BigInt(frame.sourcePts) * 15360n, BigInt(frame.outputPts) * 30n);
  }
  assert.throws(() => buildSourceTimeMapping("1/29"), /cannot represent.*exactly/u);
});

test("pinned software codecs mux/decode local fixture media with exact declared clocks", { skip: !havePinnedPair }, async () => {
  const parent = await tempDir();
  const output = join(parent, "output");
  try {
    const result = await createRecorderMuxPreview({ outputDir: output, ffmpeg, ffprobe });
    assert.equal(result.manifest.kind, "LOCAL_PREVIEW_ONLY");
    assert.equal(result.manifest.source.versionRef, "local-fixture:recorder-mux-preview:v1");
    assert.equal(result.manifest.clocks.video.timeBase, "1/30");
    assert.equal(result.manifest.clocks.audio.sampleCount, 48_000);
    const sourceTimeMapping = result.manifest.sourceTimeMapping;
    assert.equal(sourceTimeMapping.sourceVersionRef, result.manifest.source.versionRef);
    assert.equal(sourceTimeMapping.sourceClockId, result.manifest.clocks.video.clockId);
    assert.equal(sourceTimeMapping.sourceTimeBase, "1/30");
    assert.equal(sourceTimeMapping.outputTimeBase, "1/15360");
    assert.equal(sourceTimeMapping.mapping, "frame-index-preserving-cfr.v1");
    assert.equal(sourceTimeMapping.frames.length, result.manifest.clocks.video.frameCount);
    const [outputNumerator, outputDenominator] = sourceTimeMapping.outputTimeBase.split("/").map(BigInt);
    for (const [frameIndex, mapping] of sourceTimeMapping.frames.entries()) {
      assert.equal(mapping.sourcePts, frameIndex);
      assert.equal(mapping.timeBase, sourceTimeMapping.outputTimeBase);
      assert.equal(BigInt(mapping.sourcePts) * outputDenominator,
        BigInt(mapping.outputPts) * outputNumerator * 30n,
        `source/output PTS must resolve to the same exact time at frame ${frameIndex}`);
    }
    assert.equal(result.manifest.output.ffprobe.videoFrames, 30);
    assert.equal(result.manifest.output.ffprobe.subtitleTrackCount, 1);
    assert.equal(result.manifest.output.ffprobe.independentlyDecoded, true);
    const files = (await readdir(output)).sort();
    assert.deepEqual(files, ["fixture-captions.vtt", "local-preview.mp4", "preview-manifest.json"]);
    const mp4 = await readFile(join(output, "local-preview.mp4"));
    assert.equal(mp4.toString("ascii", 4, 8), "ftyp");
    const manifest = JSON.parse(await readFile(join(output, "preview-manifest.json"), "utf8"));
    assert.equal(manifest.output.sha256, result.sha256);
    assert.equal(createHash("sha256").update(mp4).digest("hex"), manifest.output.sha256,
      "the read-back MP4 bytes must match the manifest digest");
    assert.match(manifest.limitations.join(" "), /not an authorized recording/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("preview never overwrites an existing output directory", async () => {
  const parent = await tempDir();
  try {
    await writeFile(join(parent, "existing.txt"), "preserve", { flag: "wx" });
    await assert.rejects(
      createRecorderMuxPreview({ outputDir: parent, ffmpeg: "/does/not/run", ffprobe: "/does/not/run" }),
      /output directory must be empty/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing pinned tool is typed CODEC_UNAVAILABLE and creates no preview", async () => {
  const parent = await tempDir();
  const output = join(parent, "output");
  try {
    await assert.rejects(
      createRecorderMuxPreview({ outputDir: output, ffmpeg: "/does/not/exist/ffmpeg", ffprobe: "/does/not/exist/ffprobe" }),
      (error) => error.code === "CODEC_UNAVAILABLE",
    );
    await assert.rejects(readdir(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(parent), [], "failed codec preflight leaves no output, stage, or render lock");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
