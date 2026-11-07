import {
  OfflineEditQueue,
  type OfflineEdit,
  type OfflineEditReplayAdapter,
  type OfflineEditReplayState,
  type OfflineEditScope,
} from "./offline-edit-queue.js";

export interface ScopedAuthorizationRead extends OfflineEditScope {
  readonly disposition: "AUTHORIZED" | "REVOKED" | "UNKNOWN";
}

export interface ScopedProjectVersionRead extends OfflineEditScope {
  readonly disposition: "CURRENT" | "UNKNOWN";
  readonly version?: string;
}

export interface ScopedEditApplyResult extends OfflineEditScope {
  readonly editId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: string;
  readonly outcome: "APPLIED" | "CONFLICT" | "OUTCOME_UNKNOWN";
  readonly receipt?: string;
}

/** Host-owned canonical operation ports. The client package defines no project route. */
export interface OfflineReconnectOperations<T = unknown> {
  reauthorize(edit: OfflineEdit<T>): Promise<ScopedAuthorizationRead>;
  readProjectVersion(scope: OfflineEditScope): Promise<ScopedProjectVersionRead>;
  applyEdit(edit: OfflineEdit<T>): Promise<ScopedEditApplyResult>;
}

export type OfflineReconnectResult<R = unknown> =
  | { readonly status: "UNAVAILABLE"; readonly reason: "CANONICAL_PROJECT_EDIT_OPERATION_UNAVAILABLE"; readonly dirty: boolean }
  | { readonly status: "UNAVAILABLE"; readonly reason: "OFFLINE_STORE_CAS_UNAVAILABLE"; readonly dirty: boolean; readonly results: readonly {
      readonly editId: string; readonly state: OfflineEditReplayState; readonly receipt?: R;
    }[] }
  | { readonly status: "OFFLINE"; readonly dirty: boolean }
  | { readonly status: "RECONNECTED"; readonly dirty: boolean; readonly results: readonly {
      readonly editId: string; readonly state: OfflineEditReplayState; readonly receipt?: R;
    }[] };

/** Coordinates reconnect through the existing encrypted queue; it never owns storage or retries unknown effects. */
export class OfflineReconnectCoordinator<T = unknown, R = string> {
  private readonly scope: OfflineEditScope;

  public constructor(
    private readonly queue: OfflineEditQueue,
    scope: OfflineEditScope,
    private readonly operations?: OfflineReconnectOperations<T>,
  ) {
    const snapshot = Object.freeze({ tenantId: scope.tenantId, projectId: scope.projectId });
    assertScope(snapshot);
    // Tenant/project identity is a constructor-time boundary. Keep later host
    // mutation of the caller's object from redirecting queue reads or checks.
    this.scope = snapshot;
  }

  public async reconnect(online: boolean): Promise<OfflineReconnectResult<R>> {
    const dirty = await this.queue.hasDirtyEdits(this.scope);
    if (!online) return { status: "OFFLINE", dirty };
    if (!this.operations) {
      return { status: "UNAVAILABLE", reason: "CANONICAL_PROJECT_EDIT_OPERATION_UNAVAILABLE", dirty };
    }
    const adapter: OfflineEditReplayAdapter<T, R> = {
      reauthorize: async (edit) => {
        if (!sameScope(edit, this.scope)) return { authorized: false, disposition: "UNKNOWN" };
        const read = await this.operations!.reauthorize(edit);
        if (!read || typeof read !== "object" || !sameScope(read, this.scope)
          || (read.disposition !== "AUTHORIZED" && read.disposition !== "REVOKED"
            && read.disposition !== "UNKNOWN")) {
          return { authorized: false, disposition: "UNKNOWN" };
        }
        return { authorized: read.disposition === "AUTHORIZED", disposition: read.disposition };
      },
      readCurrentVersion: async (scope) => {
        if (!sameScope(scope, this.scope)) return { disposition: "UNKNOWN" };
        const read = await this.operations!.readProjectVersion(scope);
        if (!sameScope(read, this.scope) || read.disposition !== "CURRENT" || !read.version?.trim()) {
          return { disposition: "UNKNOWN" };
        }
        return { disposition: "CURRENT", version: read.version };
      },
      apply: async (edit) => {
        if (!sameScope(edit, this.scope)) return { outcome: "OUTCOME_UNKNOWN" };
        const response = await this.operations!.applyEdit(edit);
        if (!response || typeof response !== "object") return { outcome: "OUTCOME_UNKNOWN" };
        // Treat adapter output as an untrusted readback. Snapshot each field
        // once so accessors cannot return one value during validation and a
        // different receipt/outcome when the replay result is persisted.
        const responseTenantId = response.tenantId;
        const responseProjectId = response.projectId;
        const responseEditId = response.editId;
        const responseIdempotencyKey = response.idempotencyKey;
        const responseExpectedVersion = response.expectedVersion;
        const outcome = response.outcome;
        const receipt = response.receipt;
        if (responseTenantId !== this.scope.tenantId || responseProjectId !== this.scope.projectId
          || responseEditId !== edit.editId || responseIdempotencyKey !== edit.idempotencyKey
          || responseExpectedVersion !== edit.expectedVersion) {
          return { outcome: "OUTCOME_UNKNOWN" };
        }
        if (outcome === "APPLIED") {
          if (typeof receipt !== "string" || !receipt.trim()) {
            return { outcome: "OUTCOME_UNKNOWN" };
          }
          return { outcome: "APPLIED", receipt: receipt as R };
        }
        if (outcome === "CONFLICT" || outcome === "OUTCOME_UNKNOWN") return { outcome };
        return { outcome: "OUTCOME_UNKNOWN" };
      },
    };
    const results = await this.queue.replay<T, R>(this.scope, adapter);
    const stillDirty = await this.queue.hasDirtyEdits(this.scope);
    if (results.some((result) => result.state === "STORE_CAS_UNAVAILABLE")) {
      return { status: "UNAVAILABLE", reason: "OFFLINE_STORE_CAS_UNAVAILABLE", dirty: stillDirty, results };
    }
    return { status: "RECONNECTED", dirty: stillDirty, results };
  }
}

function sameScope(value: OfflineEditScope, expected: OfflineEditScope): boolean {
  return value.tenantId === expected.tenantId && value.projectId === expected.projectId;
}

function assertScope(scope: OfflineEditScope): void {
  if (!isExactIdentity(scope.tenantId) || !isExactIdentity(scope.projectId)) {
    throw new TypeError("Reconnect scope requires exact tenant and project identities.");
  }
}

function isExactIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000");
}
