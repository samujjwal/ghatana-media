// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevVisionTracksPanel } from "./DevVisionTracksPanel";
import { DevContentError, sha256Hex } from "./devArtifactContent";
import { DevVisionHostError, type DevVisionPort } from "./devVisionTracks";
import { sampleDocument } from "./visionTracksFixture";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
let created: string[] = [];
let revoked: string[] = [];
beforeEach(() => {
  created = []; revoked = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => { const url = `blob:fixture/${created.length}`; created.push(url); return url; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn((url: string) => { revoked.push(url); }) });
});

async function fixture(overrides: { sourceSha?: string; lineageSha?: string; outputSha?: string } = {}) {
  const videoSha = await sha256Hex(videoBytes);
  const document = sampleDocument() as Record<string, any>;
  document.source = { ...document.source, sha256: overrides.sourceSha ?? videoSha, artifactVersionId: `sha256:${videoSha}` };
  const documentBytes = encode(document);
  const outputSha = await sha256Hex(documentBytes);
  const view = {
    schema: "media.dev.vision-output.v1", outputId: "out-1", scope: "DEV_ONLY", replayed: false,
    artifact: { artifactId: "out-1", artifactVersionId: `sha256:${outputSha}`, contentType: "application/json", sizeBytes: documentBytes.byteLength, sha256: overrides.outputSha ?? outputSha },
    lineage: { kind: "LOCAL_VISION_TRACKS", source: { sha256: overrides.lineageSha ?? videoSha, artifactId: "src-1" } },
  };
  return { videoSha, view, documentBytes };
}

function port(f: Awaited<ReturnType<typeof fixture>>, over: Partial<DevVisionPort> = {}): DevVisionPort & { track: ReturnType<typeof vi.fn>; getOutput: ReturnType<typeof vi.fn> } {
  return {
    track: vi.fn(async () => ({ status: 201, body: f.view })),
    getOutput: vi.fn(async () => ({ status: 200, body: f.view })),
    readArtifactContent: vi.fn(async (request: { artifactId: string }) => request.artifactId === "out-1"
      ? { status: 200, contentType: "application/json", bytes: f.documentBytes }
      : { status: 200, contentType: "video/mp4", bytes: videoBytes }),
    ...over,
  } as never;
}

const VERSION = `sha256:${"b".repeat(64)}`;
function fillTrackForm(): void {
  fireEvent.change(screen.getByLabelText("Source artifact ID"), { target: { value: "src-1" } });
  fireEvent.change(screen.getByLabelText("Exact source artifact version"), { target: { value: VERSION } });
}
const submit = (): void => { fireEvent.click(screen.getByRole("button", { name: "Track exact source version" })); };

