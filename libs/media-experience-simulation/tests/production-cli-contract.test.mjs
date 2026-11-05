import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../../audio-video-client/dist/cli.js", import.meta.url));
const token = "production-cli-contract-test-token";
const timestamp = "2026-11-05T12:00:00.000Z";
const job = {
  jobId: "job-1", requestId: "request-1", tenantId: "tenant-a", principalId: "principal-a",
  artifactId: "artifact-a", jobType: "SPEECH_TO_TEXT", providerId: null, status: "OUTCOME_UNKNOWN",
  createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null,
  version: 2, expectedArtifactVersion: "", requestFingerprint: "sha256:" + "f".repeat(64),
};

function invoke(args, timeoutMillis = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMillis);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`, server); }
  finally { await new Promise((resolve) => server.close(() => resolve())); }
}

function jobStatusArgs(endpoint) {
  return ["job", "status", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a", "--job", "job-1"];
}

function jobSubmitArgs(endpoint) {
  return ["job", "submit", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a",
    "--request-id", "request-1", "--correlation-id", "corr-1", "--artifact", "artifact-a",
    "--job-type", "SPEECH_TO_TEXT", "--idempotency-key", "stable-key-1", "--parameters", "{}"];
}

test("canonical CLI reports an unknown job state as an observation, never guessed success", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/v1/jobs/job-1");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["x-tenant-id"], "tenant-a");
    assert.equal(request.headers["x-principal-id"], "principal-a");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(job));
  }, async (endpoint) => {
    const result = await invoke(jobStatusArgs(endpoint));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, "media.cli-result.v1");
    assert.equal(report.commandId, "media.cli.job.status");
    assert.equal(report.job.status, "OUTCOME_UNKNOWN");
    assert.equal(report.job.completedAt, null);
    assert.equal(requests, 1);
    assert.ok(!result.stdout.includes(token));
  });
});

test("forbidden and unsupported capture/recorder commands fail with exact non-success semantics", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests++;
    response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ code: "FORBIDDEN", message: "denied" }));
  }, async (endpoint) => {
    const forbidden = await invoke(jobStatusArgs(endpoint));
    assert.equal(forbidden.status, 1);
    assert.equal(forbidden.stdout, "");
    assert.equal(JSON.parse(forbidden.stderr).code, "MEDIA_REQUEST_FAILED");
    assert.ok(!forbidden.stderr.includes(token));

    const capture = await invoke(["capture", "start", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a"]);
    const recorder = await invoke(["recorder", "start", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a"]);
    for (const result of [capture, recorder]) {
      assert.equal(result.status, 3);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).code, "NOT_ADMITTED");
    }
    assert.equal(requests, 1); // forbidden read only; unsupported commands never dispatch
  });
});

test("a lost submit acknowledgment after dispatch is OUTCOME_UNKNOWN with stable request identity", async () => {
  let requests = 0;
  let dispatchedRequestId;
  await withServer((request, response) => {
    requests++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/jobs");
    assert.equal(request.headers["idempotency-key"], "stable-key-1");
    dispatchedRequestId = request.headers["x-request-id"];
    request.resume();
    request.on("end", () => response.destroy());
  }, async (endpoint) => {
    const result = await invoke(jobSubmitArgs(endpoint));
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    assert.equal(report.code, "OUTCOME_UNKNOWN");
    assert.equal(report.requestId, dispatchedRequestId);
    assert.equal(report.requestKey, "stable-key-1");
    assert.match(report.message, /reconcile before retrying/u);
    assert.equal(requests, 1);
    assert.ok(!result.stderr.includes(token));
  });
});

test("schema-invalid canonical response exits nonzero without printing response content", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...job, jobId: 3, privateField: "do-not-print" }));
  }, async (endpoint) => {
    const result = await invoke(jobStatusArgs(endpoint));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "INVALID_MEDIA_RESPONSE");
    assert.ok(!result.stderr.includes("privateField"));
    assert.ok(!result.stderr.includes("do-not-print"));
    assert.ok(!result.stderr.includes(token));
  });
});

test("a restarted process reuses the caller's idempotency key and gets the same job", async () => {
  let requests = 0;
  let effects = 0;
  const receipts = new Map();
  await withServer((request, response) => {
    requests++;
    const key = request.headers["idempotency-key"];
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const identity = `${request.headers["x-tenant-id"]}\u0000${key}`;
      if (!receipts.has(identity)) {
        effects++;
        receipts.set(identity, { ...job, status: "ACCEPTED", requestId: JSON.parse(body).requestId });
      }
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify(receipts.get(identity)));
    });
  }, async (endpoint) => {
    const first = await invoke(jobSubmitArgs(endpoint));
    const restarted = await invoke(jobSubmitArgs(endpoint));
    assert.equal(first.status, 0);
    assert.equal(restarted.status, 0);
    assert.equal(JSON.parse(first.stdout).job.jobId, JSON.parse(restarted.stdout).job.jobId);
    assert.equal(JSON.parse(first.stdout).job.status, "ACCEPTED");
    assert.equal(requests, 2);
    assert.equal(effects, 1);
  });
});

test("strict argument and request JSON errors are local and do not call the server", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(job));
  }, async (endpoint) => {
    const unknown = await invoke([...jobStatusArgs(endpoint), "--force"]);
    assert.equal(unknown.status, 2);
    assert.equal(JSON.parse(unknown.stderr).code, "INVALID_INVOCATION");
    const malformedJson = await invoke([...jobSubmitArgs(endpoint).slice(0, -1), "{" ]);
    assert.equal(malformedJson.status, 2);
    assert.equal(JSON.parse(malformedJson.stderr).code, "INVALID_INVOCATION");
    assert.equal(requests, 0);
  });
});
