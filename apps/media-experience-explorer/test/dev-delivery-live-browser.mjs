import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_TOKEN");
const artifactId = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_ARTIFACT_ID");
const versionId = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_VERSION_ID");
const unattestedId = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_UNATTESTED_ID");
const unattestedVersion = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_UNATTESTED_VERSION");
const runId = requiredEnv("MEDIA_DEV_DELIVERY_BROWSER_RUN");
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT"));
const viteBinary = requiredEnv("MEDIA_DEV_VITE_BINARY");
const playwrightModule = requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE");
const expectedViteVersion = requiredEnv("MEDIA_DEV_VITE_VERSION");
const expectedPlaywrightVersion = "1.63.0";
const expectedChromiumRevision = "1243";
const expectedChromiumVersion = "153.0.8010.12";
const vitePackageRoot = dirname(dirname(await realpath(viteBinary)));
const vitePackage = JSON.parse(await readFile(resolve(vitePackageRoot, "package.json"), "utf8"));
assert.equal(vitePackage.version, expectedViteVersion,
  `Vite version mismatch: expected ${expectedViteVersion}, found ${vitePackage.version}`);
const playwrightEntry = await realpath(playwrightModule);
const playwrightEntryRoot = dirname(playwrightEntry);
const playwrightEntryPackage = JSON.parse(await readFile(resolve(playwrightEntryRoot, "package.json"), "utf8"));
assert.equal(playwrightEntryPackage.version, expectedPlaywrightVersion,
  `Playwright runner must be ${expectedPlaywrightVersion}, found ${playwrightEntryPackage.version}`);
const playwrightRuntimeRoot = playwrightEntryPackage.name === "@playwright/test"
  ? resolve(playwrightEntryRoot, "node_modules/playwright")
  : playwrightEntryRoot;
const playwrightRuntime = JSON.parse(await readFile(resolve(playwrightRuntimeRoot, "package.json"), "utf8"));
const playwrightCoreRoot = resolve(playwrightRuntimeRoot, "../playwright-core");
const playwrightCore = JSON.parse(await readFile(resolve(playwrightCoreRoot, "package.json"), "utf8"));
const browserManifest = JSON.parse(await readFile(resolve(playwrightCoreRoot, "browsers.json"), "utf8"));
const pinnedChromium = browserManifest.browsers.find((browser) => browser.name === "chromium");
assert.equal(playwrightRuntime.version, expectedPlaywrightVersion);
assert.equal(playwrightCore.version, expectedPlaywrightVersion);
assert.equal(pinnedChromium?.revision, expectedChromiumRevision,
  `Chromium revision mismatch: expected ${expectedChromiumRevision}, found ${pinnedChromium?.revision}`);
assert.equal(pinnedChromium?.browserVersion, expectedChromiumVersion,
  `Chromium version mismatch: expected ${expectedChromiumVersion}, found ${pinnedChromium?.browserVersion}`);
const { chromium } = await import(playwrightModule);
const chromiumBinary = chromium.executablePath();
assert.ok(chromiumBinary.includes(`chromium-${expectedChromiumRevision}/`),
  `Playwright must select Chromium revision ${expectedChromiumRevision}; found ${chromiumBinary}`);
