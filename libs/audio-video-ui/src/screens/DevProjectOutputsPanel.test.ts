// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevProject, DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import { DevProjectOutputsPanel } from "./DevProjectOutputsPanel";
import { DevOutputsHostError, type DevHostResponse, type DevProjectOutputsPort } from "./devProjectOutputs";
import { DevProjectTimelineWorkspaceScreen, type DevProjectTimelineWorkspacePort } from "./DevProjectTimelineWorkspaceScreen";

afterEach(cleanup);

const project: DevProject = {
  tenantId: "t1", projectId: "project-1", workspaceId: "w1", ownerPrincipalId: "owner-1", title: "P", headRevisionId: "rev-5",
};
const revision: DevProjectRevision = { tenantId: "t1", projectId: "project-1", revisionId: "rev-5", parentRevisionId: "rev-4", timelines: [] };
const SHA = "b".repeat(64);
const SRC_VERSION = `sha256:${"a".repeat(64)}`;

function renderBody(over: { format?: "gif" | "mp4"; replayed?: boolean; revisionId?: string; sha?: string } = {}): unknown {
  const format = over.format ?? "gif";
  const sha = over.sha ?? SHA;
  return {
    renderId: "art-render-1", replayed: over.replayed ?? false, scope: "DEV_ONLY",
    artifact: { artifactId: "art-render-1", artifactVersionId: `sha256:${sha}`, contentType: format === "gif" ? "image/gif" : "video/mp4", sizeBytes: 1234, sha256: sha },
    lineage: {
      projectId: "project-1", revisionId: over.revisionId ?? "rev-5", timelineId: "main", timelineSemanticVersionId: "tv-9",
      engine: format === "gif" ? "gif-engine" : "mp4-engine", format, frameCount: 20,
      sources: [{ clipId: "clip-1", trackId: "video-1", artifactId: "src-1", artifactVersionId: SRC_VERSION, startFrame: 0, endFrameExclusive: 10 }],
      ...(format === "mp4" ? { encoding: { videoCodec: "h264", audioCodec: "aac", videoPtsExact: true, videoFrameCount: 20, expectedDurationSeconds: 2 } } : {}),
    },
  };
}
const reviewBody = (over: Record<string, unknown> = {}): unknown => ({
  schema: "x", reviewCaseId: "devreview.1", scope: "DEV_ONLY", currentness: "CURRENT", caseRevision: 0, created: true,
  subject: { kind: "PROJECT_REVISION", projectId: "project-1", revisionId: "rev-5", reference: "project_revision:project-1@rev-5" },
  records: [], reviewState: { status: "NO_DECISION", latestDecision: null, establishesApproval: false, humanReviewApproval: false },
  authority: "DEV_ONLY synthetic owner of the exact subject; not an issued human reviewer authority",
  note: "DEV_ONLY synthetic-owner statement; not an issued human reviewer authority", ...over,
});
const receipt = (over: Record<string, unknown> = {}): unknown => ({
  schema: "x", requestId: "r", reviewCaseId: "devreview.1", appendRecordId: "rec-1", caseRevision: 1, currentness: "CURRENT",
  establishesApproval: false, replayed: false, scope: "DEV_ONLY", ...over,
});
const ok = (status: number, body: unknown): Promise<DevHostResponse> => Promise.resolve({ status, body });
const fail = (status: number, code: string): Promise<never> => Promise.reject(new DevOutputsHostError(code, status, code));

function fakePort(over: Partial<DevProjectOutputsPort> = {}): { [K in keyof DevProjectOutputsPort]: ReturnType<typeof vi.fn> } {
  return {
    requestRender: vi.fn(() => ok(201, renderBody())),
    getRender: vi.fn(() => ok(200, renderBody({ replayed: true }))),
    openReview: vi.fn(() => ok(201, reviewBody())),
    getReview: vi.fn(() => ok(200, reviewBody({ created: undefined }))),
    addReviewComment: vi.fn(() => ok(201, receipt())),
    recordReviewDecision: vi.fn(() => ok(201, receipt({ caseRevision: 1 }))),
    ...over,
  } as never;
}

