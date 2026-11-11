import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const execFile = promisify(execFileCallback);
const repoRoot = process.cwd();
const appRoot = resolve(repoRoot, "apps/media-experience-explorer");
const token = requiredEnv("MEDIA_DEV_RECOVERY_BROWSER_TOKEN");
const expectedTenant = requiredEnv("MEDIA_DEV_RECOVERY_BROWSER_TENANT");
const expectedPrincipal = requiredEnv("MEDIA_DEV_RECOVERY_BROWSER_PRINCIPAL");
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_RECOVERY_PROXY_PORT"));
const viteBinary = requiredEnv("MEDIA_DEV_VITE_BINARY");
const playwrightModule = requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE");
const expectedViteVersion = requiredEnv("MEDIA_DEV_VITE_VERSION");
const vitePort = positivePort(requiredEnv("MEDIA_DEV_RECOVERY_VITE_PORT"));
const fileName = requiredEnv("MEDIA_DEV_RECOVERY_FILE_NAME");
const expectedSize = Number(requiredEnv("MEDIA_DEV_RECOVERY_EXPECTED_SIZE"));
const expectedSha256 = requiredEnv("MEDIA_DEV_RECOVERY_EXPECTED_SHA256");
const expectedPlaywrightVersion = "1.63.0";
const expectedChromiumRevision = "1243";
const expectedChromiumVersion = "153.0.8010.12";

const vitePackageRoot = dirname(dirname(await realpath(viteBinary)));
const vitePackage = JSON.parse(await readFile(resolve(vitePackageRoot, "package.json"), "utf8"));
assert.equal(vitePackage.version, expectedViteVersion);
const playwrightEntry = await realpath(playwrightModule);
const playwrightEntryRoot = dirname(playwrightEntry);
const playwrightPackage = JSON.parse(await readFile(resolve(playwrightEntryRoot, "package.json"), "utf8"));
assert.equal(playwrightPackage.version, expectedPlaywrightVersion);
const playwrightRuntimeRoot = playwrightPackage.name === "@playwright/test"
  ? resolve(playwrightEntryRoot, "node_modules/playwright") : playwrightEntryRoot;
