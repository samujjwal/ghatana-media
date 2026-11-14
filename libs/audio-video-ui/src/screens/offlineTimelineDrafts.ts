import { IndexedDbOfflineEditStore } from "@audio-video/client/offline-edit-store";
import { OfflineEditQueue, type OfflineEdit, type OfflineEditState } from "@audio-video/client/offline-edit-queue";
import { OfflineReconnectCoordinator, type OfflineReconnectOperations } from "@audio-video/client/offline-reconnect";
import {
  MediaDevProjectTimelineError,
  type DevProjectRead,
  type DevRevisionRead,
  type DevTimelineEdit,
  type EditDevTimelineRequest,
} from "@audio-video/client/dev-project-timeline";
import { OfflineDraftKeyCustody, offlineDraftKeyId, type OfflineDraftKeyScope } from "./offlineDraftKeyCustody";

/**
 * Offline drafts for the DEV_ONLY timeline workspace.
 *
 * DECISION (owner-delegated): "Offline key custody is browser-held: each
 * (tenant, principal, project) gets a non-extractable AES-GCM CryptoKey
 * generated with WebCrypto and stored only as a CryptoKey object in IndexedDB;
 * it never leaves the browser and is never derived from the bearer token.
 * Offline edits are inert encrypted drafts bound to the exact base head
 * revision; nothing is replayed automatically. On reconnect the user must
 * explicitly review each draft; replay first re-reads the project head and
 * current authorization, sends the edit with expectedHeadRevisionId (CAS) and
 * the draft's own requestId, and on REVISION_CONFLICT shows the conflict
 * without auto-merging. A revoked or changed principal/tenant discards access
 * to the drafts (key scope mismatch). Clearing site data loses drafts by design."
 *
 * This module reuses the existing OfflineEditQueue / IndexedDbOfflineEditStore /
 * OfflineReconnectCoordinator. The draft's requestId is the queue idempotency
 * key (the durable local replay fence); the DEV_ONLY host edit route carries no
 * requestId on the wire and gets its at-most-once guarantee from the
 * expectedHeadRevisionId compare-and-set.
 */

export interface TimelineDraftPayload {
  readonly requestId: string;
  readonly timelineId: string;
  readonly edits: readonly DevTimelineEdit[];
  readonly capturedAt: string;
}

export interface TimelineDraft {
  readonly editId: string;
  readonly requestId: string;
  readonly timelineId: string;
  readonly edits: readonly DevTimelineEdit[];
  /** Exact project head revision the edit was authored against. */
  readonly baseRevisionId: string;
  readonly capturedAt: string;
  readonly state: OfflineEditState;
}

export type OfflineDraftsPort = {
  getProject(projectId: string, signal?: AbortSignal): Promise<DevProjectRead>;
  editTimeline(projectId: string, timelineId: string, request: EditDevTimelineRequest, signal?: AbortSignal): Promise<DevRevisionRead>;
};

export interface OfflineDraftsControllerOptions {
  readonly scope: OfflineDraftKeyScope;
  readonly port: OfflineDraftsPort;
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export interface DraftReview {
  readonly draft: TimelineDraft;
  readonly headRevisionId: string;
  /** True when the project head moved past the draft's base revision. */
  readonly stale: boolean;
  /** For OUTCOME_UNKNOWN drafts: what the head readback proves. */
  readonly reconciliation?: "NOT_APPLIED_CONFIRMED" | "POSSIBLY_APPLIED";
  /** Exact queue readback the host presented; replay fails closed if it changed. */
  readonly reviewedQueue: readonly OfflineEditReviewEntry<TimelineDraftPayload>[];
}

export type DraftReplayOutcome =
  | { readonly kind: "APPLIED"; readonly editId: string; readonly requestId: string; readonly revisionId: string; readonly httpStatus: 201 }
  /** Same requestId re-sent after an unknown outcome and accepted. */
  | { readonly kind: "REPLAYED"; readonly editId: string; readonly requestId: string; readonly revisionId: string }
  | { readonly kind: "REVISION_CONFLICT"; readonly editId: string; readonly baseRevisionId: string; readonly currentHeadRevisionId: string; readonly message: string }
  | { readonly kind: "DISCARDED"; readonly editId: string; readonly status: number; readonly reason: "ACCESS_REVOKED" | "NOT_FOUND" | "REJECTED"; readonly message: string }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly editId: string; readonly requestId: string; readonly message: string }
  | { readonly kind: "RETRYABLE"; readonly editId: string; readonly reason: "AUTHORIZATION_UNKNOWN" | "VERSION_UNKNOWN" | "OFFLINE"; readonly message: string }
  | { readonly kind: "REVIEW_REQUIRED"; readonly editId: string; readonly message: string };

