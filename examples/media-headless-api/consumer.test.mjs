import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHeadlessApiExample } from "./index.mjs";

const timestamp = "2026-11-09T12:00:00Z";
const CHUNK_BYTES = 5;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function makeInputFixture() {
  const directory = await mkdtemp(join(tmpdir(), "media-headless-api-negative-"));
  const inputPath = join(directory, "sample.wav");
  const input = Buffer.alloc(32, 0x22);
  input.write("RIFF", 0, "ascii");
  input.writeUInt32LE(input.length - 8, 4);
  input.write("WAVE", 8, "ascii");
  await writeFile(inputPath, input);
  return {
    directory,
    inputPath,
    input,
    digest: createHash("sha256").update(input).digest("hex"),
    env(overrides = {}) {
      return {
        GHATANA_MEDIA_BASE_URL: "http://127.0.0.1:8080",
        GHATANA_MEDIA_TENANT_ID: "tenant-1",
        GHATANA_MEDIA_PRINCIPAL_ID: "principal-1",
        GHATANA_MEDIA_BEARER_TOKEN: "supplied-host-token",
        GHATANA_MEDIA_INPUT_FILE: inputPath,
        GHATANA_MEDIA_CONTENT_TYPE: "audio/wav",
        GHATANA_MEDIA_CHUNK_BYTES: String(input.length),
        ...overrides,
      };
    },
  };
}

