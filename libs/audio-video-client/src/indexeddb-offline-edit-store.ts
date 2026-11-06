import type {
  OfflineEditRecord,
  OfflineEditScope,
  OfflineEditStore,
} from "./offline-edit-queue.js";

const STORE_NAME = "offlineEdits";
const DATABASE_VERSION = 1;

export type IndexedDbOfflineEditStoreErrorCode = "OPEN_FAILED" | "OPEN_BLOCKED" | "TRANSACTION_FAILED";

/** Safe storage failures for hosts; native IndexedDB details are not exposed. */
export class IndexedDbOfflineEditStoreError extends Error {
  public constructor(public readonly code: IndexedDbOfflineEditStoreErrorCode) {
    super(`IndexedDB offline edit store failed: ${code}`);
    this.name = "IndexedDbOfflineEditStoreError";
  }
}

export interface IndexedDbOfflineEditStoreOptions {
  /** Use a tenant/application-specific name when multiple applications share an origin. */
  readonly databaseName?: string;
  /** Injectable for tests and hosts that provide a scoped IndexedDB factory. */
  readonly indexedDB?: IDBFactory;
}

type StoredRecord = Omit<OfflineEditRecord, "nonce" | "ciphertext"> & {
  readonly rowKey: [string, string, string];
  readonly nonce: ArrayBuffer;
  readonly ciphertext: ArrayBuffer;
};

/**
 * Durable browser store shared by same-origin tabs and workers. IndexedDB
 * transactions serialize insert/CAS operations across contexts. Payload bytes
 * remain AES-GCM ciphertext; key custody remains with the host.
 */
export class IndexedDbOfflineEditStore implements OfflineEditStore {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private databasePromise?: Promise<IDBDatabase>;

  public constructor(options: IndexedDbOfflineEditStoreOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is unavailable in this host.");
    this.factory = factory;
    this.databaseName = options.databaseName?.trim() || "ghatana-media-offline-edits-v1";
  }

  public async list(scope: OfflineEditScope): Promise<readonly OfflineEditRecord[]> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readonly");
    const done = transactionDone(tx);
    const rows = await requestResult(tx.objectStore(STORE_NAME).index("scope").getAll([scope.tenantId, scope.projectId]));
    await done;
    return rows.map(fromStored);
  }

  public async insert(record: OfflineEditRecord, maximumEntries: number): Promise<boolean> {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new RangeError("maximumEntries must be positive.");
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const existing = await requestResult(store.index("scope").getAll([record.tenantId, record.projectId]));
    if (existing.length >= maximumEntries || existing.some((item: StoredRecord) =>
      item.rowKey[2] === record.editId || item.idempotencyKey === record.idempotencyKey)) {
      tx.abort();
      await ignoreAbort(done);
      return false;
    }
    store.add(toStored(record));
    await done;
    return true;
  }

  public async put(record: OfflineEditRecord): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const rowKey = keyFor(record);
    const current = await requestResult<StoredRecord | undefined>(store.get(rowKey));
    if (!current) {
      tx.abort();
      await ignoreAbort(done);
      throw new Error("Offline edit record does not exist.");
    }
    store.put(toStored(record));
    await done;
  }

  public async compareAndSet(expected: OfflineEditRecord, replacement: OfflineEditRecord): Promise<boolean> {
    if (!sameScopeAndEdit(expected, replacement)) return false;
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const current = await requestResult<StoredRecord | undefined>(store.get(keyFor(expected)));
    if (!current || !sameRecord(fromStored(current), expected)) {
      tx.abort();
      await ignoreAbort(done);
      return false;
    }
    const collision = await requestResult<StoredRecord | undefined>(
      store.index("idempotency").get([replacement.tenantId, replacement.projectId, replacement.idempotencyKey]),
    );
    if (collision && collision.rowKey[2] !== replacement.editId) {
      tx.abort();
      await ignoreAbort(done);
      return false;
    }
    store.put(toStored(replacement));
    await done;
    return true;
  }

  public async remove(scope: OfflineEditScope, editId: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).delete([scope.tenantId, scope.projectId, editId]);
    await done;
  }

  public async removeIfMatches(expected: OfflineEditRecord): Promise<boolean> {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const current = await requestResult<StoredRecord | undefined>(store.get(keyFor(expected)));
    if (!current || !sameRecord(fromStored(current), expected)) {
      tx.abort();
      await ignoreAbort(done);
      return false;
    }
    store.delete(keyFor(expected));
    await done;
    return true;
  }

  /** Close this connection so hosts can release resources or perform upgrades. */
  public async close(): Promise<void> {
    const pending = this.databasePromise;
    this.databasePromise = undefined;
    if (pending) {
      try { (await pending).close(); } catch { /* failed opens have no live connection to close */ }
    }
  }

  private database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      let blocked = false;
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (db.objectStoreNames.contains(STORE_NAME)) return;
          const store = db.createObjectStore(STORE_NAME, { keyPath: "rowKey" });
          store.createIndex("scope", ["tenantId", "projectId"], { unique: false });
          store.createIndex("idempotency", ["tenantId", "projectId", "idempotencyKey"], { unique: true });
        };
        request.onsuccess = () => {
          const db = request.result;
          // An onblocked request may still complete after the promise rejected.
          // Close that late connection rather than leaking it or reviving a
          // store instance whose caller has already been told to retry.
          if (blocked) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            if (this.databasePromise === opening) this.databasePromise = undefined;
          };
          resolve(db);
        };
        request.onerror = () => reject(new IndexedDbOfflineEditStoreError("OPEN_FAILED"));
        request.onblocked = () => {
          blocked = true;
          reject(new IndexedDbOfflineEditStoreError("OPEN_BLOCKED"));
        };
      });
      this.databasePromise = opening;
      // A failed open must not poison later calls. Keep this catch attached so
      // cleanup is immediate while callers still receive the original error.
      void opening.catch(() => {
        if (this.databasePromise === opening) this.databasePromise = undefined;
      });
    }
    return this.databasePromise;
  }
}

