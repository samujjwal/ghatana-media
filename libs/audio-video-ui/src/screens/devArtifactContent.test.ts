import { describe, expect, it, vi } from "vitest";
import {
  DEV_CONTENT_MAX_BYTES, DevContentError, describeContentFailure, readVerifiedContent, sha256Hex, type DevArtifactContentReader, type RegisteredArtifact,
} from "./devArtifactContent";

const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 2, 3]);
async function registered(over: Partial<RegisteredArtifact> = {}): Promise<RegisteredArtifact> {
  const sha = await sha256Hex(bytes);
  return { artifactId: "art-1", artifactVersionId: `sha256:${sha}`, contentType: "image/gif", sizeBytes: bytes.byteLength, sha256: sha, ...over };
}
const reader = (response: Partial<Awaited<ReturnType<DevArtifactContentReader["readArtifactContent"]>>> = {}): DevArtifactContentReader & { readArtifactContent: ReturnType<typeof vi.fn> } =>
  ({ readArtifactContent: vi.fn(async () => ({ status: 200, contentType: "image/gif", bytes, ...response })) });

describe("readVerifiedContent", () => {
  it("returns the bytes only after SHA-256, size and type match, asking for the exact version", async () => {
    const art = await registered(); const port = reader();
    const result = await readVerifiedContent(port, art);
    expect(result.bytes).toEqual(bytes);
    expect(result.sha256).toBe(art.sha256);
    expect(port.readArtifactContent).toHaveBeenCalledWith({ artifactId: "art-1", artifactVersionId: art.artifactVersionId, maxBytes: DEV_CONTENT_MAX_BYTES });
  });
  it("accepts a content type with parameters when the base type matches", async () => {
    await expect(readVerifiedContent(reader({ contentType: "Image/GIF; charset=binary" }), await registered())).resolves.toBeTruthy();
  });
  it("rejects a digest mismatch with a typed error", async () => {
    const art = await registered({ sha256: "0".repeat(64) });
    await expect(readVerifiedContent(reader(), art)).rejects.toMatchObject({ code: "CONTENT_DIGEST_MISMATCH" });
  });
  it("rejects a size mismatch and a content-type mismatch", async () => {
    await expect(readVerifiedContent(reader(), await registered({ sizeBytes: 99 }))).rejects.toMatchObject({ code: "CONTENT_SIZE_MISMATCH" });
    await expect(readVerifiedContent(reader({ contentType: "video/mp4" }), await registered())).rejects.toMatchObject({ code: "CONTENT_TYPE_MISMATCH" });
    await expect(readVerifiedContent(reader({ contentType: null }), await registered())).rejects.toMatchObject({ code: "CONTENT_TYPE_MISMATCH" });
  });
  it("refuses an oversize registered size before fetching, and an oversize body after", async () => {
    const port = reader();
    await expect(readVerifiedContent(port, await registered({ sizeBytes: 100 }), { maxBytes: 10 })).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
    expect(port.readArtifactContent).not.toHaveBeenCalled();
    await expect(readVerifiedContent(reader(), await registered({ sizeBytes: null }), { maxBytes: 4 })).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });
  it("rejects a non-200 success status such as a 206 partial body", async () => {
    await expect(readVerifiedContent(reader({ status: 206 }), await registered())).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 206 });
  });
});

describe("describeContentFailure", () => {
  const text = (status: number, code: string): string => describeContentFailure(new DevContentError(code, status, code)).text;
  it("types 404, 412, 403, 416, 400 and ceiling refusals without claiming content exists", () => {
    expect(text(404, "ARTIFACT_NOT_FOUND")).toMatch(/Not found.*Nothing is shown or saved/u);
    expect(text(412, "ARTIFACT_VERSION_MISMATCH")).toMatch(/precondition failed/u);
    expect(text(403, "ARTIFACT_PERMISSION_REQUIRED")).toMatch(/Denied/u);
    expect(text(416, "RANGE_NOT_SATISFIABLE")).toMatch(/whole files only/u);
    expect(text(400, "ARTIFACT_VERSION_REQUIRED")).toMatch(/refused the version request/u);
    expect(text(422, "CONTENT_OVER_CEILING")).toMatch(/does not read byte ranges/u);
    expect(describeContentFailure(new Error("x")).code).toBe("TRANSPORT_ERROR");
  });
});
