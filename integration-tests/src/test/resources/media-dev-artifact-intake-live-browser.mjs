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
const token = requiredEnv("MEDIA_DEV_ARTIFACT_BROWSER_TOKEN");
const expectedTenant = requiredEnv("MEDIA_DEV_ARTIFACT_BROWSER_TENANT");
const expectedPrincipal = requiredEnv("MEDIA_DEV_ARTIFACT_BROWSER_PRINCIPAL");
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_ARTIFACT_PROXY_PORT"));
const viteBinary = requiredEnv("MEDIA_DEV_VITE_BINARY");
const playwrightModule = requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE");
const expectedViteVersion = requiredEnv("MEDIA_DEV_VITE_VERSION");
const fileName = requiredEnv("MEDIA_DEV_ARTIFACT_FILE_NAME");
const expectedSize = Number(requiredEnv("MEDIA_DEV_ARTIFACT_EXPECTED_SIZE"));
const expectedSha256 = requiredEnv("MEDIA_DEV_ARTIFACT_EXPECTED_SHA256");
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
  if (!value) throw new Error(`${name} is required for the live artifact browser integration.`);
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

async function assertInspectionNotAdmitted(page, artifactId, apiRequests) {
  await page.locator("#artifact-id").fill(artifactId);
  await page.getByRole("button", { name: "Load artifact inspection" }).click();
  await page.getByText("Canonical artifact inspection is NOT_ADMITTED. No live read was requested.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Refresh artifact metadata" }).count(), 0,
    "a DEV_ONLY read scope alone must not expose an unadmitted product operation");
  assert.equal(apiRequests.some(({ method, url }) => method === "GET"
    && new URL(url).pathname === `/api/v1/artifacts/${artifactId}`), false,
  "NOT_ADMITTED inspection must make no artifact GET");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

