// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevVideoComparisonPanel } from "./DevVideoComparisonPanel";
import { VideoWipeComparison } from "./VideoWipeComparison";
import { DevContentError, sha256Hex } from "./devArtifactContent";
import { DevVideoHostError, parseVideoComparisonDocument, type DevVideoPort } from "./devVideoComparison";
import { sampleComparison } from "./videoComparisonFixture";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bytesB = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1]);
const bytesC = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 2]);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
let created: string[] = [];
let revoked: string[] = [];
beforeEach(() => {
  created = []; revoked = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => { const url = `blob:fixture/${created.length}`; created.push(url); return url; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn((url: string) => { revoked.push(url); }) });
  // jsdom does not implement media playback.
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, writable: true, value: vi.fn(async () => undefined) });
});

async function fixture(overrides: { lineageCandidateSha?: string; outputSha?: string } = {}) {
  const shaB = await sha256Hex(bytesB);
  const shaC = await sha256Hex(bytesC);
  const documentBytes = encode(sampleComparison({ sha: { baseline: shaB, candidate: shaC } }));
  const outputSha = await sha256Hex(documentBytes);
  const view = {
    schema: "media.dev.video-comparison.v1", outputId: "cmp-1", scope: "DEV_ONLY", replayed: false,
    artifact: { artifactId: "cmp-1", artifactVersionId: `sha256:${outputSha}`, contentType: "application/json", sizeBytes: documentBytes.byteLength, sha256: overrides.outputSha ?? outputSha },
    lineage: { kind: "VIDEO_QUALITY_COMPARISON", sources: [{ sha256: shaB }, { sha256: overrides.lineageCandidateSha ?? shaC }] },
  };
  return { view, documentBytes };
}

function port(f: Awaited<ReturnType<typeof fixture>>, over: Partial<DevVideoPort> = {}): DevVideoPort & { compare: ReturnType<typeof vi.fn>; getComparison: ReturnType<typeof vi.fn> } {
  return {
    compare: vi.fn(async () => ({ status: 201, body: f.view })),
    getComparison: vi.fn(async () => ({ status: 200, body: f.view })),
    readArtifactContent: vi.fn(async (request: { artifactId: string }) => request.artifactId === "cmp-1"
      ? { status: 200, contentType: "application/json", bytes: f.documentBytes }
      : { status: 200, contentType: "video/mp4", bytes: request.artifactId === "src-b" ? bytesB : bytesC }),
    ...over,
  } as never;
}

const V = (c: string): string => `sha256:${c.repeat(64)}`;
function fill(): void {
  fireEvent.change(screen.getByLabelText("Clean reference artifact ID (optional)"), { target: { value: "ref-1" } });
  fireEvent.change(screen.getByLabelText("Clean reference exact version (optional)"), { target: { value: V("a") } });
  fireEvent.change(screen.getByLabelText("Baseline artifact ID"), { target: { value: "src-b" } });
  fireEvent.change(screen.getByLabelText("Baseline exact version"), { target: { value: V("b") } });
  fireEvent.change(screen.getByLabelText("Candidate artifact ID"), { target: { value: "src-c" } });
  fireEvent.change(screen.getByLabelText("Candidate exact version"), { target: { value: V("c") } });
}
const submit = (): void => { fireEvent.click(screen.getByRole("button", { name: "Measure exact versions" })); };
const status = (lane: "compare" | "reopen"): HTMLElement => document.getElementById(`video-${lane}-status`)!;

