import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MediaOperationAmbiguousError } from "@audio-video/client/operations";
import { MediaOperationClient } from "@audio-video/client/operations";
import { MediaCanonicalClient } from "@audio-video/client/canonical-operations";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
// The launcher caps MEDIA_MAX_BODY_BYTES at 32 MiB and requires
// MEDIA_MAX_CHUNK_BYTES <= MEDIA_MAX_BODY_BYTES.
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_JOB_WAIT_MS = 30_000;
const DEFAULT_JOB_POLL_INTERVAL_MS = 1_000;
const DEFAULT_JOB_READ_TIMEOUT_MS = 30_000;
const MAX_JOB_WAIT_MS = 5 * 60 * 1_000;
const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const FORMAT_BY_EXTENSION = new Map([
  ["png", "png"], ["jpg", "jpeg"], ["jpeg", "jpeg"], ["gif", "gif"], ["webp", "webp"],
  ["mp4", "iso-bmff"], ["m4v", "iso-bmff"], ["mov", "iso-bmff"], ["m4a", "iso-bmff"],
  ["webm", "webm"], ["mkv", "webm"], ["ogg", "ogg"], ["ogv", "ogg"],
  ["mp3", "mp3"], ["wav", "wav"], ["pdf", "pdf"],
]);
const FORMAT_BY_CONTENT_TYPE = new Map([
  ["image/png", "png"], ["image/jpeg", "jpeg"], ["image/gif", "gif"], ["image/webp", "webp"],
  ["video/mp4", "iso-bmff"], ["audio/mp4", "iso-bmff"], ["application/mp4", "iso-bmff"],
  ["video/quicktime", "iso-bmff"], ["video/webm", "webm"], ["audio/webm", "webm"],
  ["audio/ogg", "ogg"], ["video/ogg", "ogg"], ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["application/pdf", "pdf"],
]);

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function sameUploadContent(left, right) {
  return left.uploadId === right.uploadId
    && left.tenantId === right.tenantId
    && left.principalId === right.principalId
    && left.fileName === right.fileName
    && left.contentType === right.contentType
    && left.expectedSizeBytes === right.expectedSizeBytes
    && left.expectedSha256 === right.expectedSha256
    && left.classification === right.classification
    && left.retention === right.retention
    && isDeepStrictEqual(left.metadata, right.metadata);
}

async function readJobWithTimeout(canonical, jobId, requestId, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timedRead = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      canonical.getJobByRequest(jobId, requestId, controller.signal)
        .then((job) => ({ timedOut: false, job })),
      timedRead,
    ]);
    return outcome.timedOut ? undefined : outcome.job;
  } catch (error) {
    if (timedOut) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    if (!timedOut) controller.abort();
  }
}

async function readJobUntilTerminal(canonical, initialJob, requestId, waitMs, pollIntervalMs, readTimeoutMs) {
  const deadline = performance.now() + waitMs;
  let job = initialJob;
  const firstReadTimeout = waitMs > 0 ? Math.min(readTimeoutMs, waitMs) : readTimeoutMs;
  const firstRead = await readJobWithTimeout(canonical, job.jobId, requestId, firstReadTimeout);
  if (!firstRead) return job;
  job = firstRead;
  while (!TERMINAL_JOB_STATUSES.has(job.status) && job.status !== "OUTCOME_UNKNOWN") {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return job;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    const readBudgetMs = deadline - performance.now();
    if (readBudgetMs <= 0) return job;
    const nextRead = await readJobWithTimeout(
      canonical, job.jobId, requestId, Math.min(readTimeoutMs, readBudgetMs),
    );
    if (!nextRead) return job;
    job = nextRead;
  }
  return job;
}