let ids = 0;
const nextId = (): string => `req-${++ids}`;
function mount(port: ReturnType<typeof fakePort>, props: Partial<React.ComponentProps<typeof DevProjectOutputsPanel>> = {}) {
  return render(React.createElement(DevProjectOutputsPanel, {
    outputs: port as unknown as DevProjectOutputsPort, project, revision, timelineId: "main", clipCount: 1, locked: false, newRequestId: nextId, ...props,
  }));
}
const click = (name: string | RegExp): void => { fireEvent.click(screen.getByRole("button", { name })); };
const status = (id: string): string => document.getElementById(id)?.textContent ?? "";

describe("DevProjectOutputsPanel render", () => {
  it("renders the exact revision as GIF, shows artifact id/version/sha and source lineage, and reopens it", async () => {
    const port = fakePort(); mount(port);
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created (HTTP 201)"));
    expect(port.requestRender).toHaveBeenCalledWith("project-1", {
      requestId: "req-" + ids, revisionId: "rev-5", timelineId: "main", width: 32, height: 24, framesPerSecond: 10, format: "gif",
    });
    const result = screen.getByRole("article", { name: /Registered render/u });
    expect(result.textContent).toContain(`sha256:${SHA}`);
    expect(result.textContent).toContain("art-render-1");
    expect(result.textContent).toContain(`src-1@${SRC_VERSION}`);
    expect(result.textContent).not.toContain("Verified encoding");
    click("Reopen render from the host");
    await waitFor(() => expect(status("render-status")).toContain("Reopened render art-render-1"));
    expect(port.getRender).toHaveBeenCalledWith("project-1", "art-render-1");
    expect(screen.getByRole("heading", { name: /Registered render · reopened/u })).toBeTruthy();
  });

  it("shows the verified encoding block for MP4 and sends format mp4", async () => {
    const port = fakePort({ requestRender: vi.fn(() => ok(201, renderBody({ format: "mp4" }))) });
    mount(port);
    fireEvent.click(screen.getByRole("radio", { name: /MP4/u }));
    click("Render exact revision");
    await waitFor(() => expect(screen.getByLabelText("Render encoding")).toBeTruthy());
    expect(screen.getByLabelText("Render encoding").textContent).toContain("h264");
    expect(screen.getByLabelText("Render encoding").textContent).toContain("aac");
    expect((port.requestRender.mock.calls[0] as unknown[])[1]).toMatchObject({ format: "mp4" });
  });

  it("reuses one requestId for an unchanged action (replay is 200) and a new one when the payload changes", async () => {
    const port = fakePort();
    port.requestRender.mockImplementationOnce(() => ok(201, renderBody())).mockImplementationOnce(() => ok(200, renderBody({ replayed: true })));
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created"));
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Replayed (HTTP 200)"));
    const [first, second] = port.requestRender.mock.calls.map((call) => (call[1] as { requestId: string }).requestId);
    expect(second).toBe(first);
    fireEvent.change(screen.getByLabelText("Width in pixels"), { target: { value: "64" } });
    port.requestRender.mockImplementationOnce(() => ok(201, renderBody()));
    click("Render exact revision");
    await waitFor(() => expect(port.requestRender).toHaveBeenCalledTimes(3));
    expect((port.requestRender.mock.calls[2]![1] as { requestId: string }).requestId).not.toBe(first);
  });

  it.each([
    [409, "IDEMPOTENCY_CONFLICT", /CONFLICT/u],
    [422, "TRACK_KIND_NOT_SUPPORTED", /track kind/u],
    [422, "RENDER_UNSUPPORTED_FRAME_GEOMETRY", /even width and height/u],
    [422, "RENDER_UNSUPPORTED_TIMELINE", /not supported/u],
    [422, "SOURCE_FORMAT_NOT_SUPPORTED", /not a supported/u],
    [422, "RENDER_LIMIT_EXCEEDED", /limit/u],
    [503, "RENDER_CODEC_UNAVAILABLE", /MP4 encoding is unavailable/u],
    [404, "SOURCE_VERSION_NOT_FOUND", /source artifact version/u],
    [403, "ARTIFACT_PERMISSION_REQUIRED", /Denied/u],
  ])("shows %i %s honestly and no registered output", async (statusCode, code, text) => {
    const port = fakePort({ requestRender: vi.fn(() => fail(statusCode, code)) });
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(code));
    expect(status("render-status")).toMatch(text);
    expect(screen.queryByRole("article", { name: /Registered render/u })).toBeNull();
    expect(status("render-status")).not.toMatch(/Created|Replayed/u);
  });

  it("offers retry with the SAME requestId after 502 RENDER_REGISTRATION_FAILED, then succeeds", async () => {
    const port = fakePort();
    port.requestRender.mockImplementationOnce(() => fail(502, "RENDER_REGISTRATION_FAILED")).mockImplementationOnce(() => ok(201, renderBody()));
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("RENDER_REGISTRATION_FAILED"));
    expect(screen.queryByRole("article", { name: /Registered render/u })).toBeNull();
    click("Retry with the same request identity");
    await waitFor(() => expect(status("render-status")).toContain("Created (HTTP 201)"));
    const ids2 = port.requestRender.mock.calls.map((call) => (call[1] as { requestId: string }).requestId);
    expect(ids2[1]).toBe(ids2[0]);
  });

  it("treats 502 RENDER_EXECUTION_FAILED and transport loss as retryable/unknown, and a 409 drops the request identity", async () => {
    const port = fakePort();
    port.requestRender.mockImplementationOnce(() => fail(502, "RENDER_EXECUTION_FAILED")).mockImplementationOnce(() => fail(0, "OUTCOME_UNKNOWN"))
      .mockImplementationOnce(() => fail(409, "IDEMPOTENCY_CONFLICT")).mockImplementationOnce(() => ok(201, renderBody()));
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("RENDER_EXECUTION_FAILED"));
    click("Retry with the same request identity");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Outcome unknown"));
    click("Retry with the same request identity");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("IDEMPOTENCY_CONFLICT"));
    expect(screen.queryByRole("button", { name: "Retry with the same request identity" })).toBeNull();
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created"));
    const used = port.requestRender.mock.calls.map((call) => (call[1] as { requestId: string }).requestId);
    expect(used[0]).toBe(used[1]); expect(used[1]).toBe(used[2]); expect(used[3]).not.toBe(used[2]);
  });

  it("rejects an inconsistent host body instead of showing success", async () => {
    const port = fakePort({ requestRender: vi.fn(() => ok(201, renderBody({ revisionId: "rev-OTHER" }))) });
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("INVALID_RESPONSE"));
    expect(screen.queryByRole("article", { name: /Registered render/u })).toBeNull();
  });

  it("blocks rendering without clips or when the displayed revision is not the project head", () => {
    const port = fakePort();
    const { unmount } = mount(port, { clipCount: 0 });
    expect((screen.getByRole("button", { name: "Render exact revision" }) as HTMLButtonElement).disabled).toBe(true);
    expect(status("render-blocked")).toContain("Add at least one clip");
    unmount();
    mount(port, { project: { ...project, headRevisionId: "rev-6" } });
    expect((screen.getByRole("button", { name: "Render exact revision" }) as HTMLButtonElement).disabled).toBe(true);
    expect(status("render-blocked")).toContain("Reopen the project head");
    expect(port.requestRender).not.toHaveBeenCalled();
  });
});

