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
  async remove(_scope: OfflineEditScope, editId: string): Promise<void> { this.records.delete(editId); }
}

describe("OfflineReconnectCoordinator", () => {
  let store: MemoryStore;
  let key: CryptoKey;
  beforeEach(async () => {
    store = new MemoryStore();
    key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  });

  async function queue(): Promise<OfflineEditQueue> {
    return new OfflineEditQueue({ store, encryptionKey: key });
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
});
