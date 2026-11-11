// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DevProject, DevProjectRead, DevProjectRevision, DevRevisionRead, DevTimelineClip } from "@audio-video/client/dev-project-timeline";
import { MediaProductRenderer, MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS } from "./MediaProductRenderer";
import type { DevProjectTimelineWorkspacePort } from "./DevProjectTimelineWorkspaceScreen";

const sourceSha256 = "a".repeat(64);
const sourceArtifact = {
  tenantId: "tenant-dev-1", principalId: "owner-dev-1", artifactId: "artifact-main",
  artifactVersionId: `sha256:${sourceSha256}`, fileName: "source.wav", contentType: "audio/wav", sha256: sourceSha256,
};

const project: DevProject = {
  tenantId: "tenant-dev-1", projectId: "project-dev-1", workspaceId: "workspace-dev-1",
  ownerPrincipalId: "owner-dev-1", title: "DEV_ONLY review", headRevisionId: "revision-1",
};
const initial: DevProjectRevision = {
  tenantId: project.tenantId, projectId: project.projectId, revisionId: "revision-1", parentRevisionId: null, timelines: [],
};
const timelineRevision: DevProjectRevision = {
  ...initial, revisionId: "revision-2", parentRevisionId: "revision-1", timelines: [
    { semanticVersionId: "timeline-version-1", graph: { timelineId: "main-cut", scenes: [], tracks: [], clips: [] } },
  ],
};
const restoredRevision: DevProjectRevision = {
  ...initial, revisionId: "revision-3", parentRevisionId: "revision-2", timelines: [],
};
const sceneRevision: DevProjectRevision = {
  ...timelineRevision, revisionId: "revision-3", parentRevisionId: "revision-2", timelines: [
    { ...timelineRevision.timelines[0]!, semanticVersionId: "timeline-version-2", graph: {
      ...timelineRevision.timelines[0]!.graph, scenes: [{ sceneId: "scene-01", order: 0 }],
    } },
  ],
};
const trackedRevision: DevProjectRevision = {
  ...sceneRevision, revisionId: "revision-4", parentRevisionId: "revision-3", timelines: [
    { ...sceneRevision.timelines[0]!, semanticVersionId: "timeline-version-3", graph: {
      ...sceneRevision.timelines[0]!.graph,
      tracks: [{ trackId: "video-01", sceneId: "scene-01", kind: "VIDEO", order: 0 }],
    } },
  ],
};
const exactClip: DevTimelineClip = {
  clipId: "clip-01", sceneId: "scene-01", trackId: "video-01",
  source: { artifactId: sourceArtifact.artifactId, artifactVersionId: sourceArtifact.artifactVersionId },
  sourceIn: { ticks: "0", rateNumerator: "16000", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
  sourceOut: { ticks: "16000", rateNumerator: "16000", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
  storyStart: { ticks: "0", rateNumerator: "48000", rateDenominator: "1", clock: "STORY" },
  storyDuration: { ticks: "48000", rateNumerator: "48000", rateDenominator: "1", clock: "STORY" },
};
const clipRevision: DevProjectRevision = {
  ...trackedRevision, revisionId: "revision-5", parentRevisionId: "revision-4", timelines: [
    { ...trackedRevision.timelines[0]!, semanticVersionId: "timeline-version-4", graph: {
      ...trackedRevision.timelines[0]!.graph, clips: [exactClip],
    } },
  ],
};
const clipRemovedRevision: DevProjectRevision = {
  ...clipRevision, revisionId: "revision-6", parentRevisionId: "revision-5", timelines: [
    { ...clipRevision.timelines[0]!, semanticVersionId: "timeline-version-5", graph: {
      ...clipRevision.timelines[0]!.graph, clips: [],
    } },
  ],
};

describe("DevProjectTimelineWorkspaceScreen", () => {
  it("creates an empty timeline, reads its exact persisted revision, then restores it as a successor revision", async () => {
    let head = initial;
    const revisions = new Map([[initial.revisionId, initial], [timelineRevision.revisionId, timelineRevision], [restoredRevision.revisionId, restoredRevision]]);
    const current = (): DevProjectRead => ({ project: { ...project, headRevisionId: head.revisionId }, currentRevision: head, scope: "DEV_ONLY" });
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => current()),
      getRevision: vi.fn(async (_projectId, revisionId) => ({ revision: revisions.get(revisionId)!, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async (_projectId, request) => {
        expect(request).toEqual({ expectedHeadRevisionId: "revision-1", timelineId: "main-cut" });
        head = timelineRevision;
        return { revision: timelineRevision, scope: "DEV_ONLY" } satisfies DevRevisionRead;
      }),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async (_projectId, request) => {
        expect(request).toEqual({ expectedHeadRevisionId: "revision-2", targetRevisionId: "revision-1" });
        head = restoredRevision;
        return { revision: restoredRevision, scope: "DEV_ONLY" } satisfies DevRevisionRead;
      }),
    };
    expect(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS["dev-project-timeline"]).toEqual({
      renderer: "DEV_ONLY_DEVELOPMENT_SCREEN", productRoute: "NOT_ADMITTED",
    });
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));

    expect(screen.getByText("No timelines yet.")).toBeTruthy();
    expect(screen.getByText(/DEV_ONLY · NOT_ADMITTED/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Render engine unavailable" })).toBeTruthy();
    expect(screen.getByText(/No render request has been submitted and no output is implied/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Timeline ID"), { target: { value: "main-cut" } });
    fireEvent.click(screen.getByRole("button", { name: "Create timeline" }));
    expect(await screen.findByText(/Created empty timeline main-cut; exact revision revision-2 reopened/)).toBeTruthy();
    expect(screen.getByText(/0 scenes, 0 tracks, 0 clips/)).toBeTruthy();
    expect(screen.getByLabelText("Project head revision").textContent).toBe("revision-2");
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe("revision-2");
    expect(client.createTimeline).toHaveBeenCalledTimes(1);
    expect(client.getProject).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: "revision-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText("Immutable revision readback")).toBeTruthy();
    expect(screen.getByText("revision-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore as new project head" }));
    expect(await screen.findByText(/Restored exact graph state from revision-1 as new head revision-3/)).toBeTruthy();
    expect(client.restoreRevision).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No timelines yet.")).toBeTruthy();
    expect(screen.getByLabelText("Project head revision").textContent).toBe("revision-3");
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe("revision-3");
  });

  it("locks another mutation after an unknown create until project-head reconciliation", async () => {
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project, currentRevision: initial, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => { throw new Error("response lost"); }),
      editTimeline: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));
    fireEvent.change(screen.getByLabelText("Timeline ID"), { target: { value: "main-cut" } });
    fireEvent.click(screen.getByRole("button", { name: "Create timeline" }));
    expect(await screen.findByText(/OUTCOME_UNKNOWN: the owner head could not confirm timeline main-cut/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create timeline" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText(/A retry with this same ID is now available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry after absence confirmed" }).hasAttribute("disabled")).toBe(false);
    expect(client.getProject).toHaveBeenCalledTimes(1);
  });

  it("refuses mutations when the host-projected revision is not the project head", () => {
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project, currentRevision: initial, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: timelineRevision }));
    expect(screen.getByText(/Project and revision identities do not match/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create timeline" }).hasAttribute("disabled")).toBe(true);
    expect(client.createTimeline).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", { ...project, tenantId: "tenant-other", headRevisionId: timelineRevision.revisionId }, { ...timelineRevision, tenantId: "tenant-other" }],
    ["project", { ...project, projectId: "project-other", headRevisionId: timelineRevision.revisionId }, { ...timelineRevision, projectId: "project-other" }],
    ["workspace", { ...project, workspaceId: "workspace-other", headRevisionId: timelineRevision.revisionId }, timelineRevision],
    ["owner", { ...project, ownerPrincipalId: "owner-other", headRevisionId: timelineRevision.revisionId }, timelineRevision],
    ["head", { ...project, headRevisionId: "revision-1" }, timelineRevision],
  ] as const)("keeps a mutation outcome unresolved when the readback has a mismatched %s", async (_label, currentProject, currentRevision) => {
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: currentProject, currentRevision, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));
    fireEvent.change(screen.getByLabelText("Timeline ID"), { target: { value: "main-cut" } });
    fireEvent.click(screen.getByRole("button", { name: "Create timeline" }));

    expect(await screen.findByText(/OUTCOME_UNKNOWN: the owner head could not confirm timeline main-cut/)).toBeTruthy();
    expect(client.createTimeline).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Create timeline" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText(/current project head is still unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry after absence confirmed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create timeline" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Project head revision").textContent).toBe("revision-1");
    expect(client.createTimeline).toHaveBeenCalledTimes(1);
  });

  it("clears exact revision observations and drafts when switching project scope", async () => {
    const otherProject: DevProject = { ...project, tenantId: "tenant-other", projectId: "project-other", headRevisionId: "other-revision-1" };
    const otherRevision: DevProjectRevision = { tenantId: otherProject.tenantId, projectId: otherProject.projectId, revisionId: "other-revision-1", parentRevisionId: null, timelines: [] };
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: otherProject, currentRevision: otherRevision, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async (_projectId, revisionId) => ({ revision: revisionId === initial.revisionId ? initial : otherRevision, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    const { rerender } = render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));
    fireEvent.change(screen.getByLabelText("Timeline ID"), { target: { value: "old-draft" } });
    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: "revision-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText("Immutable revision readback")).toBeTruthy();
    rerender(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project: otherProject, revision: otherRevision }));
    expect(screen.queryByText("Immutable revision readback")).toBeNull();
    expect((screen.getByLabelText("Timeline ID") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Exact revision ID") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Restore as new project head" }).hasAttribute("disabled")).toBe(true);
  });

  it("retries the same graph edit only after a project-head read confirms it is absent", async () => {
    let head = timelineRevision;
    let attempts = 0;
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: { ...project, headRevisionId: head.revisionId }, currentRevision: head, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async (_projectId, _timelineId, request) => {
        attempts += 1;
        expect(request.expectedHeadRevisionId).toBe("revision-2");
        expect(request.edits).toEqual([{ type: "addScene", sceneId: "scene-01", order: 0 }]);
        if (attempts === 1) throw new Error("response lost");
        head = sceneRevision;
        return { revision: sceneRevision, scope: "DEV_ONLY" as const };
      }),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project: { ...project, headRevisionId: "revision-2" }, revision: timelineRevision }));
    fireEvent.change(screen.getByLabelText("New scene ID"), { target: { value: "scene-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
    expect(await screen.findByText(/OUTCOME_UNKNOWN: addScene may have committed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add scene" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText(/Owner head confirms this graph edit is absent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry after absence confirmed" }));
    expect(await screen.findByText(/Committed and reopened addScene in revision revision-3/)).toBeTruthy();
    expect(attempts).toBe(2);
    expect(screen.getAllByText("scene-01").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Project head revision").textContent).toBe("revision-3");
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe("revision-3");
  });

  it("does not reconcile an identical old graph as a committed restore without a successor head", async () => {
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project, currentRevision: initial, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => { throw new Error("response lost before project head advanced"); }),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));
    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: "revision-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText("Immutable revision readback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore as new project head" }));
    expect(await screen.findByText(/OUTCOME_UNKNOWN: restore is still unresolved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText(/Owner head confirms the restore is not present/)).toBeTruthy();
    expect(screen.queryByText(/Restore outcome reconciled/)).toBeNull();
  });

  it("does not reconcile a same-graph sibling revision as the pending restore successor", async () => {
    const baseHead: DevProjectRevision = { ...initial, revisionId: "revision-2", parentRevisionId: initial.revisionId };
    const siblingHead: DevProjectRevision = { ...initial, revisionId: "revision-3", parentRevisionId: initial.revisionId };
    const scopedProject: DevProject = { ...project, headRevisionId: baseHead.revisionId };
    let head = baseHead;
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: { ...scopedProject, headRevisionId: head.revisionId }, currentRevision: head, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => { head = siblingHead; throw new Error("restore response lost"); }),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project: scopedProject, revision: baseHead }));
    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: initial.revisionId } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText("Immutable revision readback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore as new project head" }));
    expect(await screen.findByText(/OUTCOME_UNKNOWN: restore is still unresolved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText("Owner head changed but the requested effect is not visible. No retry is enabled.")).toBeTruthy();
    expect(screen.queryByText(/Restore outcome reconciled/)).toBeNull();
    expect(client.restoreRevision).toHaveBeenCalledWith(scopedProject.projectId, { expectedHeadRevisionId: baseHead.revisionId, targetRevisionId: initial.revisionId });
  });

  it("reads an exact owner artifact before putting a clip, rejects removal of its track, then removes the clip", async () => {
    let head = trackedRevision;
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async (artifactId) => {
        expect(artifactId).toBe(sourceArtifact.artifactId);
        return sourceArtifact;
      }),
      getProject: vi.fn(async () => ({
        project: { ...project, headRevisionId: head.revisionId }, currentRevision: head, scope: "DEV_ONLY" as const,
      })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async (_projectId, timelineId, request) => {
        expect(timelineId).toBe("main-cut");
        expect(request.expectedHeadRevisionId).toBe(head.revisionId);
        if (request.edits[0]?.type === "putClip") {
          expect(request.edits).toEqual([{ type: "putClip", clip: exactClip }]);
          head = clipRevision;
          return { revision: clipRevision, scope: "DEV_ONLY" as const };
        }
        if (request.edits[0]?.type === "removeClip") {
          expect(request.edits).toEqual([{ type: "removeClip", clipId: exactClip.clipId }]);
          head = clipRemovedRevision;
          return { revision: clipRemovedRevision, scope: "DEV_ONLY" as const };
        }
        throw new Error(`Unexpected timeline edit: ${request.edits[0]?.type}`);
      }),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project: { ...project, headRevisionId: trackedRevision.revisionId }, revision: trackedRevision }));

    expect(screen.getByRole("button", { name: "Add or update clip reference" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Source artifact ID to inspect"), { target: { value: sourceArtifact.artifactId } });
    fireEvent.click(screen.getByRole("button", { name: "Read source artifact" }));
    expect(await screen.findByLabelText("Inspected source artifact")).toBeTruthy();
    expect(client.getOwnedArtifact).toHaveBeenCalledTimes(1);
    expect(client.editTimeline).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Clip ID"), { target: { value: exactClip.clipId } });
    fireEvent.change(screen.getByLabelText("Source out ticks"), { target: { value: exactClip.sourceOut.ticks } });
    fireEvent.change(screen.getByLabelText("Source rate numerator"), { target: { value: exactClip.sourceIn.rateNumerator } });
    fireEvent.change(screen.getByLabelText("Story duration ticks"), { target: { value: exactClip.storyDuration.ticks } });
    fireEvent.change(screen.getByLabelText("Story rate numerator"), { target: { value: exactClip.storyStart.rateNumerator } });
    fireEvent.click(screen.getByRole("button", { name: "Add or update clip reference" }));

    expect(await screen.findByText(/Committed and reopened putClip in revision revision-5/)).toBeTruthy();
    expect(client.editTimeline).toHaveBeenCalledTimes(1);
    expect(client.editTimeline).toHaveBeenLastCalledWith(project.projectId, "main-cut", {
      expectedHeadRevisionId: trackedRevision.revisionId,
      edits: [{ type: "putClip", clip: exactClip }],
    });
    expect(screen.getByLabelText("Project head revision").textContent).toBe(clipRevision.revisionId);
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe(clipRevision.revisionId);
    expect(JSON.parse(screen.getByLabelText("Latest timeline revision JSON").textContent ?? "{}").revision.timelines[0].graph.clips).toEqual([exactClip]);

    fireEvent.click(screen.getByRole("button", { name: "Remove track" }));
    expect(screen.getByText("Track ID video-01 still owns clips. Remove its clips before removing the track; no mutation was sent.")).toBeTruthy();
    expect(client.editTimeline).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove clip" }));
    expect(await screen.findByText(/Committed and reopened removeClip in revision revision-6/)).toBeTruthy();
    expect(client.editTimeline).toHaveBeenCalledTimes(2);
    expect(client.editTimeline).toHaveBeenLastCalledWith(project.projectId, "main-cut", {
      expectedHeadRevisionId: clipRevision.revisionId,
      edits: [{ type: "removeClip", clipId: exactClip.clipId }],
    });
    expect(screen.getByLabelText("Project head revision").textContent).toBe(clipRemovedRevision.revisionId);
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe(clipRemovedRevision.revisionId);
    expect(screen.getByText("No clips in this timeline yet.")).toBeTruthy();
  });

  it("recovers a failed project-head reopen with a read only and never offers a mutation retry", async () => {
    let reads = 0;
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new Error("head read unavailable");
        return { project, currentRevision: initial, scope: "DEV_ONLY" as const };
      }),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));

    fireEvent.click(screen.getByRole("button", { name: "Reopen current project" }));
    expect(await screen.findByText(/Project head is unavailable or has a mismatched identity/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read current project head" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry after absence confirmed" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Read current project head" }));
    expect(await screen.findByText(`Reopened project ${project.projectId} at head ${initial.revisionId}.`)).toBeTruthy();
    expect(screen.getByLabelText("Project head revision").textContent).toBe(initial.revisionId);
    expect(screen.getByLabelText("Displayed project revision").textContent).toBe(initial.revisionId);
    expect(client.getProject).toHaveBeenCalledTimes(2);
    expect(client.createTimeline).not.toHaveBeenCalled();
    expect(client.editTimeline).not.toHaveBeenCalled();
    expect(client.restoreRevision).not.toHaveBeenCalled();
  });

  it("reconciles an initially mismatched project/revision pair without treating it as a pending timeline create", async () => {
    const mismatchedProject = { ...project, headRevisionId: "stale-head" };
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project, currentRevision: initial, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project: mismatchedProject, revision: initial }));

    expect(screen.getByText(/Project and revision identities do not match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Read current project head" }));
    expect(await screen.findByText(`Reopened project ${project.projectId} at head ${initial.revisionId}.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry after absence confirmed" })).toBeNull();
    expect(client.getProject).toHaveBeenCalledTimes(1);
    expect(client.createTimeline).not.toHaveBeenCalled();
    expect(client.editTimeline).not.toHaveBeenCalled();
    expect(client.restoreRevision).not.toHaveBeenCalled();
  });

  it("compares an exact historical revision with the displayed head without issuing a mutation", async () => {
    const currentProject = { ...project, headRevisionId: clipRevision.revisionId };
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: currentProject, currentRevision: clipRevision, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: sceneRevision, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: clipRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, {
      kind: "dev-project-timeline", client, project: currentProject, revision: clipRevision,
    }));
    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: sceneRevision.revisionId } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText(/Read exact revision revision-3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compare with displayed revision" }));
    expect(await screen.findByRole("heading", { name: "Exact revision comparison" })).toBeTruthy();
    expect(screen.getAllByText("revision-3", { selector: "code" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("revision-5", { selector: "code" }).length).toBeGreaterThan(0);
    const changes = screen.getByRole("list", { name: "Timeline graph changes" }).textContent ?? "";
    expect(changes).toContain("added track");
    expect(changes).toContain("added clip");
    expect(screen.getByText(/does not evaluate source rights, clock mapping, overlap behavior, or rendered output/)).toBeTruthy();
    expect(client.getRevision).toHaveBeenCalledTimes(1);
    expect(client.createTimeline).not.toHaveBeenCalled();
    expect(client.editTimeline).not.toHaveBeenCalled();
    expect(client.restoreRevision).not.toHaveBeenCalled();
  });

  it("refuses to compare an exact revision returned for another project scope", async () => {
    const foreignRevision: DevProjectRevision = { ...sceneRevision, tenantId: "tenant-other" };
    const currentProject = { ...project, headRevisionId: clipRevision.revisionId };
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({ project: currentProject, currentRevision: clipRevision, scope: "DEV_ONLY" as const })),
      getRevision: vi.fn(async () => ({ revision: foreignRevision, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      editTimeline: vi.fn(async () => ({ revision: clipRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, {
      kind: "dev-project-timeline", client, project: currentProject, revision: clipRevision,
    }));
    fireEvent.change(screen.getByLabelText("Exact revision ID"), { target: { value: sceneRevision.revisionId } });
    fireEvent.click(screen.getByRole("button", { name: "Read exact revision" }));
    expect(await screen.findByText(/unavailable or could not be verified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compare with displayed revision" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Exact revision comparison" })).toBeNull();
  });

  it("does not attribute a matching timeline in a different successor to an unknown create request", async () => {
    const competingRevision: DevProjectRevision = {
      ...timelineRevision, revisionId: "revision-concurrent", parentRevisionId: "revision-other-base",
    };
    const client: DevProjectTimelineWorkspacePort = {
      getOwnedArtifact: vi.fn(async () => sourceArtifact),
      getProject: vi.fn(async () => ({
        project: { ...project, headRevisionId: competingRevision.revisionId },
        currentRevision: competingRevision,
        scope: "DEV_ONLY" as const,
      })),
      getRevision: vi.fn(async () => ({ revision: initial, scope: "DEV_ONLY" as const })),
      createTimeline: vi.fn(async () => { throw new Error("response lost"); }),
      editTimeline: vi.fn(async () => ({ revision: timelineRevision, scope: "DEV_ONLY" as const })),
      restoreRevision: vi.fn(async () => ({ revision: restoredRevision, scope: "DEV_ONLY" as const })),
    };
    render(React.createElement(MediaProductRenderer, { kind: "dev-project-timeline", client, project, revision: initial }));
    fireEvent.change(screen.getByLabelText("Timeline ID"), { target: { value: "main-cut" } });
    fireEvent.click(screen.getByRole("button", { name: "Create timeline" }));
    expect(await screen.findByText(/OUTCOME_UNKNOWN: the owner head could not confirm timeline main-cut/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reconcile timeline outcome" }));
    expect(await screen.findByText("Owner head changed but the requested effect is not visible. No retry is enabled.")).toBeTruthy();
    expect(screen.queryByText(/Timeline outcome reconciled/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry after absence confirmed" })).toBeNull();
  });
});
