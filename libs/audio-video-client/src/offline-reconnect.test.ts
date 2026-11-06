import { beforeEach, describe, expect, it } from "vitest";
import {
  OfflineEditQueue,
  type OfflineEditRecord,
  type OfflineEditScope,
  type OfflineEditStore,
} from "./offline-edit-queue.js";
import {
  OfflineReconnectCoordinator,
  type OfflineReconnectOperations,
} from "./offline-reconnect.js";

const scope: OfflineEditScope = { tenantId: "tenant-a", projectId: "project-a" };
const edit = {
  ...scope, editId: "edit-a", idempotencyKey: "idem-a", expectedVersion: "revision-7",
  payload: { operation: "move-clip", clipId: "clip-a", position: 4 },
} as const;

class MemoryStore implements OfflineEditStore {
  readonly records = new Map<string, OfflineEditRecord>();
  async list(query: OfflineEditScope): Promise<readonly OfflineEditRecord[]> {
    return [...this.records.values()].filter((record) => record.tenantId === query.tenantId && record.projectId === query.projectId);
  }
  async insert(record: OfflineEditRecord, maximumEntries: number): Promise<boolean> {
    if ([...this.records.values()].some((item) => item.tenantId === record.tenantId && item.projectId === record.projectId
      && (item.editId === record.editId || item.idempotencyKey === record.idempotencyKey))) return false;
    if ([...this.records.values()].filter((item) => item.tenantId === record.tenantId && item.projectId === record.projectId).length >= maximumEntries) return false;
    this.records.set(record.editId, record);
    return true;
  }
  async put(record: OfflineEditRecord): Promise<void> { this.records.set(record.editId, record); }
  async compareAndSet(expected: OfflineEditRecord, replacement: OfflineEditRecord): Promise<boolean> {
    const current = this.records.get(expected.editId);
    if (!current || current.tenantId !== expected.tenantId || current.projectId !== expected.projectId
      || current.editId !== expected.editId || current.idempotencyKey !== expected.idempotencyKey
      || current.expectedVersion !== expected.expectedVersion || current.state !== expected.state
      || replacement.tenantId !== expected.tenantId || replacement.projectId !== expected.projectId
      || replacement.editId !== expected.editId
      || [...this.records.values()].some((item) => item.tenantId === replacement.tenantId
        && item.projectId === replacement.projectId && item.editId !== replacement.editId
        && item.idempotencyKey === replacement.idempotencyKey)) return false;
    this.records.set(replacement.editId, replacement);
    return true;
  }
  async remove(_scope: OfflineEditScope, editId: string): Promise<void> { this.records.delete(editId); }
}

