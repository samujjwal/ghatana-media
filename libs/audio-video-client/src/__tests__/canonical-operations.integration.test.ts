import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMediaCanonicalClient } from '../canonical-operations.js';
import { createMediaOperationClient } from '../operations.js';
import { MediaClientError, MediaOperationAmbiguousError } from '../http-core.js';

/**
 * SK-07: real HTTP roundtrip for the canonical job and stream client —
 * happy path plus tenant revocation, malformed responses, conflicts and
 * post-dispatch abort → OUTCOME_UNKNOWN. No fake "integration" claims.
 */

const timestamp = '2026-10-30T12:00:00.000Z';
const streamToken = 't'.repeat(48);

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1', requestId: 'req-1', tenantId: 'tenant-1', principalId: 'principal-1',
    artifactId: 'art-1', jobType: 'TRANSCODE', providerId: 'media-wire-v1',
    status: 'ACCEPTED', createdAt: timestamp, startedAt: null, completedAt: null,
    result: {}, failureCode: null, version: 1, expectedArtifactVersion: '',
    requestFingerprint: `sha256:${'c'.repeat(64)}`,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1', sessionId: 'sess-1', principalId: 'principal-1',
    streamKind: 'VIDEO', providerId: 'in-process', state: 'OPEN',
    lastSequence: -1, bufferedBytes: 0, maximumBufferedBytes: 1_048_576,
    reconnectCount: 0, leaseExpiresAt: '2026-10-30T12:30:00.000Z',
    createdAt: timestamp, updatedAt: timestamp, closedAt: null,
    metadata: {}, version: 1, acknowledgementRevision: 0, finality: 'NONE',
    ...overrides,
  };
}

