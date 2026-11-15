// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DevRegionEditPanel } from "./DevRegionEditPanel";
import {
  DevRegionEditHostError, describeRegionFailure, frameAt, parseRegionEditStatus, parseRegionLineage, parseRegionOutcome,
  type DevRegionEditHostResponse, type DevRegionEditPort,
} from "./devRegionEdit";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
});
afterEach(cleanup);

const hex = (c: string): string => c.repeat(64);
const statusBody = (ready = true): unknown => ({ scope: "DEV_ONLY", ready, schema: "media.dev.region-edit.v1", effects: ["BLUR", "PIXELATE", "FILL"],
  limits: { maxFrames: 600, maxPaddingPx: 64, maxBlockSize: 64, maxBlurRadius: 32, crfRange: [0, 30] }, encoder: { lossyOutsideMinPsnrDb: 30 } });
const version = (n: number, kind: string, c: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  versionNumber: n, kind, requestId: `req-${n}`, parentVersionNumber: n === 1 ? null : n - 1, restoresVersionNumber: null,
  artifact: { artifactId: `art-${c}`, artifactVersionId: `sha256:${hex(c)}`, sha256: hex(c), sizeBytes: 5 }, detail: {}, ...extra });
const lineageBody = (versions: Record<string, unknown>[], undo: boolean, extra: Record<string, unknown> = {}): unknown => ({
  scope: "DEV_ONLY", lineageId: "L1", headVersion: versions.length, undoAvailable: undo, versions, ...extra });
const manifest = (): unknown => ({
  videoGeometry: { width: 64, height: 48, timeBase: { num: 1, den: 10240 } }, maskedFrames: 2, effect: { type: "PIXELATE" }, encoder: { crf: 0 },
  drift: { observations: 3, maxGapFrames: 2, maxCenterErrorPx: 1.5, meanCenterErrorPx: 1.5, minIou: 0.9 },
  verification: { ptsExact: true, outsideLossless: true, outsideMaxAbsDiff: 0, outsidePsnrDb: "INFINITE", insideChangedSamples: 40, frameCount: 3 },
  frames: [{ frameIndex: 0, pts: 0, source: "NONE", mask: null }, { frameIndex: 1, pts: 1024, source: "OBSERVED", mask: { x: 2, y: 4, width: 20, height: 10 } },
    { frameIndex: 2, pts: 5120, source: "INTERPOLATED", mask: { x: 8, y: 4, width: 20, height: 10 } }] });
const base = version(1, "BASE", "a");
const editBody = (replayed = false): unknown => lineageBodyWith(replayed);
function lineageBodyWith(replayed: boolean): unknown {
  const v2 = version(2, "EDIT", "b", { manifestArtifact: { artifactId: "man-1", artifactVersionId: `sha256:${hex("c")}` } });
  return lineageBody([base, v2], true, { version: v2, manifest: manifest(), replayed });
}
const ok = (status: number, body: unknown): Promise<DevRegionEditHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevRegionEditPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevRegionEditPort> = {}, ready = true): FakePort {
  return { getStatus: vi.fn(() => ok(200, statusBody(ready))), createLineage: vi.fn(() => ok(201, lineageBody([base], false, { created: true }))),
    getLineage: vi.fn(() => ok(200, lineageBody([base], false))), edit: vi.fn(() => ok(201, editBody())),
    undo: vi.fn(() => ok(201, lineageBody([base, version(2, "EDIT", "b"), version(3, "UNDO", "a", { restoresVersionNumber: 1, parentVersionNumber: 2 })], false,
      { version: version(3, "UNDO", "a", { restoresVersionNumber: 1, parentVersionNumber: 2 }) }))),
    readArtifactContent: undefined, ...over } as unknown as FakePort;
}
const asPort = (port: FakePort): DevRegionEditPort => port as unknown as DevRegionEditPort;
const ids = (): (() => string) => { let n = 0; return () => `region-req-${++n}`; };
async function mounted(port: FakePort): Promise<void> {
  render(React.createElement(DevRegionEditPanel, { regionEdit: asPort(port), newRequestId: ids() }));
  await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("available"));
}
const fill = (label: string, value: string): void => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); };
async function withLineage(port: FakePort): Promise<void> {
  await mounted(port);
  fill("Lineage id", "L1"); fill("Video artifact id", "art-a"); fill("Exact video version (sha256:…)", `sha256:${hex("a")}`);
  fireEvent.click(screen.getByRole("button", { name: "Create lineage" }));
  await waitFor(() => expect(document.querySelector("[data-version-table]")).toBeTruthy());
}
function fillEdit(): void {
  fill("Tracks artifact id (from video tracking)", "trk"); fill("Exact tracks version (sha256:…)", `sha256:${hex("d")}`); fill("Track id", "t1");
}