const runtimePackage = JSON.parse(await readFile(resolve(playwrightRuntimeRoot, "package.json"), "utf8"));
const coreRoot = resolve(playwrightRuntimeRoot, "../playwright-core");
const corePackage = JSON.parse(await readFile(resolve(coreRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(coreRoot, "browsers.json"), "utf8"));
assert.equal(runtimePackage.version, expectedPlaywrightVersion);
assert.equal(corePackage.version, expectedPlaywrightVersion);
const chromiumPin = manifest.browsers.find((browser) => browser.name === "chromium");
assert.equal(chromiumPin?.revision, expectedChromiumRevision);
assert.equal(chromiumPin?.browserVersion, expectedChromiumVersion);
const { chromium } = await import(playwrightModule);
const chromiumBinary = chromium.executablePath();
assert.ok(chromiumBinary.includes(`chromium-${expectedChromiumRevision}/`));
const chromiumVersion = await execFile(chromiumBinary, ["--version"]);
assert.ok(chromiumVersion.stdout.includes(expectedChromiumVersion));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the upload-recovery browser integration.`);
  return value;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("A valid loopback proxy port is required.");
  return port;
}

function deterministicBytes(size) {
  assert.equal(size, 10 * 1024 * 1024 + 256);
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) & 0xff;
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(size - 44, 40);
  return bytes;
}

function durationSeconds(value) {
  if (typeof value !== "string") return undefined;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

function safeUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return "[unparseable-url]"; }
}

function safeDiagnostic(value) {
  return String(value).split(token).join("[redacted-token]")
    .replace(/https?:\/\/[^\s"'<>]+/gu, (value) => safeUrl(value))
    .replace(/\?[^\s"'<>]*/gu, "?[redacted]");
}

const bytes = deterministicBytes(expectedSize);
const actualSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
assert.equal(actualSha256, expectedSha256);
const viteEnvironment = {
  ...process.env,
  MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort),
  MEDIA_ARTIFACT_PROXY_PORT: String(proxyPort),
};
delete viteEnvironment.MEDIA_DEV_RECOVERY_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot, env: viteEnvironment, stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
const retainViteOutput = (chunk) => { viteOutput = (viteOutput + chunk).slice(-200_000); };
viteProcess.stdout.setEncoding("utf8").on("data", retainViteOutput);
viteProcess.stderr.setEncoding("utf8").on("data", retainViteOutput);

let browser;
let page;
let uploadId;
let lostAcknowledgement;
let confirmedResume = false;
const pageErrors = [];
const consoleErrors = [];
const networkFailures = [];
const apiRequests = [];
const receipts = [];
const diagnostics = () => safeDiagnostic(JSON.stringify({ pageErrors, consoleErrors, networkFailures, apiRequests, receipts, viteOutput: viteOutput.slice(-10_000) }, null, 2));
const readUploadId = () => uploadId;
const apiPath = (request) => {
  try { return new URL(request.url()).pathname; } catch { return ""; }
};

async function connectAndAdmit() {
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Read host context" }).click();
  await page.getByText(expectedTenant, { exact: true }).waitFor();
  await page.getByText(expectedPrincipal, { exact: true }).waitFor();
  await page.getByText("Verified host context admits artifact upload for this DEV_ONLY principal.", { exact: true }).waitFor();
  await page.getByText("The DEV_ONLY token carries artifactRead scope; artifact inspection remains NOT_ADMITTED without a reviewed operation binding.", { exact: true }).waitFor();
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after context verification");
  await page.getByLabel("Source classification").selectOption("INTERNAL");
  await page.getByLabel("Storage retention").selectOption("P30D");
}

try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready.\n${diagnostics()}`);
    try { if ((await fetch(`${baseUrl}/dev-artifact-intake.html`)).ok) { ready = true; break; } }
    catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the real artifact intake page.\n${diagnostics()}`);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => networkFailures.push({ method: request.method(), url: safeUrl(request.url()), error: request.failure()?.errorText ?? "" }));
  page.on("request", (request) => {
    const path = apiPath(request);
    if (path.startsWith("/dev/v1/") || path.startsWith("/api/v1/artifacts/")) {
      apiRequests.push({ method: request.method(), path, origin: new URL(request.url()).origin });
    }
  });
  page.on("response", async (response) => {
    const path = apiPath(response.request());
    if (!path.startsWith("/api/v1/artifacts/")) return;
    try {
      const payload = await response.json();
      receipts.push({ method: response.request().method(), path, status: response.status(), payload });
      if (response.request().method() === "POST" && path === "/api/v1/artifacts/uploads" && response.status() === 201) {
        uploadId = payload.uploadId;
      }
    } catch { /* Aborted and non-JSON responses carry no receipt. */ }
  });
  await page.route("**/api/v1/artifacts/uploads/*/chunks/1", async (route) => {
    const upstream = await route.fetch();
    const responseBytes = await upstream.body();
    lostAcknowledgement = { status: upstream.status(), payload: JSON.parse(responseBytes.toString("utf8")) };
    await route.abort("failed");
  });
  page.on("dialog", async (dialog) => { await dialog.accept(); });

  const pageModule = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname === "/src/dev-artifact-intake.tsx"; }
    catch { return false; }
  });
  await page.goto(`${baseUrl}/dev-artifact-intake.html`);
  assert.ok((await pageModule).status() < 300);
  await connectAndAdmit();
  await page.getByLabel("Choose source media").setInputFiles({ name: fileName, mimeType: "audio/wav", buffer: bytes });
  const beginResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/artifacts/uploads");
  const firstChunkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/chunks/0"));
  await page.getByRole("button", { name: "Upload selected source" }).click();
  const beginResponse = await beginResponsePromise;
  assert.equal(beginResponse.status(), 201);
  const beginReceipt = await beginResponse.json();
  uploadId = beginReceipt.uploadId;
  const firstChunkResponse = await firstChunkResponsePromise;
  assert.equal(firstChunkResponse.status(), 200);
  const firstChunkReceipt = await firstChunkResponse.json();
  await page.waitForFunction(() => {
    const result = document.querySelector("#intake-mount")?.textContent ?? "";
    return result.includes("Upload outcome is unknown") || result.includes("Upload was denied");
  }, undefined, { timeout: 120_000 });
  assert.equal(lostAcknowledgement?.status, 200,
    "the deliberately lost acknowledgement must follow a real successful server response");
  assert.deepEqual([lostAcknowledgement.payload.bytesReceived, lostAcknowledgement.payload.nextChunkIndex],
    [8 * 1024 * 1024, 2], "the server must commit chunk one before its browser acknowledgement is lost");
  assert.ok(readUploadId(), "the exact server uploadId must be captured from the create receipt");
  const beginReceipts = receipts.filter((receipt) => receipt.method === "POST" && receipt.path === "/api/v1/artifacts/uploads");
  assert.equal(beginReceipts.length, 1, "the interrupted transfer must create exactly one server session");
  assert.equal(firstChunkReceipt.bytesReceived, 4 * 1024 * 1024);
  assert.equal(firstChunkReceipt.nextChunkIndex, 1);
  assert.equal(apiRequests.filter((request) => request.method === "PUT" && request.path.includes("/chunks/")).length, 2,
    "only chunk zero and the deliberately aborted chunk one request may occur before reload");

  await page.reload();
  await page.getByLabel("Short-lived DEV_ONLY bearer token").waitFor();
  assert.deepEqual(await page.locator('input[type="file"]').evaluateAll((inputs) =>
    Object.fromEntries(inputs.map((input) => [input.id, input.files?.length ?? 0]))), {
    "media-source-files": 0,
    "existing-upload-source": 0,
  }, "reload must discard both browser file selections");
  assert.equal(await page.locator("#dev-token").inputValue(), "", "reload must discard the token from React/page memory");
  process.stdout.write(`${JSON.stringify({
    event: "partial", uploadId, firstAcknowledgedBytes: firstChunkReceipt.bytesReceived,
    bytesReceived: lostAcknowledgement.payload.bytesReceived,
    nextChunkIndex: lostAcknowledgement.payload.nextChunkIndex, fileName, sizeBytes: expectedSize,
    lostAckStatus: lostAcknowledgement.status, lostAckBytesReceived: lostAcknowledgement.payload.bytesReceived,
    lostAckNextChunkIndex: lostAcknowledgement.payload.nextChunkIndex,
    sha256: expectedSha256, tenantId: expectedTenant, principalId: expectedPrincipal,
    classification: "INTERNAL", retention: "P30D",
  })}\n`);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let restarted = false;
  for await (const line of input) { if (line === "host-restarted") { restarted = true; break; } }
  input.close();
  assert.equal(restarted, true, "Java harness must restart Media after the browser page reloads");

  await connectAndAdmit();
  await page.getByLabel("Choose source file for recovery").setInputFiles({ name: fileName, mimeType: "audio/wav", buffer: bytes });
  const recoveryIdInput = page.getByLabel("Existing upload ID to recover");
  await recoveryIdInput.fill(`${uploadId}-missing`);
  const unknownInspectPromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/artifacts/uploads/${uploadId}-missing`);
  await page.getByRole("button", { name: "Inspect existing upload" }).click();
  assert.equal((await unknownInspectPromise).status(), 404, "unknown upload identity must remain a read-only failure");
  assert.equal(apiRequests.filter((request) => request.method === "PUT" && request.path.includes("/chunks/")).length, 2,
    "an unknown upload ID must not append a chunk");

  await recoveryIdInput.fill(uploadId);
  const inspectResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/artifacts/uploads/${uploadId}`);
  await page.getByRole("button", { name: "Inspect existing upload" }).click();
  const inspectedResponse = await inspectResponsePromise;
  assert.equal(inspectedResponse.status(), 200);
  const inspected = await inspectedResponse.json();
  assert.ok(Number.isFinite(Date.parse(inspected.expiresAt)) && Date.parse(inspected.expiresAt) > Date.now(),
    "the OPEN upload session must still be unexpired; artifact retention is checked separately");
  assert.deepEqual({ uploadId: inspected.uploadId, tenantId: inspected.tenantId, principalId: inspected.principalId,
    fileName: inspected.fileName, contentType: inspected.contentType, expectedSizeBytes: inspected.expectedSizeBytes,
    expectedSha256: inspected.expectedSha256, classification: inspected.classification, status: inspected.status,
    bytesReceived: inspected.bytesReceived, nextChunkIndex: inspected.nextChunkIndex,
    metadata: inspected.metadata }, {
    uploadId, tenantId: expectedTenant, principalId: expectedPrincipal, fileName,
    contentType: "audio/wav", expectedSizeBytes: expectedSize, expectedSha256,
    classification: "INTERNAL", status: "OPEN", bytesReceived: 8 * 1024 * 1024,
    nextChunkIndex: 2, metadata: { classification: "INTERNAL", retention: "P30D", scope: "DEV_ONLY" },
  });
  assert.equal(durationSeconds(inspected.retention), 30 * 86_400,
    "persisted upload retention must be semantically equal to 30 days; its ISO spelling may normalize");
  assert.equal(apiRequests.filter((request) => request.method === "PUT" && request.path.includes("/chunks/")).length, 2,
    "inspection must not append any chunk before explicit confirmation");

  const differentBytes = Buffer.from(bytes);
  differentBytes[4096] ^= 0x01;
  await page.getByLabel("Choose source file for recovery").setInputFiles({ name: fileName, mimeType: "audio/wav", buffer: differentBytes });
  const mismatchInspectPromise = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/artifacts/uploads/${uploadId}`);
  await page.getByRole("button", { name: "Inspect existing upload" }).click();
  assert.equal((await mismatchInspectPromise).status(), 200);
  await page.getByText(/does not match this caller-scoped file/u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Resume from observed upload" }).count(), 0,
    "a file with a different digest must not authorize resume");
  assert.equal(apiRequests.filter((request) => request.method === "PUT" && request.path.includes("/chunks/")).length, 2,
    "a mismatched file must not append any chunk");

  await page.getByLabel("Choose source file for recovery").setInputFiles({ name: fileName, mimeType: "audio/wav", buffer: bytes });
  const exactInspectAgain = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === `/api/v1/artifacts/uploads/${uploadId}`);
  await page.getByRole("button", { name: "Inspect existing upload" }).click();
  assert.equal((await exactInspectAgain).status(), 200);
  await page.getByRole("button", { name: "Resume from observed upload" }).waitFor();
  const approvedMutationsBeforeResume = apiRequests.filter(({ method }) => method !== "GET");
  assert.deepEqual(approvedMutationsBeforeResume.map(({ method, path }) => [method, path]), [
    ["POST", "/api/v1/artifacts/uploads"],
    ["PUT", `/api/v1/artifacts/uploads/${uploadId}/chunks/0`],
    ["PUT", `/api/v1/artifacts/uploads/${uploadId}/chunks/1`],
  ], "before explicit resume confirmation, only the initial session and the two observed chunk requests may have mutated state");
  assert.equal(approvedMutationsBeforeResume.filter(({ method, path }) => method === "POST" && path.endsWith("/complete")).length,
    0, "no completion request may precede explicit resume confirmation");
  confirmedResume = true;

  const resumedChunkTwoPromise = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/chunks/2"));
  const completeResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/artifacts/uploads/${uploadId}/complete`);
  await page.getByRole("button", { name: "Resume from observed upload" }).click();
  await page.getByText(/Canonical upload completion observed for artifact /u).waitFor({ timeout: 120_000 });
  const resumedChunkTwo = await resumedChunkTwoPromise;
  assert.equal(resumedChunkTwo.status(), 200);
  const chunkTwoReceipt = await resumedChunkTwo.json();
  assert.deepEqual([chunkTwoReceipt.bytesReceived, chunkTwoReceipt.nextChunkIndex], [expectedSize, 3]);
  const completeResponse = await completeResponsePromise;
  assert.equal(completeResponse.status(), 201);
  const completed = await completeResponse.json();
  const artifactId = completed.artifactId;
  assert.ok(artifactId);
  assert.equal(completed.sizeBytes, expectedSize);
  assert.equal(completed.sha256, expectedSha256);
  assert.equal(completed.fileName, fileName);
  assert.equal(completed.contentType, "audio/wav");
  assert.equal(completed.classification, "INTERNAL");

  const chunkPaths = apiRequests.filter((request) => request.method === "PUT" && request.path.includes("/chunks/"))
    .map((request) => request.path.match(/\/chunks\/(\d+)$/u)?.[1]);
  assert.deepEqual(chunkPaths, ["0", "1", "2"],
    "the second chunk is committed before its acknowledgement is lost and is never replayed; only the next contiguous chunk is appended after confirmation");
  assert.equal(apiRequests.filter((request) => request.method === "POST" && request.path === "/api/v1/artifacts/uploads").length, 1,
    "recovery must not create a second upload session");
  const completionPosts = apiRequests.filter(({ method, path }) => method === "POST" && path.endsWith("/complete"));
  assert.deepEqual(completionPosts.map(({ path }) => path), [`/api/v1/artifacts/uploads/${uploadId}/complete`],
    "exactly one completion request must be sent, after explicit confirmation, to the recovered session");
  assert.equal(confirmedResume, true);
  assert.equal(await page.getByRole("button", { name: "Resume from observed upload" }).count(), 0,
    "terminal completion must not expose another resume confirmation");
  assert.deepEqual(apiRequests.filter(({ method }) => method !== "GET").map(({ method, path }) => [method, path]), [
    ["POST", "/api/v1/artifacts/uploads"],
    ["PUT", `/api/v1/artifacts/uploads/${uploadId}/chunks/0`],
    ["PUT", `/api/v1/artifacts/uploads/${uploadId}/chunks/1`],
    ["PUT", `/api/v1/artifacts/uploads/${uploadId}/chunks/2`],
    ["POST", `/api/v1/artifacts/uploads/${uploadId}/complete`],
  ], "the complete mutation history must contain only the initial create, contiguous chunks, and one confirmed completion");

  await page.locator("#artifact-id").fill(artifactId);
  await page.getByRole("button", { name: "Load artifact inspection" }).click();
  await page.getByText("Canonical artifact inspection is NOT_ADMITTED. No live read was requested.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Refresh artifact metadata" }).count(), 0);
  assert.equal(apiRequests.some(({ method, path }) => method === "GET" && path === `/api/v1/artifacts/${artifactId}`), false,
    "the recovered upload's unadmitted product inspection action must not send an artifact GET");
  assert.ok(apiRequests.every(({ origin, path }) => origin === baseUrl
    && (path.startsWith("/dev/v1/") || path.startsWith("/api/v1/artifacts/"))),
  "all app API requests must remain same-origin through the Vite proxy");
  assert.deepEqual(pageErrors, [], diagnostics());
  assert.deepEqual([...consoleErrors].sort(), [
    "Failed to load resource: net::ERR_FAILED",
    "Failed to load resource: the server responded with a status of 404 (Not Found)",
  ].sort(), "the only browser console errors must be the deliberately aborted ACK and unknown-ID read");
  assert.deepEqual(networkFailures.filter((failure) => !failure.url.includes("/chunks/1")), [], diagnostics());
  process.stdout.write(`${JSON.stringify({
    event: "completed", uploadId, artifactId, fileName, contentType: "audio/wav", sizeBytes: expectedSize,
    sha256: expectedSha256, classification: "INTERNAL", inspectionDisposition: "NOT_ADMITTED",
  })}\n`);
} catch (error) {
  process.stderr.write(`Live artifact upload-recovery browser run failed: ${safeDiagnostic(error?.stack ?? error)}\n${diagnostics()}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => viteProcess.once("exit", resolveExit)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