type OfflineEditReviewEntry<T> = { readonly edit: OfflineEdit<T>; readonly state: OfflineEditState };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const randomId = (): string => globalThis.crypto.randomUUID();

/** A request failure that means "no response": transport failure or an unconfirmed mutation. */
export function isConnectivityFailure(error: unknown): boolean {
  return error instanceof MediaDevProjectTimelineError && error.status === 0
    && (error.code === "TRANSPORT_ERROR" || error.code === "OUTCOME_UNKNOWN");
}

export class OfflineTimelineDrafts {
  private readonly retried = new Set<string>();
  private readonly denials = new Map<string, { status: number; reason: "ACCESS_REVOKED" | "NOT_FOUND" | "REJECTED"; message: string }>();
  private observedHead?: string;
  private conflictHead?: string;
  private readonly editScope: { readonly tenantId: string; readonly projectId: string };

  private constructor(
    private readonly options: OfflineDraftsControllerOptions,
    private readonly queue: OfflineEditQueue,
    private readonly store: IndexedDbOfflineEditStore,
  ) {
    this.editScope = Object.freeze({ tenantId: options.scope.tenantId, projectId: options.scope.projectId });
  }

  /** Opens (creating if needed) the browser-held key and the per-principal encrypted store. */
  public static async open(options: OfflineDraftsControllerOptions): Promise<OfflineTimelineDrafts> {
    const custody = new OfflineDraftKeyCustody({ indexedDB: options.indexedDB, crypto: options.crypto });
    const key = await custody.getOrCreate(options.scope);
    // One database per (tenant, principal): another principal or tenant never even lists these rows.
    offlineDraftKeyId(options.scope); // validates the exact scope
    const principalDb = [options.scope.tenantId, options.scope.principalId].map((part) => `${part.length}:${part}`).join("|");
    const store = new IndexedDbOfflineEditStore({
      indexedDB: options.indexedDB, databaseName: `ghatana-media-offline-drafts-v1:${principalDb}`,
    });
    return new OfflineTimelineDrafts(options, new OfflineEditQueue({ store, encryptionKey: key }), store);
  }

  public async close(): Promise<void> { await this.store.close(); }

  /** Stores an inert encrypted draft bound to the exact base head revision. Never sends anything. */
  public async capture(input: { timelineId: string; edits: readonly DevTimelineEdit[]; baseRevisionId: string }): Promise<TimelineDraft> {
    if (!ID.test(input.timelineId) || !ID.test(input.baseRevisionId) || !Array.isArray(input.edits) || input.edits.length < 1) {
      throw new TypeError("A draft needs a timeline, a base head revision and at least one edit.");
    }
    const newId = this.options.newId ?? randomId;
    const requestId = newId();
    const editId = `draft-${newId()}`;
    const capturedAt = (this.options.now?.() ?? new Date()).toISOString();
    const payload: TimelineDraftPayload = { requestId, timelineId: input.timelineId, edits: input.edits, capturedAt };
    await this.queue.enqueue<TimelineDraftPayload>({
      ...this.editScope, editId, idempotencyKey: requestId, expectedVersion: input.baseRevisionId, payload,
    });
    return { editId, requestId, timelineId: input.timelineId, edits: input.edits, baseRevisionId: input.baseRevisionId, capturedAt, state: "PENDING" };
  }

  public async list(): Promise<readonly TimelineDraft[]> {
    return (await this.queue.readEdits<TimelineDraftPayload>(this.editScope)).map(toDraft);
  }

  /** Records a head observation (for the base revision of future drafts). */
  public get lastObservedHead(): string | undefined { return this.observedHead; }

  /**
   * Step 1 of an explicit replay. Re-reads the project head and returns the
   * exact reviewed queue. Nothing is sent. Throws a MediaDevProjectTimelineError
   * when the head cannot be read.
   */
  public async review(editId: string): Promise<DraftReview> {
    const entries = await this.queue.readEdits<TimelineDraftPayload>(this.editScope);
    const entry = entries.find((candidate) => candidate.edit.editId === editId);
    if (!entry) throw new Error("The draft no longer exists.");
    const draft = toDraft(entry);
    const read = await this.options.port.getProject(this.editScope.projectId);
    this.assertScope(read);
    const headRevisionId = read.project.headRevisionId;
    this.observedHead = headRevisionId;
    let reconciliation: DraftReview["reconciliation"];
    if (draft.state === "OUTCOME_UNKNOWN") {
      // The CAS base is still the head: the unknown request cannot have committed.
      reconciliation = headRevisionId === draft.baseRevisionId ? "NOT_APPLIED_CONFIRMED" : "POSSIBLY_APPLIED";
    }
    return { draft, headRevisionId, stale: headRevisionId !== draft.baseRevisionId, ...(reconciliation ? { reconciliation } : {}), reviewedQueue: entries };
  }