describe("region edit parsers", () => {
  it("parses status, lineage and outcome strictly", () => {
    expect(parseRegionEditStatus({ status: 200, body: statusBody() }).maxPaddingPx).toBe(64);
    expect(() => parseRegionEditStatus({ status: 200, body: { scope: "x" } })).toThrow(DevRegionEditHostError);
    expect(parseRegionLineage({ status: 200, body: lineageBody([base], false) }).headVersion).toBe(1);
    expect(() => parseRegionLineage({ status: 200, body: lineageBody([base, version(3, "EDIT", "b")], true) })).toThrow(DevRegionEditHostError);
    const out = parseRegionOutcome({ status: 201, body: editBody() });
    expect(out.manifest!.frames).toHaveLength(3);
    expect(out.manifest!.frames[1]!.seconds).toBeCloseTo(0.1, 9);
    const tampered = editBody() as { versions: { artifact: { sha256: string } }[] };
    tampered.versions[1]!.artifact.sha256 = "zz";
    expect(() => parseRegionOutcome({ status: 201, body: tampered })).toThrow(DevRegionEditHostError);
    const wrongCount = editBody() as { manifest: { verification: { frameCount: number } } };
    wrongCount.manifest.verification.frameCount = 9;
    expect(() => parseRegionOutcome({ status: 201, body: wrongCount })).toThrow(DevRegionEditHostError);
  });

  it("finds the manifest frame shown at a time on a variable-rate timeline", () => {
    const frames = parseRegionOutcome({ status: 201, body: editBody() }).manifest!.frames;
    expect(frameAt(frames, 0.05)!.frameIndex).toBe(0);
    expect(frameAt(frames, 0.1)!.frameIndex).toBe(1);
    expect(frameAt(frames, 0.4)!.frameIndex).toBe(1);
    expect(frameAt(frames, 0.5)!.frameIndex).toBe(2);
  });

  it("types every host failure", () => {
    const stale = describeRegionFailure(new DevRegionEditHostError("STALE_BASE_VERSION", 409, "x", { expectedVersion: 1, headVersion: 2 }));
    expect(stale).toMatchObject({ tone: "conflict", stale: { expected: 1, head: 2 } });
    expect(stale.text).toContain("Reload the lineage");
    expect(describeRegionFailure(new DevRegionEditHostError("RIGHTS_DECISION_REVOKED", 403, "x")).tone).toBe("denied");
    expect(describeRegionFailure(new DevRegionEditHostError("RIGHTS_AUTHORITY_UNAVAILABLE", 503, "x")).tone).toBe("unavailable");
    expect(describeRegionFailure(new DevRegionEditHostError("TRACK_PROVENANCE_UNVERIFIED", 422, "x")).tone).toBe("untrusted");
    expect(describeRegionFailure(new DevRegionEditHostError("NOTHING_TO_UNDO", 409, "x")).tone).toBe("conflict");
    expect(describeRegionFailure(new DevRegionEditHostError("LINEAGE_NOT_FOUND", 404, "x")).tone).toBe("notFound");
    expect(describeRegionFailure(new DevRegionEditHostError("REGION_EDIT_OUTCOME_UNKNOWN", 503, "x")).tone).toBe("unknown");
    expect(describeRegionFailure(new DevRegionEditHostError("REGION_EDIT_REQUEST_ID_REUSED", 409, "x")).tone).toBe("conflict");
    expect(describeRegionFailure(new DevRegionEditHostError("REGION_EDIT_INVALID", 422, "bad", { path: "$.paddingPx" }))).toMatchObject({ tone: "invalid", path: "$.paddingPx" });
    expect(describeRegionFailure(new DevRegionEditHostError("X", 0, "no response")).tone).toBe("unknown");
  });
});