describe("OfflineReconnectCoordinator", () => {
  let store: MemoryStore;
  let key: CryptoKey;
  beforeEach(async () => {
    store = new MemoryStore();
    key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  });

  async function queue(editStore: OfflineEditStore = store): Promise<OfflineEditQueue> {
    return new OfflineEditQueue({ store: editStore, encryptionKey: key });
  }
  function operations(overrides: Partial<OfflineReconnectOperations<typeof edit.payload>> = {}): OfflineReconnectOperations<typeof edit.payload> {
    return {
      reauthorize: async (queued) => ({ ...scope, disposition: "AUTHORIZED" }),
      readProjectVersion: async () => ({ ...scope, disposition: "CURRENT", version: "revision-7" }),
      applyEdit: async (queued) => ({ ...scope, editId: queued.editId, idempotencyKey: queued.idempotencyKey,
        expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: `receipt:${queued.idempotencyKey}` }),
      ...overrides,
    };
  }

  it("preserves dirty offline state and reports unavailable when no canonical project operation is available", async () => {
    const q = await queue();
    await q.enqueue(edit);
    const coordinator = new OfflineReconnectCoordinator(q, scope);
    await expect(coordinator.reconnect(false)).resolves.toEqual({ status: "OFFLINE", dirty: true });
    await expect(coordinator.reconnect(true)).resolves.toEqual({ status: "UNAVAILABLE",
      reason: "CANONICAL_PROJECT_EDIT_OPERATION_UNAVAILABLE", dirty: true });
  });

  it("preserves legacy stores but reports unavailable before authority reads when replay CAS is unsupported", async () => {
    const legacyStore: OfflineEditStore = {
      list: (query) => store.list(query),
      insert: (record, maximumEntries) => store.insert(record, maximumEntries),
      put: (record) => store.put(record),
      remove: (query, editId) => store.remove(query, editId),
    };
    const q = await queue(legacyStore);
    await q.enqueue(edit);
    let authorityReads = 0;
    let applyCount = 0;
    const result = await new OfflineReconnectCoordinator(q, scope, operations({
      reauthorize: async () => { authorityReads++; return { ...scope, disposition: "AUTHORIZED" }; },
      readProjectVersion: async () => { authorityReads++; return { ...scope, disposition: "CURRENT", version: "revision-7" }; },
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "OFFLINE_STORE_CAS_UNAVAILABLE", dirty: true,
      results: [{ editId: edit.editId, state: "STORE_CAS_UNAVAILABLE" }] });
    expect(authorityReads).toBe(0);
    expect(applyCount).toBe(0);
    expect(store.records.get(edit.editId)?.state).toBe("PENDING");
  });

  it("records stale authorization as revoked without applying any local edit", async () => {
    const q = await queue();
    await q.enqueue(edit);
    let applyCount = 0;
    const adapter = operations({
      reauthorize: async () => ({ ...scope, disposition: "REVOKED" }),
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    });
    const result = await new OfflineReconnectCoordinator(q, scope, adapter).reconnect(true);
    expect(result.status).toBe("RECONNECTED");
    if (result.status === "RECONNECTED") expect(result.results[0]?.state).toBe("REVOKED");
    expect(applyCount).toBe(0);
    expect((await q.readEdits(scope))[0]?.state).toBe("REVOKED");
    const afterRestart = await new OfflineReconnectCoordinator(await queue(), scope, operations({
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);
    expect(afterRestart.status).toBe("RECONNECTED");
    if (afterRestart.status === "RECONNECTED") expect(afterRestart.results).toEqual([]);
    expect(applyCount).toBe(0);
  });

  it("revalidates rights after version preflight and does not replay a revoke observed before dispatch", async () => {
    const q = await queue();
    await q.enqueue(edit);
    let revokedDuringVersionRead = false;
    let applyCount = 0;
    const result = await new OfflineReconnectCoordinator(q, scope, operations({
      readProjectVersion: async () => {
        revokedDuringVersionRead = true;
        return { ...scope, disposition: "CURRENT", version: "revision-7" };
      },
      reauthorize: async () => ({ ...scope, disposition: revokedDuringVersionRead ? "REVOKED" : "AUTHORIZED" }),
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);
    expect(result.status).toBe("RECONNECTED");
    if (result.status === "RECONNECTED") expect(result.results[0]?.state).toBe("REVOKED");
    expect(applyCount).toBe(0);
    expect((await q.readEdits(scope))[0]?.state).toBe("REVOKED");
  });

  it("keeps authorization and version uncertainty distinct and prevents dispatch", async () => {
    const q = await queue();
    await q.enqueue(edit);
    const authUnknown = await new OfflineReconnectCoordinator(q, scope, operations({
      reauthorize: async () => ({ ...scope, disposition: "UNKNOWN" }),
    })).reconnect(true);
    expect(authUnknown.status).toBe("RECONNECTED");
    if (authUnknown.status === "RECONNECTED") expect(authUnknown.results[0]?.state).toBe("AUTHORIZATION_UNKNOWN");
    expect((await q.readEdits(scope))[0]?.state).toBe("PENDING");
    const authRecovered = await new OfflineReconnectCoordinator(q, scope, operations()).reconnect(true);
    expect(authRecovered.status).toBe("RECONNECTED");
    if (authRecovered.status === "RECONNECTED") expect(authRecovered.results[0]?.state).toBe("APPLIED");

    store = new MemoryStore();
    const versionQueue = await queue();
    await versionQueue.enqueue(edit);
    const versionUnknown = await new OfflineReconnectCoordinator(versionQueue, scope, operations({
      readProjectVersion: async () => ({ ...scope, disposition: "UNKNOWN" }),
    })).reconnect(true);
    expect(versionUnknown.status).toBe("RECONNECTED");
    if (versionUnknown.status === "RECONNECTED") expect(versionUnknown.results[0]?.state).toBe("VERSION_UNKNOWN");
    expect((await versionQueue.readEdits(scope))[0]?.state).toBe("PENDING");
    const versionRecovered = await new OfflineReconnectCoordinator(versionQueue, scope, operations()).reconnect(true);
    expect(versionRecovered.status).toBe("RECONNECTED");
    if (versionRecovered.status === "RECONNECTED") expect(versionRecovered.results[0]?.state).toBe("APPLIED");
  });

  it("detects version conflict and supports explicit rebase with a fresh idempotency key", async () => {
    const q = await queue();
    await q.enqueue(edit);
    const conflict = await new OfflineReconnectCoordinator(q, scope, operations({
      readProjectVersion: async () => ({ ...scope, disposition: "CURRENT", version: "revision-8" }),
    })).reconnect(true);
    expect(conflict.status).toBe("RECONNECTED");
    if (conflict.status === "RECONNECTED") expect(conflict.results[0]?.state).toBe("CONFLICT");

    await q.resolveConflict({ ...edit, idempotencyKey: "idem-rebased", expectedVersion: "revision-8",
      payload: { ...edit.payload, position: 8 } });
    const applied = await new OfflineReconnectCoordinator(q, scope, operations({
      readProjectVersion: async () => ({ ...scope, disposition: "CURRENT", version: "revision-8" }),
    })).reconnect(true);
    expect(applied.status).toBe("RECONNECTED");
    if (applied.status === "RECONNECTED") expect(applied.results[0]).toMatchObject({ state: "APPLIED", receipt: "receipt:idem-rebased" });
  });

  it("keeps an offline edit dirty through conflict resolution, then honors revocation after queue recreation", async () => {
    const offlineQueue = await queue();
    await offlineQueue.enqueue(edit);
    let authorizationReads = 0;
    let versionReads = 0;
    let applyCount = 0;

    const offline = await new OfflineReconnectCoordinator(offlineQueue, scope, operations({
      reauthorize: async () => { authorizationReads++; return { ...scope, disposition: "AUTHORIZED" }; },
      readProjectVersion: async () => { versionReads++; return { ...scope, disposition: "CURRENT", version: "revision-8" }; },
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(false);
    expect(offline).toEqual({ status: "OFFLINE", dirty: true });
    expect(authorizationReads).toBe(0);
    expect(versionReads).toBe(0);
    expect(applyCount).toBe(0);

    const conflict = await new OfflineReconnectCoordinator(offlineQueue, scope, operations({
      readProjectVersion: async () => { versionReads++; return { ...scope, disposition: "CURRENT", version: "revision-8" }; },
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);
    expect(conflict.status).toBe("RECONNECTED");
    if (conflict.status === "RECONNECTED") expect(conflict.results).toEqual([{ editId: edit.editId, state: "CONFLICT" }]);
    expect(await offlineQueue.readEdits(scope)).toMatchObject([{ edit, state: "CONFLICT" }]);
    expect(await offlineQueue.hasDirtyEdits(scope)).toBe(true);
    expect(authorizationReads).toBe(0);
    expect(versionReads).toBe(1);
    expect(applyCount).toBe(0);

    const rebasedEdit = { ...edit, idempotencyKey: "idem-rebased", expectedVersion: "revision-8",
      payload: { ...edit.payload, position: 8 } };
    await offlineQueue.resolveConflict(rebasedEdit);
    let reconnectAuthorizationReads = 0;
    let reconnectVersionReads = 0;
    const revoked = await new OfflineReconnectCoordinator(offlineQueue, scope, operations({
      reauthorize: async () => {
        reconnectAuthorizationReads++;
        return { ...scope, disposition: "REVOKED" };
      },
      readProjectVersion: async () => {
        reconnectVersionReads++;
        return { ...scope, disposition: "CURRENT", version: "revision-8" };
      },
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);
    expect(revoked.status).toBe("RECONNECTED");
    if (revoked.status === "RECONNECTED") expect(revoked.results).toEqual([{ editId: edit.editId, state: "REVOKED" }]);
    expect(reconnectVersionReads).toBe(1);
    expect(reconnectAuthorizationReads).toBe(1);
    expect(await offlineQueue.readEdits(scope)).toMatchObject([{ edit: rebasedEdit, state: "REVOKED" }]);
    expect(await offlineQueue.hasDirtyEdits(scope)).toBe(true);
    expect(applyCount).toBe(0);

    // This creates a fresh queue object over the same in-memory store fixture; it does not
    // establish process-restart or durable-store recovery behavior.
    const recreatedQueue = await queue();
    const afterQueueRecreation = await new OfflineReconnectCoordinator(recreatedQueue, scope, operations({
      reauthorize: async () => { reconnectAuthorizationReads++; return { ...scope, disposition: "AUTHORIZED" }; },
      readProjectVersion: async () => { reconnectVersionReads++; return { ...scope, disposition: "CURRENT", version: "revision-8" }; },
      applyEdit: async (...args) => { applyCount++; return operations().applyEdit(...args); },
    })).reconnect(true);
    expect(afterQueueRecreation).toEqual({ status: "RECONNECTED", dirty: true, results: [] });
    expect(reconnectAuthorizationReads).toBe(1);
    expect(reconnectVersionReads).toBe(1);
    expect(applyCount).toBe(0);
    expect(await recreatedQueue.readEdits(scope)).toMatchObject([{ edit: rebasedEdit, state: "REVOKED" }]);
  });

  it("stores lost apply acknowledgment as unknown and never blindly reapplies, including after restart", async () => {
    const q = await queue();
    await q.enqueue(edit);
    let applyCount = 0;
    const lostAck = operations({ applyEdit: async () => { applyCount++; throw new Error("connection lost after dispatch"); } });
    const first = await new OfflineReconnectCoordinator(q, scope, lostAck).reconnect(true);
    expect(first.status).toBe("RECONNECTED");
    if (first.status === "RECONNECTED") expect(first.results[0]?.state).toBe("OUTCOME_UNKNOWN");

    const restartedQueue = await queue(); // same encrypted store/key; new coordinator simulates process restart.
    const resumed = await new OfflineReconnectCoordinator(restartedQueue, scope, operations({
      applyEdit: async (queued) => { applyCount++; return operations().applyEdit(queued); },
    })).reconnect(true);
    expect(resumed.status).toBe("RECONNECTED");
    if (resumed.status === "RECONNECTED") expect(resumed.results).toEqual([]);
    expect(applyCount).toBe(1);
    expect((await restartedQueue.readEdits(scope))[0]?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("treats an applied response without a receipt as unknown and preserves the no-replay fence", async () => {
    const q = await queue();
    await q.enqueue(edit);
    let applyCount = 0;
    const first = await new OfflineReconnectCoordinator(q, scope, operations({
      applyEdit: async (queued) => {
        applyCount++;
        return { ...scope, editId: queued.editId, idempotencyKey: queued.idempotencyKey,
          expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: "  " };
      },
    })).reconnect(true);

    expect(first.status).toBe("RECONNECTED");
    if (first.status === "RECONNECTED") expect(first.results[0]?.state).toBe("OUTCOME_UNKNOWN");
    expect((await q.readEdits(scope))[0]?.state).toBe("OUTCOME_UNKNOWN");

    const recreatedQueue = await queue();
    const afterRecreation = await new OfflineReconnectCoordinator(recreatedQueue, scope, operations({
      applyEdit: async (queued) => {
        applyCount++;
        return operations().applyEdit(queued);
      },
    })).reconnect(true);

    expect(afterRecreation).toEqual({ status: "RECONNECTED", dirty: true, results: [] });
    expect(applyCount).toBe(1);
    expect((await recreatedQueue.readEdits(scope))[0]?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("treats a malformed non-string receipt as unknown and preserves the no-replay fence", async () => {
    const q = await queue();
    await q.enqueue(edit);
    let applyCount = 0;
    const malformedReceipt = operations({
      applyEdit: async (queued) => {
        applyCount++;
        return { ...scope, editId: queued.editId, idempotencyKey: queued.idempotencyKey,
          expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: 42 } as never;
      },
    });

    const first = await new OfflineReconnectCoordinator(q, scope, malformedReceipt).reconnect(true);
    expect(first.status).toBe("RECONNECTED");
    if (first.status === "RECONNECTED") expect(first.results[0]?.state).toBe("OUTCOME_UNKNOWN");
    expect((await q.readEdits(scope))[0]?.state).toBe("OUTCOME_UNKNOWN");

    const recreatedQueue = await queue();
    const afterRecreation = await new OfflineReconnectCoordinator(recreatedQueue, scope, operations({
      applyEdit: async (queued) => {
        applyCount++;
        return operations().applyEdit(queued);
      },
    })).reconnect(true);

    expect(afterRecreation).toEqual({ status: "RECONNECTED", dirty: true, results: [] });
    expect(applyCount).toBe(1);
    expect((await recreatedQueue.readEdits(scope))[0]?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("resumes a still-pending encrypted edit after restart with the same idempotency key", async () => {
    const originalQueue = await queue();
    await originalQueue.enqueue(edit);
    const restartedQueue = await queue();
    let observedKey = "";
    const resumed = await new OfflineReconnectCoordinator(restartedQueue, scope, operations({
      applyEdit: async (queued) => {
        observedKey = queued.idempotencyKey;
        return operations().applyEdit(queued);
      },
    })).reconnect(true);
    expect(observedKey).toBe(edit.idempotencyKey);
    expect(resumed.status).toBe("RECONNECTED");
    if (resumed.status === "RECONNECTED") expect(resumed.results[0]?.state).toBe("APPLIED");
  });

  it("suppresses exact duplicate edits and accepts apply only when response scope and identity match", async () => {
    const q = await queue();
    await q.enqueue(edit);
    await q.enqueue(edit);
    let applyCount = 0;
    const result = await new OfflineReconnectCoordinator(q, scope, operations({
      applyEdit: async (queued) => {
        applyCount++;
        return { ...scope, editId: queued.editId, idempotencyKey: queued.idempotencyKey,
          expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: "receipt" };
      },
    })).reconnect(true);
    expect(applyCount).toBe(1);
    expect(result.status).toBe("RECONNECTED");

    await q.enqueue({ ...edit, editId: "edit-b", idempotencyKey: "idem-b" });
    const mismatch = await new OfflineReconnectCoordinator(q, scope, operations({
      applyEdit: async (queued) => ({ tenantId: "tenant-other", projectId: scope.projectId, editId: queued.editId,
        idempotencyKey: queued.idempotencyKey, expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: "wrong" }),
    })).reconnect(true);
    expect(mismatch.status).toBe("RECONNECTED");
    if (mismatch.status === "RECONNECTED") expect(mismatch.results.find((item) => item.editId === "edit-b")?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("keeps encrypted storage envelope fields out of reconnect operation inputs", async () => {
    const q = await queue();
    await q.enqueue(edit);
    const observed: Record<string, unknown>[] = [];
    const capture = (value: object) => observed.push(value as Record<string, unknown>);
    const result = await new OfflineReconnectCoordinator(q, scope, operations({
      reauthorize: async (queued) => { capture(queued); return { ...scope, disposition: "AUTHORIZED" }; },
      applyEdit: async (queued) => {
        capture(queued);
        return { ...scope, editId: queued.editId, idempotencyKey: queued.idempotencyKey,
          expectedVersion: queued.expectedVersion, outcome: "APPLIED", receipt: "receipt" };
      },
    })).reconnect(true);

    expect(result.status).toBe("RECONNECTED");
    expect(observed).toHaveLength(3); // two authorization reads and one apply
    for (const operationInput of observed) {
      expect(Object.keys(operationInput).sort()).toEqual([
        "editId", "expectedVersion", "idempotencyKey", "payload", "projectId", "tenantId",
      ]);
      expect(operationInput.payload).toEqual(edit.payload);
    }
  });
});
