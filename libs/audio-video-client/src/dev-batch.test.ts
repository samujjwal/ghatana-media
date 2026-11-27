import { describe, expect, it } from 'vitest';
import {
  BATCH_RESULT_SCHEMA_VERSION,
  BatchValidationError,
  decodeBatchFile,
  parseBatch,
  runBatch,
  type BatchItem,
  type BatchItemOutcome,
} from './dev-batch.js';

const validItem = (id: string, requestId: string) => ({
  id,
  command: 'job submit',
  options: {
    artifact: 'artifact-a',
    'request-id': requestId,
    'job-type': 'TRANSCODE',
    'await-finality-ms': 5_000,
  },
});

const source = (...items: unknown[]) => JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items });
const parsed = (...items: unknown[]) => parseBatch(source(...items));

const jobResult = (item: BatchItem, status = 'COMPLETED') => ({
  schemaVersion: 'media.cli-result.v1',
  commandId: 'media.cli.local-development.job.submit',
  job: {
    jobId: `job-${item.options['request-id']}`,
    requestId: item.options['request-id'],
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    artifactId: item.options.artifact,
    jobType: item.options['job-type'],
    status,
    result: {},
  },
});

function outcome(value: unknown, exitCode = 0): BatchItemOutcome {
  return { exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

function failure(code: string, exitCode = 1): BatchItemOutcome {
  return { exitCode, stdout: '', stderr: `${JSON.stringify({ schemaVersion: 'media.cli-error.v1', code, message: 'typed failure' })}\n` };
}

const runOptions = {
  planFingerprint: `sha256:${'a'.repeat(64)}`,
  tenantId: 'tenant-a',
  principalId: 'principal-a',
};

describe('DEV_ONLY J-24 job submission batch', () => {
  it('parses the exact bounded schema and emits deterministic CLI arguments', () => {
    expect(parsed(validItem('first', 'request-1'))).toEqual([{
      id: 'first',
      command: 'job submit',
      options: {
        artifact: 'artifact-a',
        'request-id': 'request-1',
        'job-type': 'TRANSCODE',
        'await-finality-ms': 5_000,
      },
      flags: [
        '--artifact', 'artifact-a',
        '--request-id', 'request-1',
        '--job-type', 'TRANSCODE',
        '--await-finality-ms', '5000',
      ],
    }]);
  });

  it('rejects unknown fields, unsupported commands, duplicate identities and invalid budgets', () => {
    expect(() => parseBatch(JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [validItem('x', 'r')], tenant: 'tenant-a' })))
      .toThrowError(BatchValidationError);
    expect(() => parsed({ ...validItem('x', 'r'), extra: true })).toThrowError(BatchValidationError);
    expect(() => parsed({ ...validItem('x', 'r'), command: 'job cancel' })).toThrowError(/command must be exactly job submit/u);
    expect(() => parsed(validItem('same', 'r1'), validItem('same', 'r2'))).toThrowError(/unique opaque ID/u);
    expect(() => parsed(validItem('first', 'same'), validItem('second', 'same'))).toThrowError(/unique PDP-1 opaque request ID/u);
    expect(() => parsed({ ...validItem('x', 'r'), options: { ...validItem('x', 'r').options, extra: 'ignored' } }))
      .toThrowError(/exactly artifact, request-id, job-type and await-finality-ms/u);
    for (const budget of [0, 300_001, 1.5, '5000']) {
      const item = validItem('x', 'r');
      item.options['await-finality-ms'] = budget as number;
      expect(() => parsed(item)).toThrowError(/await-finality-ms must be an integer/u);
    }
  });

  it('rejects duplicate JSON keys and malformed UTF-8', () => {
    expect(() => parseBatch('{"schemaVersion":"media.dev.batch.v1","schemaVersion":"media.dev.batch.v1","items":[]}'))
      .toThrowError(/duplicate object keys/u);
    expect(() => parseBatch('{"schemaVersion":"media.dev.batch.v1","items":[{"id":"x","id":"y","command":"job submit","options":{}}]}'))
      .toThrowError(/duplicate object keys/u);
    expect(() => decodeBatchFile(Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d])))
      .toThrowError(/valid UTF-8/u);
  });

  it('accepts terminal COMPLETED only for an exact returned job identity', async () => {
    const items = parsed(validItem('first', 'request-1'), validItem('second', 'request-2'));
    const dispatched: string[] = [];
    const report = await runBatch(items, {
      ...runOptions,
      dispatch: async item => {
        dispatched.push(item.options['request-id']);
        return outcome(jobResult(item));
      },
    });
    expect(dispatched).toEqual(['request-1', 'request-2']);
    expect(report.exitCode).toBe(0);
    expect(report.document).toMatchObject({
      schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
      planFingerprint: runOptions.planFingerprint,
      batchId: runOptions.planFingerprint,
      summary: { total: 2, succeeded: 2, failed: 0, outcomeUnknown: 0, notRun: 0, success: true },
    });
    expect(report.document.items).toMatchObject([
      { id: 'first', requestId: 'request-1', status: 'SUCCESS', finality: 'COMPLETED', jobId: 'job-request-1' },
      { id: 'second', requestId: 'request-2', status: 'SUCCESS', finality: 'COMPLETED', jobId: 'job-request-2' },
    ]);
  });

  it('reports terminal FAILED and CANCELLED as typed non-success and stops later items', async () => {
    for (const [status, exitCode, finality] of [
      ['FAILED', 7, 'FAILED'],
      ['CANCELLED', 8, 'CANCELLED'],
    ] as const) {
      const items = parsed(validItem('first', 'request-1'), validItem('second', 'request-2'));
      const dispatched: string[] = [];
      const report = await runBatch(items, {
        ...runOptions,
        dispatch: async item => {
          dispatched.push(item.options['request-id']);
          return outcome(jobResult(item, status));
        },
      });
      expect(dispatched).toEqual(['request-1']);
      expect(report.exitCode).toBe(exitCode);
      expect(report.document.items).toMatchObject([
        { id: 'first', status: 'ERROR', finality, jobId: 'job-request-1' },
        { id: 'second', status: 'NOT_RUN', finality: null, exitCode: null },
      ]);
    }
  });

  it('reports accepted/running results as UNKNOWN with stable resume identity and fail-stop', async () => {
    const items = parsed(validItem('first', 'request-1'), validItem('second', 'request-2'));
    const dispatched: string[] = [];
    const report = await runBatch(items, {
      ...runOptions,
      dispatch: async item => {
        dispatched.push(item.options['request-id']);
        return outcome(jobResult(item, 'RUNNING'));
      },
    });
    expect(dispatched).toEqual(['request-1']);
    expect(report.exitCode).toBe(10);
    expect(report.document.items).toMatchObject([
      {
        id: 'first', status: 'OUTCOME_UNKNOWN', finality: 'UNKNOWN', jobId: 'job-request-1',
        resume: { requestId: 'request-1' },
      },
      { id: 'second', status: 'NOT_RUN' },
    ]);
  });

  it('keeps forbidden, missing, or mismatched results from becoming success', async () => {
    const items = parsed(validItem('first', 'request-1'), validItem('second', 'request-2'));
    const denied = await runBatch(items, {
      ...runOptions,
      dispatch: async () => failure('FORBIDDEN', 4),
    });
    expect(denied.exitCode).toBe(4);
    expect(denied.document.items).toMatchObject([
      { id: 'first', status: 'ERROR', finality: null, error: { code: 'FORBIDDEN' } },
      { id: 'second', status: 'NOT_RUN' },
    ]);

    const mismatch = await runBatch(items.slice(0, 1), {
      ...runOptions,
      dispatch: async item => outcome({
        ...jobResult(item),
        job: { ...jobResult(item).job, requestId: 'different-request' },
      }),
    });
    expect(mismatch.exitCode).toBe(10);
    expect(mismatch.document.items).toMatchObject([
      { status: 'OUTCOME_UNKNOWN', finality: 'UNKNOWN', error: { code: 'OUTCOME_UNKNOWN' } },
    ]);
  });

  it('marks malformed output, transport failure and process interruption UNKNOWN without new identities', async () => {
    const items = parsed(validItem('first', 'request-1'));
    for (const dispatch of [
      async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      async () => ({ exitCode: null, stdout: '', stderr: '' }),
      async () => { throw new Error('child interrupted'); },
      async () => ({ exitCode: 0, stdout: '{broken', stderr: '' }),
    ]) {
      const report = await runBatch(items, { ...runOptions, dispatch });
      expect(report.exitCode).toBe(10);
      expect(report.document.items).toMatchObject([
        {
          requestId: 'request-1',
          status: 'OUTCOME_UNKNOWN',
          finality: 'UNKNOWN',
          resume: { requestId: 'request-1' },
        },
      ]);
    }
  });

  it('records Ctrl-C before dispatch as NOT_RUN and does not create an effect', async () => {
    const items = parsed(validItem('first', 'request-1'), validItem('second', 'request-2'));
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;
    const report = await runBatch(items, {
      ...runOptions,
      signal: controller.signal,
      dispatch: async () => { dispatched = true; return failure('OUTCOME_UNKNOWN', 10); },
    });
    expect(dispatched).toBe(false);
    expect(report.exitCode).toBe(130);
    expect(report.document.items).toMatchObject([
      { id: 'first', status: 'NOT_RUN', finality: null, exitCode: null },
      { id: 'second', status: 'NOT_RUN', finality: null, exitCode: null },
    ]);
  });
});
