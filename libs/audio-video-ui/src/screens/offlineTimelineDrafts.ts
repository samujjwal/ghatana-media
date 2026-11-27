import { IndexedDbOfflineEditStore } from "@audio-video/client/offline-edit-store";
import { OfflineEditQueue, OfflineEditQueueError, type OfflineEdit, type OfflineEditState } from "@audio-video/client/offline-edit-queue";
import { OfflineReconnectCoordinator, type OfflineReconnectOperations } from "@audio-video/client/offline-reconnect";
import {
  MediaDevProjectTimelineError,
  type DevProjectRead,
  type DevProjectRevision,
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
 * key (the durable local replay fence); the DEV_ONLY host edit route receives
 * that requestId but does not currently expose owner-confirmed replay status.
 * Its source edit remains guarded by expectedHeadRevisionId compare-and-set.
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
  editTimeline(projectId: string, timelineId: string, request: EditDevTimelineRequest, signal?: AbortSignal): Promise<DevRevisionRead & { readonly replayed?: boolean }>;
  /** Exact revision reads let a review show the other version and reconcile an unknown outcome. */
  getRevision?(projectId: string, revisionId: string, signal?: AbortSignal): Promise<DevRevisionRead>;
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
  /**
   * For OUTCOME_UNKNOWN drafts: what the head readback proves.
   * APPLIED_CONFIRMED: the child of the base revision holds this draft's exact effects (never re-send).
   * NOT_APPLIED_CONFIRMED: the head still is the base. NOT_APPLIED_STALE: the base's only child lacks the effects
   * (compare-and-set means this draft lost), so it can only be rebased. POSSIBLY_APPLIED: not provable.
   */
  readonly reconciliation?: "NOT_APPLIED_CONFIRMED" | "POSSIBLY_APPLIED" | "APPLIED_CONFIRMED" | "NOT_APPLIED_STALE";
  /** Set with APPLIED_CONFIRMED: the revision that already carries the draft's effects. */
  readonly appliedRevisionId?: string;
  /** For a stale draft: what changed on the server between the draft's base and the current head ("theirs"). */
  readonly theirs?: RevisionChanges;
  /** Exact queue readback the host presented; replay fails closed if it changed. */
  readonly reviewedQueue: readonly OfflineEditReviewEntry<TimelineDraftPayload>[];
}

export type DraftReplayOutcome =
  | { readonly kind: "APPLIED"; readonly editId: string; readonly requestId: string; readonly revisionId: string; readonly httpStatus: 201 }
  /** The owner confirms the exact request identity was already committed and returns its original receipt. */
  | { readonly kind: "REPLAYED"; readonly editId: string; readonly requestId: string; readonly revisionId: string }
  | { readonly kind: "REVISION_CONFLICT"; readonly editId: string; readonly baseRevisionId: string; readonly currentHeadRevisionId: string; readonly message: string }
  /** A typed host refusal. The draft is KEPT (never discarded by a refusal); the user decides what to do with it. */
  | { readonly kind: "REFUSED"; readonly editId: string; readonly status: number; readonly code: string; readonly reason: RefusalReason; readonly draftKept: true; readonly message: string }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly editId: string; readonly requestId: string; readonly message: string }
  | { readonly kind: "RETRYABLE"; readonly editId: string; readonly reason: "AUTHORIZATION_UNKNOWN" | "VERSION_UNKNOWN" | "OFFLINE"; readonly message: string }
  | { readonly kind: "REVIEW_REQUIRED"; readonly editId: string; readonly message: string }
  /** The local encrypted store could not be read: nothing was sent. */
  | { readonly kind: "UNREADABLE"; readonly editId: string; readonly message: string };

export type RefusalReason = "AUTH_EXPIRED" | "ACCESS_DENIED" | "PROJECT_UNAVAILABLE" | "REJECTED";

export interface RevisionChanges {
  readonly baseRevisionId: string;
  readonly headRevisionId: string;
  /** Human-readable structural differences; empty when none are visible. */
  readonly changes: readonly string[];
  /** True when the exact base revision could not be read, so no comparison is shown. */
  readonly unavailable?: true;
}

