// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { MediaDevProjectTimelineError, type DevProject, type DevProjectRead, type DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import { DevOfflineDraftsPanel } from "./DevOfflineDraftsPanel";

const project: DevProject = { tenantId: "tenant-a", projectId: "project-a", workspaceId: "w", ownerPrincipalId: "p", title: "t", headRevisionId: "rev-1" };
const revision: DevProjectRevision = { tenantId: "tenant-a", projectId: "project-a", revisionId: "rev-1", parentRevisionId: null,
  timelines: [{ semanticVersionId: "v1", graph: { timelineId: "main", scenes: [], tracks: [], clips: [] } }] };
const readOf = (head: string): DevProjectRead => ({ scope: "DEV_ONLY", project: { ...project, headRevisionId: head }, currentRevision: { ...revision, revisionId: head } });

function setup(head = "rev-1") {
  let current = head; let n = 0;
  const client = {
    getProject: vi.fn(async () => readOf(current)),
    editTimeline: vi.fn(async (_p: string, _t: string, r: { expectedHeadRevisionId: string }) =>
      ({ scope: "DEV_ONLY", revision: { ...revision, revisionId: "rev-2", parentRevisionId: r.expectedHeadRevisionId } }) as never),
  };
  const view = render(React.createElement(DevOfflineDraftsPanel, {
    client, project, revision, principalId: "principal-a", indexedDB: new IDBFactory(), newId: () => `id-${++n}`,
  }));
  return { client, view, setHead: (h: string) => { current = h; } };
}
const save = async (sceneId: string): Promise<void> => {
  await waitFor(() => expect((screen.getByRole("button", { name: "Save as offline draft" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Scene id"), { target: { value: sceneId } });
  fireEvent.click(screen.getByRole("button", { name: "Save as offline draft" }));
  await screen.findByText(/Saved offline draft/);
};

const clickEnabled = async (name: string): Promise<void> => {
  await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name }));
};

describe("DevOfflineDraftsPanel", () => {
  it("captures a draft while offline without sending, and replay needs an explicit review then confirm", async () => {
    const { client } = setup();
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByTestId("offline-link-state").textContent).toContain("Offline");
    await save("scene-offline");
    expect(client.editTimeline).not.toHaveBeenCalled();
    expect(client.getProject).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Review and replay" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(screen.getByTestId("offline-link-state").textContent).toContain("Online");
    expect(client.editTimeline).not.toHaveBeenCalled(); // reconnect never replays
    await clickEnabled("Review and replay");
    await screen.findByLabelText("Draft review");
    expect(client.editTimeline).not.toHaveBeenCalled(); // review sends nothing
    await clickEnabled("Confirm replay");
    await waitFor(() => expect(client.editTimeline).toHaveBeenCalledTimes(1));
    expect(client.editTimeline.mock.calls[0]![2]).toEqual({ expectedHeadRevisionId: "rev-1", edits: [{ type: "addScene", sceneId: "scene-offline", order: 0 }] });
    await screen.findByText(/APPLIED \(201\)/);
  });

  it("shows REVISION_CONFLICT with the current head instead of merging", async () => {
    const { client, setHead } = setup();
    await save("scene-stale");
    setHead("rev-7");
    await clickEnabled("Review and replay");
    await screen.findByText(/project head now/);
    expect(screen.getByLabelText("Draft review").textContent).toContain("rev-7");
    await clickEnabled("Confirm replay");
    await waitFor(() => expect(screen.getAllByRole("status").map((e) => e.textContent).join(" ")).toMatch(/REVISION_CONFLICT.*rev-1.*rev-7/));
    expect(client.editTimeline).not.toHaveBeenCalled();
    await clickEnabled("Review and replay");
    fireEvent.click(await screen.findByRole("button", { name: "Rebase onto current head" }));
    await screen.findByText(/rebased onto the current head with a new requestId/);
    expect(client.editTimeline).not.toHaveBeenCalled();
  });

  it("marks the link offline after a failed request and discards on 403", async () => {
    const { client } = setup();
    await save("scene-x");
    client.getProject.mockRejectedValueOnce(new MediaDevProjectTimelineError("TRANSPORT_ERROR", 0, "down"));
    await clickEnabled("Review and replay");
    await waitFor(() => expect(screen.getByTestId("offline-link-state").textContent).toContain("Offline"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await clickEnabled("Review and replay");
    await screen.findByLabelText("Draft review");
    client.getProject.mockRejectedValue(new MediaDevProjectTimelineError("FORBIDDEN", 403, "no"));
    await clickEnabled("Confirm replay");
    await screen.findByText(/DISCARDED \(403 ACCESS_REVOKED\)/);
    await screen.findByText("No offline drafts.");
  });
});
