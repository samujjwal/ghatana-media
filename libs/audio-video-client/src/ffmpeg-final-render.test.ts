import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PinnedFfmpegFinalRenderMuxer } from "./ffmpeg-final-render.js";
import { orchestrateScenario, type FinalRenderRequest } from "./recorder-orchestrator.js";

const ffmpegPath = process.env.GHATANA_MEDIA_FFMPEG ?? "/home/samujjwal/.local/bin/ffmpeg";
const ffprobePath = process.env.GHATANA_MEDIA_FFPROBE ?? "/home/samujjwal/.local/bin/ffprobe";
const ffmpegSha256 = process.env.GHATANA_MEDIA_FFMPEG_SHA256 ?? "ebf248ee793773ec207c63aa354657ca080328b8d669ceed975590240c90ec04";
const ffprobeSha256 = process.env.GHATANA_MEDIA_FFPROBE_SHA256 ?? "871e88ff30db7b7c99cafcb54dff64b1a14d11217366059aaa36aa8fff0c853d";
const expectedVersion = process.env.GHATANA_MEDIA_FFMPEG_VERSION ?? "6.1.1";
const developmentLicenseProfileRef = process.env.GHATANA_MEDIA_FFMPEG_LICENSE_PROFILE
  ?? "local-development-fixture/gpl-ffmpeg-6.1.1";

