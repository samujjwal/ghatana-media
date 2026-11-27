import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("refuses opaque closing credit refs before starting the local codec", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-render-credit-boundary-"));
    try {
      const source = join(root, "scene.mp4");
      const invocationMarker = join(root, "codec-invoked");
      await writeFile(source, new Uint8Array([1]));
      const ffmpegStub = `#!/bin/sh\nprintf '%s\\n' invoked >> '${invocationMarker}'\nprintf '%s\\n' 'ffmpeg version ${expectedVersion}'\n`;
      const ffprobeStub = `#!/bin/sh\nprintf '%s\\n' 'ffprobe version ${expectedVersion}'\n`;
      const ffmpegStubPath = join(root, "ffmpeg-fixture");
      const ffprobeStubPath = join(root, "ffprobe-fixture");
      await writeFile(ffmpegStubPath, ffmpegStub, { mode: 0o700 });
      await writeFile(ffprobeStubPath, ffprobeStub, { mode: 0o700 });

      const plan = orchestrateScenario({ scenarioId: "credit-boundary", revision: "v1", actors: [], scenes: [{
        sceneId: "scene", sourceRef: { kind: "MEDIA_FILE", sourceIdentity: "fixture/scene",
          purposeRef: "purpose/local-codec-fixture", exactRightsScope: "rights/synthetic-fixture/v1",
          sourceVersionRef: "scene@v1", secretsRef: "secrets/none", frameClockRef: "clock/30fps" },
        actorRefs: [], narration: [], captionRefs: [], durationMillis: 1000,
      }] });
      const request: FinalRenderRequest = {
        renderId: "render/credit-boundary/v1", plan,
        frameRate: { numerator: 30, denominator: 1 }, variableFrameRate: false,
        timeBase: { numerator: 1, denominator: 90_000 }, durationTicks: 90_000,
        captions: [], creditRefs: ["credits/unresolved@v1"], fileName: "credits.mp4",
        retention: "P1D", classification: "INTERNAL",
      };
      const muxer = new PinnedFfmpegFinalRenderMuxer({
        ffmpegPath: ffmpegStubPath, ffmpegSha256: digest(ffmpegStub),
        ffprobePath: ffprobeStubPath, ffprobeSha256: digest(ffprobeStub), expectedVersion,
        sourceRoot: root,
        resolver: {
          resolveSceneSource: () => source,
          resolveNarrationSource: () => source,
          resolveCaptionText: () => "Unused caption",
        },
        developmentLicenseProfileRef: "fixture-only",
      });

      await expect(muxer.muxAndVerify(request)).rejects.toThrow("unsupported local render profile");
      expect(existsSync(invocationMarker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects 64 scenes plus a generated caption input before encode", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-render-input-bound-"));
    try {
      const source = join(root, "scene.mp4");
      const encodeMarker = join(root, "encode-invoked");
      await writeFile(source, new Uint8Array([1]));
      const ffmpegStub = `#!/bin/sh\nif [ "$1" = "-version" ]; then\n  printf '%s\\n' 'ffmpeg version ${expectedVersion}'\nelse\n  printf '%s\\n' 'encode invoked' > '${encodeMarker}'\nfi\n`;
      const ffprobeStub = `#!/bin/sh\nprintf '%s\\n' 'ffprobe version ${expectedVersion}'\n`;
      const ffmpegStubPath = join(root, "ffmpeg-fixture");
      const ffprobeStubPath = join(root, "ffprobe-fixture");
      await writeFile(ffmpegStubPath, ffmpegStub, { mode: 0o700 });
      await writeFile(ffprobeStubPath, ffprobeStub, { mode: 0o700 });

      const plan = orchestrateScenario({
        scenarioId: "render-input-bound", revision: "v1", actors: [],
        scenes: Array.from({ length: 64 }, (_, index) => ({
          sceneId: `scene-${index}`,
          sourceRef: { kind: "MEDIA_FILE", sourceIdentity: `fixture/scene-${index}`,
            purposeRef: "purpose/local-codec-fixture", exactRightsScope: "rights/synthetic-fixture/v1",
            sourceVersionRef: `scene-${index}@v1`, secretsRef: "secrets/none", frameClockRef: "clock/30fps" },
          actorRefs: [], narration: [], captionRefs: [], durationMillis: 1000,
        })),
      });
      const request: FinalRenderRequest = {
        renderId: "render/input-bound/v1", plan,
        frameRate: { numerator: 30, denominator: 1 }, variableFrameRate: false,
        timeBase: { numerator: 1, denominator: 90_000 }, durationTicks: 64 * 90_000,
        captions: [{ captionRef: "captions/synthetic@v1", startTicks: 0, endTicks: 90_000 }],
        creditRefs: [], fileName: "bounded.mp4", retention: "P1D", classification: "INTERNAL",
      };
      const muxer = new PinnedFfmpegFinalRenderMuxer({
        ffmpegPath: ffmpegStubPath, ffmpegSha256: digest(ffmpegStub),
        ffprobePath: ffprobeStubPath, ffprobeSha256: digest(ffprobeStub), expectedVersion,
        sourceRoot: root,
        resolver: {
          resolveSceneSource: () => source,
          resolveNarrationSource: () => source,
          resolveCaptionText: () => "Synthetic caption",
        },
        developmentLicenseProfileRef: "fixture-only",
      });

      await expect(muxer.muxAndVerify(request)).rejects.toThrow(/render input count exceeds bound/u);
      expect(existsSync(encodeMarker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops an active codec child and waits for its close before returning cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-render-abort-"));
    const childPidPath = join(root, "encoder.pid");
    const ffmpegStub = `#!/bin/sh\nif [ "$1" = "-version" ]; then\n  printf '%s\\n' 'ffmpeg version ${expectedVersion}'\nelse\n  printf '%s\\n' "$$" > '${childPidPath}'\n  exec sleep 60\nfi\n`;
    const ffprobeStub = `#!/bin/sh\nprintf '%s\\n' 'ffprobe version ${expectedVersion}'\n`;
    const ffmpegStubPath = join(root, "ffmpeg-fixture");
    const ffprobeStubPath = join(root, "ffprobe-fixture");
    const source = join(root, "scene.mp4");
    await writeFile(ffmpegStubPath, ffmpegStub, { mode: 0o700 });
    await writeFile(ffprobeStubPath, ffprobeStub, { mode: 0o700 });
    await writeFile(source, new Uint8Array([1]));

    const plan = orchestrateScenario({ scenarioId: "abort", revision: "v1", actors: [], scenes: [{
      sceneId: "scene", sourceRef: { kind: "MEDIA_FILE", sourceIdentity: "fixture/scene",
        purposeRef: "purpose/local-codec-fixture", exactRightsScope: "rights/synthetic-fixture/v1",
        sourceVersionRef: "scene@v1", secretsRef: "secrets/none", frameClockRef: "clock/30fps" },
      actorRefs: [], narration: [], captionRefs: [], durationMillis: 1000,
    }] });
    const request: FinalRenderRequest = {
      renderId: "render/abort/v1", plan,
      frameRate: { numerator: 30, denominator: 1 }, variableFrameRate: false,
      timeBase: { numerator: 1, denominator: 90_000 }, durationTicks: 90_000,
      captions: [], creditRefs: [], fileName: "abort.mp4", retention: "P1D", classification: "INTERNAL",
    };
    const muxer = new PinnedFfmpegFinalRenderMuxer({
      ffmpegPath: ffmpegStubPath, ffmpegSha256: digest(ffmpegStub),
      ffprobePath: ffprobeStubPath, ffprobeSha256: digest(ffprobeStub), expectedVersion,
      sourceRoot: root,
      resolver: {
        resolveSceneSource: () => source,
        resolveNarrationSource: () => source,
        resolveCaptionText: () => "Unused caption",
      },
      developmentLicenseProfileRef: "fixture-only",
    });
    const controller = new AbortController();
    const muxPromise = muxer.muxAndVerify(request, controller.signal);
    const muxSettlement = muxPromise.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );

    try {
      const deadline = Date.now() + 3_000;
      let muxFinished = false;
      void muxSettlement.then(() => { muxFinished = true; });
      while (!existsSync(childPidPath) && !muxFinished && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      if (!existsSync(childPidPath)) {
        const settlement = await muxSettlement;
        const error = settlement.state === "rejected" && settlement.error instanceof Error
          ? `${settlement.error.name}: ${settlement.error.message}` : settlement.state;
        throw new Error(`mux ended before its codec child became active: ${error}`);
      }
      expect(existsSync(childPidPath)).toBe(true);
      const childPid = Number(await readFile(childPidPath, "utf8"));
      controller.abort();
      await expect(muxSettlement).resolves.toMatchObject({ state: "rejected", error: { name: "AbortError" } });
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      controller.abort();
      await muxSettlement;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

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