describe("DevRegionEditPanel", () => {
  it("reads limits from the host and fails closed when not ready", async () => {
    await mounted(fakePort());
    expect(document.querySelector("[data-status-line]")!.textContent).toContain("up to 600 frames");
    cleanup();
    render(React.createElement(DevRegionEditPanel, { regionEdit: asPort(fakePort({}, false)) }));
    await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("not available"));
    expect(screen.getByRole("button", { name: "Create lineage" }).hasAttribute("disabled")).toBe(true);
  });

  it("creates the lineage, marks the head and disables undo on the original", async () => {
    const port = fakePort();
    await withLineage(port);
    expect(port.createLineage).toHaveBeenCalledWith({ lineageId: "L1", artifactId: "art-a", artifactVersionId: `sha256:${hex("a")}` });
    const row = document.querySelector("[data-version-number='1']")!;
    expect(row.getAttribute("data-head")).toBe("true");
    expect(row.textContent).toContain("your video");
    expect(screen.getByRole("button", { name: "Undo the last edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("refuses a malformed version locally with its path and sends nothing", async () => {
    const port = fakePort();
    await mounted(port);
    fill("Lineage id", "L1"); fill("Video artifact id", "a"); fill("Exact video version (sha256:…)", "latest");
    fireEvent.click(screen.getByRole("button", { name: "Create lineage" }));
    expect(document.querySelector("[data-problems]") ?? document.querySelector("[role=alert]")).toBeTruthy();
    expect(port.createLineage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("Exact video version (sha256:…)"));
  });

  it("applies an edit against the head it saw, shows the verified manifest and reuses the request id on a retry", async () => {
    const port = fakePort();
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-region-result]")).toBeTruthy());
    const sent = port.edit.mock.calls[0]!;
    expect(sent[0]).toBe("L1");
    expect(sent[1]).toMatchObject({ requestId: "region-req-1", baseVersion: 1, effect: { type: "PIXELATE", blockSize: 8 }, paddingPx: 4,
      encoder: { crf: 0 }, track: { trackId: "t1" } });
    expect(document.querySelector("[data-edit-summary]")!.textContent).toContain("PIXELATE on 2 of 3 frames of 64 by 48");
    expect(document.querySelector("[data-verification]")!.textContent).toContain("bit-identical (lossless)");
    expect(document.querySelector("[data-drift]")!.textContent).toContain("3 observations");
    expect(document.querySelectorAll("[data-mask-table] tbody tr")).toHaveLength(3);
    expect(document.querySelector("[data-version-number='2'][data-version-kind='EDIT']")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Edit registered: version 2" }));
    expect(screen.getByRole("button", { name: "Undo the last edit" }).hasAttribute("disabled")).toBe(false);
    // the head moved to 2, so the next press is a different request
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(port.edit).toHaveBeenCalledTimes(2));
    expect(port.edit.mock.calls[1]![1]).toMatchObject({ requestId: "region-req-2", baseVersion: 2 });
  });

  it("an unknown outcome retries with the SAME request id", async () => {
    const edit = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new DevRegionEditHostError("REGION_EDIT_OUTCOME_UNKNOWN", 503, "unknown")))
      .mockImplementation(() => ok(201, editBody()));
    const port = fakePort({ edit });
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-failure-tone=unknown]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect((edit.mock.calls[0]![1] as { requestId: string }).requestId).toBe((edit.mock.calls[1]![1] as { requestId: string }).requestId);
  });

  it("a stale base is a typed alert, adds no version row, does not retry, and Reload shows the new head", async () => {
    const moved = lineageBody([base, version(2, "EDIT", "b")], true);
    const port = fakePort({
      edit: vi.fn(() => Promise.reject(new DevRegionEditHostError("STALE_BASE_VERSION", 409, "stale", { expectedVersion: 1, headVersion: 2 }))),
      getLineage: vi.fn(() => ok(200, moved)),
    });
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-failure-code=STALE_BASE_VERSION]")).toBeTruthy());
    const failure = document.querySelector("[data-failure-code=STALE_BASE_VERSION]") as HTMLElement;
    expect(failure.textContent).toContain("Sent against version 1; the head is version 2.");
    expect(document.querySelectorAll("[data-version-table] tbody tr")).toHaveLength(1);
    expect(port.edit).toHaveBeenCalledTimes(1);
    fireEvent.click(within(failure).getByRole("button", { name: "Reload lineage" }));
    await waitFor(() => expect(document.querySelectorAll("[data-version-table] tbody tr")).toHaveLength(2));
    expect(port.edit).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-failure-code]")).toBeNull();
  });

  it("undo sends the head it saw and shows the restored artifact digest", async () => {
    const port = fakePort();
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-region-result]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Undo the last edit" }));
    await waitFor(() => expect(document.querySelector("[data-undo-summary]")).toBeTruthy());
    expect(port.undo.mock.calls[0]![1]).toMatchObject({ baseVersion: 2 });
    expect(document.querySelector("[data-head-sha256]")!.textContent).toBe(hex("a"));
    expect(document.querySelector("[data-version-number='3'][data-version-kind='UNDO']")!.textContent).toContain("restores version 1");
  });

  it("shows a denied alert for revoked rights and renders nothing", async () => {
    const port = fakePort({ edit: vi.fn(() => Promise.reject(new DevRegionEditHostError("RIGHTS_DECISION_REVOKED", 403, "no"))) });
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-failure-tone=denied]")).toBeTruthy());
    expect(document.querySelector("[data-region-result]")).toBeNull();
  });

  it("focuses the offending field when the host names a path", async () => {
    const port = fakePort({ edit: vi.fn(() => Promise.reject(new DevRegionEditHostError("REGION_EDIT_INVALID", 422, "too big", { path: "$.paddingPx" }))) });
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Padding around the mask/u)));
  });

  it("plays the video only after the registered SHA-256 matches and draws the manifest mask", async () => {
    const bytes = new TextEncoder().encode("12345");
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    const body = editBody() as { versions: { artifact: Record<string, unknown> }[]; version: { artifact: Record<string, unknown> } };
    for (const entry of [body.versions[1]!, body.version]) entry.artifact = { ...entry.artifact, sha256: sha, artifactVersionId: `sha256:${sha}` };
    URL.createObjectURL = vi.fn(() => "blob:video") as never;
    URL.revokeObjectURL = vi.fn() as never;
    const port = fakePort({ edit: vi.fn(() => ok(201, body)), readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes })) });
    await withLineage(port);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-region-result]")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Load the edited video/u }));
    await waitFor(() => expect(document.querySelector("video[data-verified-preview=region-edit-video]")).toBeTruthy());
    expect(document.querySelector("[data-playback-status]")!.textContent).toContain(sha);
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { value: 0.2, configurable: true });
    fireEvent(video, new Event("seeked"));
    await waitFor(() => expect(document.querySelector("canvas[data-mask-overlay]")!.getAttribute("data-mask")).toBe("2,4,20,10"));
    cleanup();
    const tampered = fakePort({ edit: vi.fn(() => ok(201, body)),
      readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes: new TextEncoder().encode("12346") })) });
    await withLineage(tampered);
    fillEdit();
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    await waitFor(() => expect(document.querySelector("[data-region-result]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Load the edited video/u }));
    await waitFor(() => expect(document.querySelector("[data-playback-state=failed]")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
  });

  it("is keyboard operable: every control is a native button, input or select with a label", async () => {
    await withLineage(fakePort());
    for (const control of Array.from(document.querySelectorAll("button, input, select"))) expect(control.getAttribute("tabindex")).not.toBe("-1");
    for (const control of Array.from(document.querySelectorAll("input, select"))) expect((control as HTMLInputElement).labels!.length).toBeGreaterThan(0);
  });
});
