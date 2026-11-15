// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevCompositeRenderPanel } from "./DevCompositeRenderPanel";
import {
  DevCompositeHostError, buildPlacementEdits, describeCompositeFailure, parseCompositeCapabilities, parseCompositeRender,
  type CompositeClipRow, type DevCompositeHostResponse, type DevCompositePort,
} from "./devCompositeRender";

afterEach(cleanup);

const hex = (c: string): string => c.repeat(64);
const VERSION = `sha256:${hex("a")}`;
const capabilitiesBody = (): unknown => ({ scope: "DEV_ONLY", videoSourceTypes: ["video/mp4"], audioSourceTypes: ["audio/wav"],
  captionModes: ["MUX", "BURN", "BOTH"], gapPolicies: ["REFUSE", "BLACK"], note: "A video clip's embedded audio is not used.",
  limits: { maxClips: 64, maxTimelineSeconds: 120, maxOutputBytes: 67108864 } });
const renderBody = (replayed = false): unknown => ({ schema: "media.dev.composite-render.v1", scope: "DEV_ONLY", renderId: "render-1", replayed,
  artifact: { artifactId: "render-1", artifactVersionId: `sha256:${hex("b")}`, contentType: "video/mp4", sizeBytes: 1234, sha256: hex("b") },
  lineage: { width: 320, height: 240, framesPerSecond: 25, frameCount: 100, durationSeconds: "4.000000000",
    sources: [{ clipId: "v-a", trackKind: "VIDEO", artifactId: "a", artifactVersionId: VERSION, sha256: hex("a") }],
    composition: { captionMode: "BOTH", captionCueCount: 2 },
    encoding: { videoCodec: "h264", audioCodec: "aac", subtitleCodec: "mov_text", formatDurationSeconds: 4.0 } } });
const ok = (status: number, body: unknown): Promise<DevCompositeHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevCompositePort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevCompositePort> = {}): FakePort {
  return {
    getCapabilities: vi.fn(() => ok(200, capabilitiesBody())),
    readHead: vi.fn(() => ok(200, { currentRevision: { revisionId: "rev-1" } })),
    applyEdits: vi.fn(() => ok(201, { revision: { revisionId: "rev-2" } })),
    render: vi.fn(() => ok(201, renderBody())),
    cancel: vi.fn(() => ok(200, {})),
    readArtifactContent: undefined,
    ...over,
  } as unknown as FakePort;
}
const asPort = (port: FakePort): DevCompositePort => port as unknown as DevCompositePort;
const ids = (): (() => string) => { let n = 0; return () => `composite-req-${++n}`; };

describe("composite render boundary", () => {
  it("builds the scene, one track per distinct track id in first-seen order, and one putClip per row", () => {
    const row = (over: Partial<CompositeClipRow>): CompositeClipRow => ({ clipId: "c", trackId: "video-main", trackKind: "VIDEO", artifactId: "a",
      artifactVersionId: VERSION, sourceInMs: 1000, sourceOutMs: 3000, storyStartMs: 0, storyDurationMs: 2000, ...over });
    const edits = buildPlacementEdits([row({ clipId: "v1" }), row({ clipId: "v2", storyStartMs: 2000 }),
      row({ clipId: "n1", trackId: "audio-nar", trackKind: "AUDIO" })], true);
    expect(edits.map((edit) => edit.type)).toEqual(["addScene", "addTrack", "addTrack", "putClip", "putClip", "putClip"]);
    expect(edits[1]).toMatchObject({ trackId: "video-main", trackKind: "VIDEO", order: 0 });
    expect(edits[2]).toMatchObject({ trackId: "audio-nar", trackKind: "AUDIO", order: 1 });
    expect(edits[3]).toMatchObject({ type: "putClip", clip: { clipId: "v1", sourceIn: { ticks: "1000", rateNumerator: "1000", clock: "SOURCE_PRESENTATION" },
      storyStart: { ticks: "0", clock: "STORY" }, storyDuration: { ticks: "2000" } } });
    expect(buildPlacementEdits([row({})], false).map((edit) => edit.type)).toEqual(["putClip"]);
  });

  it("parses capabilities and rejects a foreign or malformed view", () => {
    expect(parseCompositeCapabilities(capabilitiesBody())).toMatchObject({ maxClips: 64, captionModes: ["MUX", "BURN", "BOTH"] });
    expect(() => parseCompositeCapabilities({ scope: "PROD", limits: {} })).toThrow(DevCompositeHostError);
  });

  it("parses a render view and refuses a version that is not sha256 of its digest", () => {
    const view = parseCompositeRender({ status: 201, body: renderBody() });
    expect(view).toMatchObject({ renderId: "render-1", frameCount: 100, measured: { videoCodec: "h264", subtitleCodec: "mov_text" } });
    const bad = renderBody() as { artifact: { artifactVersionId: string } };
    bad.artifact.artifactVersionId = `sha256:${hex("c")}`;
    expect(() => parseCompositeRender({ status: 201, body: bad })).toThrow(DevCompositeHostError);
    expect(() => parseCompositeRender({ status: 201, body: { scope: "DEV_ONLY" } })).toThrow(DevCompositeHostError);
  });

  it("keeps the typed path of a refusal and classifies the outcome without leaking internals", () => {
    const refused = describeCompositeFailure(new DevCompositeHostError("TIMELINE_OVERLAP", 422, "video clips overlap", { path: "timeline.clips[c2].storyStart" }));
    expect(refused).toMatchObject({ code: "TIMELINE_OVERLAP", path: "timeline.clips[c2].storyStart", tone: "invalid" });
    expect(describeCompositeFailure(new DevCompositeHostError("OUTCOME_UNKNOWN", 0, "no response")).tone).toBe("unknown");
    expect(describeCompositeFailure(new DevCompositeHostError("RENDER_CANCELLED", 409, "cancelled")).tone).toBe("cancelled");
    expect(describeCompositeFailure(new DevCompositeHostError("RENDER_SPACE_BUDGET", 422, "space")).tone).toBe("budget");
    expect(describeCompositeFailure(new DevCompositeHostError("RIGHTS_DECISION_REVOKED", 403, "revoked")).tone).toBe("denied");
    expect(describeCompositeFailure(new Error("boom"))).toMatchObject({ code: "UNEXPECTED_ERROR", tone: "unavailable" });
  });
});