function makeJourneyStub(fixture, {
  ambiguousFirstChunk = false,
  acceptAmbiguousChunk = true,
  uploadRead = (upload) => upload,
  jobStatus = "COMPLETED",
  jobRead = undefined,
} = {}) {
  const { input, digest } = fixture;
  const calls = [];
  const upload = {
    uploadId: "upload-1", tenantId: "tenant-1", principalId: "principal-1",
    fileName: "sample.wav", contentType: "audio/wav", expectedSizeBytes: input.length,
    expectedSha256: digest, classification: "INTERNAL", retention: "PT24H", createdAt: timestamp, expiresAt: "2026-11-10T12:00:00Z",
    bytesReceived: 0, nextChunkIndex: 0, status: "OPEN", metadata: { source: "media-headless-api-example" },
  };
  const artifact = {
    tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1", fileName: "sample.wav",
    contentType: "audio/wav", sizeBytes: input.length, sha256: digest,
    objectReference: "opaque-object-reference", classification: "INTERNAL", createdAt: timestamp,
    expiresAt: "2026-11-10T12:00:00Z", metadata: { source: "media-headless-api-example" },
  };
  const job = {
    jobId: "job-1", requestId: "request-1", tenantId: "tenant-1", principalId: "principal-1",
    artifactId: "artifact-1", jobType: "TRANSCODE", providerId: "local-diagnostic", status: "ACCEPTED",
    createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null, version: 1,
    expectedArtifactVersion: "", requestFingerprint: `sha256:${digest}`,
  };
  const counts = { chunkWrites: 0, completions: 0, jobSubmits: 0, jobReads: 0 };
  let receivedBytes = 0;
  const fetchImpl = async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), "Bearer supplied-host-token");
    assert.equal(headers.get("X-Tenant-ID"), "tenant-1");
    assert.equal(headers.get("X-Principal-Id"), "principal-1");
    calls.push(`${init.method ?? "GET"} ${requestUrl.pathname}${requestUrl.search}`);
    if (requestUrl.pathname === "/api/v1/artifacts/uploads" && init.method === "POST") return response(upload, 201);
    const chunkPath = /^\/api\/v1\/artifacts\/uploads\/upload-1\/chunks\/(\d+)$/u.exec(requestUrl.pathname);
    if (chunkPath && init.method === "PUT") {
      const chunkIndex = Number(chunkPath[1]);
      counts.chunkWrites += 1;
      assert.equal(chunkIndex, upload.nextChunkIndex);
      const chunk = Buffer.from(await new Response(init.body).arrayBuffer());
      assert.deepEqual(chunk, input.subarray(receivedBytes, receivedBytes + chunk.length));
      if (ambiguousFirstChunk && chunkIndex === 0) {
        if (acceptAmbiguousChunk) {
          receivedBytes += chunk.length;
          upload.bytesReceived = receivedBytes;
          upload.nextChunkIndex += 1;
        }
        return response({ error: { code: "HTTP_503_UNKNOWN", message: "acknowledgment lost" } }, 503);
      }
      receivedBytes += chunk.length;
      upload.bytesReceived = receivedBytes;
      upload.nextChunkIndex += 1;
      return response(upload);
    }
    if (requestUrl.pathname === "/api/v1/artifacts/uploads/upload-1" && init.method === "GET") {
      return response(uploadRead(upload));
    }
    if (requestUrl.pathname === "/api/v1/artifacts/uploads/upload-1/complete" && init.method === "POST") {
      counts.completions += 1;
      return response(artifact);
    }
    if (requestUrl.pathname === "/api/v1/artifacts/artifact-1" && init.method === "GET") return response(artifact);
    if (requestUrl.pathname === "/api/v1/jobs" && init.method === "POST") {
      counts.jobSubmits += 1;
      job.requestId = JSON.parse(init.body).requestId;
      return response(job, 202);
    }
    if (requestUrl.pathname === "/api/v1/jobs/job-1" && init.method === "GET") {
      counts.jobReads += 1;
      if (jobRead) return jobRead({ count: counts.jobReads, job, signal: init.signal });
      return response({ ...job, status: jobStatus });
    }
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${requestUrl.pathname}`);
  };
  return { fetchImpl, calls, counts };
}

test("public SDK consumer streams multiple bounded chunks then reads artifact and diagnostic job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "media-headless-api-"));
  const inputPath = join(directory, "sample.wav");
  const input = Buffer.alloc(64, 0x11);
  input.write("RIFF", 0, "ascii");
  input.writeUInt32LE(input.length - 8, 4);
  input.write("WAVE", 8, "ascii");
  const digest = createHash("sha256").update(input).digest("hex");
  await writeFile(inputPath, input);
  const calls = [];
  let receivedBytes = 0;
  let jobReads = 0;
  const receivedChunks = [];
  const upload = {
    uploadId: "upload-1", tenantId: "tenant-1", principalId: "principal-1",
    fileName: "sample.wav", contentType: "audio/wav", expectedSizeBytes: input.length,
    expectedSha256: digest, classification: "INTERNAL", retention: "PT24H", createdAt: timestamp, expiresAt: "2026-11-10T12:00:00Z",
    bytesReceived: 0, nextChunkIndex: 0, status: "OPEN", metadata: { source: "media-headless-api-example" },
  };
  const artifact = {
    tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1", fileName: "sample.wav",
    contentType: "audio/wav", sizeBytes: input.length, sha256: digest,
    objectReference: "opaque-object-reference", classification: "INTERNAL", createdAt: timestamp,
    expiresAt: "2026-11-10T12:00:00Z", metadata: { source: "media-headless-api-example" },
  };
  const job = {
    jobId: "job-1", requestId: "request-1", tenantId: "tenant-1", principalId: "principal-1",
    artifactId: "artifact-1", jobType: "TRANSCODE", providerId: "local-diagnostic", status: "ACCEPTED",
    createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null, version: 1,
    expectedArtifactVersion: "", requestFingerprint: `sha256:${digest}`,
  };

  const fetchImpl = async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), "Bearer supplied-host-token");
    assert.equal(headers.get("X-Tenant-ID"), "tenant-1");
    assert.equal(headers.get("X-Principal-Id"), "principal-1");
    calls.push(`${init.method ?? "GET"} ${requestUrl.pathname}${requestUrl.search}`);

    if (requestUrl.pathname === "/api/v1/artifacts/uploads" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.tenantId, "tenant-1");
      assert.equal(body.principalId, "principal-1");
      assert.equal(body.fileName, "sample.wav");
      assert.equal(body.expectedSizeBytes, input.length);
      return response(upload, 201);
    }
    const chunkPath = /^\/api\/v1\/artifacts\/uploads\/upload-1\/chunks\/(\d+)$/u.exec(requestUrl.pathname);
    if (chunkPath && init.method === "PUT") {
      const chunkIndex = Number(chunkPath[1]);
      assert.equal(chunkIndex, upload.nextChunkIndex);
      const chunk = Buffer.from(await new Response(init.body).arrayBuffer());
      assert.ok(chunk.length <= CHUNK_BYTES, "each source read stays within the configured 5-byte chunk bound");
      assert.deepEqual(chunk, input.subarray(receivedBytes, receivedBytes + chunk.length));
      receivedChunks.push(chunk);
      receivedBytes += chunk.length;
      upload.bytesReceived = receivedBytes;
      upload.nextChunkIndex += 1;
      if (chunkIndex === 0) return response({ error: { code: "HTTP_503_UNKNOWN", message: "acknowledgment lost" } }, 503);
      return response(upload);
    }
    if (requestUrl.pathname === "/api/v1/artifacts/uploads/upload-1" && init.method === "GET") {
      return response(upload);
    }
    if (requestUrl.pathname === "/api/v1/artifacts/uploads/upload-1/complete" && init.method === "POST") {
      assert.equal(receivedBytes, input.length);
      assert.deepEqual(Buffer.concat(receivedChunks), input);
      return response(artifact);
    }
    if (requestUrl.pathname === "/api/v1/artifacts/artifact-1" && init.method === "GET") {
      return response(artifact);
    }
    if (requestUrl.pathname === "/api/v1/jobs" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.jobType, "TRANSCODE");
      assert.equal(body.providerHint, "local-diagnostic");
      job.requestId = body.requestId;
      return response(job, 202);
    }
    if (requestUrl.pathname === "/api/v1/jobs/job-1" && init.method === "GET") {
      jobReads += 1;
      if (jobReads === 2) job.status = "COMPLETED";
      return response(job);
    }
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${requestUrl.pathname}`);
  };

  try {
    const result = await runHeadlessApiExample({
      env: {
        GHATANA_MEDIA_BASE_URL: "http://127.0.0.1:8080",
        GHATANA_MEDIA_TENANT_ID: "tenant-1",
        GHATANA_MEDIA_PRINCIPAL_ID: "principal-1",
        GHATANA_MEDIA_BEARER_TOKEN: "supplied-host-token",
        GHATANA_MEDIA_INPUT_FILE: inputPath,
        GHATANA_MEDIA_CONTENT_TYPE: "audio/wav",
        GHATANA_MEDIA_CHUNK_BYTES: String(CHUNK_BYTES),
        GHATANA_MEDIA_JOB_WAIT_MS: "100",
        GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "1",
      },
      fetchImpl,
    });
    const expectedCalls = ["POST /api/v1/artifacts/uploads"];
    for (let index = 0; index < Math.ceil(input.length / CHUNK_BYTES); index++) {
      expectedCalls.push(`PUT /api/v1/artifacts/uploads/upload-1/chunks/${index}`);
      if (index === 0) expectedCalls.push("GET /api/v1/artifacts/uploads/upload-1");
    }
    expectedCalls.push(
      "POST /api/v1/artifacts/uploads/upload-1/complete",
      "GET /api/v1/artifacts/artifact-1",
      "POST /api/v1/jobs",
      `GET /api/v1/jobs/job-1?requestId=${encodeURIComponent(job.requestId)}`,
      `GET /api/v1/jobs/job-1?requestId=${encodeURIComponent(job.requestId)}`,
    );
    assert.deepEqual(calls, expectedCalls);
    assert.deepEqual(result.artifact, {
      artifactId: "artifact-1", fileName: "sample.wav", contentType: "audio/wav",
      sizeBytes: input.length, sha256: digest,
    });
    assert.equal(result.job.status, "COMPLETED");
    assert.equal(JSON.stringify(result).includes("supplied-host-token"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public SDK resumes an interrupted upload only from the exact scoped session", async () => {
  const fixture = await makeInputFixture();
  try {
    const stub = makeJourneyStub(fixture);
    const baseEnv = fixture.env({ GHATANA_MEDIA_CHUNK_BYTES: String(CHUNK_BYTES) });
    const checkpoint = await runHeadlessApiExample({
      env: { ...baseEnv, GHATANA_MEDIA_MAX_CHUNKS_THIS_RUN: "1" }, fetchImpl: stub.fetchImpl,
    });
    assert.equal(checkpoint.interrupted, true);
    assert.equal(checkpoint.upload.uploadId, "upload-1");
    assert.equal(checkpoint.upload.bytesReceived, CHUNK_BYTES);
    assert.equal(checkpoint.upload.nextChunkIndex, 1);
    assert.deepEqual(stub.counts, { chunkWrites: 1, completions: 0, jobSubmits: 0, jobReads: 0 });

    const resumed = await runHeadlessApiExample({
      env: { ...baseEnv, GHATANA_MEDIA_UPLOAD_ID: checkpoint.upload.uploadId }, fetchImpl: stub.fetchImpl,
    });
    assert.equal(resumed.artifact.sha256, fixture.digest);
    assert.equal(resumed.artifact.sizeBytes, fixture.input.length);
    assert.equal(resumed.job.status, "COMPLETED");
    assert.equal(stub.calls.filter((call) => call === "POST /api/v1/artifacts/uploads").length, 1);
    assert.ok(stub.calls.includes("GET /api/v1/artifacts/uploads/upload-1"));
    assert.equal(stub.counts.completions, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("public SDK refuses a resumed session with a different upload identity before appending", async () => {
  const fixture = await makeInputFixture();
  try {
    const stub = makeJourneyStub(fixture, {
      uploadRead: (upload) => ({ ...upload, uploadId: "different-upload" }),
    });
    await assert.rejects(runHeadlessApiExample({
      env: fixture.env({ GHATANA_MEDIA_UPLOAD_ID: "upload-1" }), fetchImpl: stub.fetchImpl,
    }));
    assert.deepEqual(stub.counts, { chunkWrites: 0, completions: 0, jobSubmits: 0, jobReads: 0 });
    assert.equal(stub.calls.includes("POST /api/v1/artifacts/uploads"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("public SDK refuses a resumed session with a different retention policy before appending", async () => {
  const fixture = await makeInputFixture();
  try {
    const stub = makeJourneyStub(fixture, {
      uploadRead: (upload) => ({ ...upload, retention: "PT48H" }),
    });
    await assert.rejects(runHeadlessApiExample({
      env: fixture.env({ GHATANA_MEDIA_UPLOAD_ID: "upload-1" }), fetchImpl: stub.fetchImpl,
    }));
    assert.deepEqual(stub.counts, { chunkWrites: 0, completions: 0, jobSubmits: 0, jobReads: 0 });
    assert.equal(stub.calls.includes("POST /api/v1/artifacts/uploads"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("ambiguous chunk recovery stops on a mismatched upload identity without replay or completion", async () => {
  const fixture = await makeInputFixture();
  const stub = makeJourneyStub(fixture, {
    ambiguousFirstChunk: true,
    uploadRead: (upload) => ({ ...upload, uploadId: "different-upload" }),
  });
  try {
    await assert.rejects(runHeadlessApiExample({ env: fixture.env(), fetchImpl: stub.fetchImpl }),
      /upload response identity does not match/u);
    assert.deepEqual(stub.calls, [
      "POST /api/v1/artifacts/uploads",
      "PUT /api/v1/artifacts/uploads/upload-1/chunks/0",
      "GET /api/v1/artifacts/uploads/upload-1",
    ]);
    assert.deepEqual(stub.counts, { chunkWrites: 1, completions: 0, jobSubmits: 0, jobReads: 0 });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("ambiguous chunk recovery stops when readback shows no append and never replays", async () => {
  const fixture = await makeInputFixture();
  const stub = makeJourneyStub(fixture, { ambiguousFirstChunk: true, acceptAmbiguousChunk: false });
  try {
    await assert.rejects(runHeadlessApiExample({ env: fixture.env(), fetchImpl: stub.fetchImpl }),
      (error) => error.name === "MediaOperationAmbiguousError");
    assert.deepEqual(stub.calls, [
      "POST /api/v1/artifacts/uploads",
      "PUT /api/v1/artifacts/uploads/upload-1/chunks/0",
      "GET /api/v1/artifacts/uploads/upload-1",
    ]);
    assert.deepEqual(stub.counts, { chunkWrites: 1, completions: 0, jobSubmits: 0, jobReads: 0 });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("OUTCOME_UNKNOWN remains unknown and stops job polling immediately", async () => {
  const fixture = await makeInputFixture();
  const stub = makeJourneyStub(fixture, { jobStatus: "OUTCOME_UNKNOWN" });
  try {
    const result = await runHeadlessApiExample({ env: fixture.env(), fetchImpl: stub.fetchImpl });
    assert.equal(result.job.status, "OUTCOME_UNKNOWN");
    assert.equal(stub.counts.jobSubmits, 1);
    assert.equal(stub.counts.jobReads, 1);
    assert.deepEqual(stub.calls.slice(-2), [
      "POST /api/v1/jobs",
      `GET /api/v1/jobs/job-1?requestId=${encodeURIComponent(result.job.requestId)}`,
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("zero wait returns one job observation and bounded timeout returns its last status", async () => {
  const zeroWaitFixture = await makeInputFixture();
  const zeroWaitStub = makeJourneyStub(zeroWaitFixture, { jobStatus: "RUNNING" });
  try {
    const result = await runHeadlessApiExample({
      env: zeroWaitFixture.env({ GHATANA_MEDIA_JOB_WAIT_MS: "0" }),
      fetchImpl: zeroWaitStub.fetchImpl,
    });
    assert.equal(result.job.status, "RUNNING");
    assert.equal(zeroWaitStub.counts.jobSubmits, 1);
    assert.equal(zeroWaitStub.counts.jobReads, 1);
  } finally {
    await rm(zeroWaitFixture.directory, { recursive: true, force: true });
  }

  const timeoutFixture = await makeInputFixture();
  const timeoutStub = makeJourneyStub(timeoutFixture, { jobStatus: "ACCEPTED" });
  try {
    const result = await runHeadlessApiExample({
      env: timeoutFixture.env({
        GHATANA_MEDIA_JOB_WAIT_MS: "30",
        GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "5",
      }),
      fetchImpl: timeoutStub.fetchImpl,
    });
    assert.equal(result.job.status, "ACCEPTED");
    assert.equal(timeoutStub.counts.jobSubmits, 1);
    assert.ok(timeoutStub.counts.jobReads > 1 && timeoutStub.counts.jobReads < 20);
    assert.equal(timeoutStub.calls.filter((call) => call === "POST /api/v1/jobs").length, 1);
  } finally {
    await rm(timeoutFixture.directory, { recursive: true, force: true });
  }
});

test("hung poll read is aborted and returns the last confirmed job status", async () => {
  const fixture = await makeInputFixture();
  let pollSignal;
  const stub = makeJourneyStub(fixture, {
    jobRead: ({ count, job, signal }) => {
      if (count === 1) return response({ ...job, status: "RUNNING" });
      pollSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  try {
    const result = await runHeadlessApiExample({
      env: fixture.env({
        GHATANA_MEDIA_JOB_WAIT_MS: "1000",
        GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "1",
        GHATANA_MEDIA_JOB_READ_TIMEOUT_MS: "10",
      }),
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(result.job.status, "RUNNING");
    assert.equal(stub.counts.jobSubmits, 1);
    assert.equal(stub.counts.jobReads, 2);
    assert.equal(pollSignal.aborted, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("slow first status read is capped by the poll budget and falls back to submit status", async () => {
  const fixture = await makeInputFixture();
  let firstReadSignal;
  const stub = makeJourneyStub(fixture, {
    jobRead: ({ job, signal }) => {
      firstReadSignal = signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response({ ...job, status: "RUNNING" })), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  try {
    const result = await runHeadlessApiExample({
      env: fixture.env({
        GHATANA_MEDIA_JOB_WAIT_MS: "10",
        GHATANA_MEDIA_JOB_READ_TIMEOUT_MS: "1000",
      }),
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(result.job.status, "ACCEPTED");
    assert.equal(stub.counts.jobSubmits, 1);
    assert.equal(stub.counts.jobReads, 1);
    assert.equal(firstReadSignal.aborted, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("invalid job wait and poll values fail before network access", async () => {
  const fixture = await makeInputFixture();
  const invalidSettings = [
    { GHATANA_MEDIA_JOB_WAIT_MS: "-1" },
    { GHATANA_MEDIA_JOB_WAIT_MS: "1.5" },
    { GHATANA_MEDIA_JOB_WAIT_MS: "NaN" },
    { GHATANA_MEDIA_JOB_WAIT_MS: "300001" },
    { GHATANA_MEDIA_JOB_READ_TIMEOUT_MS: "0" },
    { GHATANA_MEDIA_JOB_READ_TIMEOUT_MS: "300001" },
    { GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "0" },
    { GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "-5" },
    { GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "1.5" },
    { GHATANA_MEDIA_JOB_POLL_INTERVAL_MS: "NaN" },
  ];
  let dispatches = 0;
  try {
    for (const settings of invalidSettings) {
      await assert.rejects(runHeadlessApiExample({
        env: fixture.env(settings),
        fetchImpl: async () => {
          dispatches += 1;
          throw new Error("invalid polling configuration must fail before network access");
        },
      }));
    }
    assert.equal(dispatches, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("unsupported extension and content type fail before opening or uploading input", async () => {
  let dispatched = false;
  const baseEnv = {
    GHATANA_MEDIA_BASE_URL: "http://127.0.0.1:8080",
    GHATANA_MEDIA_TENANT_ID: "tenant-1",
    GHATANA_MEDIA_PRINCIPAL_ID: "principal-1",
    GHATANA_MEDIA_BEARER_TOKEN: "supplied-host-token",
  };
  await assert.rejects(runHeadlessApiExample({
    env: {
      ...baseEnv,
      GHATANA_MEDIA_INPUT_FILE: "/missing/unrecognized.bin",
    },
    fetchImpl: async () => {
      dispatched = true;
      throw new Error("unexpected request");
    },
  }), /Input file extension\/content type does not identify a supported Media format claim/u);
  await assert.rejects(runHeadlessApiExample({
    env: { ...baseEnv, GHATANA_MEDIA_INPUT_FILE: "/missing/sample.wav", GHATANA_MEDIA_CONTENT_TYPE: "text/plain" },
    fetchImpl: async () => {
      dispatched = true;
      throw new Error("unexpected request");
    },
  }), /Input content type is not supported by the local Media artifact verification profile/u);
  await assert.rejects(runHeadlessApiExample({
    env: {
      ...baseEnv,
      GHATANA_MEDIA_INPUT_FILE: "/missing/sample.wav",
      GHATANA_MEDIA_CHUNK_BYTES: String(32 * 1024 * 1024 + 1),
    },
    fetchImpl: async () => {
      dispatched = true;
      throw new Error("unexpected request");
    },
  }), /GHATANA_MEDIA_CHUNK_BYTES must not exceed the Media host maximum of 33554432 bytes/u);
  assert.equal(dispatched, false);
});
