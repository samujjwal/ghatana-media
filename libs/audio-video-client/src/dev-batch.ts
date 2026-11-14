/**
 * Purpose: DEV_ONLY batch driver for the local-development CLI (`batch run --file <path>`,
 * `media.dev.outcome-structured-command-batch`, J-24).
 * Consumers: `cli.ts` local-development channel only; it is not exported from the package index.
 * Non-goals: production admission, atomicity, rollback, cross-item transactions, or any HTTP logic;
 * every item is dispatched through the existing single-command implementation supplied by the caller.
 * Change policy: extend the command table only with commands that already exist in the local-development CLI.
 *
 * Conservative assumption (owner-delegated decision, recorded verbatim): "J-24 batch is a DEV_ONLY
 * local-development CLI command `batch run --file <path>` that executes an ordered JSON list of existing
 * local-development commands (artifact upload/inspect, job get/cancel, project render/render-get, export
 * create/get) sequentially. It is explicitly NON-atomic: there is no rollback and no cross-item
 * transaction. Every mutating item MUST carry its own requestId (so a retried batch is idempotent per
 * item); items without one are rejected before any dispatch. Default policy stops at the first
 * non-success item (`--continue-on-error` opts in to running the rest). Output is one JSON document with
 * a per-item result in input order (success | typed error | OUTCOME_UNKNOWN | NOT_RUN) and a batch
 * summary; the batch never reports success unless every item succeeded. Exit code is the worst item exit
 * code. The production channel continues to reject `batch` and `job batch`."
 */
import { open } from 'node:fs/promises';

export const BATCH_SCHEMA_VERSION = 'media.dev.batch.v1';
export const BATCH_RESULT_SCHEMA_VERSION = 'media.cli-batch-result.v1';
export const MAX_BATCH_FILE_BYTES = 262_144;
export const MAX_BATCH_ITEMS = 25;

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NUMERIC_OPTIONS: ReadonlySet<string> = new Set(['width', 'height', 'fps', 'expected-version']);

interface ItemShape {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** Option that carries the item's idempotency identity; present only for mutating commands. */
  readonly requestIdOption?: string;
}

/** Per-command exact option keys (flag names without `--`; endpoint/tenant/principal come from the batch invocation). */
const ITEM_SHAPES: Readonly<Record<string, ItemShape>> = {
  'artifact upload': { required: ['file', 'content-type', 'classification', 'retention', 'idempotency-key'], optional: [], requestIdOption: 'idempotency-key' },
  'artifact inspect': { required: ['artifact'], optional: [] },
  'job get': { required: ['job'], optional: ['request-id'] },
  'job cancel': { required: ['job', 'request-id'], optional: ['expected-version'], requestIdOption: 'request-id' },
  'project render': { required: ['project-id', 'revision-id', 'timeline-id', 'request-id', 'width', 'height', 'fps'], optional: ['format'], requestIdOption: 'request-id' },
  'project render-get': { required: ['project-id', 'render-id'], optional: [] },
  'export create': { required: ['request-id', 'artifact-id', 'artifact-version-id', 'destination-id'], optional: [], requestIdOption: 'request-id' },
  'export get': { required: ['request-id'], optional: [] },
};

export class BatchValidationError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BatchValidationError';
  }
}

export interface BatchItem {
  readonly id: string;
  readonly command: string;
  /** Flags (with leading `--`) in deterministic order, values already stringified. */
  readonly flags: readonly string[];
  readonly mutating: boolean;
}

export type BatchItemStatus = 'SUCCESS' | 'ERROR' | 'OUTCOME_UNKNOWN' | 'NOT_RUN';

export interface BatchItemOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BatchItemResult {
  readonly id: string;
  readonly command: string;
  readonly status: BatchItemStatus;
  readonly exitCode: number | null;
  readonly result?: unknown;
  readonly error?: unknown;
}

function fail(code: string, message: string): never {
  throw new BatchValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a local regular file with a hard size bound; the path is never echoed back. */
export async function readBatchFile(path: string): Promise<string> {
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) {
    fail('BATCH_FILE_INVALID', 'Batch file must be a local filesystem path.');
  }
  let handle;
  try { handle = await open(path, 'r'); }
  catch { fail('BATCH_FILE_INVALID', 'Batch file could not be opened.'); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('BATCH_FILE_INVALID', 'Batch file must be a regular file.');
    if (info.size > MAX_BATCH_FILE_BYTES) fail('BATCH_FILE_TOO_LARGE', `Batch file must not exceed ${MAX_BATCH_FILE_BYTES} bytes.`);
    const buffer = Buffer.alloc(MAX_BATCH_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_BATCH_FILE_BYTES) fail('BATCH_FILE_TOO_LARGE', `Batch file must not exceed ${MAX_BATCH_FILE_BYTES} bytes.`);
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    try { await handle.close(); } catch { /* cleanup does not alter the result */ }
  }
}

