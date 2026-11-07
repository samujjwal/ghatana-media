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
  public constructor(public readonly code: "CRYPTO_UNAVAILABLE" | "QUEUE_FULL" | "PAYLOAD_TOO_LARGE" | "INVALID_EDIT" | "STORE_SCOPE_MISMATCH" | "STORE_CAS_UNAVAILABLE" | "STORE_RECORD_CHANGED") {
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
  private readonly maximumEntries: number;
  private readonly maximumPayloadBytes: number;
  private readonly cryptoApi: Crypto;

  public constructor(private readonly options: OfflineEditQueueOptions) {
    this.maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    this.maximumPayloadBytes = options.maximumPayloadBytes ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) throw new OfflineEditQueueError("CRYPTO_UNAVAILABLE");
    this.cryptoApi = cryptoApi;
    if (!Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1
      || !Number.isSafeInteger(this.maximumPayloadBytes) || this.maximumPayloadBytes < 1) {
      throw new RangeError("Offline edit queue bounds must be positive safe integers.");
    }
    if (options.encryptionKey.algorithm.name !== "AES-GCM" || options.encryptionKey.extractable) {
      throw new TypeError("Offline edit queue requires a non-extractable AES-GCM key.");
    }
  }

  public get canReplaySafely(): boolean {
    return typeof this.options.store.compareAndSet === "function";
  }

  public async enqueue<T>(edit: OfflineEdit<T>): Promise<void> {
    assertEdit(edit);
    const serialized = serializeJsonPayload(edit.payload, this.maximumPayloadBytes);
    const plaintext = encoder.encode(serialized);
    if (plaintext.byteLength > this.maximumPayloadBytes) throw new OfflineEditQueueError("PAYLOAD_TOO_LARGE");
    const records = await this.listScoped(edit);
    const existing = records.find((record) => record.editId === edit.editId
      || record.idempotencyKey === edit.idempotencyKey);
    if (existing) {
      if (existing.editId !== edit.editId || existing.idempotencyKey !== edit.idempotencyKey
        || existing.expectedVersion !== edit.expectedVersion
        || !equalBytes(await this.decryptPayloadBytes(existing), plaintext)) {
        throw new OfflineEditQueueError("INVALID_EDIT");
      }
      return; // exact duplicate is suppressed, including terminal/unknown entries.
    }
    if (records.length >= this.maximumEntries) throw new OfflineEditQueueError("QUEUE_FULL");
    const record = await this.encrypt(edit, plaintext, "PENDING");
    if (!await this.options.store.insert(record, this.maximumEntries)) {
      const afterInsertRace = await this.listScoped(edit);
      const raced = afterInsertRace.find((item) => item.editId === edit.editId
        || item.idempotencyKey === edit.idempotencyKey);
      if (!raced && afterInsertRace.length >= this.maximumEntries) throw new OfflineEditQueueError("QUEUE_FULL");
      if (!raced || raced.editId !== edit.editId || raced.idempotencyKey !== edit.idempotencyKey
        || raced.expectedVersion !== edit.expectedVersion
        || !equalBytes(await this.decryptPayloadBytes(raced), plaintext)) throw new OfflineEditQueueError("INVALID_EDIT");
    }
  }

  /** Explicitly rebase a conflict with a new exact version and idempotency key. */
  public async resolveConflict<T>(edit: OfflineEdit<T>): Promise<void> {
    assertEdit(edit);
    const compareAndSet = this.options.store.compareAndSet;
    if (!compareAndSet) throw new OfflineEditQueueError("STORE_CAS_UNAVAILABLE");
    const previous = (await this.listScoped(edit)).find((record) => record.editId === edit.editId);
    if (previous?.state !== "CONFLICT" || previous.idempotencyKey === edit.idempotencyKey
      || previous.expectedVersion === edit.expectedVersion) {
      throw new Error("Conflict resolution requires a conflicted edit, new version and new idempotency key.");
    }
    if ((await this.listScoped(edit)).some((record) => record.editId !== edit.editId
      && record.idempotencyKey === edit.idempotencyKey)) throw new OfflineEditQueueError("INVALID_EDIT");
    const serialized = serializeJsonPayload(edit.payload, this.maximumPayloadBytes);
    const plaintext = encoder.encode(serialized);
    if (plaintext.byteLength > this.maximumPayloadBytes) throw new OfflineEditQueueError("PAYLOAD_TOO_LARGE");
    const replacement = await this.encrypt(edit, plaintext, "PENDING");
    if (!await compareAndSet.call(this.options.store, previous, replacement)) {
      throw new OfflineEditQueueError("INVALID_EDIT");
    }
  }

  public async hasDirtyEdits(scope: OfflineEditScope): Promise<boolean> {
    assertScope(scope);
    return (await this.listScoped(scope)).some((record) => record.state !== "APPLIED");
  }

  /** Restore exact queued edits after restart for a scoped local editor. */
  public async readEdits<T = unknown>(scope: OfflineEditScope): Promise<readonly {
    readonly edit: OfflineEdit<T>;
    readonly state: OfflineEditState;
  }[]> {
    assertScope(scope);
    const records = await this.listScoped(scope);
    return Promise.all(records.map(async (record) => ({ edit: await this.decrypt<T>(record), state: record.state })));
  }

  public async replay<T, R>(scope: OfflineEditScope, adapter: OfflineEditReplayAdapter<T, R>): Promise<readonly {
    readonly editId: string;
    readonly state: OfflineEditReplayState;
    readonly receipt?: R;
  }[]> {
    assertScope(scope);
    const records = await this.listScoped(scope);
    if (!this.canReplaySafely) {
      return records.filter((record) => record.state === "PENDING")
        .map((record) => ({ editId: record.editId, state: "STORE_CAS_UNAVAILABLE" as const }));
    }
    const results: { editId: string; state: OfflineEditReplayState; receipt?: R }[] = [];
    for (const record of records) {
      if (record.state !== "PENDING") continue; // unknown, revoked, conflicts are never auto-replayed.
      const edit = freezeEdit(await this.decrypt<T>(record));
      let versionRead: Awaited<ReturnType<typeof adapter.readCurrentVersion>>;
      try {
        versionRead = await adapter.readCurrentVersion(scope);
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
      if (typeof currentVersion !== "string" || !currentVersion.trim()) {
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
        authorization = await adapter.reauthorize(edit);
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
        dispatchAuthorization = await adapter.reauthorize(edit);
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
        if (!outcome || (outcome.outcome !== "APPLIED" && outcome.outcome !== "CONFLICT"
          && outcome.outcome !== "OUTCOME_UNKNOWN")) {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        if (outcome.outcome === "APPLIED" && !validReceipt(outcome.receipt)) {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        if (outcome.outcome === "OUTCOME_UNKNOWN") {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        const confirmed = await this.transition(dispatchIntent, outcome.outcome);
        if (!confirmed) {
          results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
          continue;
        }
        results.push({ editId: record.editId, state: outcome.outcome,
          ...(outcome.outcome === "APPLIED" ? { receipt: outcome.receipt } : {}) });
      } catch {
        results.push({ editId: record.editId, state: "OUTCOME_UNKNOWN" });
      }
    }
    return results;
  }

  /** Remove only after an authoritative reconciliation proves no effect occurred. */
  public async discardUnknown(scope: OfflineEditScope, editId: string, confirmedNotApplied: boolean): Promise<void> {
    assertScope(scope);
    if (!confirmedNotApplied) throw new Error("OUTCOME_UNKNOWN requires authoritative no-effect reconciliation.");
    if (!this.options.store.removeIfMatches) throw new OfflineEditQueueError("STORE_CAS_UNAVAILABLE");
    const record = (await this.listScoped(scope)).find((candidate) => candidate.editId === editId);
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
    const plaintext = await this.cryptoApi.subtle.decrypt(
      { name: "AES-GCM", iv: this.copyBufferSource(record.nonce), additionalData: this.aad(record) },
      this.options.encryptionKey,
      this.copyBufferSource(record.ciphertext),
    );
    return new Uint8Array(plaintext);
  }

  private async transition(record: OfflineEditRecord, state: OfflineEditState): Promise<OfflineEditRecord | undefined> {
    const replacement = { ...record, state };
    try {
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
    const records = await this.options.store.list(scope);
    if (records.some((record) => record.tenantId !== scope.tenantId || record.projectId !== scope.projectId)) {
      throw new OfflineEditQueueError("STORE_SCOPE_MISMATCH");
    }
    if (records.some((record) => !isValidAadIdentity(record.tenantId) || !isValidAadIdentity(record.projectId)
      || !isValidAadIdentity(record.editId) || !isValidAadIdentity(record.idempotencyKey)
      || !isValidAadIdentity(record.expectedVersion))) {
      throw new OfflineEditQueueError("STORE_SCOPE_MISMATCH");
    }
    return records;
  }

  private async encrypt(edit: OfflineEdit, plaintext: Uint8Array, state: OfflineEditState): Promise<OfflineEditRecord> {
    const nonce = new Uint8Array(12);
    this.cryptoApi.getRandomValues(nonce);
    const ciphertext = new Uint8Array(await this.cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv: this.copyBufferSource(nonce), additionalData: this.aad(edit) },
      this.options.encryptionKey,
      this.copyBufferSource(plaintext),
    ));
    return { tenantId: edit.tenantId, projectId: edit.projectId, editId: edit.editId,
      idempotencyKey: edit.idempotencyKey, expectedVersion: edit.expectedVersion, nonce, ciphertext,
      payloadBytes: plaintext.byteLength, state };
  }

  private aad(scope: OfflineEditScope & {
    readonly editId?: string;
    readonly expectedVersion?: string;
    readonly idempotencyKey?: string;
  }): ArrayBuffer {
    return this.copyBufferSource(encoder.encode(
      `${scope.tenantId}\u0000${scope.projectId}\u0000${scope.editId ?? ""}\u0000${scope.expectedVersion ?? ""}\u0000${scope.idempotencyKey ?? ""}`,
    ));
  }

  private copyBufferSource(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
}

function validReceipt<R>(receipt: R | undefined): receipt is R {
  if (receipt === undefined || receipt === null) return false;
  return typeof receipt !== "string" || receipt.trim().length > 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
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
