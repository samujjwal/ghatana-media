// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevProject, DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import { DevProjectOutputsPanel } from "./DevProjectOutputsPanel";
import { DevReviewSection } from "./DevReviewSection";
import { DevOutputsHostError, type DevHostResponse, type DevProjectOutputsPort } from "./devProjectOutputs";
import { DevContentError, sha256Hex } from "./devArtifactContent";
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
const assignment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assignmentId: "asg-1", reviewerPrincipalId: "reviewer-1", assignedByPrincipalId: "owner-1", scopes: ["APPROVAL", "QUALITY"],
  expiresAt: "2026-01-08T00:00:00Z", status: "ACTIVE", assignmentVersion: 1, ...over,
});
const reviewBody = (over: Record<string, unknown> = {}): unknown => ({
  schema: "x", reviewCaseId: "devreview.1", scope: "DEV_ONLY", currentness: "CURRENT", caseRevision: 0, created: true,
  subject: { kind: "PROJECT_REVISION", projectId: "project-1", revisionId: "rev-5", reference: "project_revision:project-1@rev-5" },
  records: [], observedAt: "2026-01-01T00:00:00Z", assignments: [assignment()],
  reviewState: { status: "NO_DECISION", latestDecision: null, establishesApproval: false, humanReviewApproval: false },
  authority: "DEV_ONLY synthetic owner of the exact subject; not an issued human reviewer authority",
  note: "DEV_ONLY synthetic-owner statement; not an issued human reviewer authority", ...over,
});
const assignmentReceipt = (over: Record<string, unknown> = {}): unknown => ({
  schema: "x", reviewCaseId: "devreview.1", assignment: assignment(), replayed: false, establishesApproval: false, humanReviewApproval: false, scope: "DEV_ONLY", ...over,
});
const receipt = (over: Record<string, unknown> = {}): unknown => ({
  schema: "x", requestId: "r", reviewCaseId: "devreview.1", appendRecordId: "rec-1", caseRevision: 1, currentness: "CURRENT",
  establishesApproval: false, replayed: false, scope: "DEV_ONLY", ...over,
});
function exportBody(over: Record<string, unknown> = {}): unknown {
  return {
    requestId: `req-${ids}`, artifactId: "art-render-1", artifactVersionId: `sha256:${SHA}`, artifactDigest: SHA, destinationId: "dev-local",
    status: "DESTINATION_CONFIRMED", acknowledgedBytes: 1234, destinationConfirmed: true,
    destinationReceiptRef: "dev-local-directory-receipt:abc", replayed: false, scope: "DEV_ONLY", ...over,
  };
}
const unconfirmedBody = (over: Record<string, unknown> = {}): unknown =>
  exportBody({ status: "OUTCOME_UNKNOWN", destinationConfirmed: false, destinationReceiptRef: null, acknowledgedBytes: 0, ...over });
const ok = (status: number, body: unknown): Promise<DevHostResponse> => Promise.resolve({ status, body });
const fail = (status: number, code: string): Promise<never> => Promise.reject(new DevOutputsHostError(code, status, code));

