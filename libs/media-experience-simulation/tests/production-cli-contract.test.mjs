import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../../audio-video-client/dist/cli.js", import.meta.url));
const fetchFixture = fileURLToPath(new URL("../../audio-video-client/src/__fixtures__/cli-fetch.mjs", import.meta.url));
const token = "production-cli-contract-test-token";
const timestamp = "2026-11-05T12:00:00.000Z";
const job = {
  jobId: "job-1", requestId: "request-1", tenantId: "tenant-a", principalId: "principal-a",
  artifactId: "artifact-a", jobType: "SPEECH_TO_TEXT", providerId: null, status: "OUTCOME_UNKNOWN",
  createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null,
  version: 2, expectedArtifactVersion: "", requestFingerprint: "sha256:" + "f".repeat(64),
};

async function withFixture(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), "media-production-cli-contract-"));
  const log = join(directory, "requests.jsonl");
  const state = join(directory, "state.json");
  try { await run({ mode, log, state }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function invoke(args, { mode, log, state } = {}, timeoutMillis = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", fetchFixture, cliPath, ...args], {
      env: {
        ...process.env,
        GHATANA_MEDIA_BEARER_TOKEN: token,
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: mode,
        GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(["success", "restart"].includes(mode) ? { ...job, status: "ACCEPTED" } : job),
        GHATANA_MEDIA_CLI_TEST_STATE: state,
        GHATANA_MEDIA_CLI_TEST_LOG: log,
        ...(mode === "timeout" ? { GHATANA_MEDIA_REQUEST_TIMEOUT_MS: "50" } : {}),
      },
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

async function requests(log) {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function jobStatusArgs(endpoint = "https://media.example.test") {
  return ["job", "status", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a", "--job", "job-1"];
}

function jobSubmitArgs(endpoint = "https://media.example.test") {
  return ["job", "submit", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a",
    "--request-id", "request-1", "--correlation-id", "corr-1", "--artifact", "artifact-a",
    "--job-type", "SPEECH_TO_TEXT", "--idempotency-key", "stable-key-1", "--parameters", "{}"];
}

test("canonical CLI reports an unknown job state as an observation, never guessed success", async () => {
  await withFixture("unknown", async (fixture) => {
    const result = await invoke(jobStatusArgs(), fixture);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    assert.equal(report.schemaVersion, "media.cli-error.v1");
    assert.equal(report.commandId, "media.cli.job.status");
    assert.equal(report.code, "OUTCOME_UNKNOWN");
    assert.equal(report.jobId, "job-1");
    assert.equal(report.requestId, "request-1");
    assert.ok(!result.stderr.includes(token));
    const [request] = await requests(fixture.log);
    assert.equal(request.path, "/api/v1/jobs/job-1");
    assert.equal(request.method, "GET");
    assert.equal(request.tenant, "tenant-a");
    assert.equal(request.principal, "principal-a");
    assert.equal(request.authenticated, true);
    assert.ok(!result.stdout.includes(token));
  });
});

test("forbidden and unsupported capture/recorder commands fail with exact non-success semantics", async () => {
  await withFixture("forbidden", async (fixture) => {
    const forbidden = await invoke(jobStatusArgs(), fixture);
    assert.equal(forbidden.status, 1);
    assert.equal(forbidden.stdout, "");
    assert.equal(JSON.parse(forbidden.stderr).code, "MEDIA_REQUEST_FAILED");
    assert.ok(!forbidden.stderr.includes(token));

    const capture = await invoke(["capture", "start", "--endpoint", "https://media.example.test", "--tenant", "tenant-a", "--principal", "principal-a"], fixture);
    const recorder = await invoke(["recorder", "start", "--endpoint", "https://media.example.test", "--tenant", "tenant-a", "--principal", "principal-a"], fixture);
    for (const result of [capture, recorder]) {
      assert.equal(result.status, 3);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).code, "NOT_ADMITTED");
    }
    assert.equal((await requests(fixture.log)).length, 1); // unsupported commands never dispatch
  });
});

test("a lost submit acknowledgment after dispatch is OUTCOME_UNKNOWN with stable request identity", async () => {
  await withFixture("timeout", async (fixture) => {
    const result = await invoke(jobSubmitArgs(), fixture, 10_000);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    assert.equal(report.code, "OUTCOME_UNKNOWN");
    const [request] = await requests(fixture.log);
    assert.equal(report.requestId, request.requestId);
    assert.equal(report.requestKey, "stable-key-1");
    assert.match(report.message, /reconcile before retrying/u);
    assert.equal(request.path, "/api/v1/jobs");
    assert.equal(request.method, "POST");
    assert.equal(request.authenticated, true);
    assert.equal(request.idempotencyKey, "stable-key-1");
    assert.ok(!result.stderr.includes(token));
  });
});

test("schema-invalid canonical response exits nonzero without printing response content", async () => {
  await withFixture("malformed", async (fixture) => {
    const result = await invoke(jobStatusArgs(), fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "INVALID_MEDIA_RESPONSE");
    assert.ok(!result.stderr.includes("privateField"));
    assert.ok(!result.stderr.includes("do-not-print"));
    assert.ok(!result.stderr.includes(token));
  });
});

test("a restarted process reuses the caller's idempotency key and gets the same job", async () => {
  await withFixture("restart", async (fixture) => {
    const first = await invoke(jobSubmitArgs(), fixture);
    const restarted = await invoke(jobSubmitArgs(), fixture);
    assert.equal(first.status, 0);
    assert.equal(restarted.status, 0);
    assert.equal(JSON.parse(first.stdout).job.jobId, JSON.parse(restarted.stdout).job.jobId);
    assert.equal(JSON.parse(first.stdout).job.status, "ACCEPTED");
    const loggedRequests = await requests(fixture.log);
    assert.equal(loggedRequests.length, 2);
    assert.deepEqual(loggedRequests.map((request) => request.idempotencyKey), ["stable-key-1", "stable-key-1"]);
    const state = JSON.parse(await readFile(fixture.state, "utf8"));
    assert.equal(state.effectCount, 1);
  });
});

test("strict argument and request JSON errors are local and do not call the server", async () => {
  await withFixture("success", async (fixture) => {
    const unknown = await invoke([...jobStatusArgs(), "--force"], fixture);
    assert.equal(unknown.status, 2);
    assert.equal(JSON.parse(unknown.stderr).code, "INVALID_INVOCATION");
    const malformedJson = await invoke([...jobSubmitArgs().slice(0, -1), "{"], fixture);
    assert.equal(malformedJson.status, 2);
    assert.equal(JSON.parse(malformedJson.stderr).code, "INVALID_INVOCATION");
    assert.equal((await requests(fixture.log)).length, 0);
  });
});