describe("DevVisionTracksPanel", () => {
  it("tracks an exact version, verifies both byte streams and shows the overlay with the track list", async () => {
    const f = await fixture();
    const vision = port(f);
    render(React.createElement(DevVisionTracksPanel, { vision, newRequestId: () => "req-fixed" }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(screen.getByRole("region", { name: "Tracking result" })).toBeTruthy());
    expect(vision.track).toHaveBeenCalledWith({ requestId: "req-fixed", artifactId: "src-1", artifactVersionId: VERSION, maxFrames: 16 });
    expect(document.getElementById("vision-track-status")!.textContent).toContain("Created (HTTP 201)");
    expect(document.querySelector("video")!.getAttribute("src")).toBe("blob:fixture/0");
    expect(document.querySelector("svg.vto-overlay")).not.toBeNull();
    expect(screen.getByRole("list", { name: "Tracks" }).querySelectorAll("li")).toHaveLength(2);
    expect(document.getElementById("vision-result")!.getAttribute("data-output-id")).toBe("out-1");
    const requests = (vision.readArtifactContent as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as { artifactId: string; artifactVersionId: string });
    expect(requests.map((request) => request.artifactId)).toEqual(["out-1", "src-1"]);
    expect(JSON.stringify(requests)).not.toMatch(/Bearer|token/iu);
  });

  it("reports an unknown outcome without a result and reuses the same request id on retry", async () => {
    const f = await fixture();
    const vision = port(f);
    vision.track.mockRejectedValueOnce(new DevVisionHostError("VISION_OUTCOME_UNKNOWN", 503, "x"));
    let n = 0;
    render(React.createElement(DevVisionTracksPanel, { vision, newRequestId: () => `req-${++n}` }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-tone")).toBe("unknown"));
    expect(document.getElementById("vision-track-status")!.getAttribute("role")).toBe("alert");
    expect(document.getElementById("vision-track-status")!.textContent).toContain("nothing was registered");
    expect(document.getElementById("vision-result")).toBeNull();
    submit();
    await waitFor(() => expect(document.getElementById("vision-result")).not.toBeNull());
    expect(vision.track.mock.calls.map((call) => (call[0] as { requestId: string }).requestId)).toEqual(["req-1", "req-1"]);
    // A changed request is a new attempt with a new request id.
    fireEvent.change(screen.getByLabelText("Frames to sample (1 to 64)"), { target: { value: "8" } });
    submit();
    await waitFor(() => expect(vision.track).toHaveBeenCalledTimes(3));
    expect((vision.track.mock.calls[2]![0] as { requestId: string }).requestId).toBe("req-2");
  });

  it.each([
    [403, "RIGHTS_REVOKED", "denied"], [404, "SOURCE_VERSION_NOT_FOUND", "refused"], [503, "LOCAL_MODEL_NOT_ADMITTED", "unavailable"],
  ] as const)("shows a typed %i refusal and no result", async (status, code, tone) => {
    const f = await fixture();
    const vision = port(f);
    vision.track.mockRejectedValueOnce(new DevVisionHostError(code, status, "refused"));
    render(React.createElement(DevVisionTracksPanel, { vision }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe(code));
    expect(document.getElementById("vision-track-status")!.getAttribute("data-tone")).toBe(tone);
    expect(document.getElementById("vision-result")).toBeNull();
    expect(vision.readArtifactContent).not.toHaveBeenCalled();
  });

  it("does not send malformed input", async () => {
    const f = await fixture();
    const vision = port(f);
    render(React.createElement(DevVisionTracksPanel, { vision }));
    fillTrackForm();
    fireEvent.change(screen.getByLabelText("Exact source artifact version"), { target: { value: "nope" } });
    submit();
    expect(document.getElementById("vision-track-status")!.textContent).toContain("INVALID_REQUEST");
    fireEvent.change(screen.getByLabelText("Exact source artifact version"), { target: { value: VERSION } });
    fireEvent.change(screen.getByLabelText("Frames to sample (1 to 64)"), { target: { value: "65" } });
    submit();
    expect(document.getElementById("vision-track-status")!.textContent).toContain("INVALID_REQUEST");
    fireEvent.click(screen.getByRole("button", { name: "Reopen tracks from the host" }));
    expect(document.getElementById("vision-reopen-status")!.textContent).toContain("INVALID_REQUEST");
    expect(vision.track).not.toHaveBeenCalled();
    expect(vision.getOutput).not.toHaveBeenCalled();
  });

  it("shows nothing when the tracks bytes do not match the registered digest", async () => {
    const f = await fixture({ outputSha: "f".repeat(64) });
    render(React.createElement(DevVisionTracksPanel, { vision: port(f) }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe("CONTENT_DIGEST_MISMATCH"));
    expect(document.querySelector("video")).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("shows nothing when the source video bytes do not match the document's source digest", async () => {
    const f = await fixture({ sourceSha: "c".repeat(64), lineageSha: "c".repeat(64) });
    render(React.createElement(DevVisionTracksPanel, { vision: port(f) }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe("CONTENT_DIGEST_MISMATCH"));
    expect(document.querySelector("video")).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("refuses a document whose source digest differs from its registered lineage", async () => {
    const f = await fixture({ lineageSha: "d".repeat(64) });
    render(React.createElement(DevVisionTracksPanel, { vision: port(f) }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe("TRACKS_LINEAGE_MISMATCH"));
    expect(document.getElementById("vision-result")).toBeNull();
  });

  it("refuses a document with an out-of-frame box", async () => {
    const f = await fixture();
    const bad = sampleDocument() as Record<string, any>;
    bad.source = { ...bad.source, sha256: f.videoSha };
    bad.tracks[0].observations[0].box.x = 600;
    const bytes = encode(bad);
    const outputSha = await sha256Hex(bytes);
    const view = { ...f.view, artifact: { ...f.view.artifact, sha256: outputSha, sizeBytes: bytes.byteLength, artifactVersionId: `sha256:${outputSha}` } };
    const vision = port({ ...f, view, documentBytes: bytes });
    render(React.createElement(DevVisionTracksPanel, { vision }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe("TRACKS_DOCUMENT_INVALID"));
    expect(document.querySelector("video")).toBeNull();
  });

  it("reopens a registered output by id and types a missing one", async () => {
    const f = await fixture();
    const vision = port(f);
    vision.getOutput.mockRejectedValueOnce(new DevVisionHostError("VISION_OUTPUT_NOT_FOUND", 404, "nf"));
    render(React.createElement(DevVisionTracksPanel, { vision }));
    fireEvent.change(screen.getByLabelText("Output ID"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen tracks from the host" }));
    await waitFor(() => expect(document.getElementById("vision-reopen-status")!.getAttribute("data-failure")).toBe("VISION_OUTPUT_NOT_FOUND"));
    fireEvent.change(screen.getByLabelText("Output ID"), { target: { value: "out-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen tracks from the host" }));
    await waitFor(() => expect(document.getElementById("vision-result")!.getAttribute("data-via")).toBe("reopened"));
    expect(document.getElementById("vision-reopen-status")!.textContent).toContain("Reopened output out-1");
    expect(vision.track).not.toHaveBeenCalled();
  });

  it("says so when the host exposes no content route, and revokes the blob URL on unmount", async () => {
    const f = await fixture();
    const noContent = { track: vi.fn(async () => ({ status: 201, body: f.view })), getOutput: vi.fn() } as DevVisionPort;
    const first = render(React.createElement(DevVisionTracksPanel, { vision: noContent }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(document.getElementById("vision-track-status")!.getAttribute("data-failure")).toBe("CONTENT_UNAVAILABLE"));
    first.unmount();
    render(React.createElement(DevVisionTracksPanel, { vision: port(f) }));
    fillTrackForm();
    submit();
    await waitFor(() => expect(created).toHaveLength(1));
    cleanup();
    expect(revoked).toEqual(["blob:fixture/0"]);
    expect(DevContentError).toBeDefined();
  });
});