function fakePort(over: Partial<DevProjectOutputsPort> = {}): { [K in keyof DevProjectOutputsPort]: ReturnType<typeof vi.fn> } {
  return {
    principalId: "reviewer-1",
    assignReviewer: vi.fn(() => ok(201, assignmentReceipt())),
    revokeReviewAssignment: vi.fn(() => ok(200, assignmentReceipt({ assignment: assignment({ status: "REVOKED", assignmentVersion: 2 }) }))),
    requestRender: vi.fn(() => ok(201, renderBody())),
    getRender: vi.fn(() => ok(200, renderBody({ replayed: true }))),
    openReview: vi.fn(() => ok(201, reviewBody())),
    getReview: vi.fn(() => ok(200, reviewBody({ created: undefined }))),
    addReviewComment: vi.fn(() => ok(201, receipt())),
    recordReviewDecision: vi.fn(() => ok(201, receipt({ caseRevision: 1 }))),
    requestExport: vi.fn(() => ok(201, exportBody())),
    getExport: vi.fn(() => ok(200, exportBody({ replayed: true }))),
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
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
    const submit = screen.getByRole("button", { name: "Record DEV_ONLY decision" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no explicit confirmation yet
    fireEvent.click(screen.getByLabelText(/I confirm this records a DEV_ONLY ACCEPT decision/u));
    expect(submit.disabled).toBe(false);
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 2, reviewState: { status: "DEV_ONLY_ACCEPT_CURRENT", latestDecision: { decision: "ACCEPT" }, establishesApproval: false, humanReviewApproval: false } })));
    port.recordReviewDecision.mockImplementation(() => ok(201, receipt({ caseRevision: 2 })));
    fireEvent.click(submit);
    await waitFor(() => expect(status("review-status")).toContain("not human approval"));
    expect(port.recordReviewDecision).toHaveBeenCalledWith("devreview.1", expect.objectContaining({ expectedCaseRevision: 1, decision: "ACCEPT", scope: "APPROVAL", reason: "Looks right", confirmed: true }));
    const caseView = screen.getByRole("article", { name: /Review case/u }).textContent ?? "";
    expect(caseView).toContain("DEV_ONLY_ACCEPT_CURRENT");
    expect(caseView).toContain("establishesApproval=false");
  });

  it("shows replayed decisions as replays, not a new decision", async () => {
    const port = fakePort({ recordReviewDecision: vi.fn(() => ok(200, receipt({ replayed: true }))) }); await openCase(port);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(status("review-status")).toContain("Replayed (HTTP 200): decision already recorded"));
  });

  it("surfaces STALE after a later edit, disables decisions, and refuses a stale decision with a typed 409", async () => {
    const port = fakePort(); await openCase(port);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "ok" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
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
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
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

async function renderThenExport(port: ReturnType<typeof fakePort>, destination = "dev-local"): Promise<void> {
  mount(port);
  click("Render exact revision");
  await waitFor(() => expect(status("render-status")).toContain("Created (HTTP 201)"));
  fireEvent.change(screen.getByLabelText("Destination ID"), { target: { value: destination } });
  click("Export render artifact");
}
const exportResult = (): HTMLElement | null => screen.queryByRole("article", { name: "Export result" });

describe("DevProjectOutputsPanel export", () => {
  it("offers no export before a render exists", () => {
    mount(fakePort());
    expect(screen.queryByRole("button", { name: "Export render artifact" })).toBeNull();
  });

  it("exports the exact render artifact version and shows the receipt only when destination-confirmed", async () => {
    const port = fakePort(); await renderThenExport(port);
    await waitFor(() => expect(status("export-status")).toContain("Exported (HTTP 201)"));
    expect(port.requestExport).toHaveBeenCalledWith({
      requestId: `req-${ids}`, artifactId: "art-render-1", artifactVersionId: `sha256:${SHA}`, destinationId: "dev-local",
    });
    const result = exportResult()!;
    expect(result.getAttribute("data-destination-confirmed")).toBe("true");
    expect(result.textContent).toContain("dev-local-directory-receipt:abc");
    expect(result.textContent).toContain(`${SHA} equals the artifact sha256`);
    expect(result.textContent).toContain("Delivered with destination receipt");
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("reuses one request identity for a duplicate export and shows the replay (HTTP 200) with the same receipt", async () => {
    const port = fakePort(); await renderThenExport(port);
    await waitFor(() => expect(status("export-status")).toContain("HTTP 201"));
    const first = (port.requestExport.mock.calls[0]![0] as { requestId: string }).requestId;
    port.requestExport.mockImplementation(() => ok(200, exportBody({ requestId: first, replayed: true })));
    click("Export render artifact");
    await waitFor(() => expect(status("export-status")).toContain("Replayed or read back (HTTP 200)"));
    expect(port.requestExport).toHaveBeenCalledTimes(2);
    expect((port.requestExport.mock.calls[1]![0] as { requestId: string }).requestId).toBe(first);
  });

  it("uses a new request identity for a different destination", async () => {
    const port = fakePort(); await renderThenExport(port);
    await waitFor(() => expect(status("export-status")).toContain("HTTP 201"));
    const first = (port.requestExport.mock.calls[0]![0] as { requestId: string }).requestId;
    fireEvent.change(screen.getByLabelText("Destination ID"), { target: { value: "other" } });
    port.requestExport.mockImplementation((request: { requestId: string; destinationId: string }) => ok(201, exportBody({ requestId: request.requestId, destinationId: "other" })));
    click("Export render artifact");
    await waitFor(() => expect(port.requestExport).toHaveBeenCalledTimes(2));
    expect((port.requestExport.mock.calls[1]![0] as { requestId: string }).requestId).not.toBe(first);
  });

  it("never shows 202 as delivered: no receipt, 'Check again' reads back and only then confirms", async () => {
    const port = fakePort({ requestExport: vi.fn(() => ok(202, unconfirmedBody())) as never }); await renderThenExport(port);
    await waitFor(() => expect(status("export-status")).toContain("NOT CONFIRMED"));
    const result = exportResult()!;
    expect(result.getAttribute("data-destination-confirmed")).toBe("false");
    expect(result.textContent).not.toContain("receipt:");
    expect(result.textContent).not.toMatch(/Delivered/u);
    expect(screen.queryByText("Destination receipt")).toBeNull();
    port.getExport.mockImplementationOnce(() => ok(200, unconfirmedBody({ replayed: true })));
    click("Check again");
    await waitFor(() => expect(port.getExport).toHaveBeenCalledWith(`req-${ids}`));
    await waitFor(() => expect(status("export-status")).toContain("NOT CONFIRMED"));
    expect(exportResult()!.getAttribute("data-destination-confirmed")).toBe("false");
    port.getExport.mockImplementationOnce(() => ok(200, exportBody({ replayed: true })));
    click("Check again");
    await waitFor(() => expect(exportResult()!.getAttribute("data-destination-confirmed")).toBe("true"));
    expect(exportResult()!.textContent).toContain("dev-local-directory-receipt:abc");
    expect(port.requestExport).toHaveBeenCalledTimes(1);
  });

  it("rejects bodies that claim confirmation without a receipt, with a wrong digest, or on a 202", async () => {
    for (const [status_, body] of [
      [201, exportBody({ destinationReceiptRef: null })],
      [201, exportBody({ artifactDigest: "c".repeat(64) })],
      [201, exportBody({ acknowledgedBytes: 5 })],
      [201, exportBody({ destinationId: "elsewhere" })],
      [201, exportBody({ status: "OUTCOME_UNKNOWN" })],
      [202, exportBody()],
      [200, unconfirmedBody()],
    ] as const) {
      cleanup();
      const port = fakePort({ requestExport: vi.fn(() => ok(status_, body)) as never }); await renderThenExport(port);
      await waitFor(() => expect(status("export-status")).toContain("INVALID_RESPONSE"));
      expect(exportResult()).toBeNull();
      expect(document.body.textContent).not.toContain("Delivered with destination receipt");
    }
  });

  it("maps typed failures truthfully and never claims delivery", async () => {
    const cases: Array<[number, string, RegExp, string]> = [
      [409, "EXPORT_REQUEST_CONFLICT", /already bound to a different artifact version or destination/u, "error"],
      [404, "DESTINATION_NOT_FOUND", /not configured on this DEV_ONLY host/u, "error"],
      [404, "ARTIFACT_VERSION_NOT_FOUND", /exact artifact version is not available/u, "error"],
      [422, "EXPORT_LIMIT_EXCEEDED", /size limit/u, "error"],
      [422, "EXPORT_INVALID", /refused this export/u, "error"],
      [403, "EXPORT_AUTHORIZATION_DENIED", /Denied/u, "denied"],
      [503, "DELIVERY_DESTINATION_UNAVAILABLE", /destination is unavailable/u, "unavailable"],
      [404, "NOT_FOUND", /export lane is not available/u, "unavailable"],
      [502, "DESTINATION_EVIDENCE_INVALID", /Retry with the same request identity/u, "unknown"],
      [0, "OUTCOME_UNKNOWN", /Retry with the same request identity/u, "unknown"],
    ];
    for (const [httpStatus, code, text, tone] of cases) {
      cleanup();
      const port = fakePort({ requestExport: vi.fn(() => fail(httpStatus, code)) as never }); await renderThenExport(port);
      await waitFor(() => expect(status("export-status")).toContain(code));
      expect(status("export-status")).toMatch(text);
      expect(document.querySelector("#dev-export [data-outcome]")?.getAttribute("data-outcome")).toBe(tone);
      expect(exportResult()).toBeNull();
      expect(document.body.textContent).not.toContain("Delivered with destination receipt");
    }
  });

  it("retries an unknown outcome with the SAME request identity, and a 409 drops the identity", async () => {
    const port = fakePort({ requestExport: vi.fn(() => fail(502, "DESTINATION_EVIDENCE_INVALID")) as never }); await renderThenExport(port);
    await waitFor(() => expect(status("export-status")).toContain("DESTINATION_EVIDENCE_INVALID"));
    const first = (port.requestExport.mock.calls[0]![0] as { requestId: string }).requestId;
    port.requestExport.mockImplementation((request: { requestId: string }) => ok(200, exportBody({ requestId: request.requestId, replayed: true })));
    click("Retry export with the same request identity");
    await waitFor(() => expect(exportResult()?.getAttribute("data-destination-confirmed")).toBe("true"));
    expect((port.requestExport.mock.calls[1]![0] as { requestId: string }).requestId).toBe(first);

    cleanup();
    const conflict = fakePort({ requestExport: vi.fn(() => fail(409, "EXPORT_REQUEST_CONFLICT")) as never }); await renderThenExport(conflict);
    await waitFor(() => expect(status("export-status")).toContain("EXPORT_REQUEST_CONFLICT"));
    const firstConflict = (conflict.requestExport.mock.calls[0]![0] as { requestId: string }).requestId;
    click("Export render artifact");
    await waitFor(() => expect(conflict.requestExport).toHaveBeenCalledTimes(2));
    expect((conflict.requestExport.mock.calls[1]![0] as { requestId: string }).requestId).not.toBe(firstConflict);
  });

  it("requires a valid destination id before enabling export", async () => {
    mount(fakePort());
    click("Render exact revision");
    await waitFor(() => expect(status("render-status")).toContain("Created (HTTP 201)"));
    const button = screen.getByRole("button", { name: "Export render artifact" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Destination ID"), { target: { value: "../../etc" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Destination ID"), { target: { value: "dev-local" } });
    expect(button.disabled).toBe(false);
  });
});

describe("DevProjectOutputsPanel reopen known ids", () => {
  it("reopens a known render id from the host and enables export of it", async () => {
    const port = fakePort(); mount(port);
    fireEvent.change(screen.getByLabelText("Known render ID"), { target: { value: "art-render-1" } });
    click("Reopen known render");
    await waitFor(() => expect(status("render-status")).toContain("Reopened render art-render-1"));
    expect(port.getRender).toHaveBeenCalledWith("project-1", "art-render-1");
    expect(port.requestRender).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export render artifact" })).toBeTruthy();
  });

  it("refuses a render body for a different id and reports a typed 404", async () => {
    const port = fakePort({ getRender: vi.fn(() => ok(200, renderBody())) as never }); mount(port);
    fireEvent.change(screen.getByLabelText("Known render ID"), { target: { value: "other-render" } });
    click("Reopen known render");
    await waitFor(() => expect(status("render-status")).toContain("INVALID_RESPONSE"));
    expect(document.querySelector("[data-render-id]")).toBeNull();
    cleanup();
    const missing = fakePort({ getRender: vi.fn(() => fail(404, "RENDER_NOT_FOUND")) as never }); mount(missing);
    fireEvent.change(screen.getByLabelText("Known render ID"), { target: { value: "gone" } });
    click("Reopen known render");
    await waitFor(() => expect(status("render-status")).toContain("RENDER_NOT_FOUND"));
  });

  it("reopens a known review case, and refuses one from another project", async () => {
    const port = fakePort(); mount(port);
    fireEvent.change(screen.getByLabelText("Known review case ID"), { target: { value: "devreview.1" } });
    click("Reopen known review case");
    await waitFor(() => expect(status("review-status")).toContain("Reopened review case devreview.1"));
    expect(document.querySelector("[data-review-case='devreview.1']")).not.toBeNull();
    cleanup();
    const foreign = fakePort({ getReview: vi.fn(() => ok(200, reviewBody({
      subject: { kind: "PROJECT_REVISION", projectId: "project-9", revisionId: "rev-1", reference: "project_revision:project-9@rev-1" } }))) as never });
    mount(foreign);
    fireEvent.change(screen.getByLabelText("Known review case ID"), { target: { value: "devreview.1" } });
    click("Reopen known review case");
    await waitFor(() => expect(status("review-status")).toContain("INVALID_RESPONSE"));
    expect(document.querySelector("[data-review-case]")).toBeNull();
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

describe("DevProjectOutputsPanel verified preview and download", () => {
  const GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
  const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const withBytes = async (format: "gif" | "mp4", data: Uint8Array, over: { sha?: string; sizeBytes?: number } = {}): Promise<unknown> => {
    const sha = await sha256Hex(data);
    const body = renderBody({ format, sha }) as { artifact: Record<string, unknown> };
    body.artifact.sizeBytes = over.sizeBytes ?? data.byteLength;
    if (over.sha) { body.artifact.sha256 = over.sha; body.artifact.artifactVersionId = `sha256:${over.sha}`; }
    return body;
  };
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => "blob:fixture/render") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  });

  it("previews a GIF through the content route with the exact version, verified before display, and the token never in a URL", async () => {
    const readArtifactContent = vi.fn(async () => ({ status: 200, contentType: "image/gif", bytes: GIF }));
    const body = await withBytes("gif", GIF);
    const port = fakePort({ requestRender: vi.fn(() => ok(201, body)), readArtifactContent } as never); mount(port);
    click("Render exact revision");
    await waitFor(() => screen.getByRole("button", { name: /Preview GIF/u }));
    expect(document.querySelector("img")).toBeNull();
    expect(readArtifactContent).not.toHaveBeenCalled();
    click(/Preview GIF/u);
    await waitFor(() => expect(document.querySelector('img[data-verified-preview="gif"]')).not.toBeNull());
    const sha = await sha256Hex(GIF);
    expect(readArtifactContent).toHaveBeenCalledWith({ artifactId: "art-render-1", artifactVersionId: `sha256:${sha}`, maxBytes: expect.any(Number) });
    expect(document.body.textContent).toContain("Bytes verified against the registered version");
    expect(document.querySelector("img")!.getAttribute("src")).toBe("blob:fixture/render");
    expect(JSON.stringify(readArtifactContent.mock.calls)).not.toMatch(/token|Bearer/iu);
    expect(screen.getByRole("button", { name: /Download GIF/u })).toBeTruthy();
  });

  it("previews an MP4 with native controls after reopening a render", async () => {
    const body = await withBytes("mp4", MP4);
    const port = fakePort({ getRender: vi.fn(() => ok(200, body)), readArtifactContent: vi.fn(async () => ({ status: 200, contentType: "video/mp4", bytes: MP4 })) } as never); mount(port);
    fireEvent.change(screen.getByLabelText("Known render ID"), { target: { value: "art-render-1" } });
    click("Reopen known render");
    await waitFor(() => screen.getByRole("button", { name: /Preview MP4/u }));
    click(/Preview MP4/u);
    await waitFor(() => expect(document.querySelector("video[controls]")).not.toBeNull());
  });

  it("shows no preview on a digest mismatch, and types 404, 412, 403 and 416 refusals", async () => {
    for (const [status, code] of [[404, "ARTIFACT_NOT_FOUND"], [412, "ARTIFACT_VERSION_MISMATCH"], [403, "ARTIFACT_PERMISSION_REQUIRED"], [416, "RANGE_NOT_SATISFIABLE"]] as const) {
      cleanup();
      const body = await withBytes("gif", GIF);
      const port = fakePort({ requestRender: vi.fn(() => ok(201, body)), readArtifactContent: vi.fn(() => Promise.reject(new DevContentError(code, status, code))) } as never); mount(port);
      click("Render exact revision");
      await waitFor(() => screen.getByRole("button", { name: /Preview GIF/u }));
      click(/Preview GIF/u);
      await waitFor(() => expect(document.querySelector("[data-failure]")?.getAttribute("data-failure")).toBe(code));
      expect(document.querySelector("img")).toBeNull();
    }
    cleanup();
    const body = await withBytes("gif", GIF, { sha: "9".repeat(64) });
    const port = fakePort({ requestRender: vi.fn(() => ok(201, body)), readArtifactContent: vi.fn(async () => ({ status: 200, contentType: "image/gif", bytes: GIF })) } as never); mount(port);
    click("Render exact revision");
    await waitFor(() => screen.getByRole("button", { name: /Preview GIF/u }));
    click(/Preview GIF/u);
    await waitFor(() => expect(document.querySelector("[data-failure]")?.getAttribute("data-failure")).toBe("CONTENT_DIGEST_MISMATCH"));
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).not.toContain("Bytes verified");
  });

  it("refuses an oversize registered render without requesting its bytes, and says so when no content route exists", async () => {
    const body = await withBytes("gif", GIF, { sizeBytes: 64 * 1024 * 1024 });
    const readArtifactContent = vi.fn();
    mount(fakePort({ requestRender: vi.fn(() => ok(201, body)), readArtifactContent } as never));
    click("Render exact revision");
    await waitFor(() => screen.getByRole("button", { name: /Download GIF/u }));
    click(/Download GIF/u);
    await waitFor(() => expect(document.querySelector("[data-failure]")?.getAttribute("data-failure")).toBe("CONTENT_TOO_LARGE"));
    expect(readArtifactContent).not.toHaveBeenCalled();
    cleanup();
    mount(fakePort()); click("Render exact revision");
    await waitFor(() => expect(document.body.textContent).toContain("no DEV_ONLY content route"));
  });
});

describe("DevProjectOutputsPanel reviewer assignment", () => {
  const openAs = async (principalId: string, body: Record<string, unknown> = {}, over: Partial<DevProjectOutputsPort> = {}) => {
    const port = fakePort({ principalId, openReview: vi.fn(() => ok(201, reviewBody(body))), ...over } as never);
    mount(port);
    click("Open review case");
    await waitFor(() => expect(screen.getByRole("article", { name: /Review case/u })).toBeTruthy());
    return port;
  };
  const submitDisabled = (): boolean => (screen.getByRole("button", { name: "Record DEV_ONLY decision" }) as HTMLButtonElement).disabled;

  it("disables decisions for the owner and explains that the owner cannot decide", async () => {
    await openAs("owner-1");
    expect(submitDisabled()).toBe(true);
    expect((screen.getByLabelText("Scope") as HTMLSelectElement).disabled).toBe(true);
    expect(document.querySelector("[data-decision-gate='OWNER']")?.textContent).toMatch(/owner cannot decide/u);
    expect(screen.getByRole("button", { name: "Assign reviewer" })).toBeTruthy();
  });

  it.each([
    ["stranger-9", {}, "NOT_ASSIGNED", /no reviewer assignment/u],
    ["reviewer-1", { assignments: [assignment({ status: "REVOKED", assignmentVersion: 2 })] }, "REVOKED", /revoked/u],
    ["reviewer-1", { assignments: [assignment({ status: "EXPIRED" })] }, "EXPIRED", /expired/u],
    ["reviewer-1", { assignments: [assignment({ expiresAt: "2025-12-31T00:00:00Z" })] }, "EXPIRED", /expired/u],
  ])("explains %s cannot decide (%s)", async (principal, body, gate, text) => {
    await openAs(principal, body);
    expect(submitDisabled()).toBe(true);
    expect(document.querySelector(`[data-decision-gate='${gate}']`)?.textContent).toMatch(text);
    expect(screen.queryByRole("button", { name: "Assign reviewer" })).toBeNull();
  });

  it("lets an assigned reviewer pick only an assigned scope and records DEV_ASSIGNED_REVIEWER_ACCEPT without approval", async () => {
    const port = await openAs("reviewer-1");
    const options = Array.from((screen.getByLabelText("Scope") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(["", "QUALITY", "APPROVAL"]);
    expect(submitDisabled()).toBe(true);
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 2,
      records: [{ appendRecordId: "rec-2", caseRevision: 2, kind: "DECISION", decision: "ACCEPT", reason: "Reviewed", currentness: "CURRENT", recordedAs: "DEV_ASSIGNED_REVIEWER_ACCEPT", scope: "APPROVAL", principalId: "reviewer-1" }],
      reviewState: { status: "DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT", latestDecision: { decision: "ACCEPT" }, establishesApproval: false, humanReviewApproval: false } })));
    port.recordReviewDecision.mockImplementation(() => ok(201, receipt({ caseRevision: 2 })));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(status("review-status")).toContain("not human approval"));
    expect(port.recordReviewDecision).toHaveBeenCalledWith("devreview.1", expect.objectContaining({ decision: "ACCEPT", scope: "APPROVAL" }));
    const text = screen.getByRole("article", { name: /Review case/u }).textContent ?? "";
    expect(text).toContain("DEV_ASSIGNED_REVIEWER_ACCEPT");
    expect(text).toContain("scope APPROVAL");
    expect(text).toContain("by reviewer-1");
    expect(text).toContain("establishesApproval=false");
    expect(screen.getByRole("note", { name: "Review approval disclaimer" }).textContent).toMatch(/not human approval/u);
  });

  it("assigns a reviewer with scopes and an expiry within 30 days, then revokes", async () => {
    const port = await openAs("owner-1", { assignments: [] });
    const assign = screen.getByRole("button", { name: "Assign reviewer" }) as HTMLButtonElement;
    expect(assign.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reviewer principal ID"), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "APPROVAL" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "QUALITY" }));
    fireEvent.change(screen.getByLabelText(/Expires in days/u), { target: { value: "31" } });
    expect(assign.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Expires in days/u), { target: { value: "30" } });
    expect(assign.disabled).toBe(false);
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 1 })));
    const before = Date.now();
    fireEvent.click(assign);
    await waitFor(() => expect(status("review-status")).toContain("Assigned (HTTP 201)"));
    const request = port.assignReviewer.mock.calls[0]![1] as { reviewerPrincipalId: string; scopes: string[]; expiresAt: string; expectedCaseRevision: number };
    expect(request).toMatchObject({ reviewerPrincipalId: "reviewer-1", scopes: ["APPROVAL", "QUALITY"], expectedCaseRevision: 0 });
    expect(Date.parse(request.expiresAt) - before).toBeLessThanOrEqual(30 * 86_400_000);
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(before);
    expect(screen.getByLabelText("Reviewer assignments", { selector: "ul" }).textContent).toContain("reviewer-1");
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 2, assignments: [assignment({ status: "REVOKED", assignmentVersion: 2 })] })));
    fireEvent.click(screen.getByRole("button", { name: "Revoke reviewer-1 assignment" }));
    await waitFor(() => expect(status("review-status")).toContain("Revoked reviewer-1"));
    expect(port.revokeReviewAssignment).toHaveBeenCalledWith("devreview.1", "asg-1", expect.objectContaining({ expectedCaseRevision: 1 }));
    expect(screen.queryByRole("button", { name: /Revoke/u })).toBeNull();
  });

  it.each([
    [403, "REVIEWER_NOT_ASSIGNED", /case owner cannot decide/u],
    [403, "REVIEW_SCOPE_NOT_ASSIGNED", /does not include the chosen scope/u],
    [403, "REVIEW_ASSIGNMENT_EXPIRED", /assignment has expired/u],
    [409, "REVIEW_AUTHORITY_CHANGED", /authority changed/u],
  ])("shows %i %s for a decision as a typed refusal", async (statusCode, code, text) => {
    const port = await openAs("reviewer-1");
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "APPROVAL" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText(/I confirm/u));
    port.recordReviewDecision.mockImplementation(() => fail(statusCode, code));
    click("Record DEV_ONLY decision");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(code));
    expect(status("review-status")).toMatch(text);
  });

  it.each([
    [422, "REVIEW_SELF_ASSIGNMENT_REFUSED", /cannot assign themselves/u],
    [409, "REVIEW_ASSIGNMENT_ALREADY_ACTIVE", /already holds an active assignment/u],
    [409, "REVIEW_ASSIGNMENT_ALREADY_REVOKED", /already revoked/u],
    [404, "REVIEW_ASSIGNMENT_NOT_FOUND", /not on this review case/u],
    [400, "INVALID_REQUEST", /within 30 days/u],
  ])("shows %i %s for an assignment", async (statusCode, code, text) => {
    const port = await openAs("owner-1", { assignments: [] });
    port.assignReviewer.mockImplementation(() => fail(statusCode, code));
    fireEvent.change(screen.getByLabelText("Reviewer principal ID"), { target: { value: "reviewer-1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "APPROVAL" }));
    click("Assign reviewer");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(code));
    expect(status("review-status")).toMatch(text);
  });

  it("lets a reviewer reopen the owner's case by id without any project and comment", async () => {
    const port = fakePort({ principalId: "reviewer-1" } as never);
    render(React.createElement(DevReviewSection, { outputs: port as unknown as DevProjectOutputsPort, locked: false, newRequestId: nextId, projectId: null, headKey: null, subjectChoices: [] }));
    expect(screen.queryByRole("button", { name: "Open review case" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Known review case ID"), { target: { value: "devreview.1" } });
    click("Reopen known review case");
    await waitFor(() => expect(document.querySelector("[data-review-case='devreview.1']")).not.toBeNull());
    expect(port.getReview).toHaveBeenCalledWith("devreview.1");
    expect(screen.queryByRole("button", { name: "Assign reviewer" })).toBeNull();
    expect((screen.getByLabelText("Scope") as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "From the reviewer" } });
    port.getReview.mockImplementation(() => ok(200, reviewBody({ caseRevision: 1 })));
    click("Add comment");
    await waitFor(() => expect(status("review-status")).toContain("Recorded comment"));
  });
});