describe("DevProjectOutputsPanel review", () => {
  const openCase = async (port: ReturnType<typeof fakePort>, props: Partial<React.ComponentProps<typeof DevProjectOutputsPanel>> = {}) => {
    mount(port, props);
    click("Open review case");
    await waitFor(() => expect(screen.getByRole("article", { name: /Review case/u })).toBeTruthy());
  };

  it("opens a case on the exact revision and always discloses that DEV_ONLY ACCEPT is not human approval", async () => {
    const port = fakePort(); await openCase(port);
    expect(port.openReview).toHaveBeenCalledWith({ kind: "PROJECT_REVISION", projectId: "project-1", revisionId: "rev-5" });
    expect(screen.getByRole("note", { name: "Review approval disclaimer" }).textContent).toMatch(/not human approval/u);
    expect(screen.getByRole("article", { name: /Review case/u }).textContent).toContain("establishesApproval=false");
    expect(status("review-status")).toContain("No approval exists");
  });

  it("opens a case on the render artifact version after a render", async () => {
    const port = fakePort({ openReview: vi.fn(() => ok(201, reviewBody({ subject: { kind: "ARTIFACT_VERSION", artifactId: "art-render-1", artifactVersionId: `sha256:${SHA}`, reference: "artifact_version:x" } }))) });
    mount(port);
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created"));
    fireEvent.click(screen.getByRole("radio", { name: /Render artifact version/u }));
    click("Open review case");
    await waitFor(() => expect(port.openReview).toHaveBeenCalledWith({ kind: "ARTIFACT_VERSION", artifactId: "art-render-1", artifactVersionId: `sha256:${SHA}` }));
  });

  it("adds a comment with a stable request identity, then records a confirmed decision that stays non-approval", async () => {
    const port = fakePort(); await openCase(port);
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 1 })));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Tighten the cut" } });
    click("Add comment");
    await waitFor(() => expect(status("review-status")).toContain("Recorded comment (HTTP 201)"));
    expect(port.addReviewComment).toHaveBeenCalledWith("devreview.1", expect.objectContaining({ expectedCaseRevision: 0, text: "Tighten the cut", disposition: "OPEN" }));

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Looks right" } });
    const submit = screen.getByRole("button", { name: "Record DEV_ONLY decision" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no explicit confirmation yet
    fireEvent.click(screen.getByLabelText(/I confirm this records a DEV_ONLY ACCEPT decision/u));
    expect(submit.disabled).toBe(false);
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 2, reviewState: { status: "DEV_ONLY_ACCEPT_CURRENT", latestDecision: { decision: "ACCEPT" }, establishesApproval: false, humanReviewApproval: false } })));
    port.recordReviewDecision.mockImplementation(() => ok(201, receipt({ caseRevision: 2 })));
    fireEvent.click(submit);
    await waitFor(() => expect(status("review-status")).toContain("not human approval"));
    expect(port.recordReviewDecision).toHaveBeenCalledWith("devreview.1", expect.objectContaining({ expectedCaseRevision: 1, decision: "ACCEPT", reason: "Looks right", confirmed: true }));
    const caseView = screen.getByRole("article", { name: /Review case/u }).textContent ?? "";
    expect(caseView).toContain("DEV_ONLY_ACCEPT_CURRENT");
    expect(caseView).toContain("establishesApproval=false");
  });

  it("shows replayed decisions as replays, not a new decision", async () => {
    const port = fakePort({ recordReviewDecision: vi.fn(() => ok(200, receipt({ replayed: true }))) }); await openCase(port);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(status("review-status")).toContain("Replayed (HTTP 200): decision already recorded"));
  });

  it("surfaces STALE after a later edit, disables decisions, and refuses a stale decision with a typed 409", async () => {
    const port = fakePort(); await openCase(port);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    port.getReview.mockImplementation(() => ok(200, reviewBody({ currentness: "STALE", reviewState: { status: "DEV_ONLY_ACCEPT_STALE", latestDecision: null, establishesApproval: false, humanReviewApproval: false } })));
    port.recordReviewDecision.mockImplementation(() => fail(409, "REVIEW_SUBJECT_STALE"));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("REVIEW_SUBJECT_STALE"));
    await waitFor(() => expect(screen.getByText(/STALE · the reviewed version has changed/u)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Record DEV_ONLY decision" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Decisions are disabled because this case is STALE/u)).toBeTruthy();
    expect(screen.getByRole("note", { name: "Review approval disclaimer" })).toBeTruthy();
  });

  it("re-reads the case when the project head moves so STALE becomes visible", async () => {
    const port = fakePort();
    const view = render(React.createElement(DevProjectOutputsPanel, { outputs: port as unknown as DevProjectOutputsPort, project, revision, timelineId: "main", clipCount: 1, locked: false, newRequestId: nextId }));
    click("Open review case");
    await waitFor(() => expect(screen.getByRole("article", { name: /Review case/u })).toBeTruthy());
    port.getReview.mockClear();
    port.getReview.mockImplementation(() => ok(200, reviewBody({ currentness: "STALE" })));
    const next = { ...revision, revisionId: "rev-6", parentRevisionId: "rev-5" };
    view.rerender(React.createElement(DevProjectOutputsPanel, { outputs: port as unknown as DevProjectOutputsPort, project: { ...project, headRevisionId: "rev-6" }, revision: next, timelineId: "main", clipCount: 1, locked: false, newRequestId: nextId }));
    await waitFor(() => expect(screen.getByText(/STALE · the reviewed version has changed/u)).toBeTruthy());
  });

  it.each([
    [409, "REVIEW_CASE_REVISION_CONFLICT", /case changed/u],
    [409, "REVIEW_REQUEST_ID_REUSED", /already used/u],
    [403, "REVIEW_ACCESS_DENIED", /Denied/u],
    [422, "REVIEW_CONFIRMATION_REQUIRED", /confirmation is required/u],
  ])("shows %i %s for a decision and records nothing", async (statusCode, code, text) => {
    const port = fakePort(); await openCase(port);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    port.recordReviewDecision.mockImplementation(() => fail(statusCode, code));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(code));
    expect(status("review-status")).toMatch(text);
    expect(status("review-status")).not.toContain("Recorded");
  });

  it("refuses a host body that claims approval", async () => {
    const port = fakePort({ openReview: vi.fn(() => ok(201, reviewBody({ reviewState: { status: "DEV_ONLY_ACCEPT_CURRENT", latestDecision: null, establishesApproval: true, humanReviewApproval: false } }))) });
    mount(port);
    click("Open review case");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("INVALID_RESPONSE"));
    expect(screen.queryByRole("article", { name: /Review case/u })).toBeNull();
  });

  it("reports an unavailable review host without a fake case", async () => {
    const port = fakePort({ openReview: vi.fn(() => fail(503, "REVIEW_UNAVAILABLE")) });
    mount(port);
    click("Open review case");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unavailable"));
    expect(screen.queryByRole("article", { name: /Review case/u })).toBeNull();
  });
});

