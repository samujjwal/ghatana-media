/**
 * Encrypted, bounded local queue for private project edits. This is a client
 * side store only: replay requires an injected current-rights check, a current
 * project version read, and an effect adapter with explicit finality.
 */

export interface OfflineEditScope {
  readonly tenantId: string;
  readonly projectId: string;
}
export interface OfflineEdit<T = unknown> extends OfflineEditScope {
  readonly editId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: string;
  readonly payload: T;
}

export type OfflineEditState = "PENDING" | "APPLIED" | "CONFLICT" | "REVOKED"
  | "OUTCOME_UNKNOWN";
export type OfflineEditReplayState = OfflineEditState | "AUTHORIZATION_UNKNOWN" | "VERSION_UNKNOWN" | "STORE_CAS_UNAVAILABLE";

export interface OfflineEditRecord extends OfflineEditScope {
  readonly editId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly payloadBytes: number;
  readonly state: OfflineEditState;
  /** Absent on legacy v1 rows; new authenticated envelopes use v2. */
  readonly envelopeVersion?: 2;
}

/** Exact queue readback presented by the host before it asks to replay drafts. */
export interface OfflineEditReviewEntry<T = unknown> {
  readonly edit: OfflineEdit<T>;
  readonly state: OfflineEditState;
}

/** Implementations must store only the supplied ciphertext for edit payloads. */
export interface OfflineEditStore {
  list(scope: OfflineEditScope): Promise<readonly OfflineEditRecord[]>;
  /**
   * Atomically inserts only if editId and idempotencyKey are unused and the
   * exact tenant/project scope has fewer than maximumEntries records. Returns
   * false on either a uniqueness collision or a full scope.
   */
  insert(record: OfflineEditRecord, maximumEntries: number): Promise<boolean>;
  /** Atomically replaces an existing record with the same editId. */
  put(record: OfflineEditRecord): Promise<void>;
  /** Atomically replaces the exact expected row and preserves scoped edit/key uniqueness. */
  compareAndSet?(expected: OfflineEditRecord, replacement: OfflineEditRecord): Promise<boolean>;
  /** Atomically removes the exact expected row, including its ciphertext and state. */
  removeIfMatches?(expected: OfflineEditRecord): Promise<boolean>;
  remove(scope: OfflineEditScope, editId: string): Promise<void>;
}

export interface OfflineEditReplayAdapter<T = unknown, R = unknown> {
  /** Must obtain fresh authorization for this exact edit and current principal. */
  reauthorize(edit: OfflineEdit<T>): Promise<{ readonly authorized: boolean; readonly disposition?: "AUTHORIZED" | "REVOKED" | "UNKNOWN" }>;
  readCurrentVersion(scope: OfflineEditScope): Promise<string | { readonly disposition: "CURRENT"; readonly version: string } | { readonly disposition: "UNKNOWN" }>;
  /** Must send the stored idempotency key and expected version as a CAS. */
  apply(edit: OfflineEdit<T>): Promise<
    | { readonly outcome: "APPLIED"; readonly receipt: R }
    | { readonly outcome: "CONFLICT" }
    | { readonly outcome: "OUTCOME_UNKNOWN" }
  >;
}

export interface OfflineEditQueueOptions {
  readonly store: OfflineEditStore;
  /** Non-extractable AES-GCM key supplied by a host key store; never persisted here. */
  readonly encryptionKey: CryptoKey;
  readonly maximumEntries?: number;
  readonly maximumPayloadBytes?: number;
}

