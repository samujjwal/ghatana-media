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

function artifactInspectArgs(endpoint = "https://media.example.test") {
  return ["artifact", "inspect", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a", "--artifact", "artifact-a"];
}

function jobStatusArgs(endpoint = "https://media.example.test") {
  return ["job", "status", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a", "--job", "job-1"];
}

function jobSubmitArgs(endpoint = "https://media.example.test") {
  return ["job", "submit", "--endpoint", endpoint, "--tenant", "tenant-a", "--principal", "principal-a",
    "--request-id", "request-1", "--correlation-id", "corr-1", "--artifact", "artifact-a",
    "--job-type", "SPEECH_TO_TEXT", "--idempotency-key", "stable-key-1", "--parameters", "{}"];
}

// The production `ghatanamedia-api` channel is intentionally limited to `artifact inspect`
// (the authenticated job status/submit CLI was reverted). Job, capture and recorder
// commands exist only in the loopback DEV_ONLY channel, so the production channel must
// fail closed locally and never dispatch a request or imply success.
test("production CLI exposes no job, capture or recorder commands and never dispatches them", async () => {
  await withFixture("success", async (fixture) => {
    const commands = [
      jobStatusArgs(),
      jobSubmitArgs(),
      ["capture", "start", "--endpoint", "https://media.example.test", "--tenant", "tenant-a", "--principal", "principal-a"],
      ["recorder", "start", "--endpoint", "https://media.example.test", "--tenant", "tenant-a", "--principal", "principal-a"],
    ];
    for (const args of commands) {
      const result = await invoke(args, fixture);
      assert.equal(result.status, 2, args.slice(0, 2).join(" "));
      assert.equal(result.stdout, "");
      const report = JSON.parse(result.stderr);
      assert.equal(report.code, "INVALID_INVOCATION");
      assert.equal(report.commandId, "media.cli.invocation");
      assert.ok(!result.stderr.includes(token));
    }
    assert.equal((await requests(fixture.log)).length, 0);
  });
});

test("a forbidden artifact observation is a non-success with no token echo", async () => {
  await withFixture("artifact-forbidden", async (fixture) => {
    const result = await invoke(artifactInspectArgs(), fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr);
    assert.equal(report.commandId, "media.cli.artifact.inspect");
    assert.equal(report.code, "MEDIA_REQUEST_FAILED");
    assert.equal(report.statusCode, 403);
    assert.ok(!result.stderr.includes(token));
    const [request] = await requests(fixture.log);
    assert.equal(request.path, "/api/v1/artifacts/artifact-a");
    assert.equal(request.method, "GET");
    assert.equal(request.tenant, "tenant-a");
    assert.equal(request.principal, "principal-a");
    assert.equal(request.authenticated, true);
  });
});

test("an unreachable endpoint reports no observation instead of guessing success", async () => {
  await withFixture("artifact-timeout", async (fixture) => {
    const result = await invoke(artifactInspectArgs(), fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "OBSERVATION_UNAVAILABLE");
    assert.ok(!result.stderr.includes(token));
  });
});

test("a schema-invalid artifact response exits nonzero without printing response content", async () => {
  await withFixture("artifact-malformed-json", async (fixture) => {
    const result = await invoke(artifactInspectArgs(), fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "INVALID_MEDIA_RESPONSE");
    assert.ok(!result.stderr.includes('"artifactId"'));
    assert.ok(!result.stderr.includes(token));
  });
});

test("strict argument errors are local and do not call the server", async () => {
  await withFixture("success", async (fixture) => {
    const unknown = await invoke([...artifactInspectArgs(), "--force", "yes"], fixture);
    assert.equal(unknown.status, 2);
    assert.equal(JSON.parse(unknown.stderr).code, "INVALID_INVOCATION");
    const missing = await invoke(artifactInspectArgs().slice(0, -2), fixture);
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stderr).code, "INVALID_INVOCATION");
    assert.equal((await requests(fixture.log)).length, 0);
  });
});
