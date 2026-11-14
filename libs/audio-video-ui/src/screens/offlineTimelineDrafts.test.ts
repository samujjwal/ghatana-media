// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { MediaDevProjectTimelineError, type DevProjectRead } from "@audio-video/client/dev-project-timeline";
import { OfflineDraftKeyCustody, OfflineDraftKeyCustodyError } from "./offlineDraftKeyCustody";
import { OfflineTimelineDrafts, isConnectivityFailure, type OfflineDraftsPort } from "./offlineTimelineDrafts";

const scope = { tenantId: "tenant-a", principalId: "principal-a", projectId: "project-a" };
const SECRET = "scene-super-secret-marker";
const EDITS = [{ type: "addScene", sceneId: SECRET, order: 1 }] as const;

function read(head: string): DevProjectRead {
  return { scope: "DEV_ONLY", project: { tenantId: "tenant-a", projectId: "project-a", headRevisionId: head },
    currentRevision: { tenantId: "tenant-a", projectId: "project-a", revisionId: head, timelines: [] } } as unknown as DevProjectRead;
}
function revisionRead(id: string, parent: string): never {
  return { scope: "DEV_ONLY", revision: { tenantId: "tenant-a", projectId: "project-a", revisionId: id, parentRevisionId: parent, timelines: [] } } as never;
}
function fixture(overrides: Partial<{ head: string }> = {}) {
  let head = overrides.head ?? "rev-1";
  const calls = { edit: [] as unknown[] };
  const port = {
    getProject: vi.fn(async () => read(head)),
    editTimeline: vi.fn(async (_p: string, _t: string, request: { expectedHeadRevisionId: string }) => {
      calls.edit.push(request);
      return revisionRead("rev-2", request.expectedHeadRevisionId);
    }),
  };
  let n = 0;
  return { port, calls, setHead: (value: string) => { head = value; }, newId: () => `id-${++n}` };
}
const open = (indexedDB: IDBFactory, port: OfflineDraftsPort, newId?: () => string, s = scope) =>
  OfflineTimelineDrafts.open({ scope: s, port, indexedDB, newId });

async function rawStoreBytes(factory: IDBFactory): Promise<string> {
  const names = (await factory.databases()).map((db) => db.name!).filter((name) => name.startsWith("ghatana-media-offline-drafts"));
  let all = "";
  for (const name of names) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    for (const storeName of Array.from(db.objectStoreNames)) {
      const rows = await new Promise<unknown[]>((resolve) => { const r = db.transaction(storeName).objectStore(storeName).getAll(); r.onsuccess = () => resolve(r.result); });
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        all += JSON.stringify(record, (_k, v) => v instanceof ArrayBuffer ? Buffer.from(v).toString("latin1") : ArrayBuffer.isView(v) ? Buffer.from(v.buffer as ArrayBuffer).toString("latin1") : v);
      }
    }
    db.close();
  }
  return all;
}

describe("offline key custody", () => {
  it("generates a non-extractable AES-GCM key per scope and reuses it", async () => {
    const idb = new IDBFactory();
    const custody = new OfflineDraftKeyCustody({ indexedDB: idb });
    const key = await custody.getOrCreate(scope);
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
    const again = await new OfflineDraftKeyCustody({ indexedDB: idb }).getOrCreate(scope);
    // Same persisted key material: ciphertext from one decrypts with the other.
    const iv = new Uint8Array(12);
    const sealed = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("x"));
    expect(new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, again, sealed))[0]).toBe(120);
  });

  it("gives another principal, tenant or project a different key and denies a forged scope record", async () => {
    const idb = new IDBFactory();
    const custody = new OfflineDraftKeyCustody({ indexedDB: idb });
    const a = await custody.getOrCreate(scope);
    const other = await custody.getOrCreate({ ...scope, principalId: "principal-b" });
    const iv = new Uint8Array(12);
    const sealed = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, new Uint8Array([1]));
    await expect(globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, other, sealed)).rejects.toBeTruthy();
    expect(await custody.get({ ...scope, tenantId: "tenant-z" })).toBeUndefined();
    // Tamper: relabel the stored record's principal; the exact scope check must refuse it.
    const db = await new Promise<IDBDatabase>((resolve) => { const r = idb.open("ghatana-media-offline-draft-keys-v1"); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("keys", "readwrite"); const store = tx.objectStore("keys");
      const get = store.getAll(); get.onsuccess = () => { for (const row of get.result) if (row.principalId === "principal-b") store.put({ ...row, principalId: "principal-a-forged" }); };
      tx.oncomplete = () => resolve();
    });
    db.close();
    await expect(new OfflineDraftKeyCustody({ indexedDB: idb }).get({ ...scope, principalId: "principal-b" }))
      .rejects.toMatchObject({ code: "KEY_SCOPE_MISMATCH" });
    await expect(custody.getOrCreate({ ...scope, tenantId: " " })).rejects.toBeInstanceOf(OfflineDraftKeyCustodyError);
  });
});

