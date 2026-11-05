import { describe, expect, it } from "vitest";
import {
  OfflineEditQueue,
  OfflineEditQueueError,
  type OfflineEditRecord,
  type OfflineEditScope,
  type OfflineEditStore,
} from "./offline-edit-queue.js";

const scope: OfflineEditScope = { tenantId: "tenant-1", projectId: "project-1" };
const edit = {
  ...scope,
  editId: "edit-1",
  idempotencyKey: "idem-1",
  expectedVersion: "v7",
  payload: { operation: "move-clip", clipId: "clip-1", position: 12 },
} as const;

class MemoryStore implements OfflineEditStore {
  readonly records = new Map<string, OfflineEditRecord>();
  failNextPut = false;
  async list(query: OfflineEditScope): Promise<readonly OfflineEditRecord[]> {
    return [...this.records.values()].filter((record) => record.tenantId === query.tenantId
      && record.projectId === query.projectId);
  }
  async insert(record: OfflineEditRecord, maximumEntries: number): Promise<boolean> {
    if ([...this.records.values()].some((item) => item.tenantId === record.tenantId
      && item.projectId === record.projectId
      && (item.editId === record.editId || item.idempotencyKey === record.idempotencyKey))) return false;
    if ([...this.records.values()].filter((item) => item.tenantId === record.tenantId
      && item.projectId === record.projectId).length >= maximumEntries) return false;
    if (this.failNextPut) { this.failNextPut = false; throw new Error("local storage unavailable"); }
    this.records.set(record.editId, record);
    return true;
  }
  async put(record: OfflineEditRecord): Promise<void> {
    if (this.failNextPut) { this.failNextPut = false; throw new Error("local storage unavailable"); }
    this.records.set(record.editId, record);
  }
  async remove(_query: OfflineEditScope, editId: string): Promise<void> { this.records.delete(editId); }
}

async function createQueue(store = new MemoryStore()): Promise<{ queue: OfflineEditQueue; store: MemoryStore }> {
  const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { queue: new OfflineEditQueue({ store, encryptionKey: key, maximumEntries: 2 }), store };
}

