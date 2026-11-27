import { randomUUID } from 'node:crypto';
import { closeSync, openSync, fstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { DocumentContentScanInput, SignedScanAttestation } from './contract.ts';

export type ScanJobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'UNKNOWN' | 'EXPIRED';

export interface ScanJob {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly state: ScanJobState;
  readonly fingerprint: string;
  readonly input: string | null;
  readonly attestation: string | null;
  readonly claimToken: string | null;
}

const SELECT = 'SELECT id, tenant_id AS tenantId, principal_id AS principalId, state, fingerprint, input, attestation, claim_token AS claimToken FROM scanner_jobs';
type Reservation =
  | { readonly kind: 'accepted'; readonly job: ScanJob }
  | { readonly kind: 'conflict' | 'busy' | 'full' };

/**
 * Media-owned replay and result authority. All processes on the same local host must use the
 * same SQLite database. No scan bytes or credentials are stored. A terminal result can be
 * retired, but its replay identity is never evicted silently.
 */
export class ScannerJobLedger {
  readonly #db: DatabaseSync;

  constructor(filename: string) {
    if (!filename || !filename.trim()) throw new TypeError('scanner job database path is required');
    // In-memory is an explicit test-only host choice. The deployable entrypoint requires a file.
    if (filename !== ':memory:') {
      const fd = openSync(filename, 'a', 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('scanner job database must be a private regular file');
      } finally { closeSync(fd); }
    }
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#db.exec([
        'CREATE TABLE IF NOT EXISTS scanner_jobs (',
        'id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, replay_key TEXT NOT NULL,',
        'fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (\'QUEUED\',\'RUNNING\',\'COMPLETED\',\'CANCELLED\',\'UNKNOWN\',\'EXPIRED\')),',
        'input TEXT, attestation TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, claim_token TEXT, lease_until INTEGER,',
        'UNIQUE(tenant_id, principal_id, replay_key));',
        'CREATE INDEX IF NOT EXISTS scanner_jobs_claim ON scanner_jobs(state, lease_until, created_at);',
        'CREATE INDEX IF NOT EXISTS scanner_jobs_retention ON scanner_jobs(state, finished_at);',
      ].join(' '));
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  read(id: string): ScanJob | undefined {
    return this.#db.prepare(SELECT + ' WHERE id=?').get(id) as unknown as ScanJob | undefined;
  }

  reserve(tenant: string, principal: string, key: string, fingerprint: string, input: DocumentContentScanInput,
      now: number, maxActive: number, maxReplayEntries: number): Reservation {
    return this.#transaction(() => {
      const prior = this.#db.prepare(SELECT + ' WHERE tenant_id=? AND principal_id=? AND replay_key=?')
        .get(tenant, principal, key) as unknown as ScanJob | undefined;
      if (prior) return prior.fingerprint === fingerprint ? { kind: 'accepted', job: prior } : { kind: 'conflict' };
      const active = Number(this.#db.prepare("SELECT count(*) AS n FROM scanner_jobs WHERE state IN ('QUEUED','RUNNING')").get()?.n);
      if (active >= maxActive) return { kind: 'busy' };
      const entries = Number(this.#db.prepare('SELECT count(*) AS n FROM scanner_jobs').get()?.n);
      if (entries >= maxReplayEntries) return { kind: 'full' };
      const id = randomUUID();
      this.#db.prepare("INSERT INTO scanner_jobs(id,tenant_id,principal_id,replay_key,fingerprint,state,input,created_at) VALUES (?,?,?,?,?,'QUEUED',?,?)")
        .run(id, tenant, principal, key, fingerprint, JSON.stringify(input), now);
      return { kind: 'accepted', job: this.read(id)! };
    });
  }

  claim(now: number, leaseMs: number, excluded: readonly string[]): ScanJob | undefined {
    return this.#transaction(() => {
      const skip = excluded.length === 0 ? '' : ' AND id NOT IN (' + excluded.map(() => '?').join(',') + ')';
      const candidate = this.#db.prepare(SELECT + " WHERE (state='QUEUED' OR (state='RUNNING' AND lease_until<=?))" + skip + ' ORDER BY created_at,id LIMIT 1')
        .get(now, ...excluded) as unknown as ScanJob | undefined;
      if (!candidate) return undefined;
      this.#db.prepare("UPDATE scanner_jobs SET state='RUNNING',claim_token=?,lease_until=? WHERE id=?")
        .run(randomUUID(), now + leaseMs, candidate.id);
      return this.read(candidate.id);
    });
  }

  renew(id: string, token: string, now: number, leaseMs: number): boolean {
    return Number(this.#db.prepare("UPDATE scanner_jobs SET lease_until=? WHERE id=? AND state='RUNNING' AND claim_token=? AND lease_until>?")
      .run(now + leaseMs, id, token, now).changes) === 1;
  }

  finish(id: string, token: string, now: number, attestation: SignedScanAttestation | undefined): boolean {
    return Number(this.#db.prepare("UPDATE scanner_jobs SET state=?,attestation=?,input=NULL,finished_at=?,claim_token=NULL,lease_until=NULL WHERE id=? AND state='RUNNING' AND claim_token=? AND lease_until>?")
      .run(attestation ? 'COMPLETED' : 'UNKNOWN', attestation ? JSON.stringify(attestation) : null, now, id, token, now).changes) === 1;
  }

  abandon(id: string, token: string): void {
    this.#db.prepare("UPDATE scanner_jobs SET state='QUEUED',claim_token=NULL,lease_until=NULL WHERE id=? AND state='RUNNING' AND claim_token=?")
      .run(id, token);
  }

  cancel(id: string, now: number): ScanJob | undefined {
    return this.#transaction(() => {
      this.#db.prepare("UPDATE scanner_jobs SET state='CANCELLED',input=NULL,attestation=NULL,finished_at=?,claim_token=NULL,lease_until=NULL WHERE id=? AND state IN ('QUEUED','RUNNING')")
        .run(now, id);
      return this.read(id);
    });
  }

  /** Keep tombstones: expiry never permits a new job for an existing replay key. */
  prune(now: number, retentionMs: number, maxRetained: number): void {
    this.#transaction(() => {
      const terminal = "state IN ('COMPLETED','CANCELLED','UNKNOWN')";
      this.#db.prepare("UPDATE scanner_jobs SET state='EXPIRED',attestation=NULL WHERE " + terminal + ' AND finished_at<=?')
        .run(now - retentionMs);
      this.#db.prepare("UPDATE scanner_jobs SET state='EXPIRED',attestation=NULL WHERE id IN (SELECT id FROM scanner_jobs WHERE " +
        terminal + ' ORDER BY finished_at DESC,id DESC LIMIT -1 OFFSET ?)').run(maxRetained);
    });
  }

  counts(): { queued: number; running: number; retained: number } {
    const counts = { queued: 0, running: 0, retained: 0 };
    for (const row of this.#db.prepare("SELECT state,count(*) AS n FROM scanner_jobs WHERE state<>'EXPIRED' GROUP BY state").all()) {
      if (row.state === 'QUEUED') counts.queued = Number(row.n);
      else if (row.state === 'RUNNING') counts.running = Number(row.n);
      else counts.retained += Number(row.n);
    }
    return counts;
  }

  close(): void { this.#db.close(); }
}