describe("offline timeline drafts", () => {
  it("encrypts drafts at rest, restores them after reopen, and sends nothing on capture", async () => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    expect(draft.state).toBe("PENDING");
    expect(f.port.editTimeline).not.toHaveBeenCalled();
    expect(f.port.getProject).not.toHaveBeenCalled();
    const raw = await rawStoreBytes(idb);
    expect(raw).toContain("draft-id-2");
    expect(raw).not.toContain(SECRET);
    await drafts.close();
    const reopened = await open(idb, f.port, f.newId);
    const listed = await reopened.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ baseRevisionId: "rev-1", timelineId: "timeline-main", requestId: draft.requestId, state: "PENDING" });
    expect(JSON.stringify(listed[0]!.edits)).toContain(SECRET);
    expect(f.port.editTimeline).not.toHaveBeenCalled(); // no auto-replay on reopen
  });

  it("denies access to drafts for a different principal or tenant (key and store scope mismatch)", async () => {
    const idb = new IDBFactory(); const f = fixture();
    await (await open(idb, f.port, f.newId)).capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const otherPrincipal = await open(idb, f.port, f.newId, { ...scope, principalId: "principal-b" });
    expect(await otherPrincipal.list()).toEqual([]);
    const otherTenant = await open(idb, f.port, f.newId, { ...scope, tenantId: "tenant-b" });
    expect(await otherTenant.list()).toEqual([]);
    // Destroying the key makes the original drafts permanently unreadable (clearing site data loses drafts by design).
    await new OfflineDraftKeyCustody({ indexedDB: idb }).destroy(scope);
    const afterLoss = await open(idb, f.port, f.newId);
    await expect(afterLoss.list()).rejects.toBeTruthy();
  });

  it("requires explicit review and replays with CAS on the base revision and the draft's requestId", async () => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const review = await drafts.review(draft.editId);
    expect(review).toMatchObject({ headRevisionId: "rev-1", stale: false });
    expect(f.port.editTimeline).not.toHaveBeenCalled(); // review never sends
    const outcome = await drafts.replay(review);
    expect(outcome).toMatchObject({ kind: "APPLIED", revisionId: "rev-2", requestId: draft.requestId, httpStatus: 201 });
    expect(f.calls.edit).toEqual([{ expectedHeadRevisionId: "rev-1", edits: EDITS }]);
    expect(await drafts.list()).toEqual([]);
  });

  it("only replays the reviewed draft, never the others", async () => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const first = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const second = await drafts.capture({ timelineId: "timeline-main", edits: [{ type: "removeScene", sceneId: "s2" }], baseRevisionId: "rev-1" });
    await drafts.replay(await drafts.review(first.editId));
    expect(f.port.editTimeline).toHaveBeenCalledTimes(1);
    const rest = await drafts.list();
    expect(rest.map((d) => [d.editId, d.state])).toEqual([[second.editId, "PENDING"]]);
  });

  it("fails closed when the queue changed after review", async () => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const first = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const review = await drafts.review(first.editId);
    await drafts.capture({ timelineId: "timeline-main", edits: [{ type: "removeScene", sceneId: "late" }], baseRevisionId: "rev-1" });
    expect(await drafts.replay(review)).toMatchObject({ kind: "REVIEW_REQUIRED" });
    expect(f.port.editTimeline).not.toHaveBeenCalled();
  });

  it("shows REVISION_CONFLICT with the current head and never auto-merges", async () => {
    const idb = new IDBFactory(); const f = fixture({ head: "rev-9" });
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const review = await drafts.review(draft.editId);
    expect(review).toMatchObject({ stale: true, headRevisionId: "rev-9" });
    const outcome = await drafts.replay(review);
    expect(outcome).toMatchObject({ kind: "REVISION_CONFLICT", baseRevisionId: "rev-1", currentHeadRevisionId: "rev-9" });
    expect(f.port.editTimeline).not.toHaveBeenCalled();
    expect((await drafts.list())[0]).toMatchObject({ state: "CONFLICT", baseRevisionId: "rev-1" });
    // An explicit rebase onto the shown head yields a new pending draft with a new requestId; still nothing is sent.
    const rebased = await drafts.rebaseConflict(draft.editId, "rev-9");
    expect(rebased.requestId).not.toBe(draft.requestId);
    expect(f.port.editTimeline).not.toHaveBeenCalled();
  });

  it("maps a host-side REVISION_CONFLICT (head moved after the preflight read)", async () => {
    const idb = new IDBFactory(); const f = fixture();
    f.port.editTimeline.mockRejectedValueOnce(new MediaDevProjectTimelineError("REVISION_CONFLICT", 409, "Project head changed", { currentHeadRevisionId: "rev-5" }));
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    expect(await drafts.replay(await drafts.review(draft.editId))).toMatchObject({ kind: "REVISION_CONFLICT", currentHeadRevisionId: "rev-5" });
  });

  it.each([[403, "ACCESS_REVOKED"], [404, "NOT_FOUND"]] as const)("discards the draft with an explanation on a %i authorization read", async (status, reason) => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const review = await drafts.review(draft.editId);
    f.port.getProject.mockRejectedValue(new MediaDevProjectTimelineError("FORBIDDEN", status, "denied"));
    const outcome = await drafts.replay(review);
    expect(outcome).toMatchObject({ kind: "DISCARDED", status, reason });
    expect((outcome as { message: string }).message).toMatch(/discarded/);
    expect(f.port.editTimeline).not.toHaveBeenCalled();
    expect(await drafts.list()).toEqual([]);
  });

  it("discards on a 403 returned by the edit itself (provably not applied)", async () => {
    const idb = new IDBFactory(); const f = fixture();
    f.port.editTimeline.mockRejectedValueOnce(new MediaDevProjectTimelineError("FORBIDDEN", 403, "denied"));
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    expect(await drafts.replay(await drafts.review(draft.editId))).toMatchObject({ kind: "DISCARDED", status: 403 });
    expect(await drafts.list()).toEqual([]);
  });

  it("keeps the draft retryable when authorization or the head cannot be read", async () => {
    const idb = new IDBFactory(); const f = fixture();
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    const review = await drafts.review(draft.editId);
    f.port.getProject.mockRejectedValue(new MediaDevProjectTimelineError("TRANSPORT_ERROR", 0, "down"));
    expect(await drafts.replay(review)).toMatchObject({ kind: "RETRYABLE", reason: "AUTHORIZATION_UNKNOWN" });
    expect((await drafts.list())[0]!.state).toBe("PENDING");
    expect(f.port.editTimeline).not.toHaveBeenCalled();
  });

  it("OUTCOME_UNKNOWN is fenced, never auto-replayed, and retries the same requestId once the head proves no commit", async () => {
    const idb = new IDBFactory(); const f = fixture();
    f.port.editTimeline.mockRejectedValueOnce(new MediaDevProjectTimelineError("OUTCOME_UNKNOWN", 0, "lost response"));
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    expect(await drafts.replay(await drafts.review(draft.editId))).toMatchObject({ kind: "OUTCOME_UNKNOWN", requestId: draft.requestId });
    expect(f.port.editTimeline).toHaveBeenCalledTimes(1);
    // A fresh review of the unknown draft never sends and does not replay it.
    const review = await drafts.review(draft.editId);
    expect(review).toMatchObject({ reconciliation: "NOT_APPLIED_CONFIRMED", draft: { state: "OUTCOME_UNKNOWN" } });
    expect(await drafts.replay(review)).toMatchObject({ kind: "REVIEW_REQUIRED" });
    expect(f.port.editTimeline).toHaveBeenCalledTimes(1);
    await drafts.rearmUnknown(review);
    const rearmed = await drafts.list();
    expect(rearmed[0]).toMatchObject({ editId: draft.editId, requestId: draft.requestId, baseRevisionId: "rev-1", state: "PENDING" });
    expect(f.port.editTimeline).toHaveBeenCalledTimes(1);
    const outcome = await drafts.replay(await drafts.review(draft.editId));
    expect(outcome).toMatchObject({ kind: "REPLAYED", requestId: draft.requestId, revisionId: "rev-2" });
    expect(f.port.editTimeline).toHaveBeenCalledTimes(2);
    const { mock } = f.port.editTimeline;
    expect(mock.calls[0]).toEqual(mock.calls[1]); // identical CAS request on retry
  });

  it("cannot re-arm an unknown draft when the head moved (possibly applied)", async () => {
    const idb = new IDBFactory(); const f = fixture();
    f.port.editTimeline.mockRejectedValueOnce(new MediaDevProjectTimelineError("OUTCOME_UNKNOWN", 504, "gateway"));
    const drafts = await open(idb, f.port, f.newId);
    const draft = await drafts.capture({ timelineId: "timeline-main", edits: [...EDITS], baseRevisionId: "rev-1" });
    await drafts.replay(await drafts.review(draft.editId));
    f.setHead("rev-2");
    const review = await drafts.review(draft.editId);
    expect(review.reconciliation).toBe("POSSIBLY_APPLIED");
    await expect(drafts.rearmUnknown(review)).rejects.toThrow();
  });

  it("classifies only no-response failures as connectivity loss", () => {
    expect(isConnectivityFailure(new MediaDevProjectTimelineError("TRANSPORT_ERROR", 0, "x"))).toBe(true);
    expect(isConnectivityFailure(new MediaDevProjectTimelineError("OUTCOME_UNKNOWN", 0, "x"))).toBe(true);
    expect(isConnectivityFailure(new MediaDevProjectTimelineError("REVISION_CONFLICT", 409, "x"))).toBe(false);
    expect(isConnectivityFailure(new Error("x"))).toBe(false);
  });
});