function safeDiagnostic(value) {
  return String(value).split(token).join("[redacted-token]")
    .replace(/https?:\/\/[^\s"'<>]+/gu, (value) => safeUrl(value))
    .replace(/\?[^\s"'<>]*/gu, "?[redacted]");
}

const bytes = deterministicBytes(expectedSize);
const computedDigest = await crypto.subtle.digest("SHA-256", bytes);
const actualSha256 = Array.from(new Uint8Array(computedDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
assert.equal(actualSha256, expectedSha256);
const vitePort = 4178;
const viteEnvironment = {
  ...process.env,
  MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort),
  MEDIA_ARTIFACT_PROXY_PORT: String(proxyPort),
};
delete viteEnvironment.MEDIA_DEV_ARTIFACT_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
const retainViteOutput = (chunk) => { viteOutput = (viteOutput + chunk).slice(-200_000); };
viteProcess.stdout.setEncoding("utf8").on("data", retainViteOutput);
viteProcess.stderr.setEncoding("utf8").on("data", retainViteOutput);

let browser;
let page;
const pageErrors = [];
const consoleErrors = [];
const networkFailures = [];
const responseStatuses = [];
const apiRequests = [];
const apiErrors = [];
const uploadReceipts = [];
const responseReadTasks = [];
let uiDiagnostics = [];
const diagnostics = () => safeDiagnostic(JSON.stringify({
  pageErrors,
  consoleErrors,
  failedRequests: networkFailures,
  responseStatuses,
  apiRequests,
  apiErrors,
  uploadReceipts,
  uiDiagnostics,
  viteOutput: viteOutput.slice(-12_000),
}, null, 2));
const readUiSnapshot = async () => page.evaluate(() => ({
  statuses: Array.from(document.querySelectorAll('[role="status"]')).map((status) => status.textContent?.trim() ?? ""),
  selectedFile: (() => {
    const file = document.querySelector('input[type="file"]')?.files?.[0];
    return file ? { sizeBytes: file.size, contentType: file.type } : null;
  })(),
  uploadButtonDisabled: Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Upload selected source"))?.disabled ?? null,
}));
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready.\n${diagnostics()}`);
    try {
      const response = await fetch(`${baseUrl}/dev-artifact-intake.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual artifact intake page.\n${diagnostics()}`);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => networkFailures.push({ method: request.method(), url: safeUrl(request.url()), error: request.failure()?.errorText ?? "" }));
  page.on("response", (response) => {
    responseStatuses.push({ method: response.request().method(), url: safeUrl(response.url()), status: response.status() });
    const method = response.request().method();
    let requestPath;
    try { requestPath = new URL(response.url()).pathname; } catch { return; }
    if (!requestPath.startsWith("/api/v1/artifacts/")) return;
    responseReadTasks.push((async () => {
      const headers = await response.allHeaders();
      const safeHeaders = Object.fromEntries(["content-type", "cache-control", "x-request-id", "x-correlation-id"]
        .filter((name) => typeof headers[name] === "string")
        .map((name) => [name, headers[name]]));
      try {
        const payload = await response.json();
        if (response.status() >= 400) {
          const error = payload && typeof payload === "object" ? payload.error : undefined;
          const rawCode = error && typeof error === "object" ? error.code : undefined;
          const rawMessage = error && typeof error === "object" ? error.message : undefined;
          apiErrors.push({
            method, url: safeUrl(response.url()), status: response.status(), headers: safeHeaders,
            body: {
              code: typeof rawCode === "string" && /^[A-Z0-9_]{1,80}$/u.test(rawCode) ? rawCode : "UNAVAILABLE",
              message: typeof rawMessage === "string" && rawMessage.length <= 160 ? rawMessage : "UNAVAILABLE",
              retryable: error && typeof error === "object" && typeof error.retryable === "boolean" ? error.retryable : null,
              requestId: payload?.meta?.requestId,
              correlationId: payload?.meta?.correlationId,
            },
          });
          return;
        }
        if (requestPath === "/api/v1/artifacts/uploads" || /\/api\/v1\/artifacts\/uploads\/[^/]+(?:\/chunks\/\d+|\/complete)?$/u.test(requestPath)) {
          const upload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          uploadReceipts.push({
            method, path: requestPath, status: response.status(),
            headers: safeHeaders,
            receipt: Object.fromEntries(["uploadId", "artifactId", "status", "bytesReceived", "nextChunkIndex", "expectedSizeBytes", "contentType", "sizeBytes", "classification"]
              .filter((key) => Object.hasOwn(upload, key)).map((key) => [key, upload[key]])),
          });
        }
      } catch {
        if (response.status() >= 400) {
          apiErrors.push({ method, url: safeUrl(response.url()), status: response.status(), headers: safeHeaders, body: { code: "UNAVAILABLE" } });
        }
      }
    })());
  });
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/") || request.url().includes("/api/v1/artifacts/")) {
      apiRequests.push({ method: request.method(), url: safeUrl(request.url()) });
    }
  });
  const intakeModuleResponse = page.waitForResponse((response) => {
    try { return new URL(response.url()).pathname === "/src/dev-artifact-intake.tsx"; }
    catch { return false; }
  });
  await page.goto(`${baseUrl}/dev-artifact-intake.html`);
  const moduleResponse = await intakeModuleResponse;
  assert.ok(moduleResponse.status() >= 200 && moduleResponse.status() < 300,
    `Artifact intake page module did not load successfully (HTTP ${moduleResponse.status()}).\n${diagnostics()}`);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  const contextResponsePromise = page.waitForResponse((response) => response.url().endsWith("/dev/v1/context"));
  await page.getByRole("button", { name: "Read host context" }).click();
  const contextProjection = await (await contextResponsePromise).json();
  await page.getByText(expectedTenant, { exact: true }).waitFor();
  await page.getByText(expectedPrincipal, { exact: true }).waitFor();
  await page.getByText("Verified host context admits artifact upload for this DEV_ONLY principal.", { exact: true }).waitFor();
  await page.getByText("The DEV_ONLY token carries artifactRead scope; artifact inspection remains NOT_ADMITTED without a reviewed operation binding.", { exact: true }).waitFor();
  assert.equal(await page.locator("#dev-token").inputValue(), "");
  assert.equal(contextProjection?.scope, "DEV_ONLY");
  assert.equal(contextProjection?.capabilities?.artifactUpload, true);
  assert.equal(contextProjection?.capabilities?.artifactRead, true);
  assert.ok(apiRequests.some(({ method, url }) => method === "GET" && url.endsWith("/dev/v1/context")));

  await page.getByLabel("Source classification").selectOption("INTERNAL");
  await page.getByLabel("Storage retention").selectOption("P30D");
  await page.getByLabel("Choose source media").setInputFiles({
    name: fileName,
    mimeType: "audio/wav",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Upload selected source" }).click();
  const transferMessagePromise = page.waitForFunction(() => {
    const statuses = Array.from(document.querySelectorAll('[role="status"]'));
    return statuses.map((status) => status.textContent?.trim() ?? "").find((message) =>
      message.startsWith("Upload completion acknowledged for artifact ")
      || message.startsWith("Source hashing failed before upload began.")
      || message.startsWith("Upload stopped because the current host no longer admits the route.")
      || message.startsWith("Upload was denied by the current authenticated route.")
      || message.startsWith("Upload outcome is unknown.")
      || message.startsWith("Upload completion outcome is unknown.")
      || message.startsWith("Begin-upload outcome is unknown and no upload ID was acknowledged.")
      || message.startsWith("Completion outcome is unknown.")) ?? null;
  }, undefined, { timeout: 120_000 });
  const firstTransferObservation = await Promise.race([
    transferMessagePromise.then((handle) => ({ handle })),
    delay(5_000).then(() => ({ timedOut: true })),
  ]);
  if (firstTransferObservation.timedOut) uiDiagnostics = await readUiSnapshot();
  const transferMessageHandle = firstTransferObservation.handle ?? await transferMessagePromise;
  const transferMessage = await transferMessageHandle.jsonValue();
  assert.ok(transferMessage.startsWith("Upload completion acknowledged for artifact "),
    `The real upload journey did not complete: ${transferMessage}`);
  await Promise.all(responseReadTasks);
  const artifactId = await page.locator("#artifact-id").inputValue();
  assert.ok(artifactId.length > 0, "the completion callback must populate the exact artifact ID");
  await assertInspectionNotAdmitted(page, artifactId, apiRequests);
  assert.ok(apiRequests.some(({ method, url }) => method === "POST" && url.endsWith("/api/v1/artifacts/uploads")));
  const chunkRequests = apiRequests.filter(({ method, url }) => method === "PUT" && url.includes("/chunks/"));
  assert.equal(chunkRequests.length, 3, "a >10 MiB file must traverse three real chunk uploads");
  assert.ok(apiRequests.some(({ method, url }) => method === "POST" && url.endsWith("/complete")));
  assert.equal(apiRequests.some(({ method, url }) => method === "GET"
    && new URL(url).pathname === `/api/v1/artifacts/${artifactId}`), false);
  assert.ok(apiRequests.every(({ url }) => new URL(url).origin === baseUrl), "API calls must use the same-origin Vite proxy");
  const beginReceipt = uploadReceipts.find(({ method, path }) => method === "POST" && path === "/api/v1/artifacts/uploads");
  assert.equal(typeof beginReceipt?.receipt.uploadId, "string");
  assert.equal(beginReceipt?.status, 201);
  assert.equal(beginReceipt?.headers["content-type"], "application/json");
  assert.equal(beginReceipt?.headers["cache-control"], "no-store");
  assert.deepEqual({ status: beginReceipt?.receipt.status, bytesReceived: beginReceipt?.receipt.bytesReceived,
    nextChunkIndex: beginReceipt?.receipt.nextChunkIndex, expectedSizeBytes: beginReceipt?.receipt.expectedSizeBytes },
  { status: "OPEN", bytesReceived: 0, nextChunkIndex: 0, expectedSizeBytes: expectedSize });
  const chunkReceipts = uploadReceipts.filter(({ method, path }) => method === "PUT" && path.includes("/chunks/"));
  assert.deepEqual(chunkReceipts.map(({ status, receipt }) => [status, receipt.bytesReceived, receipt.nextChunkIndex]), [
    [200, 4 * 1024 * 1024, 1],
    [200, 8 * 1024 * 1024, 2],
    [200, expectedSize, 3],
  ]);
  assert.ok(uploadReceipts.some(({ method, path, status, receipt }) =>
    method === "POST" && path.endsWith("/complete") && status === 201 && receipt.artifactId === artifactId));

  process.stdout.write(`${JSON.stringify({
    event: "completed",
    artifactId,
    fileName,
    contentType: "audio/wav",
    sizeBytes: expectedSize,
    sha256: expectedSha256,
    classification: "INTERNAL",
    inspectionDisposition: "NOT_ADMITTED",
    capabilities: contextProjection.capabilities,
    apiRequests,
    uploadReceipts,
  })}\n`);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let restarted = false;
  for await (const line of input) {
    if (line === "host-restarted") { restarted = true; break; }
  }
  input.close();
  assert.equal(restarted, true, "the Java harness must restart Media while Chromium remains open");

  assert.equal(await page.locator("#artifact-id").inputValue(), artifactId, "the live page must retain the completed artifact identity");
  await assertInspectionNotAdmitted(page, artifactId, apiRequests);
  assert.deepEqual(pageErrors, [], diagnostics());
  assert.deepEqual(consoleErrors, [], diagnostics());
  assert.deepEqual(networkFailures, [], diagnostics());
  process.stdout.write(`${JSON.stringify({
    event: "readback",
    artifactId,
    fileName,
    sizeBytes: expectedSize,
    sha256: expectedSha256,
    classification: "INTERNAL",
    inspectionDisposition: "NOT_ADMITTED",
  })}\n`);
} catch (error) {
  try { uiDiagnostics = await readUiSnapshot(); }
  catch { /* The page may already be closed; retain the transport diagnostics collected so far. */ }
  process.stderr.write(`Live artifact browser run failed: ${safeDiagnostic(error?.stack ?? error)}\n${diagnostics()}\n`);
  throw error;
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => viteProcess.once("exit", resolveExit)),
      delay(5_000),
    ]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
