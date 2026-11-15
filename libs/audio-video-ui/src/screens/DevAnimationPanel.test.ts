// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DevAnimationPanel } from "./DevAnimationPanel";
import {
  DevAnimationHostError, describeAnimationFailure, ease, exampleSpec, parseAnimationRenderView, parseAnimationStatus, sampleCurve,
  toRequestSpec, type DevAnimationHostResponse, type DevAnimationPort,
} from "./devAnimation";

beforeAll(() => {
  // jsdom has no 2D canvas; the preview only needs a context whose calls are no-ops.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
});
afterEach(cleanup);

const hex = (c: string): string => c.repeat(64);
const statusBody = (over: { ready?: boolean } = {}): unknown => ({
  scope: "DEV_ONLY", ready: over.ready ?? true, specSchema: "media.dev.animation-spec.v1", text: "NOT_SUPPORTED",
  limits: { maxWidth: 1280, maxHeight: 720, maxFrames: 240, maxFramesPerSecond: 60, maxShapes: 256, maxAssets: 8, maxAnimationPixels: 33554432 },
  primitives: ["RECTANGLE", "ELLIPSE", "LINE", "RASTER_ASSET"], easings: ["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"],
  encoder: { codec: "libx264", defaultCrf: 14, minCrf: 10, maxCrf: 30 }, rightsAuthority: { ready: true, scope: "PROCESSING" },
});
const artifact = (id: string, c: string, type: string): Record<string, unknown> => ({ artifactId: id, artifactVersionId: `sha256:${hex(c)}`,
  contentType: type, sizeBytes: 5, sha256: hex(c) });
const renderBody = (replayed = false, frames = 3): unknown => ({
  schema: "media.dev.animation-render.v1", scope: "DEV_ONLY", renderId: "manifest-1", replayed, note: "DEV_ONLY",
  video: artifact("video-1", "b", "video/mp4"), manifestArtifact: artifact("manifest-1", "c", "application/json"),
  manifest: { profile: { width: 320, height: 180, fpsNumerator: 24, fpsDenominator: 1, frameCount: frames }, frameSetSha256: hex("d"),
    encoder: { crf: 14, tool: "ffmpeg 7.0.2" }, assets: [],
    verification: { codec: "h264", pixelFormat: "yuv420p", averageFrameRate: "24/1", timeBase: "1/12816", ptsExact: true },
    frames: Array.from({ length: frames }, (_, index) => ({ index, ptsNumerator: String(index), ptsDenominator: "24", ptsTicks: index * 534,
      pngSha256: hex("e"), pixelSha256: hex("f") })) },
});
const ok = (status: number, body: unknown): Promise<DevAnimationHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevAnimationPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevAnimationPort> = {}, status: unknown = statusBody()): FakePort {
  return { getStatus: vi.fn(() => ok(200, status)), render: vi.fn(() => ok(201, renderBody())), readArtifactContent: undefined, ...over } as unknown as FakePort;
}
const asPort = (port: FakePort): DevAnimationPort => port as unknown as DevAnimationPort;
const ids = (): (() => string) => { let n = 0; return () => `anim-req-${++n}`; };
async function mounted(port: FakePort, locked = false) {
  render(React.createElement(DevAnimationPanel, { animation: asPort(port), locked, newRequestId: ids() }));
  await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("renders up to"));
}