/** Strictly validates the whole batch document before any item is dispatched. */
export function parseBatch(source: string): readonly BatchItem[] {
  let document: unknown;
  try { document = JSON.parse(source); }
  catch { fail('BATCH_SCHEMA_INVALID', 'Batch file is not valid JSON.'); }
  if (!isRecord(document) || Object.keys(document).length !== 2
    || document.schemaVersion !== BATCH_SCHEMA_VERSION || !Array.isArray(document.items)) {
    fail('BATCH_SCHEMA_INVALID', `Batch document must be exactly {"schemaVersion":"${BATCH_SCHEMA_VERSION}","items":[...]}.`);
  }
  const rawItems = document.items as unknown[];
  if (rawItems.length < 1 || rawItems.length > MAX_BATCH_ITEMS) {
    fail('BATCH_SCHEMA_INVALID', `Batch must contain 1 to ${MAX_BATCH_ITEMS} items.`);
  }
  const ids = new Set<string>();
  const mutatingIdentities = new Set<string>();
  return rawItems.map((raw, index): BatchItem => {
    const where = `items[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).length !== 3 || !('id' in raw) || !('command' in raw) || !('options' in raw)) {
      fail('BATCH_SCHEMA_INVALID', `${where} must have exactly the keys id, command and options.`);
    }
    const { id, command, options } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !ITEM_ID.test(id) || ids.has(id)) {
      fail('BATCH_SCHEMA_INVALID', `${where}.id must be a unique opaque identity of 1 to 128 characters.`);
    }
    ids.add(id);
    if (typeof command !== 'string' || !Object.hasOwn(ITEM_SHAPES, command)) {
      fail('BATCH_UNKNOWN_COMMAND', `${where}.command is not a batchable local-development command.`);
    }
    const shape = ITEM_SHAPES[command]!;
    if (!isRecord(options)) fail('BATCH_SCHEMA_INVALID', `${where}.options must be an object.`);
    const allowed = new Set([...shape.required, ...shape.optional]);
    for (const key of Object.keys(options)) {
      if (!allowed.has(key)) fail('BATCH_SCHEMA_INVALID', `${where}.options contains an option not accepted by ${command}.`);
    }
    if (shape.requestIdOption !== undefined && !Object.hasOwn(options, shape.requestIdOption)) {
      fail('BATCH_REQUEST_ID_REQUIRED', `${where} (${command}) is mutating and must carry its own ${shape.requestIdOption}; batches are not dispatched without it.`);
    }
    for (const key of shape.required) {
      if (!Object.hasOwn(options, key)) fail('BATCH_SCHEMA_INVALID', `${where}.options is missing ${key}.`);
    }
    const flags: string[] = [];
    for (const key of [...shape.required, ...shape.optional]) {
      if (!Object.hasOwn(options, key)) continue;
      const value = options[key];
      const text = NUMERIC_OPTIONS.has(key) && typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      if (typeof text !== 'string' || text.length < 1 || text.length > 4096 || text.startsWith('--') || /[\u0000-\u001f\u007f]/u.test(text)) {
        fail('BATCH_SCHEMA_INVALID', `${where}.options.${key} is invalid.`);
      }
      flags.push(`--${key}`, text);
    }
    if (shape.requestIdOption !== undefined) {
      const identity = `${command}\u0000${String(options[shape.requestIdOption])}`;
      if (mutatingIdentities.has(identity)) {
        fail('BATCH_SCHEMA_INVALID', `${where} reuses a request identity already used by another ${command} item.`);
      }
      mutatingIdentities.add(identity);
    }
    return { id, command, flags, mutating: shape.requestIdOption !== undefined };
  });
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { return undefined; }
}

export interface BatchRunOptions {
  readonly continueOnError: boolean;
  readonly dispatch: (item: BatchItem) => Promise<BatchItemOutcome>;
}

export interface BatchRunReport {
  readonly document: Record<string, unknown>;
  readonly exitCode: number;
}

/** Runs items sequentially. Non-atomic: nothing is rolled back and no item depends on another. */
export async function runBatch(items: readonly BatchItem[], options: BatchRunOptions): Promise<BatchRunReport> {
  const results: BatchItemResult[] = [];
  let worst = 0;
  let stopped = false;
  let stoppedAt: string | null = null;
  for (const item of items) {
    if (stopped) { results.push({ id: item.id, command: item.command, status: 'NOT_RUN', exitCode: null }); continue; }
    const outcome = await options.dispatch(item);
    const error = outcome.stderr.trim() ? parseJson(outcome.stderr) : undefined;
    const ok = outcome.exitCode === 0 && !outcome.stderr.trim();
    const parsed = ok ? parseJson(outcome.stdout) : undefined;
    let status: BatchItemStatus = 'SUCCESS';
    if (!ok || parsed === undefined) {
      status = isRecord(error) && error.code === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'ERROR';
    }
    const exitCode = status === 'SUCCESS' ? 0 : Math.max(outcome.exitCode, 1);
    worst = Math.max(worst, exitCode);
    results.push(status === 'SUCCESS'
      ? { id: item.id, command: item.command, status, exitCode, result: parsed }
      : { id: item.id, command: item.command, status, exitCode,
        error: error ?? { code: 'ITEM_FAILED', message: 'The item failed without a structured error.' } });
    if (status !== 'SUCCESS' && !options.continueOnError) { stopped = true; stoppedAt = item.id; }
  }
  const count = (status: BatchItemStatus) => results.filter((entry) => entry.status === status).length;
  const succeeded = count('SUCCESS');
  const summary = {
    total: items.length, succeeded, failed: count('ERROR'), outcomeUnknown: count('OUTCOME_UNKNOWN'),
    notRun: count('NOT_RUN'), stoppedAt, atomic: false,
    success: succeeded === items.length,
  };
  return {
    document: { schemaVersion: BATCH_RESULT_SCHEMA_VERSION, commandId: 'media.cli.local-development.batch.run',
      nonAtomic: true, items: results, summary },
    exitCode: summary.success ? 0 : worst,
  };
}