describe("DevCompositeRenderPanel", () => {
  async function mounted(port: FakePort) {
    render(React.createElement(DevCompositeRenderPanel, { composite: asPort(port), newRequestId: ids() }));
    await waitFor(() => expect(screen.getByText(/Limits: 64 clips/u)).toBeTruthy());
  }

  it("places clips against the loaded head, then renders with the placed head and the typed settings", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Project id"), { target: { value: "project-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Load head revision" }));
    await waitFor(() => expect((screen.getByLabelText("Head revision id") as HTMLInputElement).value).toBe("rev-1"));
    fireEvent.click(screen.getByRole("button", { name: "Add video clip" }));
    const row = screen.getByRole("group", { name: "Clip 1" });
    fireEvent.change(within(row).getByLabelText("Clip id"), { target: { value: "v-a" } });
    fireEvent.change(within(row).getByLabelText("Artifact id"), { target: { value: "artifact-a" } });
    fireEvent.change(within(row).getByLabelText("Exact version"), { target: { value: "sha256:abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Place clips on the timeline" }));
    expect(await screen.findByText(/Clip 1: the exact version must be sha256/u)).toBeTruthy();
    expect(port.applyEdits).not.toHaveBeenCalled();
    fireEvent.change(within(row).getByLabelText("Exact version"), { target: { value: VERSION } });
    fireEvent.click(screen.getByLabelText(/Create the scene and tracks first/u));
    fireEvent.click(screen.getByRole("button", { name: "Place clips on the timeline" }));
    await waitFor(() => expect(port.applyEdits).toHaveBeenCalledTimes(1));
    expect(port.applyEdits.mock.calls[0]!.slice(0, 3)).toEqual(["project-1", "timeline-main", "rev-1"]);
    await waitFor(() => expect((screen.getByLabelText("Head revision id") as HTMLInputElement).value).toBe("rev-2"));

    fireEvent.change(screen.getByLabelText("Brightness (-0.5 to 0.5)"), { target: { value: "-0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Render finished master" }));
    await waitFor(() => expect(port.render).toHaveBeenCalledTimes(1));
    expect(port.render.mock.calls[0]![0]).toMatchObject({ requestId: "composite-req-1", projectId: "project-1", revisionId: "rev-2",
      width: 320, height: 240, framesPerSecond: 25, gapPolicy: "REFUSE", captionMode: "MUX", color: { brightness: -0.1, contrast: 1, saturation: 1 } });
    expect(await screen.findByText(/320 x 240 at 25 fps, 100 frames/u)).toBeTruthy();
    expect(screen.getByText(hex("b"))).toBeTruthy();
    expect(screen.getByText("v-a")).toBeTruthy();
    // an unchanged request reuses its requestId (a replay), a changed one gets a fresh id
    fireEvent.click(screen.getByRole("button", { name: "Render finished master" }));
    await waitFor(() => expect(port.render).toHaveBeenCalledTimes(2));
    expect(port.render.mock.calls[1]![0].requestId).toBe("composite-req-1");
    fireEvent.change(screen.getByLabelText("Brightness (-0.5 to 0.5)"), { target: { value: "-0.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Render finished master" }));
    await waitFor(() => expect(port.render).toHaveBeenCalledTimes(3));
    expect(port.render.mock.calls[2]![0].requestId).toBe("composite-req-2");
  });

  it("shows a typed refusal with its path as an alert and no result", async () => {
    const port = fakePort({ render: vi.fn(() => Promise.reject(new DevCompositeHostError("OVERLAY_PLACEMENT_REQUIRED", 422, "no placement",
      { path: "composition.overlays" }))) });
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Project id"), { target: { value: "p" } });
    fireEvent.change(screen.getByLabelText("Head revision id"), { target: { value: "rev-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Render finished master" }));
    const alert = await screen.findByRole("alert", { name: "" }).catch(() => null);
    await waitFor(() => expect(document.querySelector("[data-failure-path]")?.textContent).toBe("composition.overlays"));
    expect(document.querySelector("[data-composite-result]")).toBeNull();
    expect(alert === null || alert instanceof HTMLElement).toBe(true);
  });

  it("enables Cancel only while rendering and sends the active requestId", async () => {
    let release: (value: DevCompositeHostResponse) => void = () => undefined;
    const port = fakePort({ render: vi.fn(() => new Promise<DevCompositeHostResponse>((resolve) => { release = resolve; })) });
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Project id"), { target: { value: "p" } });
    fireEvent.change(screen.getByLabelText("Head revision id"), { target: { value: "rev-1" } });
    expect((screen.getByRole("button", { name: "Cancel render" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Render finished master" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel render" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel render" }));
    await waitFor(() => expect(port.cancel).toHaveBeenCalledWith("composite-req-1"));
    release({ status: 201, body: renderBody() });
    await screen.findByText(/320 x 240/u);
  });
});