export class OfflineEditQueueError extends Error {
  public constructor(public readonly code: "CRYPTO_UNAVAILABLE" | "QUEUE_FULL" | "PAYLOAD_TOO_LARGE" | "INVALID_EDIT" | "STORE_SCOPE_MISMATCH" | "STORE_CAS_UNAVAILABLE" | "STORE_RECORD_CHANGED" | "STORE_RECORD_INVALID" | "REVIEW_REQUIRED") {
    super(`Offline edit queue failed: ${code}`);
    this.name = "OfflineEditQueueError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_MAXIMUM_ENTRIES = 100;
const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 256 * 1024;
const MAXIMUM_JSON_DEPTH = 100;
const MAXIMUM_JSON_NODES = 100_000;

/** Offline payloads must already be a bounded JSON data tree; serialization never coerces caller values. */
function serializeJsonPayload(payload: unknown, maximumBytes: number): string {
  let nodes = 0;
  let serializedBytes = 0;
  const ancestors = new WeakSet<object>();
  const addBytes = (count: number): void => {
    serializedBytes += count;
    if (serializedBytes > maximumBytes) throw new OfflineEditQueueError("PAYLOAD_TOO_LARGE");
  };
  const addJsonStringBytes = (value: string): void => {
    addBytes(2); // quotes
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
        || code === 0x0a || code === 0x0c || code === 0x0d) {
        addBytes(2);
      } else if (code < 0x20) {
        addBytes(6); // \\u00xx
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          addBytes(4);
          index++;
        } else {
          addBytes(6); // well-formed JSON.stringify escapes lone surrogates
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        addBytes(6);
      } else if (code <= 0x7f) {
        addBytes(1);
      } else if (code <= 0x7ff) {
        addBytes(2);
      } else {
        addBytes(3);
      }
    }
  };
  const snapshot = (value: unknown, depth: number): unknown => {
    if (++nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) throw new OfflineEditQueueError("INVALID_EDIT");
    if (value === null) { addBytes(4); return value; }
    if (typeof value === "string") { addJsonStringBytes(value); return value; }
    if (typeof value === "boolean") { addBytes(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new OfflineEditQueueError("INVALID_EDIT");
      addBytes(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== "object") throw new OfflineEditQueueError("INVALID_EDIT");
    if (ancestors.has(value)) throw new OfflineEditQueueError("INVALID_EDIT");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        if (keys.length > MAXIMUM_JSON_NODES + 1) throw new OfflineEditQueueError("INVALID_EDIT");
        if (keys.some((key) => typeof key === "symbol"
          || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
          throw new OfflineEditQueueError("INVALID_EDIT");
        }
        const result: unknown[] = [];
        addBytes(2); // brackets
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new OfflineEditQueueError("INVALID_EDIT");
          }
          if (index > 0) addBytes(1);
          result.push(snapshot(descriptor.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new OfflineEditQueueError("INVALID_EDIT");
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      addBytes(2); // braces
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAXIMUM_JSON_NODES) throw new OfflineEditQueueError("INVALID_EDIT");
      let propertyIndex = 0;
      for (const key of keys) {
        if (typeof key !== "string") throw new OfflineEditQueueError("INVALID_EDIT");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new OfflineEditQueueError("INVALID_EDIT");
        }
        if (propertyIndex++ > 0) addBytes(1);
        addJsonStringBytes(key);
        addBytes(1); // colon
        Object.defineProperty(result, key, { value: snapshot(descriptor.value, depth + 1), enumerable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    return JSON.stringify(snapshot(payload, 0));
  } catch (error) {
    if (error instanceof OfflineEditQueueError) throw error;
    throw new OfflineEditQueueError("INVALID_EDIT");
  }
}

function assertScope(scope: OfflineEditScope): void {
  if (!isValidAadIdentity(scope.tenantId) || !isValidAadIdentity(scope.projectId)) {
    throw new OfflineEditQueueError("INVALID_EDIT");
  }
}

/** Snapshot exact storage identity before the first asynchronous boundary. */
function snapshotScope(scope: OfflineEditScope): OfflineEditScope {
  const snapshot = {
    tenantId: readOwnDataProperty<string>(scope, "tenantId"),
    projectId: readOwnDataProperty<string>(scope, "projectId"),
  };
  assertScope(snapshot);
  return Object.freeze(snapshot);
}

/** Caller-owned edit identity must not be reread after storage or authority awaits. */
function snapshotEdit<T>(edit: OfflineEdit<T>): OfflineEdit<T> {
  const snapshot = {
    tenantId: readOwnDataProperty<string>(edit, "tenantId"),
    projectId: readOwnDataProperty<string>(edit, "projectId"),
    editId: readOwnDataProperty<string>(edit, "editId"),
    idempotencyKey: readOwnDataProperty<string>(edit, "idempotencyKey"),
    expectedVersion: readOwnDataProperty<string>(edit, "expectedVersion"),
    payload: readOwnDataProperty<T>(edit, "payload"),
  };
  assertEdit(snapshot);
  return Object.freeze(snapshot);
}

function readOwnDataProperty<T>(value: unknown, name: string): T {
  try {
    if (!value || typeof value !== "object") throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError();
    return descriptor.value as T;
  } catch {
    throw new OfflineEditQueueError("INVALID_EDIT");
  }
}

function assertEdit(edit: OfflineEdit): void {
  assertScope(edit);
  if (!isValidAadIdentity(edit.editId) || !isValidAadIdentity(edit.idempotencyKey)
    || !isValidAadIdentity(edit.expectedVersion)) {
    throw new OfflineEditQueueError("INVALID_EDIT");
  }
}

/** NUL is the AAD field separator; reject it inside every field to keep tuples unambiguous. */
function isValidAadIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

export class OfflineEditQueue {
  private readonly options: OfflineEditQueueOptions;
  private readonly maximumEntries: number;
  private readonly maximumPayloadBytes: number;
  private readonly cryptoApi: Crypto;

  public constructor(options: OfflineEditQueueOptions) {
    // Pin the host-selected store and key. A caller-owned mutable options
    // object must not redirect a durable replay fence between store operations.
    const pinnedOptions = Object.freeze({ ...options });
    this.options = pinnedOptions;
    this.maximumEntries = pinnedOptions.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    this.maximumPayloadBytes = pinnedOptions.maximumPayloadBytes ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) throw new OfflineEditQueueError("CRYPTO_UNAVAILABLE");
    this.cryptoApi = cryptoApi;
    if (!Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1
      || !Number.isSafeInteger(this.maximumPayloadBytes) || this.maximumPayloadBytes < 1) {
      throw new RangeError("Offline edit queue bounds must be positive safe integers.");
    }
    if (pinnedOptions.encryptionKey.algorithm.name !== "AES-GCM" || pinnedOptions.encryptionKey.extractable) {
      throw new TypeError("Offline edit queue requires a non-extractable AES-GCM key.");
    }
  }

  public get canReplaySafely(): boolean {
    return typeof this.options.store.compareAndSet === "function";
  }

  public async enqueue<T>(edit: OfflineEdit<T>): Promise<void> {
    const stableEdit = snapshotEdit(edit);
    const serialized = serializeJsonPayload(stableEdit.payload, this.maximumPayloadBytes);
    const plaintext = encoder.encode(serialized);
    if (plaintext.byteLength > this.maximumPayloadBytes) throw new OfflineEditQueueError("PAYLOAD_TOO_LARGE");
    const records = await this.listScoped(stableEdit);
    const existing = records.find((record) => record.editId === stableEdit.editId
      || record.idempotencyKey === stableEdit.idempotencyKey);
    if (existing) {
      if (existing.editId !== stableEdit.editId || existing.idempotencyKey !== stableEdit.idempotencyKey
        || existing.expectedVersion !== stableEdit.expectedVersion
        || !equalBytes(await this.decryptPayloadBytes(existing), plaintext)) {
        throw new OfflineEditQueueError("INVALID_EDIT");
      }
      return; // exact duplicate is suppressed, including terminal/unknown entries.
    }
    if (records.length >= this.maximumEntries) throw new OfflineEditQueueError("QUEUE_FULL");
    const record = await this.encrypt(stableEdit, plaintext, "PENDING");
    if (!await this.options.store.insert(record, this.maximumEntries)) {
      const afterInsertRace = await this.listScoped(stableEdit);
      const raced = afterInsertRace.find((item) => item.editId === stableEdit.editId
        || item.idempotencyKey === stableEdit.idempotencyKey);
      if (!raced && afterInsertRace.length >= this.maximumEntries) throw new OfflineEditQueueError("QUEUE_FULL");
      if (!raced || raced.editId !== stableEdit.editId || raced.idempotencyKey !== stableEdit.idempotencyKey
        || raced.expectedVersion !== stableEdit.expectedVersion
        || !equalBytes(await this.decryptPayloadBytes(raced), plaintext)) throw new OfflineEditQueueError("INVALID_EDIT");
    }
  }

  /** Explicitly rebase a conflict with a new exact version and idempotency key. */
  public async resolveConflict<T>(edit: OfflineEdit<T>): Promise<void> {
    const stableEdit = snapshotEdit(edit);
    const serialized = serializeJsonPayload(stableEdit.payload, this.maximumPayloadBytes);
    const plaintext = encoder.encode(serialized);
    if (plaintext.byteLength > this.maximumPayloadBytes) throw new OfflineEditQueueError("PAYLOAD_TOO_LARGE");
    const compareAndSet = this.options.store.compareAndSet;
    if (!compareAndSet) throw new OfflineEditQueueError("STORE_CAS_UNAVAILABLE");
    const previous = (await this.listScoped(stableEdit)).find((record) => record.editId === stableEdit.editId);
    if (previous?.envelopeVersion !== 2 || previous.state !== "CONFLICT"
      || previous.idempotencyKey === stableEdit.idempotencyKey
      || previous.expectedVersion === stableEdit.expectedVersion) {
      throw new Error("Conflict resolution requires a conflicted edit, new version and new idempotency key.");
    }
    if ((await this.listScoped(stableEdit)).some((record) => record.editId !== stableEdit.editId
      && record.idempotencyKey === stableEdit.idempotencyKey)) throw new OfflineEditQueueError("INVALID_EDIT");
    const replacement = await this.encrypt(stableEdit, plaintext, "PENDING");
    if (!await compareAndSet.call(this.options.store, previous, replacement)) {
      throw new OfflineEditQueueError("INVALID_EDIT");
    }
  }

  public async hasDirtyEdits(scope: OfflineEditScope): Promise<boolean> {
    return (await this.listScoped(scope)).some((record) => record.envelopeVersion !== 2 || record.state !== "APPLIED");
  }

  /** Restore exact queued edits after restart for a scoped local editor. */
  public async readEdits<T = unknown>(scope: OfflineEditScope): Promise<readonly OfflineEditReviewEntry<T>[]> {
    const records = await this.listScoped(scope);
    return Promise.all(records.map(async (record) => ({ edit: freezeEdit(await this.decrypt<T>(record)),
      state: record.envelopeVersion === 2 ? record.state : "OUTCOME_UNKNOWN" as const })));
  }

  public async replay<T, R>(scope: OfflineEditScope, adapter: OfflineEditReplayAdapter<T, R>,
      reviewedQueue?: readonly OfflineEditReviewEntry<T>[]): Promise<readonly {
    readonly editId: string;
    readonly state: OfflineEditReplayState;
    readonly receipt?: R;
  }[]> {
    const stableScope = snapshotScope(scope);
    const records = await this.listScoped(stableScope);
    await this.assertReviewedQueue(records, reviewedQueue);
    if (!this.canReplaySafely) {
      return records.filter((record) => record.state === "PENDING")
        .map((record) => ({ editId: record.editId, state: "STORE_CAS_UNAVAILABLE" as const }));
    }
    const results: { editId: string; state: OfflineEditReplayState; receipt?: R }[] = [];
    for (const record of records) {
      if (record.envelopeVersion !== 2) {
        // Legacy v1 authenticated edit identity but not replay state. Fence and
        // upgrade before any authorization/version reads or external effects.
        const migrated = await this.transition(record, "OUTCOME_UNKNOWN");
        results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
        if (!migrated) continue;
        continue;
      }
      if (record.state !== "PENDING") continue; // unknown, revoked, conflicts are never auto-replayed.
      const edit = freezeEdit(await this.decrypt<T>(record));
      // Establish current access to the exact tenant/project before asking
      // the host for its canonical revision. Version lookup is scoped data
      // access and must not disclose project state when access is denied.
      let lookupAuthorization: Awaited<ReturnType<typeof adapter.reauthorize>>;
      try {
        const read = await adapter.reauthorize(edit);
        if (!read || typeof read !== "object") {
          results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
          continue;
        }
        const authorized = read.authorized;
        const disposition = read.disposition;
        lookupAuthorization = { authorized, disposition };
      } catch {
        results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
        continue;
      }
      if (typeof lookupAuthorization.authorized !== "boolean"
        || (lookupAuthorization.disposition !== undefined
          && lookupAuthorization.disposition !== "AUTHORIZED" && lookupAuthorization.disposition !== "REVOKED"
          && lookupAuthorization.disposition !== "UNKNOWN")
        || (lookupAuthorization.authorized && lookupAuthorization.disposition === "REVOKED")
        || (!lookupAuthorization.authorized && lookupAuthorization.disposition === "AUTHORIZED")
        || lookupAuthorization.disposition === "UNKNOWN") {
        results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
        continue;
      }
      if (!lookupAuthorization.authorized || lookupAuthorization.disposition === "REVOKED") {
        const transitioned = await this.transition(record, "REVOKED");
        results.push({ editId: record.editId, state: transitioned ? "REVOKED" : "OUTCOME_UNKNOWN" });
        continue;
      }
      let versionRead: Awaited<ReturnType<typeof adapter.readCurrentVersion>>;
      try {
        versionRead = await adapter.readCurrentVersion(stableScope);
      } catch {
        // A failed read is pre-dispatch. Preserve PENDING and retry only the
        // authorization/version checks on the next explicit reconnect.
        results.push({ editId: record.editId, state: "VERSION_UNKNOWN" });
        continue;
      }
      if (typeof versionRead !== "string" && (!versionRead || typeof versionRead !== "object"
        || (versionRead.disposition !== "CURRENT" && versionRead.disposition !== "UNKNOWN"))) {
        results.push({ editId: record.editId, state: "VERSION_UNKNOWN" });
        continue;
      }
      if (typeof versionRead !== "string" && versionRead.disposition === "UNKNOWN") {
        results.push({ editId: record.editId, state: "VERSION_UNKNOWN" });
        continue;
      }
      const currentVersion = typeof versionRead === "string" ? versionRead : versionRead.version;
      // A version read is an identity observation, not user-facing text. Do
      // not normalize malformed values into either a match or a stale-version
      // conflict; preserve the edit as retryable until an exact readback exists.
      if (typeof currentVersion !== "string" || !isValidAadIdentity(currentVersion)) {
        results.push({ editId: record.editId, state: "VERSION_UNKNOWN" });
        continue;
      }
      if (currentVersion !== record.expectedVersion) {
        const transitioned = await this.transition(record, "CONFLICT");
        results.push({ editId: record.editId, state: transitioned ? "CONFLICT" : "OUTCOME_UNKNOWN" });
        continue;
      }
      // Check rights after read-only version preflight, immediately before the
      // effect dispatch. A revoke observed during preflight cannot be replayed.
      let authorization: Awaited<ReturnType<typeof adapter.reauthorize>>;
      try {
        const read = await adapter.reauthorize(edit);
        if (!read || typeof read !== "object") {
          results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
          continue;
        }
        // Snapshot adapter fields once. A changing accessor must not validate
        // one authorization observation and then authorize dispatch with another.
        const authorized = read.authorized;
        const disposition = read.disposition;
        authorization = { authorized, disposition };
      } catch {
        results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
        continue;
      }
      if (!authorization || typeof authorization.authorized !== "boolean"
        || (authorization.disposition !== undefined
          && authorization.disposition !== "AUTHORIZED" && authorization.disposition !== "REVOKED"
          && authorization.disposition !== "UNKNOWN")
        || (authorization.authorized && authorization.disposition === "REVOKED")
        || (!authorization.authorized && authorization.disposition === "AUTHORIZED")) {
        results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
        continue;
      }
      if (authorization.disposition === "UNKNOWN") {
        results.push({ editId: record.editId, state: "AUTHORIZATION_UNKNOWN" });
        continue;
      }
      if (!authorization.authorized || authorization.disposition === "REVOKED") {
        const transitioned = await this.transition(record, "REVOKED");
        results.push({ editId: record.editId, state: transitioned ? "REVOKED" : "OUTCOME_UNKNOWN" });
        continue;
      }
      // Persist unknown state before crossing the external boundary. A crash
      // after this CAS cannot leave a PENDING edit available for blind replay.
      const dispatchIntent = await this.transition(record, "OUTCOME_UNKNOWN");
      if (!dispatchIntent) {
        results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
        continue;
      }
      // The durable barrier can take time (for example, a cross-tab IndexedDB
      // transaction). Refresh authorization after it so a revocation observed
      // during that write cannot cross the provider boundary. The canonical
      // operation must still enforce its own atomic authorization policy.
      let dispatchAuthorization: Awaited<ReturnType<typeof adapter.reauthorize>>;
      try {
        const read = await adapter.reauthorize(edit);
        if (!read || typeof read !== "object") {
          const reset = await this.transition(dispatchIntent, "PENDING");
          results.push({ editId: record.editId, state: reset ? "AUTHORIZATION_UNKNOWN" : "OUTCOME_UNKNOWN" });
          continue;
        }
        // Apply the same single-observation rule after the durable dispatch fence.
        const authorized = read.authorized;
        const disposition = read.disposition;
        dispatchAuthorization = { authorized, disposition };
      } catch {
        const reset = await this.transition(dispatchIntent, "PENDING");
        results.push({ editId: record.editId, state: reset ? "AUTHORIZATION_UNKNOWN" : "OUTCOME_UNKNOWN" });
        continue;
      }
      if (!dispatchAuthorization || typeof dispatchAuthorization.authorized !== "boolean"
        || (dispatchAuthorization.disposition !== undefined
          && dispatchAuthorization.disposition !== "AUTHORIZED" && dispatchAuthorization.disposition !== "REVOKED"
          && dispatchAuthorization.disposition !== "UNKNOWN")
        || (dispatchAuthorization.authorized && dispatchAuthorization.disposition === "REVOKED")
        || (!dispatchAuthorization.authorized && dispatchAuthorization.disposition === "AUTHORIZED")) {
        const reset = await this.transition(dispatchIntent, "PENDING");
        results.push({ editId: record.editId, state: reset ? "AUTHORIZATION_UNKNOWN" : "OUTCOME_UNKNOWN" });
        continue;
      }
      if (dispatchAuthorization.disposition === "UNKNOWN") {
        const reset = await this.transition(dispatchIntent, "PENDING");
        results.push({ editId: record.editId, state: reset ? "AUTHORIZATION_UNKNOWN" : "OUTCOME_UNKNOWN" });
        continue;
      }
      if (!dispatchAuthorization.authorized || dispatchAuthorization.disposition === "REVOKED") {
        const revoked = await this.transition(dispatchIntent, "REVOKED");
        results.push({ editId: record.editId, state: revoked ? "REVOKED" : "OUTCOME_UNKNOWN" });
        continue;
      }
      // A thrown or malformed result is ambiguous after dispatch; leave the
      // durable record OUTCOME_UNKNOWN until an owner readback resolves it.
      try {
        const outcome = await adapter.apply(edit);
        if (!outcome || typeof outcome !== "object") {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        // Treat adapter results as untrusted readbacks. Snapshot accessor-backed
        // fields once so validation, durable state and caller result use the
        // same observation even if a getter changes on later reads.
        const observedOutcome = outcome.outcome;
        const observedReceipt = observedOutcome === "APPLIED" ? outcome.receipt : undefined;
        if (observedOutcome !== "APPLIED" && observedOutcome !== "CONFLICT"
          && observedOutcome !== "OUTCOME_UNKNOWN") {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        if (observedOutcome === "APPLIED" && !validReceipt(observedReceipt)) {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        if (observedOutcome === "OUTCOME_UNKNOWN") {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        const confirmed = await this.transition(dispatchIntent, observedOutcome);
        if (!confirmed) {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        results.push({ editId: record.editId, state: observedOutcome,
          ...(observedOutcome === "APPLIED" ? { receipt: observedReceipt as R } : {}) });
      } catch {
        results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
      }
    }
    return results;
  }

  /** Fail closed if the queue changed after the host presented its exact readback for review. */
  private async assertReviewedQueue<T>(records: readonly OfflineEditRecord[],
      reviewedQueue?: readonly OfflineEditReviewEntry<T>[]): Promise<void> {
    const hasDirtyRecords = records.some((record) => record.envelopeVersion !== 2 || record.state !== "APPLIED");
    if (reviewedQueue === undefined) {
      if (hasDirtyRecords) throw new OfflineEditQueueError("REVIEW_REQUIRED");
      return;
    }
    if (!Array.isArray(reviewedQueue) || reviewedQueue.length > this.maximumEntries
      || reviewedQueue.length !== records.length) {
      throw new OfflineEditQueueError("REVIEW_REQUIRED");
    }
    const reviewedById = new Map<string, OfflineEditReviewEntry<T>>();
    try {
      for (let index = 0; index < reviewedQueue.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(reviewedQueue, String(index));
        if (!descriptor || !("value" in descriptor)) throw new OfflineEditQueueError("REVIEW_REQUIRED");
        const entry = descriptor.value as OfflineEditReviewEntry<T>;
        const edit = reviewDataProperty<OfflineEdit<T>>(entry, "edit");
        const editId = reviewDataProperty<string>(edit, "editId");
        reviewDataProperty<string>(edit, "tenantId");
        reviewDataProperty<string>(edit, "projectId");
        reviewDataProperty<string>(edit, "idempotencyKey");
        reviewDataProperty<string>(edit, "expectedVersion");
        const state = reviewDataProperty<OfflineEditState>(entry, "state");
        if (!editId || reviewedById.has(editId)) throw new OfflineEditQueueError("REVIEW_REQUIRED");
        reviewedById.set(editId, { edit, state });
      }
    } catch {
      throw new OfflineEditQueueError("REVIEW_REQUIRED");
    }
    for (const record of records) {
      const reviewed = reviewedById.get(record.editId);
      const expectedState = record.envelopeVersion === 2 ? record.state : "OUTCOME_UNKNOWN";
      if (!reviewed || reviewed.state !== expectedState
        || reviewDataProperty<string>(reviewed.edit, "tenantId") !== record.tenantId
        || reviewDataProperty<string>(reviewed.edit, "projectId") !== record.projectId
        || reviewDataProperty<string>(reviewed.edit, "idempotencyKey") !== record.idempotencyKey
        || reviewDataProperty<string>(reviewed.edit, "expectedVersion") !== record.expectedVersion) {
        throw new OfflineEditQueueError("REVIEW_REQUIRED");
      }
      let reviewedPayload: Uint8Array;
      try {
        const payload = reviewDataProperty<unknown>(reviewed.edit, "payload");
        reviewedPayload = encoder.encode(serializeJsonPayload(payload, this.maximumPayloadBytes));
      } catch {
        throw new OfflineEditQueueError("REVIEW_REQUIRED");
      }
      if (!equalBytes(await this.decryptPayloadBytes(record), reviewedPayload)) {
        throw new OfflineEditQueueError("REVIEW_REQUIRED");
      }
    }
  }

  /** Remove only after an authoritative reconciliation proves no effect occurred. */
  public async discardUnknown(scope: OfflineEditScope, editId: string, confirmedNotApplied: boolean): Promise<void> {
    const stableScope = snapshotScope(scope);
    if (!confirmedNotApplied) throw new Error("OUTCOME_UNKNOWN requires authoritative no-effect reconciliation.");
    if (!this.options.store.removeIfMatches) throw new OfflineEditQueueError("STORE_CAS_UNAVAILABLE");
    const record = (await this.listScoped(stableScope)).find((candidate) => candidate.editId === editId);
    if (record && record.envelopeVersion !== 2) {
      await this.transition(record, "OUTCOME_UNKNOWN");
      throw new Error("Legacy edit fenced; reconcile its outcome again before discard.");
    }
    if (record?.state !== "OUTCOME_UNKNOWN") throw new Error("The edit is not awaiting unknown-outcome reconciliation.");
    if (!await this.options.store.removeIfMatches(record)) throw new OfflineEditQueueError("STORE_RECORD_CHANGED");
  }

  private async decrypt<T>(record: OfflineEditRecord): Promise<OfflineEdit<T>> {
    const plaintext = await this.decryptPayloadBytes(record);
    // Keep the storage envelope private to the queue. In particular, replay
    // adapters should receive the edit contract only, never IndexedDB fields
    // such as ciphertext, nonce, state or byte-accounting metadata.
    return {
      tenantId: record.tenantId,
      projectId: record.projectId,
      editId: record.editId,
      idempotencyKey: record.idempotencyKey,
      expectedVersion: record.expectedVersion,
      payload: JSON.parse(decoder.decode(plaintext)) as T,
    };
  }

  private async decryptPayloadBytes(record: OfflineEditRecord): Promise<Uint8Array> {
    if (!(record.nonce instanceof Uint8Array) || !(record.ciphertext instanceof Uint8Array)
      || !isOfflineEditState(record.state)
      || !Number.isSafeInteger(record.payloadBytes) || record.payloadBytes < 0
      || record.payloadBytes > this.maximumPayloadBytes
      // AES-GCM records are written with a 96-bit nonce and the default
      // 128-bit authentication tag, so ciphertext is exactly plaintext + 16.
      // Validate lengths before WebCrypto allocates/decrypts attacker-sized rows.
      || record.nonce.byteLength !== 12
      || record.ciphertext.byteLength !== record.payloadBytes + 16) {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await this.cryptoApi.subtle.decrypt(
        { name: "AES-GCM", iv: this.copyBufferSource(record.nonce), additionalData: this.aad(record) },
        this.options.encryptionKey,
        this.copyBufferSource(record.ciphertext),
      );
    } catch {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    const bytes = new Uint8Array(plaintext);
    if (bytes.byteLength !== record.payloadBytes || bytes.byteLength > this.maximumPayloadBytes) {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    return bytes;
  }

  private async transition(record: OfflineEditRecord, state: OfflineEditState): Promise<OfflineEditRecord | undefined> {
    // Replay state controls whether an external effect may be dispatched, so
    // authenticate it with the payload. Re-encrypt on every state transition
    // with a fresh nonce before attempting the store CAS.
    let replacement: OfflineEditRecord;
    try {
      const plaintext = await this.decryptPayloadBytes(record);
      replacement = await this.encrypt({ ...record, payload: undefined }, plaintext, state);
      return this.options.store.compareAndSet && await this.options.store.compareAndSet(record, replacement)
        ? replacement : undefined;
    } catch {
      // A store exception is an indeterminate CAS result: it may have failed
      // before or after committing. Treat it like a conflict so replay never
      // crosses the effect boundary without a confirmed durable fence.
      return undefined;
    }
  }

  private async listScoped(scope: OfflineEditScope): Promise<readonly OfflineEditRecord[]> {
    const stableScope = snapshotScope(scope);
    const storedRecords = await this.options.store.list(stableScope);
    // Store adapters may return live objects (unlike IndexedDB's structured
    // clone). Detach the readback before any later await so the exact row used
    // as a CAS expectation cannot be changed through an adapter-owned alias.
    const records = storedRecords.map(snapshotRecord);
    if (records.some((record) => record.tenantId !== stableScope.tenantId || record.projectId !== stableScope.projectId)) {
      throw new OfflineEditQueueError("STORE_SCOPE_MISMATCH");
    }
    if (records.some((record) => !isValidAadIdentity(record.tenantId) || !isValidAadIdentity(record.projectId)
      || !isValidAadIdentity(record.editId) || !isValidAadIdentity(record.idempotencyKey)
      || !isValidAadIdentity(record.expectedVersion)
      || (record.envelopeVersion !== undefined && record.envelopeVersion !== 2)
      || !isOfflineEditState(record.state))) {
      throw new OfflineEditQueueError("STORE_SCOPE_MISMATCH");
    }
    return records;
  }

  private async encrypt(edit: OfflineEdit, plaintext: Uint8Array, state: OfflineEditState): Promise<OfflineEditRecord> {
    const nonce = new Uint8Array(12);
    this.cryptoApi.getRandomValues(nonce);
    const ciphertext = new Uint8Array(await this.cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv: this.copyBufferSource(nonce), additionalData: this.aad({ ...edit, state, envelopeVersion: 2 }) },
      this.options.encryptionKey,
      this.copyBufferSource(plaintext),
    ));
    return { tenantId: edit.tenantId, projectId: edit.projectId, editId: edit.editId,
      idempotencyKey: edit.idempotencyKey, expectedVersion: edit.expectedVersion, nonce, ciphertext,
      payloadBytes: plaintext.byteLength, state, envelopeVersion: 2 };
  }

  private aad(scope: OfflineEditScope & {
    readonly editId?: string;
    readonly expectedVersion?: string;
    readonly idempotencyKey?: string;
    readonly state?: OfflineEditState;
    readonly envelopeVersion?: 2;
  }): ArrayBuffer {
    const base = `${scope.tenantId}\u0000${scope.projectId}\u0000${scope.editId ?? ""}\u0000${scope.expectedVersion ?? ""}\u0000${scope.idempotencyKey ?? ""}`;
    return this.copyBufferSource(encoder.encode(scope.envelopeVersion === 2
      ? `${base}\u0000${scope.state ?? ""}` : base));
  }

  private copyBufferSource(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
}

function snapshotRecord(record: OfflineEditRecord): OfflineEditRecord {
  const read = <T>(name: string): T => {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    return descriptor.value as T;
  };
  try {
    const nonce = read<Uint8Array>("nonce");
    const ciphertext = read<Uint8Array>("ciphertext");
    if (!(nonce instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    const envelopeVersion = Object.getOwnPropertyDescriptor(record, "envelopeVersion");
    if (envelopeVersion && (!envelopeVersion.enumerable || !("value" in envelopeVersion))) {
      throw new OfflineEditQueueError("STORE_RECORD_INVALID");
    }
    return {
      tenantId: read("tenantId"), projectId: read("projectId"), editId: read("editId"),
      idempotencyKey: read("idempotencyKey"), expectedVersion: read("expectedVersion"),
      nonce: new Uint8Array(nonce), ciphertext: new Uint8Array(ciphertext),
      payloadBytes: read("payloadBytes"), state: read("state"),
      ...(envelopeVersion ? { envelopeVersion: envelopeVersion.value as 2 } : {}),
    };
  } catch (error) {
    if (error instanceof OfflineEditQueueError) throw error;
    throw new OfflineEditQueueError("STORE_RECORD_INVALID");
  }
}

function isOfflineEditState(value: unknown): value is OfflineEditState {
  return value === "PENDING" || value === "APPLIED" || value === "CONFLICT"
    || value === "REVOKED" || value === "OUTCOME_UNKNOWN";
}

function validReceipt<R>(receipt: R | undefined): receipt is R {
  if (receipt === undefined || receipt === null) return false;
  return typeof receipt !== "string" || receipt.trim().length > 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function reviewDataProperty<T>(value: unknown, name: string): T {
  if (!value || typeof value !== "object") throw new TypeError("Review snapshot must contain plain data objects.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Review snapshot must contain plain data objects.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("Review snapshot must contain own data properties.");
  }
  return descriptor.value as T;
}

/** Keep injected adapters from changing the decrypted, persisted edit between checks and dispatch. */
function freezeEdit<T>(edit: OfflineEdit<T>): OfflineEdit<T> {
  const freezeValue = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  };
  freezeValue(edit.payload);
  return Object.freeze(edit);
}