describe("animation authoring model", () => {
  it("ease matches the renderer's four curves", () => {
    expect(ease("LINEAR", 0.25)).toBe(0.25);
    expect(ease("EASE_IN", 0.5)).toBe(0.25);
    expect(ease("EASE_OUT", 0.5)).toBe(0.75);
    expect(ease("EASE_IN_OUT", 0.25)).toBe(0.125);
    expect(ease("EASE_IN_OUT", 0.75)).toBe(0.875);
  });

  it("samples the example box curve exactly like the easing math", () => {
    const box = exampleSpec().shapes[0]!;
    expect(sampleCurve(box.keyframes, 0)!.x).toBe(0);
    expect(sampleCurve(box.keyframes, 12)!.x).toBeCloseTo(100, 9); // ease-in-out midpoint of 0..200 at t=0.5
    expect(sampleCurve(box.keyframes, 24)!.x).toBe(200);
    expect(sampleCurve(box.keyframes, 47)!.x).toBe(100);
    expect(sampleCurve([], 5)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 });
    expect(sampleCurve([{ ...box.keyframes[0]!, x: "far" }], 0)).toBeNull();
  });

  it("builds the host spec and reports a non-number with its JSON path instead of sending", () => {
    const built = toRequestSpec(exampleSpec());
    expect(built.problems).toEqual([]);
    expect(built.spec).toMatchObject({ width: 320, height: 180, background: "#101828", frameCount: 48, fps: { numerator: 24, denominator: 1 } });
    expect((built.spec.shapes as { keyframes: unknown[] }[])[0]!.keyframes).toHaveLength(3);
    const broken = { ...exampleSpec(), shapes: [{ ...exampleSpec().shapes[0]!, keyframes: [{ ...exampleSpec().shapes[0]!.keyframes[0]!, opacity: "half" }] }] };
    expect(toRequestSpec(broken).problems).toEqual([{ path: "$.shapes[0].keyframes[0].opacity", message: "Enter a number." }]);
    expect(toRequestSpec({ ...exampleSpec(), frameCount: "4.5" }).problems[0]).toEqual({ path: "$.frameCount", message: "Enter a whole number." });
  });

  it("parses status and render views strictly and types every host failure", () => {
    expect(parseAnimationStatus({ status: 200, body: statusBody() }).maxFrames).toBe(240);
    expect(() => parseAnimationStatus({ status: 200, body: { scope: "x" } })).toThrow(DevAnimationHostError);
    expect(parseAnimationRenderView({ status: 201, body: renderBody() }).frames).toHaveLength(3);
    const tampered = renderBody() as { video: { sha256: string } };
    tampered.video.sha256 = "zz";
    expect(() => parseAnimationRenderView({ status: 201, body: tampered })).toThrow(DevAnimationHostError);
    const wrongCount = renderBody(false, 3) as { manifest: { profile: { frameCount: number } } };
    wrongCount.manifest.profile.frameCount = 4;
    expect(() => parseAnimationRenderView({ status: 201, body: wrongCount })).toThrow(DevAnimationHostError);
    const failure = describeAnimationFailure(new DevAnimationHostError("ANIMATION_SPEC_INVALID", 422, "frame must be within range.", { path: "$.shapes[0].keyframes[1].frame" }));
    expect(failure).toMatchObject({ tone: "invalid", path: "$.shapes[0].keyframes[1].frame" });
    expect(describeAnimationFailure(new DevAnimationHostError("RIGHTS_NOT_ADMITTED", 403, "x", { path: "$.assets[0]", verdict: "REVOKED" })).text).toContain("REVOKED");
    expect(describeAnimationFailure(new DevAnimationHostError("ANIMATION_BUDGET_EXCEEDED", 422, "x", { path: "$.frameCount", limit: "frameCount", ceiling: 240, requested: 241 })).text)
      .toContain("requested 241");
    expect(describeAnimationFailure(new DevAnimationHostError("X", 0, "no response")).tone).toBe("unknown");
  });
});

