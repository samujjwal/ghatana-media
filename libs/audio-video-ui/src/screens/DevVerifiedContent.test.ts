// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevVerifiedContent } from "./DevVerifiedContent";
import { DevContentError, sha256Hex, type DevArtifactContentReader, type RegisteredArtifact } from "./devArtifactContent";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
let created: string[] = []; let revoked: string[] = [];
beforeEach(() => {
  created = []; revoked = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => { const url = `blob:fixture/${created.length}`; created.push(url); return url; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn((url: string) => { revoked.push(url); }) });
});
async function art(contentType: string, over: Partial<RegisteredArtifact> = {}): Promise<RegisteredArtifact> {
  const sha = await sha256Hex(bytes);
  return { artifactId: "art-1", artifactVersionId: `sha256:${sha}`, contentType, sizeBytes: bytes.byteLength, sha256: sha, ...over };
}
const okReader = (contentType: string): DevArtifactContentReader & { readArtifactContent: ReturnType<typeof vi.fn> } =>
  ({ readArtifactContent: vi.fn(async () => ({ status: 200, contentType, bytes })) });
const failingReader = (status: number, code: string): DevArtifactContentReader => ({ readArtifactContent: vi.fn(() => Promise.reject(new DevContentError(code, status, code))) });
const click = (name: RegExp): void => { fireEvent.click(screen.getByRole("button", { name })); };

describe("DevVerifiedContent", () => {
  it.each([["gif", "image/gif", "img"], ["mp4", "video/mp4", "video"], ["wav", "audio/wav", "audio"]] as const)("previews %s only after the bytes verify", async (kind, type, tag) => {
    const reader = okReader(type);
    render(React.createElement(DevVerifiedContent, { reader, artifact: await art(type), kind }));
    expect(document.querySelector(tag)).toBeNull();
    click(/^Preview/u);
    await waitFor(() => expect(document.querySelector(`${tag}[data-verified-preview="${kind}"]`)).not.toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Bytes verified against the registered version");
    const node = document.querySelector(tag)!;
    expect(node.getAttribute("src")).toBe("blob:fixture/0");
    if (tag !== "img") expect(node.hasAttribute("controls")).toBe(true);
    expect(node.getAttribute(tag === "img" ? "alt" : "aria-label")).toContain("art-1");
    const request = reader.readArtifactContent.mock.calls[0]![0] as { artifactVersionId: string };
    expect(JSON.stringify(request)).not.toMatch(/Bearer|token/iu);
    expect(created).toHaveLength(1);
  });
  it("shows no preview and a typed error on a digest mismatch", async () => {
    render(React.createElement(DevVerifiedContent, { reader: okReader("image/gif"), artifact: await art("image/gif", { sha256: "f".repeat(64) }), kind: "gif" }));
    click(/^Preview/u);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("CONTENT_DIGEST_MISMATCH"));
    expect(document.querySelector("img")).toBeNull();
    expect(created).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).not.toContain("Bytes verified");
  });
  it.each([[404, "ARTIFACT_NOT_FOUND", /Not found/u], [412, "ARTIFACT_VERSION_MISMATCH", /precondition/u], [403, "ARTIFACT_PERMISSION_REQUIRED", /Denied/u], [416, "RANGE_NOT_SATISFIABLE", /byte range/u]] as const)(
    "types a %i refusal and shows nothing", async (status, code, pattern) => {
      render(React.createElement(DevVerifiedContent, { reader: failingReader(status, code), artifact: await art("image/gif"), kind: "gif" }));
      click(/^Preview/u);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(pattern));
      expect(screen.getByRole("alert").textContent).toContain(code);
      expect(document.querySelector("img")).toBeNull();
    });
  it("refuses an oversize registered artifact without fetching", async () => {
    const reader = okReader("image/gif");
    render(React.createElement(DevVerifiedContent, { reader, artifact: await art("image/gif", { sizeBytes: 50_000_000 }), kind: "gif" }));
    click(/^Download/u);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("CONTENT_TOO_LARGE"));
    expect(reader.readArtifactContent).not.toHaveBeenCalled();
  });
  it("downloads only verified bytes as an attachment link, and GLB offers download but no preview", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.href, download: this.download }); });
    render(React.createElement(DevVerifiedContent, { reader: okReader("model/gltf-binary"), artifact: await art("model/gltf-binary"), kind: "glb" }));
    expect(screen.queryByRole("button", { name: /^Preview/u })).toBeNull();
    click(/^Download GLB/u);
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]).toEqual({ href: "blob:fixture/0", download: "art-1.glb" });
    expect(document.querySelector("img, video, audio")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Bytes verified against the registered version");
  });
  it("does not download unverified bytes", async () => {
    const clicks: unknown[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { clicks.push(1); });
    render(React.createElement(DevVerifiedContent, { reader: okReader("model/gltf-binary"), artifact: await art("model/gltf-binary", { sha256: "e".repeat(64) }), kind: "glb" }));
    click(/^Download GLB/u);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("CONTENT_DIGEST_MISMATCH"));
    expect(clicks).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
  it("revokes the preview URL on unmount and says so when the host has no content route", async () => {
    const { unmount } = render(React.createElement(DevVerifiedContent, { reader: okReader("image/gif"), artifact: await art("image/gif"), kind: "gif" }));
    click(/^Preview/u);
    await waitFor(() => expect(created).toHaveLength(1));
    unmount();
    expect(revoked).toEqual(["blob:fixture/0"]);
    cleanup();
    render(React.createElement(DevVerifiedContent, { reader: undefined, artifact: await art("image/gif"), kind: "gif" }));
    expect(screen.getByRole("note").textContent).toContain("no DEV_ONLY content route");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
