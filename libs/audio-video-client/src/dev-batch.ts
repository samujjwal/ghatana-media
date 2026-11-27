/**
 * Purpose: parse and report the bounded J-24 DEV_ONLY job submission batch.
 * Consumers: the local-development CLI only; this module is not exported from the package index.
 * Non-goals: production/API admission, atomicity, cancellation, retries, or cross-item references.
 * Every item is dispatched through the existing single-command `job submit` path.
 */
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

export const BATCH_SCHEMA_VERSION = 'media.dev.batch.v1';
export const BATCH_RESULT_SCHEMA_VERSION = 'media.cli-batch-result.v1';
export const BATCH_COMMAND_ID = 'media.cli.local-development.batch.run';
export const MAX_BATCH_FILE_BYTES = 262_144;
export const MAX_BATCH_ITEMS = 16;
export const MAX_AWAIT_FINALITY_MS = 300_000;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const JOB_TYPES = new Set(['TRANSCODE', 'SPEECH_TO_TEXT', 'TEXT_TO_SPEECH', 'VISION', 'MULTIMODAL']);
const TERMINAL_JOB_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const SAFE_TERMINAL_ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'LOCAL_DEV_IDENTITY_REJECTED',
  'MISSING_AUTH_TOKEN',
  'INVALID_CONFIGURATION',
  'INVALID_INVOCATION',
  'ARTIFACT_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'MEDIA_POLICY_DENIED',
]);

export class BatchValidationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly path = '$',
  ) {
    super(message);
    this.name = 'BatchValidationError';
  }
}

export interface BatchItemOptions {
  readonly artifact: string;
  readonly 'request-id': string;
  readonly 'job-type': string;
  readonly 'await-finality-ms': number;
}

export interface BatchItem {
  readonly id: string;
  readonly command: 'job submit';
  readonly options: BatchItemOptions;
  /** Exact, deterministic arguments for the existing local-development CLI command. */
  readonly flags: readonly string[];
}

export type BatchItemStatus = 'SUCCESS' | 'ERROR' | 'OUTCOME_UNKNOWN' | 'NOT_RUN';
export type BatchFinality = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN' | null;

export interface BatchItemOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BatchItemResult {
  readonly id: string;
  readonly command: 'job submit';
  readonly requestId: string;
  readonly status: BatchItemStatus;
  readonly finality: BatchFinality;
  readonly exitCode: number | null;
  readonly jobId?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly resume?: { readonly requestId: string; readonly instruction: string };
}

export interface BatchRunReport {
  readonly document: Record<string, unknown>;
  readonly exitCode: number;
}

export interface BatchRunOptions {
  /** Exact bytes' SHA-256, formatted as `sha256:<lowercase hex>`, checked by the CLI wrapper. */
  readonly planFingerprint: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** Local Ctrl-C signal: abort observation only; never request host cancellation. */
  readonly signal?: AbortSignal;
  readonly dispatch: (item: BatchItem) => Promise<BatchItemOutcome>;
}