describe("DevVideoComparisonPanel", () => {
  it("measures exact versions, verifies every byte stream and shows aggregates, wipe player and chart", async () => {
    const f = await fixture();
    const video = port(f);
    render(React.createElement(DevVideoComparisonPanel, { video, newRequestId: () => "req-fixed" }));
    fill();
    submit();
    await waitFor(() => expect(screen.getByRole("region", { name: "Comparison result" })).toBeTruthy());
    expect(video.compare).toHaveBeenCalledWith({
      requestId: "req-fixed", reference: { artifactId: "ref-1", artifactVersionId: V("a") },
      subjects: [{ label: "baseline", artifactId: "src-b", artifactVersionId: V("b") }, { label: "candidate", artifactId: "src-c", artifactVersionId: V("c") }],
    });
    expect(status("compare").textContent).toContain("Measured (HTTP 201)");
    const aggregates = screen.getByRole("table", { name: "Measured aggregates" });
    expect(within(aggregates).getAllByRole("row")).toHaveLength(3);
    const requests = (video.readArtifactContent as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { artifactId: string }).artifactId);
    expect(requests).toEqual(["cmp-1", "src-b", "src-c"]);
    expect(document.querySelectorAll("video")).toHaveLength(2);
    expect(JSON.stringify((video.readArtifactContent as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/Bearer|token/iu);
  });

  it("refuses a comparison document whose subject digests differ from its registered lineage", async () => {
    const f = await fixture({ lineageCandidateSha: "d".repeat(64) });
    render(React.createElement(DevVideoComparisonPanel, { video: port(f) }));
    fill();
    submit();
    await waitFor(() => expect(status("compare").getAttribute("data-failure")).toBe("COMPARISON_LINEAGE_MISMATCH"));
    expect(document.getElementById("video-result")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("refuses bytes that do not match the registered SHA-256 and shows nothing", async () => {
    const f = await fixture();
    const video = port(f, {
      readArtifactContent: vi.fn(async (request: { artifactId: string }) => request.artifactId === "cmp-1"
        ? { status: 200, contentType: "application/json", bytes: f.documentBytes }
        : { status: 200, contentType: "video/mp4", bytes: new Uint8Array([9, 9, 9]) }) as never,
    });
    render(React.createElement(DevVideoComparisonPanel, { video }));
    fill();
    submit();
    await waitFor(() => expect(status("compare").getAttribute("data-state")).toBe("failed"));
    expect(status("compare").textContent).toContain("CONTENT_");
    expect(document.getElementById("video-result")).toBeNull();
  });

  it("reports an unknown outcome and reuses the same request id on retry", async () => {
    const f = await fixture();
    const video = port(f);
    video.compare.mockRejectedValueOnce(new DevVideoHostError("OUTCOME_UNKNOWN", 0, "x"));
    let n = 0;
    render(React.createElement(DevVideoComparisonPanel, { video, newRequestId: () => `req-${++n}` }));
    fill();
    submit();
    await waitFor(() => expect(status("compare").getAttribute("data-tone")).toBe("unknown"));
    expect(status("compare").getAttribute("role")).toBe("alert");
    expect(status("compare").textContent).toContain("nothing was registered");
    expect(document.getElementById("video-result")).toBeNull();
    submit();
    await waitFor(() => expect(document.getElementById("video-result")).not.toBeNull());
    expect(video.compare.mock.calls.map((call) => (call[0] as { requestId: string }).requestId)).toEqual(["req-1", "req-1"]);
  });

  it.each([
    [403, "RIGHTS_REVOKED", "denied"], [404, "SOURCE_VERSION_NOT_FOUND", "refused"], [422, "SOURCE_VIDEO_CORRUPT", "refused"], [503, "RIGHTS_AUTHORITY_UNAVAILABLE", "unavailable"],
  ] as const)("shows a typed %i refusal and fetches nothing", async (code, name, tone) => {
    const f = await fixture();
    const video = port(f);
    video.compare.mockRejectedValueOnce(new DevVideoHostError(name, code, "refused"));
    render(React.createElement(DevVideoComparisonPanel, { video }));
    fill();
    submit();
    await waitFor(() => expect(status("compare").getAttribute("data-failure")).toBe(name));
    expect(status("compare").getAttribute("data-tone")).toBe(tone);
    expect(video.readArtifactContent).not.toHaveBeenCalled();
  });

  it("does not send malformed input and requires both reference fields together", async () => {
    const f = await fixture();
    const video = port(f);
    render(React.createElement(DevVideoComparisonPanel, { video }));
    fill();
    fireEvent.change(screen.getByLabelText("Clean reference exact version (optional)"), { target: { value: "" } });
    submit();
    expect(status("compare").getAttribute("data-failure")).toBe("INVALID_REQUEST");
    fireEvent.change(screen.getByLabelText("Clean reference artifact ID (optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Candidate exact version"), { target: { value: "latest" } });
    submit();
    expect(status("compare").getAttribute("data-failure")).toBe("INVALID_REQUEST");
    expect(video.compare).not.toHaveBeenCalled();
  });

  it("sends no reference when none is entered and reports a no-reference result honestly", async () => {
    const f = await fixture();
    const video = port(f);
    render(React.createElement(DevVideoComparisonPanel, { video, newRequestId: () => "r" }));
    fill();
    fireEvent.change(screen.getByLabelText("Clean reference artifact ID (optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Clean reference exact version (optional)"), { target: { value: "" } });
    submit();
    await waitFor(() => expect(video.compare).toHaveBeenCalled());
    expect((video.compare.mock.calls[0]![0] as Record<string, unknown>).reference).toBeUndefined();
  });

  it("reopens by id, and reports a missing content route without showing anything", async () => {
    const f = await fixture();
    const video = port(f, { readArtifactContent: undefined });
    render(React.createElement(DevVideoComparisonPanel, { video }));
    fireEvent.change(screen.getByLabelText("Output ID"), { target: { value: "cmp-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen comparison from the host" }));
    await waitFor(() => expect(status("reopen").getAttribute("data-state")).toBe("failed"));
    expect(status("reopen").textContent).toContain("CONTENT_UNAVAILABLE");
    cleanup();
    const ok = port(f);
    render(React.createElement(DevVideoComparisonPanel, { video: ok }));
    fireEvent.change(screen.getByLabelText("Output ID"), { target: { value: "cmp-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen comparison from the host" }));
    await waitFor(() => expect(document.getElementById("video-result")!.getAttribute("data-via")).toBe("reopened"));
  });

  it("revokes object URLs it created when it unmounts", async () => {
    const f = await fixture();
    render(React.createElement(DevVideoComparisonPanel, { video: port(f) }));
    fill();
    submit();
    await waitFor(() => expect(document.getElementById("video-result")).not.toBeNull());
    cleanup();
    expect(revoked.sort()).toEqual([...created].sort());
    expect(DevContentError).toBeDefined();
  });
});

describe("VideoWipeComparison", () => {
  const doc = parseVideoComparisonDocument(sampleComparison());
  const urls = { degraded: "blob:fixture/degraded", enhanced: "blob:fixture/enhanced" };
  const mount = (): void => { render(React.createElement(VideoWipeComparison, { document: doc, videoUrls: urls })); };

  it("has a keyboard-operable wipe slider with a text alternative and clips the candidate by its value", () => {
    mount();
    const slider = screen.getByRole("slider", { name: /Wipe position: 50% shows enhanced/ });
    expect(slider.getAttribute("aria-valuetext")).toBe("50% enhanced, 50% degraded");
    fireEvent.change(slider, { target: { value: "25" } });
    expect(screen.getByRole("slider", { name: /Wipe position: 25%/ }).getAttribute("aria-valuetext")).toBe("25% enhanced, 75% degraded");
    const candidatePane = document.querySelector(".vwc-cand") as HTMLElement;
    expect(candidatePane.style.clipPath).toBe("inset(0 75% 0 0)");
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    expect(document.querySelector(".vwc-stage")!.className).toContain("vwc-side");
    expect(screen.queryByRole("slider", { name: /Wipe position/ })).toBeNull();
    expect((document.querySelector(".vwc-cand") as HTMLElement).style.clipPath).toBe("");
  });

  it("steps frame by frame on the exact measured times and announces both subjects' numbers", () => {
    mount();
    const status = document.getElementById("vwc-frame-status")!;
    expect(status.textContent).toContain("Frame 1 of 6 at 0.000 s");
    expect(status.textContent).toContain("degraded: PSNR 24.10 dB");
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    expect(status.getAttribute("data-frame-index")).toBe("1");
    expect(status.textContent).toContain("at 0.040 s");
    const videos = document.querySelectorAll("video");
    expect((videos[0] as HTMLVideoElement).currentTime).toBeCloseTo(0.042, 3);
    expect((videos[1] as HTMLVideoElement).currentTime).toBeCloseTo(0.042, 3);
    fireEvent.change(screen.getByRole("slider", { name: "Frame" }), { target: { value: "3" } });
    expect(status.textContent).toContain("enhanced: PSNR 24.00 dB");
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    expect(status.getAttribute("data-frame-index")).toBe("0");
  });

  it("plots exactly the measured numbers, marks the frame where the candidate is worse and states the verdict", () => {
    mount();
    const chart = document.querySelector("svg.vwc-chart")!;
    expect(chart.getAttribute("role")).toBe("img");
    expect(chart.getAttribute("aria-label")).toContain("PSNR (luma) per frame for degraded, enhanced");
    expect(chart.querySelectorAll("path.vwc-line")).toHaveLength(2);
    const worse = chart.querySelectorAll("rect.vwc-worse");
    expect(worse).toHaveLength(1);
    expect(worse[0]!.getAttribute("data-frame")).toBe("3");
    const verdict = document.getElementById("vwc-verdict")!;
    expect(verdict.getAttribute("data-verdict")).toBe("IMPROVED");
    expect(verdict.textContent).toContain("PSNR better in 5, worse in 1");
    // Switching metric re-plots; the no-reference metrics have no regression markers.
    fireEvent.click(screen.getByRole("radio", { name: /Noise sigma estimate/ }));
    expect(chart.getAttribute("data-metric")).toBe("noiseSigmaY");
    expect(chart.querySelectorAll("rect.vwc-worse")).toHaveLength(0);
    // The data table is an accessible alternative with one row per frame.
    expect(document.querySelectorAll(".vwc-table tbody tr")).toHaveLength(6);
  });

  it("leaves unmeasured frames as gaps and offers no reference metrics when none was supplied", () => {
    const noRef = parseVideoComparisonDocument(sampleComparison({ reference: false }));
    render(React.createElement(VideoWipeComparison, { document: noRef, videoUrls: urls }));
    expect(screen.queryByRole("radio", { name: /PSNR/ })).toBeNull();
    expect(document.querySelector("svg.vwc-chart")!.getAttribute("data-metric")).toBe("noiseSigmaY");
    expect(document.getElementById("vwc-verdict")!.textContent).toContain("No reference was supplied, so no PSNR or SSIM is reported");
  });

  it("shows only the measured numbers when the verified video bytes are not available", () => {
    render(React.createElement(VideoWipeComparison, { document: doc, videoUrls: {} }));
    expect(screen.getByRole("alert").textContent).toContain("only the measured numbers are shown");
    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByRole("button", { name: "Next frame" }).hasAttribute("disabled")).toBe(true);
  });
});