  /**
   * Re-arms an OUTCOME_UNKNOWN draft with the same editId, requestId and base
   * revision once the head readback proves it did not commit. Does not send.
   */
  public async rearmUnknown(review: DraftReview): Promise<void> {
    if (review.draft.state !== "OUTCOME_UNKNOWN" || review.reconciliation !== "NOT_APPLIED_CONFIRMED") {
      throw new Error("Only an unknown-outcome draft whose base head is still current can be re-armed.");
    }
    const { draft } = review;
    await this.queue.discardUnknown(this.editScope, draft.editId, true);
    await this.queue.enqueue<TimelineDraftPayload>({
      ...this.editScope, editId: draft.editId, idempotencyKey: draft.requestId, expectedVersion: draft.baseRevisionId,
      payload: { requestId: draft.requestId, timelineId: draft.timelineId, edits: draft.edits, capturedAt: draft.capturedAt },
    });
    this.retried.add(draft.editId);
  }

  /** After a REVISION_CONFLICT the user may rebase the same edit onto the shown head (new requestId); still not sent. */
  public async rebaseConflict(editId: string, currentHeadRevisionId: string): Promise<TimelineDraft> {
    const entry = (await this.queue.readEdits<TimelineDraftPayload>(this.editScope)).find((candidate) => candidate.edit.editId === editId);
    if (!entry || entry.state !== "CONFLICT") throw new Error("Only a conflicted draft can be rebased.");
    const requestId = (this.options.newId ?? randomId)();
    await this.queue.resolveConflict<TimelineDraftPayload>({
      ...this.editScope, editId, idempotencyKey: requestId, expectedVersion: currentHeadRevisionId,
      payload: { ...entry.edit.payload, requestId },
    });
    return { ...toDraft(entry), requestId, baseRevisionId: currentHeadRevisionId, state: "PENDING" };
  }

  public async discard(editId: string): Promise<void> {
    await this.store.remove(this.editScope, editId);
  }