/** Typed fail-closed error for a corrupt, tampered or key-orphaned local draft store. Nothing was sent. */
export class OfflineDraftsUnreadableError extends Error {
  public readonly code = "DRAFTS_UNREADABLE";
  public constructor() {
    super("A stored offline draft could not be decrypted or authenticated (it may be corrupted, or its browser key was lost). "
      + "Nothing was sent to the host. You can discard the unreadable local drafts to continue.");
    this.name = "OfflineDraftsUnreadableError";
  }
}

type OfflineEditReviewEntry<T> = { readonly edit: OfflineEdit<T>; readonly state: OfflineEditState };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const randomId = (): string => globalThis.crypto.randomUUID();

/** A request failure that means "no response": transport failure or an unconfirmed mutation. */
export function isConnectivityFailure(error: unknown): boolean {
  return error instanceof MediaDevProjectTimelineError && error.status === 0
    && (error.code === "TRANSPORT_ERROR" || error.code === "OUTCOME_UNKNOWN");
}

export class OfflineTimelineDrafts {
  private readonly denials = new Map<string, Refusal>();
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

  /** Local-store failures are typed and fail closed: no remote call is ever made on their behalf. */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof OfflineEditQueueError
        && (error.code === "STORE_RECORD_INVALID" || error.code === "STORE_SCOPE_MISMATCH")) throw new OfflineDraftsUnreadableError();
      if (error instanceof SyntaxError || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "OperationError")) {
        throw new OfflineDraftsUnreadableError();
      }
      throw error;
    }
  }

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
    await this.guard(() => this.queue.enqueue<TimelineDraftPayload>({
      ...this.editScope, editId, idempotencyKey: requestId, expectedVersion: input.baseRevisionId, payload,
    }));
    return { editId, requestId, timelineId: input.timelineId, edits: input.edits, baseRevisionId: input.baseRevisionId, capturedAt, state: "PENDING" };
  }

  public async list(): Promise<readonly TimelineDraft[]> {
    return (await this.guard(() => this.queue.readEdits<TimelineDraftPayload>(this.editScope))).map(toDraft);
  }

  /**
   * Explicit user action after DRAFTS_UNREADABLE: removes every local row of this scope without decrypting it.
   * Rows are never removed by any automatic path.
   */
  public async discardUnreadableLocalDrafts(): Promise<number> {
    const rows = await this.store.list(this.editScope);
    for (const row of rows) await this.store.remove(this.editScope, row.editId);
    return rows.length;
  }

  /** Records a head observation (for the base revision of future drafts). */
  public get lastObservedHead(): string | undefined { return this.observedHead; }

  /**
   * Step 1 of an explicit replay. Re-reads the project head and returns the
   * exact reviewed queue. Nothing is sent. Throws a MediaDevProjectTimelineError
   * when the head cannot be read.
   */
  public async review(editId: string): Promise<DraftReview> {
    const entries = await this.guard(() => this.queue.readEdits<TimelineDraftPayload>(this.editScope));
    const entry = entries.find((candidate) => candidate.edit.editId === editId);
    if (!entry) throw new Error("The draft no longer exists.");
    const draft = toDraft(entry);
    const read = await this.options.port.getProject(this.editScope.projectId);
    this.assertScope(read);
    const headRevisionId = read.project.headRevisionId;
    this.observedHead = headRevisionId;
    const stale = headRevisionId !== draft.baseRevisionId;
    let reconciliation: DraftReview["reconciliation"];
    let appliedRevisionId: string | undefined;
    let baseRevision: DevProjectRevision | undefined;
    if (stale) baseRevision = await this.readRevision(draft.baseRevisionId);
    if (draft.state === "OUTCOME_UNKNOWN") {
      if (!stale) {
        // The CAS base is still the head: the unknown request cannot have committed.
        reconciliation = "NOT_APPLIED_CONFIRMED";
      } else {
        const verdict = await this.reconcile(draft, read.currentRevision, baseRevision);
        reconciliation = verdict.kind;
        appliedRevisionId = verdict.revisionId;
      }
    }
    const theirs: RevisionChanges | undefined = stale ? baseRevision
      ? { baseRevisionId: draft.baseRevisionId, headRevisionId, changes: summarizeRevisionChanges(baseRevision, read.currentRevision) }
      : { baseRevisionId: draft.baseRevisionId, headRevisionId, changes: [], unavailable: true } : undefined;
    return { draft, headRevisionId, stale, ...(reconciliation ? { reconciliation } : {}),
      ...(appliedRevisionId ? { appliedRevisionId } : {}), ...(theirs ? { theirs } : {}), reviewedQueue: entries };
  }

  private async readRevision(revisionId: string): Promise<DevProjectRevision | undefined> {
    const getRevision = this.options.port.getRevision;
    if (!getRevision) return undefined;
    try {
      const read = await getRevision.call(this.options.port, this.editScope.projectId, revisionId);
      return read.revision.projectId === this.editScope.projectId && read.revision.revisionId === revisionId ? read.revision : undefined;
    } catch { return undefined; }
  }

  /**
   * Decides, from exact revision readbacks, whether an unknown-outcome draft committed. The edit route is a
   * compare-and-set on the head, so at most one revision is a child of the draft's base: the draft either is that
   * child or lost.
   */
  private async reconcile(draft: TimelineDraft, head: DevProjectRevision, base: DevProjectRevision | undefined):
    Promise<{ kind: "APPLIED_CONFIRMED" | "NOT_APPLIED_STALE" | "POSSIBLY_APPLIED"; revisionId?: string }> {
    if (!base) return { kind: "POSSIBLY_APPLIED" };
    let child: DevProjectRevision | undefined = head;
    for (let step = 0; step < 25 && child && child.parentRevisionId !== draft.baseRevisionId; step += 1) {
      const parentId: string | null = child.parentRevisionId;
      child = parentId ? await this.readRevision(parentId) : undefined;
    }
    if (!child || child.parentRevisionId !== draft.baseRevisionId) return { kind: "POSSIBLY_APPLIED" };
    const before = base.timelines.find((item) => item.graph.timelineId === draft.timelineId)?.graph;
    const after = child.timelines.find((item) => item.graph.timelineId === draft.timelineId)?.graph;
    const flags = draft.edits.map((edit) => ({ now: effectPresent(edit, after), was: effectPresent(edit, before) }));
    if (flags.every((flag) => flag.now && !flag.was)) return { kind: "APPLIED_CONFIRMED", revisionId: child.revisionId };
    if (flags.every((flag) => !flag.now || flag.was)) return { kind: "NOT_APPLIED_STALE" };
    return { kind: "POSSIBLY_APPLIED" };
  }

  /**
   * Re-arms an OUTCOME_UNKNOWN draft with the same editId, requestId and base
   * revision once the head readback proves it did not commit. Does not send.
   */
  public async rearmUnknown(review: DraftReview): Promise<void> {
    if (review.draft.state !== "OUTCOME_UNKNOWN" || review.reconciliation !== "NOT_APPLIED_CONFIRMED") {
      throw new Error("Only an unknown-outcome draft whose base head is still current can be re-armed.");
    }
    await this.rearmSame(review.draft);
  }

  private async rearmSame(draft: TimelineDraft): Promise<void> {
    await this.queue.discardUnknown(this.editScope, draft.editId, true);
    await this.queue.enqueue<TimelineDraftPayload>({
      ...this.editScope, editId: draft.editId, idempotencyKey: draft.requestId, expectedVersion: draft.baseRevisionId,
      payload: { requestId: draft.requestId, timelineId: draft.timelineId, edits: draft.edits, capturedAt: draft.capturedAt },
    });
  }

  /**
   * An unknown-outcome draft whose effects the head readback PROVES are already committed: the local copy is
   * removed without re-sending anything (a re-send could only conflict or duplicate).
   */
  public async acknowledgeApplied(review: DraftReview): Promise<string> {
    if (review.draft.state !== "OUTCOME_UNKNOWN" || review.reconciliation !== "APPLIED_CONFIRMED" || !review.appliedRevisionId) {
      throw new Error("Only an unknown-outcome draft whose effects are confirmed in the head history can be acknowledged.");
    }
    await this.queue.discardUnknown(this.editScope, review.draft.editId, true);
    return review.appliedRevisionId;
  }

  /** After a REVISION_CONFLICT the user may rebase the same edit onto the shown head (new requestId); still not sent. */
  public async rebaseConflict(editId: string, currentHeadRevisionId: string): Promise<TimelineDraft> {
    const entry = (await this.guard(() => this.queue.readEdits<TimelineDraftPayload>(this.editScope))).find((candidate) => candidate.edit.editId === editId);
    if (!entry || entry.state !== "CONFLICT") throw new Error("Only a conflicted draft can be rebased.");
    const requestId = (this.options.newId ?? randomId)();
    await this.queue.resolveConflict<TimelineDraftPayload>({
      ...this.editScope, editId, idempotencyKey: requestId, expectedVersion: currentHeadRevisionId,
      payload: { ...entry.edit.payload, requestId },
    });
    return { ...toDraft(entry), requestId, baseRevisionId: currentHeadRevisionId, state: "PENDING" };
  }

  /**
   * "Keep mine": re-bases the user's own edit onto the reviewed head under a NEW requestId and base, as a new
   * PENDING draft. The new draft is stored before the old one is removed, so a crash never loses the edit. Nothing is
   * sent; the user still reviews and confirms the new compare-and-set.
   */
  public async rebase(review: DraftReview): Promise<TimelineDraft> {
    const { draft } = review;
    if (!review.stale) throw new Error("Only a draft whose base is no longer the head needs a rebase.");
    if (draft.state === "CONFLICT") return this.rebaseConflict(draft.editId, review.headRevisionId);
    const rebasable = draft.state === "PENDING" || (draft.state === "OUTCOME_UNKNOWN" && review.reconciliation === "NOT_APPLIED_STALE");
    if (!rebasable) throw new Error("This draft cannot be rebased: its outcome is not known to be a no-effect.");
    const newId = this.options.newId ?? randomId;
    const requestId = newId();
    const editId = `draft-${newId()}`;
    await this.guard(() => this.queue.enqueue<TimelineDraftPayload>({
      ...this.editScope, editId, idempotencyKey: requestId, expectedVersion: review.headRevisionId,
      payload: { requestId, timelineId: draft.timelineId, edits: draft.edits, capturedAt: draft.capturedAt },
    }));
    if (draft.state === "OUTCOME_UNKNOWN") await this.queue.discardUnknown(this.editScope, draft.editId, true);
    else await this.store.remove(this.editScope, draft.editId);
    return { editId, requestId, timelineId: draft.timelineId, edits: draft.edits, baseRevisionId: review.headRevisionId,
      capturedAt: draft.capturedAt, state: "PENDING" };
  }

  /** "Take theirs": the user explicitly gives up this draft. */
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
    const note = (error: unknown): void => { const refusal = refusalFor(error); if (refusal) this.denials.set(editId, refusal); };
    const operations: OfflineReconnectOperations<TimelineDraftPayload> = {
      reauthorize: async (edit) => {
        if (edit.editId !== editId) return { ...scope, disposition: "UNKNOWN" };
        // A fresh read with the CURRENT token. A 401/403/404 is a typed refusal, never a reason to drop the draft.
        try { assertScope(await port.getProject(scope.projectId)); return { ...scope, disposition: "AUTHORIZED" }; }
        catch (error) { note(error); return { ...scope, disposition: "UNKNOWN" }; }
      },
      readProjectVersion: async () => {
        try {
          const read = await port.getProject(scope.projectId);
          assertScope(read);
          this.observedHead = read.project.headRevisionId;
          this.conflictHead = read.project.headRevisionId;
          return { ...scope, disposition: "CURRENT", version: read.project.headRevisionId };
        } catch (error) { note(error); return { ...scope, disposition: "UNKNOWN" }; }
      },
      applyEdit: async (edit) => {
        const base = { ...scope, editId: edit.editId, idempotencyKey: edit.idempotencyKey, expectedVersion: edit.expectedVersion };
        if (edit.idempotencyKey !== edit.payload.requestId) return { ...base, outcome: "OUTCOME_UNKNOWN" };
        try {
          const applied = await port.editTimeline(scope.projectId, edit.payload.timelineId,
            { expectedHeadRevisionId: edit.expectedVersion, edits: edit.payload.edits, requestId: edit.payload.requestId });
          this.observedHead = applied.revision.revisionId;
          const replayed: unknown = applied.replayed;
          if (replayed !== undefined && typeof replayed !== "boolean") return { ...base, outcome: "OUTCOME_UNKNOWN" };
          return { ...base, outcome: "APPLIED", receipt: applied.revision.revisionId,
            ...(typeof replayed === "boolean" ? { replayed } : {}) };
        } catch (error) {
          if (error instanceof MediaDevProjectTimelineError && error.code === "REVISION_CONFLICT") {
            const head = error.details?.currentHeadRevisionId;
            if (typeof head === "string") this.conflictHead = head;
            return { ...base, outcome: "CONFLICT" };
          }
          note(error);
          return { ...base, outcome: "OUTCOME_UNKNOWN" };
        }
      },
    };
    const coordinator = new OfflineReconnectCoordinator<TimelineDraftPayload, string>(this.queue, scope, operations);
    const result = await this.guard(() => coordinator.reconnect(true, { reviewedQueue: review.reviewedQueue }));
    if (result.status === "REVIEW_REQUIRED") {
      return { kind: "REVIEW_REQUIRED", editId, message: "The draft queue changed after review. Review the draft again before replaying." };
    }
    if (result.status === "UNAVAILABLE" && result.reason === "OFFLINE_EDIT_STORE_UNAVAILABLE") {
      return { kind: "UNREADABLE", editId, message: new OfflineDraftsUnreadableError().message };
    }
    if (result.status !== "RECONNECTED") {
      return { kind: "RETRYABLE", editId, reason: "OFFLINE", message: "Replay is unavailable in this browser (compare-and-set storage is required)." };
    }
    const mine = result.results.find((entry) => entry.editId === editId);
    const denial = this.denials.get(editId);
    const refused = (refusal: Refusal): DraftReplayOutcome => ({ kind: "REFUSED", editId, status: refusal.status, code: refusal.code,
      reason: refusal.reason, draftKept: true, message: refusal.message });
    switch (mine?.state) {
      case "APPLIED": {
        const revisionId = mine.receipt ?? "";
        await this.store.remove(scope, editId).catch(() => undefined);
        if (mine.replayed === true) return { kind: "REPLAYED", editId, requestId: review.draft.requestId, revisionId };
        return { kind: "APPLIED", editId, requestId: review.draft.requestId, revisionId, httpStatus: 201 };
      }
      case "CONFLICT":
        return { kind: "REVISION_CONFLICT", editId, baseRevisionId: review.draft.baseRevisionId,
          currentHeadRevisionId: this.conflictHead ?? this.observedHead ?? "unknown",
          message: "The project head changed since this draft was authored. Nothing was merged or overwritten; choose to keep yours (rebase) or take theirs." };
      case "REVOKED":
        return refused(denial ?? { status: 403, code: "FORBIDDEN", reason: "ACCESS_DENIED", message: "Access was revoked. The draft is kept; nothing was sent." });
      case "OUTCOME_UNKNOWN": {
        if (denial) {
          // A 4xx before commit is provably not applied: re-arm the very same draft (same requestId) so it is kept PENDING.
          try { await this.rearmSame(review.draft); return refused(denial); }
          catch { /* fall through: stay fenced, never lost */ }
        }
        return { kind: "OUTCOME_UNKNOWN", editId, requestId: review.draft.requestId,
          message: "The host did not confirm whether the edit committed. Review again to reconcile against the head history; the draft stays on this device." };
      }
      case "AUTHORIZATION_UNKNOWN":
        if (denial) return refused(denial);
        return { kind: "RETRYABLE", editId, reason: "AUTHORIZATION_UNKNOWN", message: "Current authorization could not be confirmed; the draft is unchanged." };
      case "VERSION_UNKNOWN":
        if (denial) return refused(denial);
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

interface Refusal { readonly status: number; readonly code: string; readonly reason: RefusalReason; readonly message: string }

/** Maps a typed host refusal to a message. Only definite 4xx answers qualify: transport loss and 5xx are not refusals. */
export function refusalFor(error: unknown): Refusal | undefined {
  if (!(error instanceof MediaDevProjectTimelineError)) return undefined;
  const { status, code } = error;
  if (status === 401) {
    return { status, code, reason: "AUTH_EXPIRED",
      message: "The host rejected the access token (expired or invalid). The draft is kept and nothing was sent; connect with a fresh token and review again." };
  }
  if (status === 403) {
    return { status, code, reason: "ACCESS_DENIED",
      message: "The host denied this principal on the project (project access or a required right was revoked). The draft is kept and nothing was sent." };
  }
  if (status === 404) {
    return { status, code, reason: "PROJECT_UNAVAILABLE",
      message: "The project or timeline is not available to this principal any more. The draft is kept and nothing was sent." };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429 && code !== "REVISION_CONFLICT") {
    return { status, code, reason: "REJECTED", message: `The host rejected the edit (${code}): ${error.message} The draft is kept.` };
  }
  return undefined;
}

type Graph = DevProjectRevision["timelines"][number]["graph"];
const idOf = (record: Readonly<Record<string, unknown>>, key: string): string => String(record[key] ?? "");

/** Whether an edit's effect is visible in a timeline graph (an absent timeline shows no added element). */
function effectPresent(edit: DevTimelineEdit, graph: Graph | undefined): boolean {
  const scenes = graph?.scenes ?? [], tracks = graph?.tracks ?? [], clips = graph?.clips ?? [];
  switch (edit.type) {
    case "addScene": return scenes.some((scene) => idOf(scene, "sceneId") === edit.sceneId);
    case "removeScene": return graph !== undefined && !scenes.some((scene) => idOf(scene, "sceneId") === edit.sceneId);
    case "addTrack": return tracks.some((track) => idOf(track, "trackId") === edit.trackId);
    case "removeTrack": return graph !== undefined && !tracks.some((track) => idOf(track, "trackId") === edit.trackId);
    case "putClip": return clips.some((clip) => clip.clipId === edit.clip.clipId && clip.sceneId === edit.clip.sceneId && clip.trackId === edit.clip.trackId);
    case "removeClip": return graph !== undefined && !clips.some((clip) => clip.clipId === edit.clipId);
  }
}

/** Structural differences between two revisions ("theirs" relative to a draft's base). Deterministic order. */
export function summarizeRevisionChanges(base: DevProjectRevision, head: DevProjectRevision): readonly string[] {
  const changes: string[] = [];
  const ids = (items: readonly Readonly<Record<string, unknown>>[], key: string) => new Map(items.map((item) => [idOf(item, key), JSON.stringify(item)]));
  const diff = (label: string, key: string, before: readonly Readonly<Record<string, unknown>>[], after: readonly Readonly<Record<string, unknown>>[], where: string): void => {
    const was = ids(before, key), now = ids(after, key);
    for (const id of [...now.keys()].sort()) {
      if (!was.has(id)) changes.push(`Added ${label} ${id} in ${where}`);
      else if (was.get(id) !== now.get(id)) changes.push(`Changed ${label} ${id} in ${where}`);
    }
    for (const id of [...was.keys()].sort()) if (!now.has(id)) changes.push(`Removed ${label} ${id} in ${where}`);
  };
  const before = new Map(base.timelines.map((item) => [item.graph.timelineId, item.graph]));
  for (const { graph } of head.timelines) {
    const prior = before.get(graph.timelineId);
    if (!prior) { changes.push(`Added timeline ${graph.timelineId}`); continue; }
    diff("scene", "sceneId", prior.scenes, graph.scenes, graph.timelineId);
    diff("track", "trackId", prior.tracks, graph.tracks, graph.timelineId);
    diff("clip", "clipId", prior.clips as never, graph.clips as never, graph.timelineId);
  }
  const after = new Set(head.timelines.map((item) => item.graph.timelineId));
  for (const id of [...before.keys()].sort()) if (!after.has(id)) changes.push(`Removed timeline ${id}`);
  return changes;
}

function toDraft(entry: OfflineEditReviewEntry<TimelineDraftPayload>): TimelineDraft {
  const { edit, state } = entry;
  return {
    editId: edit.editId, requestId: edit.payload.requestId, timelineId: edit.payload.timelineId,
    edits: edit.payload.edits, baseRevisionId: edit.expectedVersion, capturedAt: edit.payload.capturedAt, state,
  };
}