function fail(code: string, message: string, path = '$'): never {
  throw new BatchValidationError(code, message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * JSON.parse accepts duplicate object keys using last-value-wins semantics. That is
 * unsafe for a confirmed plan because the displayed and dispatched values can differ.
 * This bounded scanner rejects duplicate keys before JSON.parse validates the grammar.
 */
function rejectDuplicateKeys(source: string): void {
  let index = 0;

  const whitespace = () => {
    while (source[index] === ' ' || source[index] === '\t' || source[index] === '\r' || source[index] === '\n') index += 1;
  };

  const stringToken = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error('Expected JSON string.');
    index += 1;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      const ch = source[index]!;
      if (ch === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (code < 0x20) throw new Error('Invalid control character in JSON string.');
      if (ch === '\\') {
        index += 1;
        const escaped = source[index];
        if (escaped === 'u') {
          if (!/^[0-9A-Fa-f]{4}$/u.test(source.slice(index + 1, index + 5))) throw new Error('Invalid JSON escape.');
          index += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) throw new Error('Invalid JSON escape.');
      }
      index += 1;
    }
    throw new Error('Unterminated JSON string.');
  };

  const value = (): void => {
    whitespace();
    const ch = source[index];
    if (ch === '"') {
      stringToken();
      return;
    }
    if (ch === '{') {
      object();
      return;
    }
    if (ch === '[') {
      array();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    number.lastIndex = index;
    const match = number.exec(source);
    if (match === null) throw new Error('Invalid JSON value.');
    index = number.lastIndex;
  };

  const object = (): void => {
    index += 1;
    whitespace();
    if (source[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      whitespace();
      const key = stringToken();
      if (keys.has(key)) throw new Error('Duplicate JSON object key.');
      keys.add(key);
      whitespace();
      if (source[index] !== ':') throw new Error('Expected colon after JSON object key.');
      index += 1;
      value();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      if (source[index] !== ',') throw new Error('Expected comma or end of JSON object.');
      index += 1;
    }
  };

  const array = (): void => {
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return;
    }
    for (;;) {
      value();
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      if (source[index] !== ',') throw new Error('Expected comma or end of JSON array.');
      index += 1;
    }
  };

  value();
  whitespace();
  if (index !== source.length) throw new Error('Unexpected trailing JSON content.');
}

/** Read a bounded local file once; the caller hashes these exact bytes before decoding. */
export async function readBatchFileBytes(path: string): Promise<Buffer> {
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) {
    fail('BATCH_FILE_INVALID', 'Batch file must be a local filesystem path.');
  }
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    fail('BATCH_FILE_INVALID', 'Batch file could not be opened.');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('BATCH_FILE_INVALID', 'Batch file must be a regular file.');
    if (info.size > MAX_BATCH_FILE_BYTES) {
      fail('BATCH_FILE_TOO_LARGE', `Batch file must not exceed ${MAX_BATCH_FILE_BYTES} bytes.`);
    }
    const bytes = Buffer.alloc(MAX_BATCH_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_BATCH_FILE_BYTES) {
        fail('BATCH_FILE_TOO_LARGE', `Batch file must not exceed ${MAX_BATCH_FILE_BYTES} bytes.`);
      }
    }
    return bytes.subarray(0, length);
  } finally {
    try {
      await handle.close();
    } catch {
      // Descriptor cleanup does not change the operation result.
    }
  }
}

/** Reject malformed UTF-8 without replacing bytes used by the CLI's raw-file hash. */
export function decodeBatchFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('BATCH_SCHEMA_INVALID', 'Batch file must contain valid UTF-8.');
  }
}

