import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureNotAdmittedError,
  CaptureOutcomeUnknownError,
  captureWithAdmission,
  noAdmittedCaptureAdapter,
  type CaptureAdapterEligibility,
  type CaptureRequest,
} from "./capture-adapters";
import { MediaFileCaptureAdapter } from "./file-capture-adapter";

const admitted: CaptureAdapterEligibility = { check: () => "ADMITTED" };

const request: CaptureRequest = {
  kind: "MEDIA_FILE",
  sourceIdentity: "media-file:clip-9",
  purposeRef: "purpose/v1",
  exactRightsScope: "rights/clip-9/v1",
  sourceVersionRef: "clip-9@v3",
  secretsRef: "secrets/capture-file",
  frameClockRef: "clock/ntsc-30",
};

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "media-file-capture-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MediaFileCaptureAdapter", () => {
  it("captures real file bytes through the admission seam", async () => {
    const dir = await tempDir();
    const payload = new Uint8Array([0, 159, 146, 150, 255, 10, 13]);
    const file = join(dir, "clip.bin");
    await writeFile(file, payload);

    const frame = await captureWithAdmission(admitted,
      new MediaFileCaptureAdapter({ resolveSource: () => file }), request);

    expect(frame.bytes).toEqual(payload);
    expect(frame.sourceIdentity).toBe(request.sourceIdentity);
    expect(frame.purposeRef).toBe(request.purposeRef);
    expect(frame.exactRightsScope).toBe(request.exactRightsScope);
    expect(frame.sourceVersionRef).toBe(request.sourceVersionRef);
    expect(frame.frameClockRef).toBe(request.frameClockRef);
    expect(Number.isSafeInteger(frame.capturedAtEpochMillis)).toBe(true);
  });

  it("returns real bytes on a direct adapter call without the wrapper", async () => {
    const dir = await tempDir();
    const file = join(dir, "clip.bin");
    await writeFile(file, "direct-file-bytes");
    const frame = await new MediaFileCaptureAdapter({ resolveSource: () => file }).capture(request);
    expect(new TextDecoder().decode(frame.bytes)).toBe("direct-file-bytes");
  });

  it("passes the admitted request to the host resolver", async () => {
    const dir = await tempDir();
    const file = join(dir, "clip.bin");
    await writeFile(file, "resolved");
    let seen: CaptureRequest | undefined;
    const adapter = new MediaFileCaptureAdapter({
      resolveSource: (candidate) => {
        seen = candidate;
        return file;
      },
    });
    await captureWithAdmission(admitted, adapter, request);
    expect(seen).toMatchObject({
      kind: "MEDIA_FILE",
      sourceIdentity: request.sourceIdentity,
      sourceVersionRef: request.sourceVersionRef,
    });
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("confines resolved sources to allowedRoot including symlink escapes", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const insideFile = join(root, "inside.bin");
    const outsideFile = join(outside, "outside.bin");
    const linkFile = join(root, "link.bin");
    await writeFile(insideFile, "inside-bytes");
    await writeFile(outsideFile, "outside-bytes");
    await symlink(outsideFile, linkFile);

    const adapter = new MediaFileCaptureAdapter({
      resolveSource: (candidate) => candidate.sourceIdentity === "media-file:inside"
        ? insideFile
        : candidate.sourceIdentity === "media-file:escape"
          ? outsideFile
          : linkFile,
      allowedRoot: root,
    });

    const insideFrame = await captureWithAdmission(admitted, adapter,
      { ...request, sourceIdentity: "media-file:inside" });
    expect(new TextDecoder().decode(insideFrame.bytes)).toBe("inside-bytes");

    for (const sourceIdentity of ["media-file:escape", "media-file:link"]) {
      await expect(captureWithAdmission(admitted, adapter,
        { ...request, sourceIdentity }))
        .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
    }
  });

  it("rejects missing files, directories and oversize files as UNKNOWN", async () => {
    const dir = await tempDir();
    const subdir = join(dir, "nested");
    await mkdir(subdir);
    const big = join(dir, "big.bin");
    await writeFile(big, Buffer.alloc(32, 1));

    const resolveTo = new Map<string, string>([
      ["media-file:missing", join(dir, "absent.bin")],
      ["media-file:dir", subdir],
      ["media-file:big", big],
    ]);
    const adapter = new MediaFileCaptureAdapter({
      resolveSource: (candidate) => resolveTo.get(candidate.sourceIdentity)!,
      maxBytes: 8,
    });

    for (const sourceIdentity of ["media-file:missing", "media-file:dir", "media-file:big"]) {
      await expect(captureWithAdmission(admitted, adapter,
        { ...request, sourceIdentity }))
        .rejects.toBeInstanceOf(CaptureOutcomeUnknownError);
    }
  });

  it("rejects an empty file through frame validation as UNKNOWN", async () => {
    const dir = await tempDir();
    const file = join(dir, "empty.bin");
    await writeFile(file, Buffer.alloc(0));
    await expect(captureWithAdmission(admitted,
      new MediaFileCaptureAdapter({ resolveSource: () => file }), request))
      .rejects.toMatchObject({ reason: "INVALID_FRAME" });
  });

  it("rejects malformed resolved paths without exposing them", async () => {
    const adapter = new MediaFileCaptureAdapter({
      resolveSource: () => `relative-path-${"x".repeat(5_000)}`,
    });
    await expect(captureWithAdmission(admitted, adapter, request))
      .rejects.toMatchObject({ reason: "ADAPTER_REJECTED" });
  });

  it("does not resolve when eligibility denies the request", async () => {
    let resolveCalls = 0;
    const adapter = new MediaFileCaptureAdapter({
      resolveSource: () => {
        resolveCalls += 1;
        return "/nonexistent";
      },
    });
    await expect(captureWithAdmission(noAdmittedCaptureAdapter, adapter, request))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
    expect(resolveCalls).toBe(0);
  });

  it("rejects a request kind outside MEDIA_FILE before resolving", async () => {
    let resolveCalls = 0;
    const adapter = new MediaFileCaptureAdapter({
      resolveSource: () => {
        resolveCalls += 1;
        return "/nonexistent";
      },
    });
    await expect(adapter.capture({ ...request, kind: "HTTP_API" }))
      .rejects.toThrow(/kind does not match/u);
    expect(resolveCalls).toBe(0);
  });
});