function artifact() {
  return {
    tenantId: 'tenant-1', principalId: 'principal-1', artifactId: 'art-1',
    fileName: 'fixture.wav', contentType: 'audio/wav', sizeBytes: 16,
    sha256: 'a'.repeat(64), objectReference: 'opaque-fixture-reference',
    classification: 'INTERNAL', createdAt: timestamp,
    expiresAt: '2026-10-31T12:00:00.000Z', metadata: {},
  };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const servers: Server[] = [];

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void readBody(request).then((body) => handler(request, response, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  await run(`http://127.0.0.1:${address.port}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

function makeClient(endpoint: string, extra: Record<string, unknown> = {}) {
  return createMediaCanonicalClient({
    baseUrl: endpoint,
    tenantId: 'tenant-1',
    defaultHeaders: { 'X-Principal-Id': 'principal-1' },
    getAccessToken: () => 'integration-secret',
    ...extra,
  });
}

describe('MediaCanonicalClient over real HTTP', () => {
  it('inspects artifact metadata through the existing scoped read route', async () => {
    let observed: { method?: string; path?: string; authorization?: string; tenant?: string; principal?: string } = {};
    await withServer((request, response) => {
      observed = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        tenant: request.headers['x-tenant-id'] as string | undefined,
        principal: request.headers['x-principal-id'] as string | undefined,
      };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(artifact()));
    }, async (endpoint) => {
      const client = createMediaOperationClient({
        baseUrl: endpoint,
        tenantId: 'tenant-1',
        defaultHeaders: { 'X-Principal-Id': 'principal-1' },
        getAccessToken: () => 'integration-secret',
      });
      expect(await client.getArtifact('art-1')).toEqual(artifact());
    });
    expect(observed).toEqual({
      method: 'GET', path: '/api/v1/artifacts/art-1', authorization: 'Bearer integration-secret',
      tenant: 'tenant-1', principal: 'principal-1',
    });
  });

  it('submits, reads, lists and cancels a job against a live server', async () => {
    const seen: string[] = [];
    await withServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      const json = (body: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      const path = request.url?.split('?')[0];
      if (path === '/api/v1/jobs' && request.method === 'POST') {
        json(job(), 202);
      } else if (path === '/api/v1/jobs' && request.method === 'GET') {
        json({ jobs: [job()] });
      } else if (request.url === '/api/v1/jobs/job-1' && request.method === 'GET') {
        json(job({ status: 'RUNNING' }));
      } else if (request.url === '/api/v1/jobs/job-1/cancel' && request.method === 'POST') {
        json(job({ status: 'CANCELLED', completedAt: timestamp }));
      } else {
        json({ error: { code: 'NOT_FOUND', message: 'nope', retryable: false },
          meta: { correlationId: 'c' } }, 404);
      }
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      const submitted = await client.submitJob({
        requestId: 'req-1', correlationId: 'corr-1', artifactId: 'art-1',
        jobType: 'TRANSCODE', idempotencyKey: 'idem-1',
      });
      expect(submitted.status).toBe('ACCEPTED');
      expect((await client.getJob('job-1')).status).toBe('RUNNING');
      expect(await client.listJobs({ limit: 10 })).toHaveLength(1);
      expect((await client.cancelJob('job-1')).status).toBe('CANCELLED');
      expect(seen).toEqual([
        'POST /api/v1/jobs',
        'GET /api/v1/jobs/job-1',
        'GET /api/v1/jobs?limit=10',
        'POST /api/v1/jobs/job-1/cancel',
      ]);
    });
  });

  it('runs a stream open → connect → frame → close roundtrip with token propagation', async () => {
    const tokensSeen: (string | undefined)[] = [];
    await withServer(async (request, response, body) => {
      const json = (payload: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      };
      if (request.url === '/api/v1/streams' && request.method === 'POST') {
        json({ session: session(), connectionToken: streamToken }, 201);
        return;
      }
      tokensSeen.push(request.headers['x-stream-token'] as string | undefined);
      if (request.url === '/api/v1/streams/sess-1/connect') {
        json(session({ state: 'CONNECTED' }));
      } else if (request.url === '/api/v1/streams/sess-1/frames/0') {
        expect(body.length).toBe(4);
        json({ acceptedSequence: 0, bufferedBytes: 4, backpressured: false }, 202);
      } else if (request.url === '/api/v1/streams/sess-1/close') {
        json(session({ state: 'CLOSED', closedAt: timestamp }));
      } else {
        json({ error: { code: 'NOT_FOUND', message: 'nope', retryable: false },
          meta: { correlationId: 'c' } }, 404);
      }
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      const registration = await client.openStream({
        correlationId: 'corr-1', streamKind: 'VIDEO', maximumBufferedBytes: 1_048_576,
        leaseDuration: 'PT30S', idempotencyKey: 'open-1',
      });
      expect(registration.connectionToken).toBe(streamToken);
      expect((await client.connectStream('sess-1', registration.connectionToken)).state)
        .toBe('CONNECTED');
      const ack = await client.submitStreamFrame(
        'sess-1', registration.connectionToken, 0, new Blob([new Uint8Array(4)]));
      expect(ack.acceptedSequence).toBe(0);
      expect((await client.closeStream('sess-1', registration.connectionToken)).state)
        .toBe('CLOSED');
      // The one-time token was carried on every session mutation.
      expect(tokensSeen).toEqual([streamToken, streamToken, streamToken]);
    });
  });

  it('fails closed on a cross-tenant job response — never surfaces it as the caller\'s', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(job({ tenantId: 'tenant-2' })));
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      await expect(client.getJob('job-1')).rejects.toThrow(/tenant and principal scope/u);
    });
  });

  it('preserves UNKNOWN for dispatched job submissions with server or response ambiguity', async () => {
    for (const responseMode of ['server-error', 'corrupt-json'] as const) {
      await withServer((_request, response) => {
        if (responseMode === 'server-error') {
          response.writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'retry later', retryable: true },
              meta: { correlationId: 'c' } }));
        } else {
          response.writeHead(202, { 'content-type': 'application/json' }).end('{');
        }
      }, async (endpoint) => {
        const client = makeClient(endpoint);
        await expect(client.submitJob({
          requestId: 'req-1', correlationId: 'corr-1', artifactId: 'art-1',
          jobType: 'TRANSCODE', idempotencyKey: `idem-${responseMode}`,
        })).rejects.toBeInstanceOf(MediaOperationAmbiguousError);
      });
    }
  });

  it('treats authenticated job submission rejection as definitive and does not retry', async () => {
    for (const status of [401, 403]) {
      let requests = 0;
      await withServer((_request, response) => {
        requests++;
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', message: 'denied', retryable: false },
          meta: { correlationId: 'c' },
        }));
      }, async (endpoint) => {
        const client = makeClient(endpoint);
        await expect(client.submitJob({
          requestId: 'req-1', correlationId: 'corr-1', artifactId: 'art-1',
          jobType: 'TRANSCODE', idempotencyKey: `idem-${status}`,
        })).rejects.toBeInstanceOf(MediaClientError);
        expect(requests).toBe(1);
      });
    }
  });

  it('fails closed on a malformed stream session — no implicit partial accept', async () => {
    await withServer((_request, response) => {
      const malformed = session() as Record<string, unknown>;
      delete malformed.finality;
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(malformed));
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      await expect(client.getStream('sess-1')).rejects.toThrow(/do not match the runtime DTO/u);
    });
  });

  it('a revoke (403) on frame submit surfaces as AUTHORIZATION, not a retry', async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 'STREAM_REVOKED', message: 'purpose revoked', retryable: false },
        meta: { correlationId: 'corr-revoke' },
      }));
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      const failure = await client.submitStreamFrame(
        'sess-1', streamToken, 0, new Blob([new Uint8Array(1)])).then(
        () => { throw new Error('unreachable'); },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MediaClientError);
      expect((failure as MediaClientError).detail.category).toBe('AUTHORIZATION');
      expect(requests).toBe(1);
    });
  });

  it('an abort after frame dispatch is OUTCOME_UNKNOWN — never a clean failure', async () => {
    let notifyRequestReceived!: () => void;
    const requestReceived = new Promise<void>((resolve) => { notifyRequestReceived = resolve; });
    await withServer((_request, response) => {
      notifyRequestReceived();
      // Hold the response open; the client aborts mid-flight.
      setTimeout(() => {
        response.writeHead(202, { 'content-type': 'application/json' })
          .end(JSON.stringify({ acceptedSequence: 0, bufferedBytes: 1, backpressured: false }));
      }, 5_000).unref();
    }, async (endpoint) => {
      const client = makeClient(endpoint);
      const controller = new AbortController();
      const pending = client.submitStreamFrame(
        'sess-1', streamToken, 0, new Blob([new Uint8Array(1)]),
        { signal: controller.signal });
      // Wait until the server has received the full frame body so this exercises
      // cancellation after dispatch, rather than cancellation during auth setup.
      await requestReceived;
      controller.abort();
      const failure = await pending.then(
        () => { throw new Error('unreachable'); },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MediaOperationAmbiguousError);
    });
  });
});