function requireSupportedFormatClaim(fileName, contentType) {
  const extension = fileName.includes(".") ? fileName.split(".").at(-1).toLowerCase() : "";
  const extensionFormat = FORMAT_BY_EXTENSION.get(extension);
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  const contentTypeFormat = FORMAT_BY_CONTENT_TYPE.get(normalizedType);
  if (normalizedType !== "application/octet-stream" && !contentTypeFormat) {
    throw new Error("Input content type is not supported by the local Media artifact verification profile.");
  }
  if (!extensionFormat && !contentTypeFormat) {
    throw new Error("Input file extension/content type does not identify a supported Media format claim.");
  }
  if (extensionFormat && contentTypeFormat && extensionFormat !== contentTypeFormat) {
    throw new Error("Input file extension conflicts with its declared content type.");
  }
}

async function readExact(file, buffer, position, length, description) {
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await file.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) throw new Error(`Input changed or ended while ${description}.`);
    bytesRead += result.bytesRead;
  }
}

/**
 * Run the public SDK upload and readback journey. fetchImpl is injectable for
 * contract tests; normal consumers should use the host's global fetch.
 */
export async function runHeadlessApiExample({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = requiredEnv(env, "GHATANA_MEDIA_BASE_URL");
  const tenantId = requiredEnv(env, "GHATANA_MEDIA_TENANT_ID");
  const principalId = requiredEnv(env, "GHATANA_MEDIA_PRINCIPAL_ID");
  const bearerToken = requiredEnv(env, "GHATANA_MEDIA_BEARER_TOKEN");
  const inputPath = requiredEnv(env, "GHATANA_MEDIA_INPUT_FILE");
  const chunkBytes = positiveInteger(env.GHATANA_MEDIA_CHUNK_BYTES, "GHATANA_MEDIA_CHUNK_BYTES", DEFAULT_CHUNK_BYTES);
  const maxChunksThisRun = positiveInteger(env.GHATANA_MEDIA_MAX_CHUNKS_THIS_RUN,
    "GHATANA_MEDIA_MAX_CHUNKS_THIS_RUN", Number.MAX_SAFE_INTEGER);
  const jobWaitMs = nonNegativeInteger(env.GHATANA_MEDIA_JOB_WAIT_MS, "GHATANA_MEDIA_JOB_WAIT_MS", DEFAULT_JOB_WAIT_MS);
  const jobPollIntervalMs = positiveInteger(env.GHATANA_MEDIA_JOB_POLL_INTERVAL_MS,
    "GHATANA_MEDIA_JOB_POLL_INTERVAL_MS", DEFAULT_JOB_POLL_INTERVAL_MS);
  const jobReadTimeoutMs = positiveInteger(env.GHATANA_MEDIA_JOB_READ_TIMEOUT_MS,
    "GHATANA_MEDIA_JOB_READ_TIMEOUT_MS", DEFAULT_JOB_READ_TIMEOUT_MS);
  if (jobWaitMs > MAX_JOB_WAIT_MS) {
    throw new Error("GHATANA_MEDIA_JOB_WAIT_MS must not exceed 300000 milliseconds.");
  }
  if (jobReadTimeoutMs > MAX_JOB_WAIT_MS) {
    throw new Error("GHATANA_MEDIA_JOB_READ_TIMEOUT_MS must not exceed 300000 milliseconds.");
  }
  if (chunkBytes > MAX_CHUNK_BYTES) {
    throw new Error("GHATANA_MEDIA_CHUNK_BYTES must not exceed the Media host maximum of 33554432 bytes.");
  }
  const fileName = basename(inputPath);
  const contentType = env.GHATANA_MEDIA_CONTENT_TYPE?.trim() || "application/octet-stream";
  requireSupportedFormatClaim(fileName, contentType);
  const input = await open(inputPath, "r");
  try {
    const { size: inputBytes } = await input.stat();
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > MAX_INPUT_BYTES) {
      throw new Error("Input must contain between 1 byte and 2 GiB.");
    }

    const digest = createHash("sha256");
    const hashBlock = Buffer.allocUnsafe(Math.min(chunkBytes, inputBytes));
    for (let position = 0; position < inputBytes;) {
      const length = Math.min(hashBlock.length, inputBytes - position);
      await readExact(input, hashBlock, position, length, "its digest was being calculated");
      digest.update(hashBlock.subarray(0, length));
      position += length;
    }

    const clientConfig = {
      baseUrl,
      tenantId,
      defaultHeaders: { "X-Principal-Id": principalId },
      getAccessToken: () => bearerToken,
      fetchImpl,
    };
    const operations = new MediaOperationClient(clientConfig);
    const canonical = new MediaCanonicalClient(clientConfig);
    const expectedSha256 = digest.digest("hex");
    const uploadId = env.GHATANA_MEDIA_UPLOAD_ID?.trim();
    const requestedRetention = "PT24H";
    let session = uploadId
      ? await operations.getUploadSession(uploadId)
      : await operations.createUploadSession({
        fileName,
        contentType,
        expectedSizeBytes: inputBytes,
        expectedSha256,
        classification: "INTERNAL",
        retention: requestedRetention,
        metadata: { source: "media-headless-api-example" },
        idempotencyKey: randomUUID(),
      });
    if (session.fileName !== fileName || session.contentType !== contentType
      || session.expectedSizeBytes !== inputBytes || session.expectedSha256 !== expectedSha256
      || session.classification !== "INTERNAL" || session.retention !== requestedRetention
      || !isDeepStrictEqual(session.metadata, { source: "media-headless-api-example" })
      || session.status !== "OPEN" || session.bytesReceived > inputBytes) {
      throw new Error("Upload session does not match the exact local source and requested scope.");
    }
    let chunksThisRun = 0;

    while (session.bytesReceived < inputBytes) {
      const start = session.bytesReceived;
      const length = Math.min(chunkBytes, inputBytes - start);
      const chunk = Buffer.allocUnsafe(length);
      await readExact(input, chunk, start, length, "its chunks were being uploaded");
      const chunkIndex = session.nextChunkIndex;
      try {
        session = await operations.uploadPart(session, chunkIndex, new Blob([chunk]));
      } catch (error) {
        if (!(error instanceof MediaOperationAmbiguousError)) throw error;
        // The chunk endpoint has no replay-safe idempotency key. Read the
        // caller-scoped session and continue only if it confirms this append.
        const observed = await operations.getUploadSession(session.uploadId);
        if (!sameUploadContent(observed, session)) {
          throw new Error("Upload recovery read returned a different upload identity.");
        }
        if (observed.bytesReceived !== start + length
          || observed.nextChunkIndex !== chunkIndex + 1 || observed.status !== "OPEN") {
          throw error;
        }
        session = observed;
      }
      chunksThisRun += 1;
      if (chunksThisRun >= maxChunksThisRun && session.bytesReceived < inputBytes) {
        return { upload: { uploadId: session.uploadId, bytesReceived: session.bytesReceived,
          nextChunkIndex: session.nextChunkIndex, status: session.status }, interrupted: true };
      }
    }

    const completedArtifact = await operations.completeUploadSession(session);
    const artifact = await operations.getArtifact(completedArtifact.artifactId);

    const requestId = randomUUID();
    const submittedJob = await canonical.submitJob({
      requestId,
      correlationId: randomUUID(),
      artifactId: artifact.artifactId,
      jobType: "TRANSCODE",
      providerHint: "local-diagnostic",
      parameters: {},
      idempotencyKey: randomUUID(),
    });
    const job = await readJobUntilTerminal(
      canonical, submittedJob, requestId, jobWaitMs, jobPollIntervalMs, jobReadTimeoutMs,
    );

    return {
      artifact: {
        artifactId: artifact.artifactId,
        fileName: artifact.fileName,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      },
      job: {
        jobId: job.jobId,
        requestId: job.requestId,
        jobType: job.jobType,
        status: job.status,
        providerId: job.providerId,
      },
    };
  } finally {
    await input.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHeadlessApiExample()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`Media headless API example failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
}
