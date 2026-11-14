/**
 * Browser-held offline draft key custody.
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
 */

export interface OfflineDraftKeyScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly projectId: string;
}

export type OfflineDraftKeyCustodyErrorCode =
  | "CRYPTO_UNAVAILABLE" | "INDEXEDDB_UNAVAILABLE" | "INVALID_SCOPE" | "KEY_SCOPE_MISMATCH"
  | "KEY_INVALID" | "STORE_FAILED";

export class OfflineDraftKeyCustodyError extends Error {
  public constructor(public readonly code: OfflineDraftKeyCustodyErrorCode) {
    super(`Offline draft key custody failed: ${code}`);
    this.name = "OfflineDraftKeyCustodyError";
  }
}

export interface OfflineDraftKeyCustodyOptions {
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
  readonly databaseName?: string;
}

interface StoredKey {
  readonly keyId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly key: CryptoKey;
}

const STORE = "keys";
const DEFAULT_DATABASE = "ghatana-media-offline-draft-keys-v1";

export function assertOfflineDraftKeyScope(scope: OfflineDraftKeyScope): void {
  for (const value of [scope?.tenantId, scope?.principalId, scope?.projectId]) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\u0000")) {
      throw new OfflineDraftKeyCustodyError("INVALID_SCOPE");
    }
  }
}

/** Collision-free scope identity (length-prefixed, so field boundaries cannot be forged). */
export function offlineDraftKeyId(scope: OfflineDraftKeyScope): string {
  assertOfflineDraftKeyScope(scope);
  return [scope.tenantId, scope.principalId, scope.projectId].map((part) => `${part.length}:${part}`).join("|");
}

/**
 * Stores one non-extractable AES-GCM key per exact (tenant, principal, project).
 * The key is generated here, persisted only as a CryptoKey object (structured
 * clone), and never exported, wrapped, or derived from any credential.
 */
export class OfflineDraftKeyCustody {
  private readonly factory: IDBFactory;
  private readonly cryptoApi: Crypto;
  private readonly databaseName: string;
  private databasePromise?: Promise<IDBDatabase>;

  public constructor(options: OfflineDraftKeyCustodyOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new OfflineDraftKeyCustodyError("INDEXEDDB_UNAVAILABLE");
    const cryptoApi = options.crypto ?? globalThis.crypto;
    if (!cryptoApi?.subtle) throw new OfflineDraftKeyCustodyError("CRYPTO_UNAVAILABLE");
    this.factory = factory;
    this.cryptoApi = cryptoApi;
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE;
  }

  /** Returns the scope's existing key or generates one. A stored key whose scope differs is refused. */
  public async getOrCreate(scope: OfflineDraftKeyScope): Promise<CryptoKey> {
    const keyId = offlineDraftKeyId(scope);
    const existing = await this.read(keyId);
    if (existing) return this.validated(existing, scope, keyId);
    const key = await this.cryptoApi.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const record: StoredKey = { keyId, tenantId: scope.tenantId, principalId: scope.principalId, projectId: scope.projectId, key };
    // add() (not put) so a concurrent tab that won the race keeps its key.
    if (!await this.add(record)) {
      const winner = await this.read(keyId);
      if (!winner) throw new OfflineDraftKeyCustodyError("STORE_FAILED");
      return this.validated(winner, scope, keyId);
    }
    return key;
  }

  /** Returns an existing key only; never creates one. */
  public async get(scope: OfflineDraftKeyScope): Promise<CryptoKey | undefined> {
    const keyId = offlineDraftKeyId(scope);
    const existing = await this.read(keyId);
    return existing ? this.validated(existing, scope, keyId) : undefined;
  }

  /** Destroys the key, making every draft encrypted with it permanently unreadable. */
  public async destroy(scope: OfflineDraftKeyScope): Promise<void> {
    const keyId = offlineDraftKeyId(scope);
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(keyId);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new OfflineDraftKeyCustodyError("STORE_FAILED"));
    });
  }

  private validated(record: StoredKey, scope: OfflineDraftKeyScope, keyId: string): CryptoKey {
    if (record.keyId !== keyId || record.tenantId !== scope.tenantId || record.principalId !== scope.principalId
      || record.projectId !== scope.projectId) throw new OfflineDraftKeyCustodyError("KEY_SCOPE_MISMATCH");
    const key = record.key;
    if (!key || key.algorithm?.name !== "AES-GCM" || key.extractable || key.type !== "secret") {
      throw new OfflineDraftKeyCustodyError("KEY_INVALID");
    }
    return key;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "keyId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => {
        this.databasePromise = undefined;
        reject(new OfflineDraftKeyCustodyError("STORE_FAILED"));
      };
    });
    return this.databasePromise;
  }

  private async read(keyId: string): Promise<StoredKey | undefined> {
    const db = await this.database();
    return new Promise<StoredKey | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(keyId);
      request.onsuccess = () => resolve(request.result as StoredKey | undefined);
      request.onerror = () => reject(new OfflineDraftKeyCustodyError("STORE_FAILED"));
    });
  }

  private async add(record: StoredKey): Promise<boolean> {
    const db = await this.database();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const request = tx.objectStore(STORE).add(record);
      let duplicate = false;
      request.onerror = (event) => { duplicate = request.error?.name === "ConstraintError"; if (duplicate) event.preventDefault(); };
      tx.oncomplete = () => resolve(true);
      tx.onabort = tx.onerror = () => duplicate ? resolve(false) : reject(new OfflineDraftKeyCustodyError("STORE_FAILED"));
    });
  }
}