  /**
   * Step 2: the user confirmed the review. Re-reads authorization and head,
   * sends one edit with expectedHeadRevisionId and the draft's own requestId,
   * and returns a typed outcome. Other drafts are not touched.
   */
  public async replay(review: DraftReview): Promise<DraftReplayOutcome> {
    const editId = review.draft.editId;
    this.denials.delete(editId);
    this.conflictHead = undefined;
    const port = this.options.port;
    const scope = this.editScope;
    const assertScope = (read: DevProjectRead): void => this.assertScope(read);
    const classify = (error: unknown): "REVOKED" | "UNKNOWN" => {
      if (error instanceof MediaDevProjectTimelineError && (error.status === 403 || error.status === 404)) {
        this.denials.set(editId, error.status === 403
          ? { status: 403, reason: "ACCESS_REVOKED", message: "Access to this project was revoked or is no longer permitted for this principal; the draft was discarded." }
          : { status: 404, reason: "NOT_FOUND", message: "The project or timeline no longer exists for this principal; the draft was discarded." });
        return "REVOKED";
      }
      return "UNKNOWN";
    };
    const operations: OfflineReconnectOperations<TimelineDraftPayload> = {
      reauthorize: async (edit) => {
        if (edit.editId !== editId) return { ...scope, disposition: "UNKNOWN" };
        try { assertScope(await port.getProject(scope.projectId)); return { ...scope, disposition: "AUTHORIZED" }; }
        catch (error) { return { ...scope, disposition: classify(error) === "REVOKED" ? "REVOKED" : "UNKNOWN" }; }
      },
      readProjectVersion: async () => {
        try {
          const read = await port.getProject(scope.projectId);
          assertScope(read);
          this.observedHead = read.project.headRevisionId;
          this.conflictHead = read.project.headRevisionId;
          return { ...scope, disposition: "CURRENT", version: read.project.headRevisionId };
        } catch { return { ...scope, disposition: "UNKNOWN" }; }
      },
      applyEdit: async (edit) => {
        const base = { ...scope, editId: edit.editId, idempotencyKey: edit.idempotencyKey, expectedVersion: edit.expectedVersion };
        if (edit.idempotencyKey !== edit.payload.requestId) return { ...base, outcome: "OUTCOME_UNKNOWN" };
        try {
          const applied = await port.editTimeline(scope.projectId, edit.payload.timelineId,
            { expectedHeadRevisionId: edit.expectedVersion, edits: edit.payload.edits });
          this.observedHead = applied.revision.revisionId;
          return { ...base, outcome: "APPLIED", receipt: applied.revision.revisionId };
        } catch (error) {
          if (error instanceof MediaDevProjectTimelineError) {
            if (error.code === "REVISION_CONFLICT") {
              const head = error.details?.currentHeadRevisionId;
              if (typeof head === "string") this.conflictHead = head;
              return { ...base, outcome: "CONFLICT" };
            }
            if (error.status === 403 || error.status === 404) { classify(error); return { ...base, outcome: "OUTCOME_UNKNOWN" }; }
            if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 425 && error.status !== 429) {
              this.denials.set(editId, { status: error.status, reason: "REJECTED", message: `The host rejected the edit (${error.code}): ${error.message} The draft was discarded.` });
            }
          }
          return { ...base, outcome: "OUTCOME_UNKNOWN" };
        }
      },
    };
    const coordinator = new OfflineReconnectCoordinator<TimelineDraftPayload, string>(this.queue, scope, operations);
    const result = await coordinator.reconnect(true, { reviewedQueue: review.reviewedQueue });
    if (result.status === "REVIEW_REQUIRED") {
      return { kind: "REVIEW_REQUIRED", editId, message: "The draft queue changed after review. Review the draft again before replaying." };
    }
    if (result.status !== "RECONNECTED") {
      return { kind: "RETRYABLE", editId, reason: "OFFLINE", message: "Replay is unavailable in this browser (compare-and-set storage is required)." };
    }
    const mine = result.results.find((entry) => entry.editId === editId);
    const denial = this.denials.get(editId);
    switch (mine?.state) {
      case "APPLIED": {
        const revisionId = mine.receipt ?? "";
        await this.store.remove(scope, editId).catch(() => undefined);
        if (this.retried.delete(editId)) return { kind: "REPLAYED", editId, requestId: review.draft.requestId, revisionId };
        return { kind: "APPLIED", editId, requestId: review.draft.requestId, revisionId, httpStatus: 201 };
      }
      case "CONFLICT":
        return { kind: "REVISION_CONFLICT", editId, baseRevisionId: review.draft.baseRevisionId,
          currentHeadRevisionId: this.conflictHead ?? this.observedHead ?? "unknown",
          message: "The project head changed since this draft was authored. Nothing was merged or sent; rebase or discard the draft." };
      case "REVOKED": {
        const d = denial ?? { status: 403, reason: "ACCESS_REVOKED" as const, message: "Access was revoked; the draft was discarded." };
        await this.store.remove(scope, editId);
        return { kind: "DISCARDED", editId, ...d };
      }
      case "OUTCOME_UNKNOWN": {
        if (denial) {
          // 4xx before commit: provably not applied, so the fenced draft can be dropped.
          await this.queue.discardUnknown(scope, editId, true);
          return { kind: "DISCARDED", editId, ...denial };
        }
        return { kind: "OUTCOME_UNKNOWN", editId, requestId: review.draft.requestId,
          message: "The host did not confirm whether the edit committed. Review again to reconcile against the head, then retry the same requestId." };
      }
      case "AUTHORIZATION_UNKNOWN":
        return { kind: "RETRYABLE", editId, reason: "AUTHORIZATION_UNKNOWN", message: "Current authorization could not be confirmed; the draft is unchanged." };
      case "VERSION_UNKNOWN":
        return { kind: "RETRYABLE", editId, reason: "VERSION_UNKNOWN", message: "The project head could not be read; the draft is unchanged." };
      default:
        return { kind: "REVIEW_REQUIRED", editId, message: "The draft is not pending. Review its state first." };
    }
  }

  private assertScope(read: DevProjectRead): void {
    if (read.project.projectId !== this.editScope.projectId || read.project.tenantId !== this.editScope.tenantId) {
      throw new MediaDevProjectTimelineError("INVALID_RESPONSE", 0, "Project read did not match the draft scope.");
    }
  }
}

function toDraft(entry: OfflineEditReviewEntry<TimelineDraftPayload>): TimelineDraft {
  const { edit, state } = entry;
  return {
    editId: edit.editId, requestId: edit.payload.requestId, timelineId: edit.payload.timelineId,
    edits: edit.payload.edits, baseRevisionId: edit.expectedVersion, capturedAt: edit.payload.capturedAt, state,
  };
}
