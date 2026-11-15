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
  await waitFor(() => expect((screen.getByRole("button", { name: "Save as offline draft" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
  fireEvent.change(screen.getByLabelText("Scene id"), { target: { value: sceneId } });
  fireEvent.click(screen.getByRole("button", { name: "Save as offline draft" }));
  await screen.findByText(/Saved offline draft/, undefined, { timeout: 10_000 });
};

const clickEnabled = async (name: string): Promise<void> => {
  await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
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

  it("shows both versions on a stale review; keep-mine rebases without sending, take-theirs discards", async () => {
    const { client, setHead } = setup();
    await save("scene-stale");
    setHead("rev-7");
    await clickEnabled("Review and replay");
    const conflict = await screen.findByTestId("offline-conflict");
    expect(screen.getByTestId("conflict-mine").textContent).toContain("Add scene scene-stale");
    expect(screen.getByTestId("conflict-theirs").textContent).toContain("rev-7");
    expect(conflict.textContent).toContain("rev-1");
    expect(screen.queryByRole("button", { name: "Confirm replay" })).toBeNull(); // a stale draft is never blindly replayed
    fireEvent.click(screen.getByRole("button", { name: "Keep mine (rebase onto current head)" }));
    await screen.findByText(/Kept mine: the edit was rebased onto the current head with a new requestId/);
    expect(client.editTimeline).not.toHaveBeenCalled();
    await clickEnabled("Review and replay");
    await screen.findByLabelText("Draft review");
    expect(screen.getByLabelText("Draft review").textContent).toContain("unchanged");
    await clickEnabled("Confirm replay");
    await waitFor(() => expect(client.editTimeline).toHaveBeenCalledTimes(1));
    expect(client.editTimeline.mock.calls[0]![2]).toMatchObject({ expectedHeadRevisionId: "rev-7" });
    await save("scene-theirs");
    setHead("rev-9");
    await clickEnabled("Review and replay");
    await screen.findByTestId("offline-conflict");
    fireEvent.click(screen.getByRole("button", { name: "Take theirs (discard my draft)" }));
    await screen.findByText(/Took theirs: my draft was discarded; the server version rev-9 stands/);
    await screen.findByText("No offline drafts.");
  });

  it("refuses typed on 403 and keeps the draft; marks the link offline after a transport failure", async () => {
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
    expect((await screen.findAllByText(/REFUSED \(403 ACCESS_DENIED\)/)).length).toBeGreaterThan(0);
    expect(client.editTimeline).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add scene scene-x/)).toBeTruthy(); // the draft is still listed
    expect(screen.queryByText("No offline drafts.")).toBeNull();
  });

  it("asks for a fresh token with a typed message when none is available", async () => {
    const { client } = setup();
    await save("scene-y");
    client.getProject.mockRejectedValue(Object.assign(new MediaDevProjectTimelineError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required."), {}));
    await clickEnabled("Review and replay");
    await screen.findByText(/AUTH_REQUIRED: connect with a fresh DEV_ONLY token/);
    expect(client.editTimeline).not.toHaveBeenCalled();
  });

  it("fails closed on an undecryptable draft: typed alert, no remote call, send controls disabled until an explicit discard", async () => {
    const idb = new IDBFactory(); let n = 0;
    const client = { getProject: vi.fn(async () => readOf("rev-1")), editTimeline: vi.fn() };
    const mount = () => render(React.createElement(DevOfflineDraftsPanel, { client: client as never, project, revision, principalId: "principal-a", indexedDB: idb, newId: () => `id-${++n}` }));
    const first = mount();
    await save("scene-corrupt");
    first.unmount();
    const name = (await idb.databases()).map((db) => db.name!).find((x) => x.startsWith("ghatana-media-offline-drafts-v1:"))!;
    const db = await new Promise<IDBDatabase>((resolve) => { const r = idb.open(name); r.onsuccess = () => resolve(r.result); });
    const storeName = Array.from(db.objectStoreNames)[0]!;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(storeName, "readwrite"); const os = tx.objectStore(storeName); const all = os.getAll();
      all.onsuccess = () => { for (const row of all.result) { const bytes = new Uint8Array(row.ciphertext); bytes[3] = bytes[3]! ^ 0x55; os.put({ ...row, ciphertext: bytes }); } };
      tx.oncomplete = () => resolve();
    });
    db.close();
    mount();
    const alert = await screen.findByTestId("offline-drafts-unreadable", undefined, { timeout: 10_000 });
    expect(alert.textContent).toContain("DRAFTS_UNREADABLE");
    expect((screen.getByRole("button", { name: "Save as offline draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.getProject).not.toHaveBeenCalled();
    expect(client.editTimeline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard unreadable local drafts" }));
    await screen.findByText(/Discarded 1 unreadable local draft row/);
    await screen.findByText("No offline drafts.");
  });
});
