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
  failNextCas = false;
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
  async compareAndSet(expected: OfflineEditRecord, replacement: OfflineEditRecord): Promise<boolean> {
    if (this.failNextCas) { this.failNextCas = false; throw new Error("local CAS unavailable"); }
    const current = this.records.get(expected.editId);
    if (!current || current.tenantId !== expected.tenantId || current.projectId !== expected.projectId
      || current.editId !== expected.editId || current.idempotencyKey !== expected.idempotencyKey
      || current.expectedVersion !== expected.expectedVersion || current.state !== expected.state
      || !sameBytes(current.nonce, expected.nonce) || !sameBytes(current.ciphertext, expected.ciphertext)
      || replacement.tenantId !== expected.tenantId || replacement.projectId !== expected.projectId
      || replacement.editId !== expected.editId
      || [...this.records.values()].some((item) => item.tenantId === replacement.tenantId
        && item.projectId === replacement.projectId && item.editId !== replacement.editId
        && item.idempotencyKey === replacement.idempotencyKey)) return false;
    this.records.set(replacement.editId, replacement);
    return true;
  }
  async removeIfMatches(expected: OfflineEditRecord): Promise<boolean> {
    const current = this.records.get(expected.editId);
    if (!current || current.tenantId !== expected.tenantId || current.projectId !== expected.projectId
      || current.editId !== expected.editId || current.idempotencyKey !== expected.idempotencyKey
      || current.expectedVersion !== expected.expectedVersion || current.payloadBytes !== expected.payloadBytes
      || current.state !== expected.state || !sameBytes(current.nonce, expected.nonce)
      || !sameBytes(current.ciphertext, expected.ciphertext)) return false;
    this.records.delete(expected.editId);
    return true;
  }
  async remove(_query: OfflineEditScope, editId: string): Promise<void> { this.records.delete(editId); }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

  it("rejects a reused edit identity when its payload changes", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);

    await expect(queue.enqueue({ ...edit, payload: { ...edit.payload, position: 99 } }))
      .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    await expect(queue.enqueue({ ...edit, editId: "edit-other" }))
      .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    expect(await queue.readEdits(scope)).toEqual([{ edit, state: "PENDING" }]);
    expect(store.records.size).toBe(1);
  });

  it("rejects padded and NUL-delimited AAD identity fields before storing an edit", async () => {
    const { queue, store } = await createQueue();
    const invalidEdits = [
      { ...edit, tenantId: "tenant-1\u0000tenant-2" },
      { ...edit, projectId: " project-1 " },
      { ...edit, editId: "edit-1\u0000alias" },
      { ...edit, editId: " edit-1 " },
      { ...edit, idempotencyKey: "idem-1\u0000alias" },
      { ...edit, idempotencyKey: " idem-1 " },
      { ...edit, expectedVersion: "v7\u0000v8" },
      { ...edit, expectedVersion: " v7 " },
    ];

    for (const invalid of invalidEdits) {
      await expect(queue.enqueue(invalid))
        .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    }
    expect(store.records.size).toBe(0);
  });

  it("rejects a stored AAD identity containing the field separator before decryption", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    const record = store.records.get(edit.editId)!;
    store.records.set(edit.editId, { ...record, idempotencyKey: "idem-1\u0000alias" });

    await expect(queue.readEdits(scope))
      .rejects.toMatchObject({ code: "STORE_SCOPE_MISMATCH" } satisfies Partial<OfflineEditQueueError>);
  });

  it("rejects a changed payload when concurrent inserts race on one identity", async () => {
    const { queue, store } = await createQueue();
    const candidates = [
      edit,
      { ...edit, payload: { ...edit.payload, position: 99 } },
    ];

    const outcomes = await Promise.allSettled(candidates.map((candidate) => queue.enqueue(candidate)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
      { reason: { code: "INVALID_EDIT" } },
    ]);
    expect(store.records.size).toBe(1);
    expect(await queue.readEdits(scope)).toHaveLength(1);
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
    expect(await bounded.readEdits(scope)).toMatchObject([{ edit: { payload: "123456" }, state: "PENDING" }]);
    await expect(bounded.enqueue({ ...edit, editId: "too-large", idempotencyKey: "too-large-key", payload: "1234567" }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" } satisfies Partial<OfflineEditQueueError>);
    await expect(bounded.enqueue({ ...edit, editId: "large-string", idempotencyKey: "large-string-key",
      payload: "x".repeat(1_000_000) }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" } satisfies Partial<OfflineEditQueueError>);
    await expect(bounded.enqueue({ ...edit, editId: "large-object", idempotencyKey: "large-object-key",
      payload: { text: "x".repeat(1_000_000) } }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" } satisfies Partial<OfflineEditQueueError>);
    expect(store.records.size).toBe(1);
  });

  it("rejects stored payload byte metadata that is inconsistent or exceeds the configured bound", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    const original = store.records.get(edit.editId)!;
    let authorityReads = 0;
    let applyCount = 0;
    const adapter = {
      reauthorize: async () => { authorityReads++; return { authorized: true }; },
      readCurrentVersion: async () => { authorityReads++; return "v7"; },
      apply: async () => { applyCount++; return { outcome: "APPLIED" as const, receipt: "receipt" }; },
    };

    store.records.set(edit.editId, { ...original, payloadBytes: original.payloadBytes + 1 });
    await expect(queue.readEdits(scope))
      .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" } satisfies Partial<OfflineEditQueueError>);
    await expect(queue.replay(scope, adapter))
      .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" } satisfies Partial<OfflineEditQueueError>);
    expect(authorityReads).toBe(0);
    expect(applyCount).toBe(0);

    store.records.set(edit.editId, { ...original, payloadBytes: Number.MAX_SAFE_INTEGER });
    await expect(queue.readEdits(scope))
      .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" } satisfies Partial<OfflineEditQueueError>);
    expect(authorityReads).toBe(0);
    expect(applyCount).toBe(0);
  });

  it("rejects malformed AES-GCM nonce and oversized ciphertext before decrypt or replay", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    const original = store.records.get(edit.editId)!;
    let authorityReads = 0;
    let applyCount = 0;
    const adapter = {
      reauthorize: async () => { authorityReads++; return { authorized: true }; },
      readCurrentVersion: async () => { authorityReads++; return "v7"; },
      apply: async () => { applyCount++; return { outcome: "APPLIED" as const, receipt: "receipt" }; },
    };
    const malformedRows = [
      { ...original, nonce: undefined as unknown as Uint8Array },
      { ...original, ciphertext: new ArrayBuffer(16) as unknown as Uint8Array },
      { ...original, nonce: new Uint8Array(11) },
      { ...original, ciphertext: new Uint8Array(256 * 1024 + 17) },
    ];

    for (const malformed of malformedRows) {
      store.records.set(edit.editId, malformed);
      await expect(queue.readEdits(scope))
        .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" } satisfies Partial<OfflineEditQueueError>);
      await expect(queue.replay(scope, adapter))
        .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" } satisfies Partial<OfflineEditQueueError>);
    }
    expect(authorityReads).toBe(0);
    expect(applyCount).toBe(0);
  });

  it("snapshots only faithful JSON trees and rejects lossy values before storage", async () => {
    const { queue, store } = await createQueue();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const sparse = [1, , 3];
    const hidden = Object.defineProperty({ visible: true }, "hidden", { value: 1 });
    const invalidPayloads: unknown[] = [
      NaN, Infinity, undefined, () => 1, 1n, cycle, sparse, accessor, hidden,
      { value: undefined }, { [Symbol("extra")]: 1 }, new Date(0),
      Object.assign(Object.create({ inherited: true }) as object, { value: 1 }),
    ];

    for (const payload of invalidPayloads) {
      await expect(queue.enqueue({ ...edit, payload }))
        .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    }
    expect(store.records.size).toBe(0);

    const specialKey = Object.defineProperty({}, "__proto__", { value: "data", enumerable: true });
    const validPayload = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: [null, true, "é", 0, specialKey],
    });
    await queue.enqueue({ ...edit, payload: validPayload });
    expect(await queue.readEdits(scope)).toEqual([{ edit: { ...edit, payload: validPayload }, state: "PENDING" }]);
    expect(store.records.size).toBe(1);
  });

  it("rejects an object with more own keys than the traversal bound before storage", async () => {
    const { queue, store } = await createQueue();
    const oversized: Record<string, number> = {};
    for (let index = 0; index <= 100_000; index++) oversized[`key-${index}`] = 1;

    await expect(queue.enqueue({ ...edit, payload: oversized }))
      .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    expect(store.records.size).toBe(0);
  });

  it("rejects invalid conflict payloads without replacing the conflicted stored edit", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    await queue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v8",
      apply: async () => ({ outcome: "APPLIED", receipt: "unused" }),
    });
    const originalRecord = store.records.get(edit.editId);
    await expect(queue.resolveConflict({ ...edit, idempotencyKey: "idem-rebased", expectedVersion: "v8",
      payload: { score: Number.NaN } }))
      .rejects.toMatchObject({ code: "INVALID_EDIT" } satisfies Partial<OfflineEditQueueError>);
    expect(store.records.get(edit.editId)).toBe(originalRecord);
    expect((await queue.readEdits(scope))[0]?.state).toBe("CONFLICT");
  });

  it("rejects a store that returns another tenant or project in a scoped read", async () => {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const leakingStore: OfflineEditStore = {
      list: async () => [{ tenantId: "tenant-other", projectId: "project-other", editId: "x", idempotencyKey: "x",
        expectedVersion: "v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array(), payloadBytes: 0, state: "PENDING" }],
      insert: async () => false,
      put: async () => undefined,
      compareAndSet: async () => false,
      remove: async () => undefined,
    };
    const q = new OfflineEditQueue({ store: leakingStore, encryptionKey: key });
    await expect(q.readEdits(scope)).rejects.toMatchObject({ code: "STORE_SCOPE_MISMATCH" });
  });

  it("authenticates the offline idempotency key with the encrypted edit metadata", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    const record = store.records.get(edit.editId)!;
    store.records.set(edit.editId, { ...record, idempotencyKey: "tampered-key" });

    await expect(queue.readEdits(scope)).rejects.toThrow();
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

  it("does not delete a replacement row when unknown-outcome cleanup races with another context", async () => {
    class ReplacingStore extends MemoryStore {
      replaceAfterNextList = false;
      override async list(query: OfflineEditScope): Promise<readonly OfflineEditRecord[]> {
        const snapshot = await super.list(query);
        if (this.replaceAfterNextList) {
          this.replaceAfterNextList = false;
          const current = this.records.get(edit.editId)!;
          this.records.set(edit.editId, { ...current, idempotencyKey: "replacement-key", state: "PENDING" });
        }
        return snapshot;
      }
    }

    const store = new ReplacingStore();
    const { queue } = await createQueue(store);
    await queue.enqueue(edit);
    await queue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async () => { throw new Error("connection lost after dispatch"); },
    });
    const replacement = { ...store.records.get(edit.editId)!, idempotencyKey: "replacement-key", state: "PENDING" as const };
    store.replaceAfterNextList = true;

    await expect(queue.discardUnknown(scope, edit.editId, true)).rejects.toMatchObject({ code: "STORE_RECORD_CHANGED" });
    expect(store.records.get(edit.editId)).toEqual(replacement);
  });

  it("persists an outcome fence before dispatch across queue instances sharing the encrypted store", async () => {
    const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const store = new MemoryStore();
    const firstQueue = new OfflineEditQueue({ store, encryptionKey: key });
    const secondQueue = new OfflineEditQueue({ store, encryptionKey: key });
    await firstQueue.enqueue(edit);

    let dispatches = 0;
    let releaseDispatch!: () => void;
    let markStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = {
      reauthorize: async () => ({ authorized: true, disposition: "AUTHORIZED" as const }),
      readCurrentVersion: async () => "v7",
      apply: async () => {
        dispatches += 1;
        expect(store.records.get(edit.editId)?.state).toBe("OUTCOME_UNKNOWN");
        markStarted();
        await release;
        return { outcome: "APPLIED" as const, receipt: "receipt-1" };
      },
    };

    const firstRun = firstQueue.replay(scope, adapter);
    await started;
    const concurrentRun = await secondQueue.replay(scope, adapter);
    expect(concurrentRun).toEqual([]);
    releaseDispatch();
    expect(await firstRun).toMatchObject([{ state: "APPLIED", receipt: "receipt-1" }]);
    expect(dispatches).toBe(1);
  });

  it("rechecks revocation after the pre-dispatch fence and never applies after a rights change during storage", async () => {
    let revoked = false;
    class RevokingFenceStore extends MemoryStore {
      override async compareAndSet(expected: OfflineEditRecord, replacement: OfflineEditRecord): Promise<boolean> {
        const committed = await super.compareAndSet(expected, replacement);
        if (committed && replacement.state === "OUTCOME_UNKNOWN") revoked = true;
        return committed;
      }
    }

    const { queue, store } = await createQueue(new RevokingFenceStore());
    await queue.enqueue(edit);
    let authorizationReads = 0;
    let dispatches = 0;
    const result = await queue.replay(scope, {
      reauthorize: async () => {
        authorizationReads++;
        return revoked ? { authorized: false, disposition: "REVOKED" as const }
          : { authorized: true, disposition: "AUTHORIZED" as const };
      },
      readCurrentVersion: async () => "v7",
      apply: async () => { dispatches++; return { outcome: "APPLIED" as const, receipt: "receipt" }; },
    });

    expect(result).toEqual([{ editId: edit.editId, state: "REVOKED" }]);
    expect(authorizationReads).toBe(2);
    expect(dispatches).toBe(0);
    expect(store.records.get(edit.editId)?.state).toBe("REVOKED");
  });

  it("fails closed when the pre-dispatch CAS throws and can retry while the edit remains pending", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    store.failNextCas = true;
    let dispatches = 0;
    const adapter = {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async () => { dispatches++; return { outcome: "APPLIED" as const, receipt: "receipt" }; },
    };

    expect(await queue.replay(scope, adapter)).toMatchObject([{ state: "OUTCOME_UNKNOWN" }]);
    expect(store.records.get(edit.editId)?.state).toBe("PENDING");
    expect(dispatches).toBe(0);

    expect(await queue.replay(scope, adapter)).toMatchObject([{ state: "APPLIED", receipt: "receipt" }]);
    expect(dispatches).toBe(1);
  });

  it("keeps the durable unknown fence when the post-dispatch result CAS throws", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    let dispatches = 0;
    const adapter = {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async () => {
        dispatches++;
        store.failNextCas = true;
        return { outcome: "APPLIED" as const, receipt: "receipt" };
      },
    };

    expect(await queue.replay(scope, adapter)).toMatchObject([{ state: "OUTCOME_UNKNOWN" }]);
    expect(store.records.get(edit.editId)?.state).toBe("OUTCOME_UNKNOWN");
    expect(await queue.replay(scope, adapter)).toEqual([]);
    expect(dispatches).toBe(1);
  });

  it("keeps malformed version and apply observations out of conflict or success states", async () => {
    const { queue, store } = await createQueue();
    await queue.enqueue(edit);
    let applyCount = 0;
    const unknownVersion = await queue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => ({ disposition: "CURRENT", version: "   " }),
      apply: async () => { applyCount++; return { outcome: "APPLIED", receipt: "receipt" }; },
    });
    expect(unknownVersion[0]?.state).toBe("VERSION_UNKNOWN");
    expect(store.records.get(edit.editId)?.state).toBe("PENDING");
    expect(applyCount).toBe(0);

    const malformedAck = await queue.replay(scope, {
      reauthorize: async () => ({ authorized: true }),
      readCurrentVersion: async () => "v7",
      apply: async () => ({ outcome: "APPLIED" }) as { outcome: "APPLIED"; receipt: string },
    });
    expect(malformedAck[0]?.state).toBe("OUTCOME_UNKNOWN");
    expect(store.records.get(edit.editId)?.state).toBe("OUTCOME_UNKNOWN");
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
