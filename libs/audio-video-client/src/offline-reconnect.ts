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
  public constructor(
    private readonly queue: OfflineEditQueue,
    private readonly scope: OfflineEditScope,
    private readonly operations?: OfflineReconnectOperations<T>,
  ) {
    assertScope(scope);
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
        if (!sameScope(read, this.scope)) return { authorized: false, disposition: "UNKNOWN" };
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
        if (!sameScope(response, this.scope) || response.editId !== edit.editId
          || response.idempotencyKey !== edit.idempotencyKey || response.expectedVersion !== edit.expectedVersion) {
          return { outcome: "OUTCOME_UNKNOWN" };
        }
        if (response.outcome === "APPLIED") {
          if (!response.receipt?.trim()) return { outcome: "OUTCOME_UNKNOWN" };
          return { outcome: "APPLIED", receipt: response.receipt as R };
        }
        return { outcome: response.outcome };
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
  if (!scope.tenantId.trim() || !scope.projectId.trim()) throw new TypeError("Reconnect scope requires exact tenant and project identities.");
}