async function run(exe: string, args: string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${exe} exited ${code}`)));
  });
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("PinnedFfmpegFinalRenderMuxer", () => {
  it("encodes, decodes, and probes three resolved scene sources with synthetic narration and captions", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-three-scene-render-"));
    try {
      const scenes = ["opening", "middle", "closing"];
      const colors = ["red", "green", "blue"];
      const paths = new Map<string, string>();
      for (let i = 0; i < scenes.length; i += 1) {
        const path = join(root, `${scenes[i]}.webm`);
        await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-f", "lavfi", "-i", `color=c=${colors[i]}:s=160x120:r=30:d=1`, "-an",
          "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "200k",
          "-pix_fmt", "yuv420p", path]);
        paths.set(scenes[i]!, path);
      }
      const narration = join(root, "narration.wav");
      await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=0.5", "-c:a", "pcm_s16le", narration]);
      const scenario = orchestrateScenario({
        scenarioId: "local-three-color-demo", revision: "v1", actors: [],
        scenes: scenes.map((sceneId, index) => ({
          sceneId,
          sourceRef: { kind: "MEDIA_FILE", sourceIdentity: `fixture/${sceneId}`,
            purposeRef: "purpose/local-codec-fixture", exactRightsScope: "rights/synthetic-fixture/v1",
            sourceVersionRef: `${sceneId}@v1`, secretsRef: "secrets/none", frameClockRef: "clock/30fps" },
          actorRefs: [], narration: index === 0 ? [{ atMillis: 200, trackRef: "narration/sine-440@v1" }] : [],
          captionRefs: index === 0 ? ["captions/synthetic@v1"] : [], durationMillis: 1000,
        })),
      });
      const request: FinalRenderRequest = {
        renderId: "render/local-three-color-demo/v1", plan: scenario,
        frameRate: { numerator: 30, denominator: 1 }, variableFrameRate: false,
        timeBase: { numerator: 1, denominator: 90_000 }, durationTicks: 270_000,
        captions: [{ captionRef: "captions/synthetic@v1", startTicks: 18_000, endTicks: 72_000 }],
        creditRefs: [], fileName: "three-color-demo.mp4", retention: "P1D", classification: "INTERNAL",
      };
      const muxer = new PinnedFfmpegFinalRenderMuxer({
        ffmpegPath, ffmpegSha256, ffprobePath, ffprobeSha256, expectedVersion,
        sourceRoot: root,
        resolver: {
          resolveSceneSource: (run) => paths.get(run.sceneId)!,
          resolveNarrationSource: () => narration,
          resolveCaptionText: () => "Synthetic 440 Hz narration cue",
        },
        width: 160, height: 120, developmentLicenseProfileRef,
      });
      const output = await muxer.muxAndVerify(request);
      expect(output.contentType).toBe("video/mp4");
      expect(output.bytes.byteLength).toBeGreaterThan(1000);
      expect(output.probe).toMatchObject({
        frameRate: { numerator: 30, denominator: 1 },
        variableFrameRate: false,
        timeBase: { numerator: 1, denominator: 90_000 },
        durationTicks: 270_000,
        decodedFrameCount: 90,
        audioTrackCount: 1,
        narrationTrackRefs: ["narration/sine-440@v1"],
        captionTrackCount: 1,
        captionTimings: [{ captionRef: "captions/synthetic@v1", startTicks: 18_000, endTicks: 72_000 }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects tool drift and file resolvers that escape the configured source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-render-boundary-"));
    try {
      const source = join(root, "source.mp4");
      await writeFile(source, new Uint8Array([1]));
      const plan = orchestrateScenario({ scenarioId: "s", revision: "v1", actors: [], scenes: [{
        sceneId: "scene", sourceRef: { kind: "MEDIA_FILE", sourceIdentity: "fixture/source",
          purposeRef: "purpose/local", exactRightsScope: "rights/local/v1", sourceVersionRef: "source@v1",
          secretsRef: "secrets/none", frameClockRef: "clock/local" }, actorRefs: [], narration: [],
        captionRefs: [], durationMillis: 1000,
      }] });
      const muxer = new PinnedFfmpegFinalRenderMuxer({ ffmpegPath, ffmpegSha256: digest("wrong"),
        ffprobePath, ffprobeSha256, expectedVersion, sourceRoot: root,
        resolver: { resolveSceneSource: () => source, resolveNarrationSource: () => source,
          resolveCaptionText: () => "caption" }, developmentLicenseProfileRef: "fixture-only" });
      const request: FinalRenderRequest = { renderId: "r", plan, frameRate: { numerator: 30, denominator: 1 },
        variableFrameRate: false, timeBase: { numerator: 1, denominator: 90_000 }, durationTicks: 90_000,
        captions: [], creditRefs: [], fileName: "x.mp4", retention: "P1D", classification: "INTERNAL" };
      await expect(muxer.muxAndVerify(request)).rejects.toThrow(/digest mismatch/u);
      const allowedRoot = join(root, "allowed");
      await mkdir(allowedRoot);
      const outsideSource = join(root, "outside.mp4");
      await writeFile(outsideSource, new Uint8Array([1]));
      // These harmless version-reporting fixtures keep this path-boundary
      // assertion independent from whether the host has the pinned codec's
      // native shared libraries installed.
      const ffmpegStub = `#!/bin/sh\nprintf '%s\\n' 'ffmpeg version ${expectedVersion}'\n`;
      const ffprobeStub = `#!/bin/sh\nprintf '%s\\n' 'ffprobe version ${expectedVersion}'\n`;
      const ffmpegStubPath = join(root, "ffmpeg-fixture");
      const ffprobeStubPath = join(root, "ffprobe-fixture");
      await writeFile(ffmpegStubPath, ffmpegStub, { mode: 0o700 });
      await writeFile(ffprobeStubPath, ffprobeStub, { mode: 0o700 });
      const boundedMuxer = new PinnedFfmpegFinalRenderMuxer({ ffmpegPath: ffmpegStubPath,
        ffmpegSha256: digest(ffmpegStub), ffprobePath: ffprobeStubPath,
        ffprobeSha256: digest(ffprobeStub), expectedVersion, sourceRoot: allowedRoot,
        resolver: { resolveSceneSource: () => outsideSource, resolveNarrationSource: () => outsideSource,
          resolveCaptionText: () => "caption" }, developmentLicenseProfileRef: "fixture-only" });
      await expect(boundedMuxer.muxAndVerify(request)).rejects.toThrow(/outside the configured root/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