describe("workspace integration", () => {
  const graphRevision: DevProjectRevision = {
    ...revision, timelines: [{ semanticVersionId: "tv-9", graph: { timelineId: "main", scenes: [{ sceneId: "s1", order: 0 }], tracks: [{ trackId: "video-1", sceneId: "s1", kind: "VIDEO", order: 0 }], clips: [{
      clipId: "clip-1", sceneId: "s1", trackId: "video-1", source: { artifactId: "src-1", artifactVersionId: SRC_VERSION },
      sourceIn: { ticks: "0", rateNumerator: "24", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
      sourceOut: { ticks: "24", rateNumerator: "24", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
      storyStart: { ticks: "0", rateNumerator: "24", rateDenominator: "1", clock: "STORY" },
      storyDuration: { ticks: "24", rateNumerator: "24", rateDenominator: "1", clock: "STORY" },
    }] } }],
  };
  const client = {} as unknown as DevProjectTimelineWorkspacePort;

  it("shows render controls only when a host port is supplied, otherwise remains truthfully unavailable", async () => {
    const port = fakePort();
    const { unmount } = render(React.createElement(DevProjectTimelineWorkspaceScreen, { client, project, revision: graphRevision, outputs: port as unknown as DevProjectOutputsPort, newRequestId: nextId }));
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created (HTTP 201)"));
    expect((port.requestRender.mock.calls[0]![1] as { timelineId: string }).timelineId).toBe("main");
    unmount();
    render(React.createElement(DevProjectTimelineWorkspaceScreen, { client, project, revision: graphRevision }));
    expect(screen.getByRole("heading", { name: "Render engine unavailable" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Render exact revision" })).toBeNull();
  });
});