function keyFor(record: Pick<OfflineEditRecord, "tenantId" | "projectId" | "editId">): [string, string, string] {
  return [record.tenantId, record.projectId, record.editId];
}

function toStored(record: OfflineEditRecord): StoredRecord {
  return { ...record, rowKey: keyFor(record), nonce: copyBuffer(record.nonce), ciphertext: copyBuffer(record.ciphertext) };
}

function fromStored(record: StoredRecord): OfflineEditRecord {
  return { tenantId: record.tenantId, projectId: record.projectId, editId: record.editId,
    idempotencyKey: record.idempotencyKey, expectedVersion: record.expectedVersion,
    nonce: new Uint8Array(record.nonce.slice(0)), ciphertext: new Uint8Array(record.ciphertext.slice(0)),
    payloadBytes: record.payloadBytes, state: record.state };
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sameScopeAndEdit(a: OfflineEditRecord, b: OfflineEditRecord): boolean {
  return a.tenantId === b.tenantId && a.projectId === b.projectId && a.editId === b.editId;
}

function sameRecord(a: OfflineEditRecord, b: OfflineEditRecord): boolean {
  return sameScopeAndEdit(a, b) && a.idempotencyKey === b.idempotencyKey
    && a.expectedVersion === b.expectedVersion && a.payloadBytes === b.payloadBytes && a.state === b.state
    && equalBytes(a.nonce, b.nonce) && equalBytes(a.ciphertext, b.ciphertext);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function requestResult<T = any>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new IndexedDbOfflineEditStoreError("TRANSACTION_FAILED"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new IndexedDbOfflineEditStoreError("TRANSACTION_FAILED"));
    tx.onerror = () => reject(new IndexedDbOfflineEditStoreError("TRANSACTION_FAILED"));
  });
  // Callers may be awaiting an individual request when the transaction aborts.
  // Mark the transaction rejection handled immediately while preserving it for
  // the caller that eventually awaits `done`.
  void done.catch(() => undefined);
  return done;
}

async function ignoreAbort(done: Promise<void>): Promise<void> {
  try { await done; } catch { /* expected after an explicit abort */ }
}