const chromiumVersionOutput = await execFile(chromiumBinary, ["--version"]);
assert.ok(chromiumVersionOutput.stdout.includes(expectedChromiumVersion),
  `Chromium binary must be ${expectedChromiumVersion}; found ${chromiumVersionOutput.stdout.trim()}`);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real-host browser integration.`);
  return value;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT must be a valid TCP port.");
  }
  return port;
}

const vitePort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_DELIVERY_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-delivery.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual delivery page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { pathname = ""; }
    consoleErrors.push({ text: message.text(), pathname });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/dev/v1/")) return;
    apiRequests.push({ method: request.method(), path: url.pathname, search: url.search });
  });

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  const emit = (event, extra = {}) => process.stdout.write(`${JSON.stringify({ event, ...extra })}\n`);
  const gate = async (expected) => assert.equal((await lines.next()).value, expected, `the integration host must say ${expected}`);

  let connected = false;
  for (let attempt = 1; attempt <= 3 && !connected; attempt += 1) {
    await page.goto(`${baseUrl}/dev-delivery.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: "Export to a destination" }).waitFor({ timeout: 15_000 });
      connected = true;
    } catch {
      if (attempt === 3) throw new Error(`panel did not render; status="${await page.locator("#connection-status").textContent()}" pageErrors=${JSON.stringify(pageErrors)}`);
    }
  }
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  const fill = async (requestId, artifact = artifactId, version = versionId) => {
    await page.getByLabel(/^Request id/u).fill(requestId);
    await page.getByLabel("Artifact id").fill(artifact);
    await page.getByLabel(/^Exact artifact version/u).fill(version);
    await page.getByLabel("Registered destination").selectOption("dev-http-receiver");
  };
  const ack = async () => (await page.locator("#ack-state").textContent()).trim();
  const waitAck = async (state) => page.locator(`[data-ack-state='${state}']`).waitFor({ timeout: 60_000 });
  const failure = async () => (await page.locator("#ack-failure-code").textContent()).trim();
  const request = (n) => `ui-j22-${n}-${runId}`;

  // ---- 1. Lost ACK: the receiver stored the bytes but the ACK was dropped. Unknown, never delivered. ----
  assert.equal(await page.getByRole("button", { name: "Export" }).isDisabled(), true, "export needs all fields");
  await fill(request(1));
  await page.getByLabel(/^Request id/u).press("Enter");
  await waitAck("UNKNOWN");
  assert.equal(await ack(), "UNKNOWN");
  assert.equal(await failure(), "DESTINATION_UNREACHABLE");
  assert.match(await page.locator("#ack-explanation").textContent(), /Nothing is marked delivered/u);
  assert.equal(await page.locator("#receipt-ref").textContent(), "none");
  assert.equal(await page.locator("#delivery-result h3").evaluate((node) => document.activeElement === node), true, "focus moves to the result heading");
  emit("unknown", { requestId: request(1) });
  await gate("verified-unknown");

  // ---- 2. Reconcile by reading the destination only: the signed status holds the exact bytes. ----
  await page.getByRole("button", { name: "Reconcile (read destination only)" }).click();
  await waitAck("DELIVERED");
  assert.match(await page.locator("#receipt-ref").textContent(), /^dev-http-receiver-receipt:/u);
  assert.equal(await page.locator("#ledger-status").textContent(), "DESTINATION_CONFIRMED");
  assert.equal(await page.getByRole("button", { name: "Reconcile and resume" }).isDisabled(), true, "nothing left to reconcile once delivered");
  emit("delivered", { requestId: request(1) });
  await gate("verified-delivered");

  // ---- 3. Duplicate export: idempotent replay, still one delivery. ----
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.locator("[data-ack-state='DELIVERED']").filter({ hasText: /Replay of an existing operation\s*yes/u }).waitFor({ timeout: 30_000 });
  emit("duplicate", { requestId: request(1) });
  await gate("verified-duplicate");

  // ---- 4. Destination credential revoked before the transfer: typed, nothing written ----
  await fill(request(2));
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await waitAck("NOT_DELIVERED");
  assert.equal(await failure(), "CREDENTIAL_REVOKED");
  assert.match(await page.locator("#ack-failure").textContent(), /refused Media's upload credential/u);
  emit("revoked", { requestId: request(2) });
  await gate("verified-revoked");

  // ---- 5. Ack lost before the store: unknown, then read-only reconcile says not delivered, then resume delivers once ----
  await fill(request(3));
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await waitAck("UNKNOWN");
  emit("dropped", { requestId: request(3) });
  await gate("verified-dropped");
  await page.getByRole("button", { name: "Reconcile (read destination only)" }).click();
  await waitAck("NOT_DELIVERED");
  assert.equal(await page.locator("#received-bytes").textContent(), "0");
  emit("absent", { requestId: request(3) });
  await gate("verified-absent");
  await page.getByRole("button", { name: "Reconcile and resume" }).click();
  await waitAck("DELIVERED");
  emit("resumed", { requestId: request(3) });
  await gate("verified-resumed");

  // ---- 6. Checksum mismatch at the destination: typed failure, never delivered ----
  await fill(request(4));
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await waitAck("UNKNOWN");
  assert.equal(await failure(), "CHECKSUM_MISMATCH");
  assert.match(await page.locator("#ack-failure").textContent(), /write-once/u);
  assert.equal(await page.locator("#receipt-ref").textContent(), "none");
  emit("mismatch", { requestId: request(4) });
  await gate("verified-mismatch");

  // ---- 7. Rights: an unattested version is refused before any effect ----
  await fill(request(5), unattestedId, unattestedVersion);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const denied = page.locator("#delivery-error");
  await denied.waitFor({ timeout: 30_000 });
  assert.match(await denied.textContent(), /EXPORT_RIGHTS_NOT_ADMITTED/u);
  assert.match(await denied.textContent(), /Nothing was sent/u);
  // An unregistered destination cannot be chosen from the page; a reopened status of a delivered export still reads back.
  await fill(request(1));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await waitAck("DELIVERED");
  // A request id of another owner/tenant is simply absent.
  await page.getByLabel(/^Request id/u).fill(`not-mine-${runId}`);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await page.locator("#delivery-error").filter({ hasText: /EXPORT_NOT_FOUND/u }).waitFor({ timeout: 30_000 });
  emit("denied", { requestId: request(5) });

  // ---- 8. Accessibility basics: names, live regions, no horizontal scroll at a narrow width ----
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, input:not([type=hidden]), select")]
    .filter((node) => !(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby") || node.labels?.length || node.textContent.trim())).length);
  assert.equal(unnamed, 0, "every control has an accessible name");
  assert.equal(await page.locator("h1").count(), 1);
  assert.ok(await page.locator("[aria-live]").count() >= 1);
  await page.setViewportSize({ width: 375, height: 900 });
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 375px, overflow ${overflow}px`);

  const allowed = [/^\/dev\/v1\/context$/u, /^\/dev\/v1\/exports$/u, /^\/dev\/v1\/exports\/[^/]+(\/reconcile)?$/u];
  for (const call of apiRequests) {
    assert.ok(allowed.some((pattern) => pattern.test(call.path)), `unexpected API call ${call.method} ${call.path}`);
    assert.notEqual(call.method, "DELETE");
    assert.equal(call.search, "", "no query strings are sent");
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  // Only deliberate typed refusals (403/404/202-class answers) may log network errors.
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !(pathname.startsWith("/dev/v1/exports") && /status of (403|404)/u.test(text)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  reader.close();
  emit("delivery-browser", { calls: apiRequests.length });
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => viteProcess.once("exit", resolve)),
      delay(5_000),
    ]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