describe("DevAnimationPanel", () => {
  it("reads limits from the host and offers its primitives and easings", async () => {
    await mounted(fakePort());
    expect(document.querySelector("[data-status-line]")!.textContent).toContain("1280 by 720 pixels, 240 frames and 60 frames per second");
    expect(screen.getByText("2D animation")).toBeTruthy();
    expect(screen.getByLabelText("Width (pixels, even)")).toBeTruthy();
    expect(screen.getAllByLabelText("Easing to the next keyframe").length).toBe(6);
  });

  it("fails closed when rendering is not ready", async () => {
    render(React.createElement(DevAnimationPanel, { animation: asPort(fakePort({}, statusBody({ ready: false }))) }));
    await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("not available"));
    expect(screen.getByRole("button", { name: "Render" }).hasAttribute("disabled")).toBe(true);
  });

  it("refuses a non-number locally with its path and focuses the field, sending nothing", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Frame count"), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(document.querySelector("[data-problems]")!.textContent).toContain("$.frameCount");
    expect(document.activeElement).toBe(screen.getByLabelText("Frame count"));
    expect(port.render).not.toHaveBeenCalled();
  });

  it("submits the authored scene, shows the verified result and reuses the request id on a retry of the same scene", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(document.querySelector("[data-render-result]")).toBeTruthy());
    expect(port.render).toHaveBeenCalledTimes(1);
    const sent = port.render.mock.calls[0]![0] as { requestId: string; spec: { shapes: unknown[] }; encoder: { crf: number } };
    expect(sent.requestId).toBe("anim-req-1");
    expect(sent.encoder).toEqual({ crf: 14 });
    expect(sent.spec.shapes).toHaveLength(2);
    expect(document.querySelector("[data-render-summary]")!.textContent).toContain("3 frames of 320 by 180 at 24/1");
    expect(document.querySelector("[data-verification]")!.textContent).toContain("every frame time exact: yes");
    expect(document.querySelectorAll("[data-frame-table] tbody tr")).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Render result" }));
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(port.render).toHaveBeenCalledTimes(2));
    expect((port.render.mock.calls[1]![0] as { requestId: string }).requestId).toBe("anim-req-1");
    fireEvent.change(screen.getByLabelText("Frame count"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(port.render).toHaveBeenCalledTimes(3));
    expect((port.render.mock.calls[2]![0] as { requestId: string }).requestId).toBe("anim-req-2");
  });

  it("shows a typed refusal with its path and moves focus to the offending field", async () => {
    const port = fakePort({ render: vi.fn(() => Promise.reject(new DevAnimationHostError("ANIMATION_SPEC_INVALID", 422, "frame must be within [0, frameCount - 1].",
      { path: "$.shapes[0].keyframes[1].frame" }))) });
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(document.querySelector("[data-failure-code]")).toBeTruthy());
    const failure = document.querySelector("[data-failure-code]")!;
    expect(failure.getAttribute("data-failure-path")).toBe("$.shapes[0].keyframes[1].frame");
    expect(failure.textContent).toContain("Scene not valid");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Frame", { selector: "#animation-shape-0-key-1-frame" })));
    expect(document.querySelector("[data-render-result]")).toBeNull();
  });

  it("is keyboard operable: every control is a native button, input or select", async () => {
    await mounted(fakePort());
    for (const control of Array.from(document.querySelectorAll("button, input, select"))) {
      expect(control.getAttribute("tabindex")).not.toBe("-1");
    }
    fireEvent.click(screen.getByRole("button", { name: "Add a shape" }));
    expect(screen.getByRole("group", { name: /Shape 3/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an image asset" }));
    expect(screen.getByLabelText("Image artifact id")).toBeTruthy();
    expect(document.querySelector("canvas")!.getAttribute("role")).toBe("img");
    expect(document.querySelector("[data-preview-description]")!.textContent).toContain("box:");
  });

  it("plays the video only after the registered SHA-256 matches", async () => {
    const bytes = new TextEncoder().encode("12345");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const body = renderBody() as { video: Record<string, unknown> };
    body.video = { ...body.video, sha256: sha, artifactVersionId: `sha256:${sha}` };
    URL.createObjectURL = vi.fn(() => "blob:video") as never;
    URL.revokeObjectURL = vi.fn() as never;
    const port = fakePort({ render: vi.fn(() => ok(201, body)), readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes })) });
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(document.querySelector("[data-render-result]")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Load the video/u }));
    await waitFor(() => expect(document.querySelector("video[data-verified-preview=animation-video]")).toBeTruthy());
    expect(document.querySelector("[data-playback-status]")!.textContent).toContain(sha);
    // tampered bytes are refused
    cleanup();
    const tampered = fakePort({ render: vi.fn(() => ok(201, body)),
      readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes: new TextEncoder().encode("12346") })) });
    await mounted(tampered);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(document.querySelector("[data-render-result]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Load the video/u }));
    await waitFor(() => expect(document.querySelector("[data-playback-state=failed]")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
  });
});