describe("OfflineEditQueue", () => {
  it("keeps the local dirty edit encrypted, bounded and scoped", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    expect(await queue.hasDirtyEdits(scope)).toBe(true);
    expect(store.records.size).toBe(1);
    expect(new TextDecoder().decode(store.records.get(edit.editId)!.ciphertext)).not.toContain("move-clip");
    expect(await queue.readEdits(scope)).toMatchObject([{ edit, state: "PENDING" }]);
    await queue.enqueue(edit);
    expect(store.records.size).toBe(1);
    await expect(queue.enqueue({ ...edit, editId: "edit-2", idempotencyKey: "idem-2" })).resolves.toBeUndefined();
    await expect(queue.enqueue({ ...edit, editId: "edit-3", idempotencyKey: "idem-3" }))
      .rejects.toMatchObject({ code: "QUEUE_FULL" } satisfies Partial<OfflineEditQueueError>);
  });

  it("enforces entry bounds atomically per tenant/project, including concurrent enqueue", async () => {
    const { queue, store } = await createQueue();
    const candidates = [1, 2, 3].map((n) => ({ ...edit, editId: `parallel-${n}`, idempotencyKey: `parallel-key-${n}` }));
    const outcomes = await Promise.allSettled(candidates.map((candidate) => queue.enqueue(candidate)));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((result) => result.status === "rejected").map((result) => result.status === "rejected" && result.reason.code))
      .toEqual(["QUEUE_FULL"]);
    expect(await queue.readEdits(scope)).toHaveLength(2);

    const otherScope = { tenantId: "tenant-2", projectId: "project-1" };
    await queue.enqueue({ ...otherScope, editId: "other-tenant", idempotencyKey: "other-tenant-key",
      expectedVersion: "v1", payload: { operation: "private-edit" } });
    expect(store.records.size).toBe(3);
    expect(await queue.readEdits(otherScope)).toHaveLength(1);
  });

  it("enforces the UTF-8 payload byte limit before storing ciphertext", async () => {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const store = new MemoryStore();
    const bounded = new OfflineEditQueue({ store, encryptionKey: key, maximumPayloadBytes: 8 });
    await expect(bounded.enqueue({ ...edit, payload: "123456" })).resolves.toBeUndefined();
    await expect(bounded.enqueue({ ...edit, editId: "too-large", idempotencyKey: "too-large-key", payload: "1234567" }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" } satisfies Partial<OfflineEditQueueError>);
    expect(store.records.size).toBe(1);
  });

  it("rejects a store that returns another tenant or project in a scoped read", async () => {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const leakingStore: OfflineEditStore = {
      list: async () => [{ tenantId: "tenant-other", projectId: "project-other", editId: "x", idempotencyKey: "x",
        expectedVersion: "v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array(), payloadBytes: 0, state: "PENDING" }],
      insert: async () => false,
      put: async () => undefined,
      remove: async () => undefined,
    };
    const q = new OfflineEditQueue({ store: leakingStore, encryptionKey: key });
    await expect(q.readEdits(scope)).rejects.toMatchObject({ code: "STORE_SCOPE_MISMATCH" });
  });

  it("requires fresh authorization and detects a stale project version before dispatch", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    let dispatched = false;
    const denied = await queue.replay(scope, {
      reauthorize: async () => ({ authorized: false }),
      readCurrentVersion: async () => "v7",
      apply: async () => { dispatched = true; return { outcome: "APPLIED", receipt: "r" }; },
    });
    expect(denied[0]?.state).toBe("REVOKED");
    expect(dispatched).toBe(false);
    expect(store.records.get(edit.editId)?.state).toBe("REVOKED");

    const { queue: conflictQueue, store: conflictStore } = await createQueue();
    await conflictQueue.enqueue(edit);
    const conflict = await conflictQueue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v8",
      apply: async () => { dispatched = true; return { outcome: "APPLIED", receipt: "r" }; },
    });
    expect(conflict[0]?.state).toBe("CONFLICT");
    expect(dispatched).toBe(false);
    expect(conflictStore.records.get(edit.editId)?.state).toBe("CONFLICT");
    await conflictQueue.resolveConflict({ ...edit, idempotencyKey: "idem-2", expectedVersion: "v8",
      payload: { ...edit.payload, position: 13 } });
    expect(conflictStore.records.get(edit.editId)).toMatchObject({
      idempotencyKey: "idem-2", expectedVersion: "v8", state: "PENDING",
    });
    const rebased = await conflictQueue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v8",
      apply: async (queued) => ({ outcome: "APPLIED", receipt: queued.idempotencyKey }),
    });
    expect(rebased[0]).toMatchObject({ state: "APPLIED", receipt: "idem-2" });
  });

  it("does not automatically replay an unknown outcome and requires no-effect reconciliation to discard", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    let attempts = 0;
    const adapter = {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async () => { attempts += 1; throw new Error("connection lost after dispatch"); },
    };
    expect((await queue.replay(scope, adapter))[0]?.state).toBe("OUTCOME_UNKNOWN");
    expect((await queue.replay(scope, adapter)).length).toBe(0);
    expect(attempts).toBe(1);
    await expect(queue.discardUnknown(scope, edit.editId, false)).rejects.toThrow(/authoritative no-effect/u);
    await queue.discardUnknown(scope, edit.editId, true);
    expect(store.records.has(edit.editId)).toBe(false);
    expect(await queue.hasDirtyEdits(scope)).toBe(false);
  });

  it("allows a failed local persistence attempt to be retried without losing the edit", async () => {
    const { queue, store } = await createQueue();
    store.failNextPut = true;
    await expect(queue.enqueue(edit)).rejects.toThrow("local storage unavailable");
    expect(await queue.hasDirtyEdits(scope)).toBe(false);
    await queue.enqueue(edit);
    expect(await queue.hasDirtyEdits(scope)).toBe(true);
    const result = await queue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async (queued) => ({ outcome: "APPLIED", receipt: queued.idempotencyKey }),
    });
    expect(result[0]).toMatchObject({ state: "APPLIED", receipt: "idem-1" });
    expect(await queue.hasDirtyEdits(scope)).toBe(false);
  });

  it("rejects an extractable key so queue payload confidentiality survives host storage inspection", async () => {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    expect(() => new OfflineEditQueue({ store: new MemoryStore(), encryptionKey: key }))
      .toThrow("non-extractable AES-GCM key");
    expect(OfflineEditQueueError).toBeDefined();
  });
});