/** Strictly validates the entire batch before the CLI dispatches any item. */
export function parseBatch(source: string): readonly BatchItem[] {
  try {
    rejectDuplicateKeys(source);
  } catch {
    fail('BATCH_SCHEMA_INVALID', 'Batch file contains invalid JSON or duplicate object keys.');
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch {
    fail('BATCH_SCHEMA_INVALID', 'Batch file is not valid JSON.');
  }
  if (!isRecord(document) || Object.keys(document).length !== 2
    || document.schemaVersion !== BATCH_SCHEMA_VERSION || !Array.isArray(document.items)) {
    fail('BATCH_SCHEMA_INVALID', `Batch document must contain exactly schemaVersion and items; schemaVersion must be ${BATCH_SCHEMA_VERSION}.`);
  }

  const rawItems = document.items as unknown[];
  if (rawItems.length < 1 || rawItems.length > MAX_BATCH_ITEMS) {
    fail('BATCH_SCHEMA_INVALID', `Batch must contain 1 to ${MAX_BATCH_ITEMS} items.`, 'items');
  }

  const ids = new Set<string>();
  const requestIds = new Set<string>();
  return rawItems.map((raw, index): BatchItem => {
    const path = `items[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).length !== 3
      || !Object.hasOwn(raw, 'id') || !Object.hasOwn(raw, 'command') || !Object.hasOwn(raw, 'options')) {
      fail('BATCH_SCHEMA_INVALID', `${path} must contain exactly id, command and options.`, path);
    }
    const id = raw.id;
    if (typeof id !== 'string' || !OPAQUE_ID.test(id) || ids.has(id)) {
      fail('BATCH_SCHEMA_INVALID', `${path}.id must be a unique opaque ID of 1 to 128 characters.`, `${path}.id`);
    }
    ids.add(id);

    if (raw.command !== 'job submit') {
      fail('BATCH_UNKNOWN_COMMAND', `${path}.command must be exactly job submit.`, `${path}.command`);
    }

    const options = raw.options;
    if (!isRecord(options) || Object.keys(options).length !== 4
      || !Object.hasOwn(options, 'artifact') || !Object.hasOwn(options, 'request-id')
      || !Object.hasOwn(options, 'job-type') || !Object.hasOwn(options, 'await-finality-ms')) {
      fail('BATCH_SCHEMA_INVALID', `${path}.options must contain exactly artifact, request-id, job-type and await-finality-ms.`, `${path}.options`);
    }

    const artifact = options.artifact;
    if (typeof artifact !== 'string' || !OPAQUE_ID.test(artifact)) {
      fail('BATCH_SCHEMA_INVALID', `${path}.options.artifact must be a PDP-1 opaque artifact ID.`, `${path}.options.artifact`);
    }
    const requestId = options['request-id'];
    if (typeof requestId !== 'string' || !OPAQUE_ID.test(requestId) || requestIds.has(requestId)) {
      fail('BATCH_SCHEMA_INVALID', `${path}.options.request-id must be a unique PDP-1 opaque request ID.`, `${path}.options.request-id`);
    }
    requestIds.add(requestId);

    const jobType = options['job-type'];
    if (typeof jobType !== 'string' || !JOB_TYPES.has(jobType)) {
      fail('BATCH_SCHEMA_INVALID', `${path}.options.job-type must be an explicit canonical Media job type.`, `${path}.options.job-type`);
    }
    const awaitFinalityMs = options['await-finality-ms'];
    if (typeof awaitFinalityMs !== 'number' || !Number.isSafeInteger(awaitFinalityMs)
      || awaitFinalityMs < 1 || awaitFinalityMs > MAX_AWAIT_FINALITY_MS) {
      fail('BATCH_SCHEMA_INVALID', `${path}.options.await-finality-ms must be an integer in 1..${MAX_AWAIT_FINALITY_MS}.`, `${path}.options.await-finality-ms`);
    }

    const typedOptions: BatchItemOptions = {
      artifact,
      'request-id': requestId,
      'job-type': jobType,
      'await-finality-ms': awaitFinalityMs,
    };
    return {
      id,
      command: 'job submit',
      options: typedOptions,
      flags: [
        '--artifact', artifact,
        '--request-id', requestId,
        '--job-type', jobType,
        '--await-finality-ms', String(awaitFinalityMs),
      ],
    };
  });
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    rejectDuplicateKeys(text);
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function itemError(outcome: BatchItemOutcome): Record<string, unknown> | undefined {
  return parseObject(outcome.stderr.trim());
}

function jobFromResult(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value?.schemaVersion !== 'media.cli-result.v1'
    || value.commandId !== 'media.cli.local-development.job.submit'
    || !isRecord(value.job)) return undefined;
  return value.job;
}

function validJobIdentity(
  job: Record<string, unknown>,
  item: BatchItem,
  tenantId: string,
  principalId: string,
): job is Record<string, unknown> & { jobId: string; requestId: string; status: string } {
  return typeof job.jobId === 'string' && OPAQUE_ID.test(job.jobId)
    && job.requestId === item.options['request-id']
    && job.tenantId === tenantId
    && job.principalId === principalId
    && job.artifactId === item.options.artifact
    && job.jobType === item.options['job-type']
    && typeof job.status === 'string';
}

function safeJobId(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE_ID.test(value) ? value : undefined;
}

function classifyError(outcome: BatchItemOutcome, error: Record<string, unknown> | undefined): {
  status: 'ERROR' | 'OUTCOME_UNKNOWN';
  finality: null | 'UNKNOWN';
  exitCode: number;
} {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const exitCode = typeof outcome.exitCode === 'number' && Number.isInteger(outcome.exitCode)
    && outcome.exitCode >= 0 ? outcome.exitCode : 1;
  if (code !== undefined && SAFE_TERMINAL_ERROR_CODES.has(code)) {
    // A typed command failure can be definitive without a job record. Do not
    // imply the job reached terminal FAILED unless the owner readback says so.
    return { status: 'ERROR', finality: null, exitCode: exitCode === 0 ? 1 : exitCode };
  }
  // A failed child, undecodable response, or any unclassified transport result
  // cannot prove that a mutating submission had no effect.
  return { status: 'OUTCOME_UNKNOWN', finality: 'UNKNOWN', exitCode: 10 };
}

/** Runs job submissions sequentially. Nothing is rolled back or automatically cancelled. */
export async function runBatch(
  items: readonly BatchItem[],
  options: BatchRunOptions,
): Promise<BatchRunReport> {
  const results: BatchItemResult[] = [];
  let stoppedAt: string | null = null;
  let exitCode = 0;

  for (const item of items) {
    if (stoppedAt !== null) {
      results.push({
        id: item.id,
        command: item.command,
        requestId: item.options['request-id'],
        status: 'NOT_RUN',
        finality: null,
        exitCode: null,
      });
      continue;
    }
    if (options.signal?.aborted) {
      stoppedAt = item.id;
      exitCode = 130;
      results.push({
        id: item.id,
        command: item.command,
        requestId: item.options['request-id'],
        status: 'NOT_RUN',
        finality: null,
        exitCode: null,
      });
      continue;
    }

    let outcome: BatchItemOutcome;
    try {
      outcome = await options.dispatch(item);
    } catch {
      outcome = { exitCode: null, stdout: '', stderr: '' };
    }

    const output = parseObject(outcome.stdout.trim());
    const job = jobFromResult(output);
    if (outcome.exitCode === 0 && outcome.stderr.trim() === '' && job !== undefined
      && validJobIdentity(job, item, options.tenantId, options.principalId)) {
      const status = job.status;
      if (status === 'COMPLETED') {
        results.push({
          id: item.id,
          command: item.command,
          requestId: item.options['request-id'],
          status: 'SUCCESS',
          finality: 'COMPLETED',
          exitCode: 0,
          jobId: job.jobId,
          result: output,
        });
        continue;
      }
      if (status === 'FAILED' || status === 'CANCELLED') {
        const cancelled = status === 'CANCELLED';
        exitCode = cancelled ? 8 : 7;
        results.push({
          id: item.id,
          command: item.command,
          requestId: item.options['request-id'],
          status: 'ERROR',
          finality: status,
          exitCode,
          jobId: job.jobId,
          result: output,
          error: {
            code: cancelled ? 'JOB_CANCELLED' : 'JOB_FAILED',
            message: `The submitted job reached terminal status ${status}.`,
            ...(typeof job.failureCode === 'string' ? { failureCode: job.failureCode } : {}),
          },
        });
        stoppedAt = item.id;
        continue;
      }
      // Even an owner-shaped ACCEPTED/RUNNING/OUTCOME_UNKNOWN DTO remains unknown.
      const knownJobId = job.jobId;
      exitCode = 10;
      results.push({
        id: item.id,
        command: item.command,
        requestId: item.options['request-id'],
        status: 'OUTCOME_UNKNOWN',
        finality: 'UNKNOWN',
        exitCode,
        jobId: knownJobId,
        result: output,
        error: {
          code: 'JOB_NOT_FINAL',
          message: `The submitted job was observed as ${status}; finality is UNKNOWN.`,
          jobId: knownJobId,
          requestId: item.options['request-id'],
        },
        resume: {
          requestId: item.options['request-id'],
          instruction: 'Re-run the unchanged batch file with the same confirmation fingerprint and request ID to reconcile this job.',
        },
      });
      stoppedAt = item.id;
      continue;
    }

    const error = itemError(outcome);
    const classification = classifyError(outcome, error);
    const errorJobId = safeJobId(error?.jobId);
    exitCode = classification.exitCode;
    results.push({
      id: item.id,
      command: item.command,
      requestId: item.options['request-id'],
      status: classification.status,
      finality: classification.finality,
      exitCode,
      ...(errorJobId === undefined ? {} : { jobId: errorJobId }),
      error: error ?? {
        code: classification.status === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'ITEM_FAILED',
        message: classification.status === 'OUTCOME_UNKNOWN'
          ? 'The job submission result is unresolved; reconcile with the same request identity.'
          : 'The job submission failed.',
      },
      ...(classification.status === 'OUTCOME_UNKNOWN' ? {
        resume: {
          requestId: item.options['request-id'],
          instruction: 'Re-run the unchanged batch file with the same confirmation fingerprint and request ID to reconcile this job.',
        },
      } : {}),
    });
    stoppedAt = item.id;
  }

  const counts = {
    succeeded: results.filter((result) => result.status === 'SUCCESS').length,
    failed: results.filter((result) => result.status === 'ERROR').length,
    outcomeUnknown: results.filter((result) => result.status === 'OUTCOME_UNKNOWN').length,
    notRun: results.filter((result) => result.status === 'NOT_RUN').length,
  };
  const summary = {
    total: items.length,
    ...counts,
    finality: {
      completed: results.filter((result) => result.finality === 'COMPLETED').length,
      failed: results.filter((result) => result.finality === 'FAILED').length,
      cancelled: results.filter((result) => result.finality === 'CANCELLED').length,
      unknown: results.filter((result) => result.finality === 'UNKNOWN').length,
    },
    stoppedAt,
    atomic: false,
    success: counts.succeeded === items.length,
  };
  const document = {
    schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
    commandId: BATCH_COMMAND_ID,
    planFingerprint: options.planFingerprint,
    batchId: options.planFingerprint,
    items: results,
    summary,
  };
  return { document, exitCode: summary.success ? 0 : exitCode };
}
