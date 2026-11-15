import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_QUALITY_BROWSER_TOKEN");
const sourceId = requiredEnv("MEDIA_DEV_QUALITY_BROWSER_SOURCE_ID");
const sourceVersion = requiredEnv("MEDIA_DEV_QUALITY_BROWSER_SOURCE_VERSION");
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

const vitePort = positivePort(requiredEnv("MEDIA_DEV_QUALITY_BROWSER_VITE_PORT"));
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_QUALITY_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const runId = Math.random().toString(36).slice(2, 8);

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-quality-optimization.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual quality optimization page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  const expectedErrors = []; // { pathname, status }
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { pathname = ""; }
    consoleErrors.push({ text: message.text(), pathname });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/dev/v1/")) return;
    apiRequests.push({ method: request.method(), path, body: request.postData(), url: request.url() });
  });
  const isPost = (path) => (response) => new URL(response.url()).pathname === path && response.request().method() === "POST";
  const isGet = (path) => (response) => new URL(response.url()).pathname === path && response.request().method() === "GET";

  async function connect(bearer) {
    await page.goto(`${baseUrl}/dev-quality-optimization.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: "Bounded quality optimization", level: 2 }).waitFor({ timeout: 60_000 });
    } catch (error) {
      const connection = await page.locator("#connection-status").textContent().catch(() => "<unreadable>");
      throw new Error(`The quality panel did not render. status=${JSON.stringify(connection)} pageErrors=${JSON.stringify(pageErrors)}`, { cause: error });
    }
  }
  const rows = () => page.locator("[data-attempt-table] tbody tr");
  const cellTexts = async (row) => row.locator("th, td").allTextContents();

  // ---- 1. Connect: the host's bounds are read from /dev/v1/quality/status and shown ----
  await connect(token);
  await page.locator("[data-quality-bounds]").waitFor({ timeout: 30_000 });
  const boundsText = await page.locator("[data-quality-bounds]").textContent();
  assert.match(boundsText, /at most 8 attempts/u, boundsText);
  assert.ok(await page.locator("[aria-live='polite']").count() >= 2, "live regions announce status");
  assert.ok(apiRequests.some(({ method, path }) => method === "GET" && path === "/dev/v1/quality/status"));

  // ---- 2. KEYBOARD ONLY: type the three source ids, Tab through the target and bounds to Run search, press Enter ----
  const lineageId = `ui-lineage-${runId}`;
  await page.getByLabel("Lineage id").focus();
  await page.keyboard.type(lineageId);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "quality-artifact");
  await page.keyboard.type(sourceId);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "quality-version");
  await page.keyboard.type(sourceVersion);
  for (const expected of ["quality-goal", "quality-metric", "quality-threshold", "quality-crf-min", "quality-crf-max", "quality-attempts"]) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), expected);
  }
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Run search");
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  assert.equal(await page.getByRole("button", { name: "Cancel search" }).isDisabled(), true, "nothing to cancel yet");
  assert.equal(await page.locator("#quality-threshold").inputValue(), "0.90");
  const optimizePost = page.waitForResponse(isPost("/dev/v1/quality/optimizations"), { timeout: 600_000 });
  await page.keyboard.press("Enter");
  const optimizeResponse = await optimizePost;
  assert.equal(optimizeResponse.status(), 201, await optimizeResponse.text());
  const host = await optimizeResponse.json();
  const sent = JSON.parse(optimizeResponse.request().postData());
  assert.deepEqual({ ...sent, requestId: "x" }, {
    requestId: "x", lineageId, artifactId: sourceId, artifactVersionId: sourceVersion,
    target: { type: "MIN_BYTES_AT_QUALITY", metric: "ssim", minQuality: 0.9 }, search: { crfMin: 16, crfMax: 40, maxAttempts: 6 },
  });
  assert.match(sent.requestId, /^opt-/u);

  // ---- 3. The attempts table is the host's report, row for row; the chosen attempt is marked in text ----
  await page.locator("[data-quality-result]").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("[data-quality-result]").getAttribute("data-outcome"), "SELECTED");
  await page.waitForFunction(() => document.activeElement?.id === "quality-result-title", null, { timeout: 5_000 });
  const attempts = host.report.attempts;
  assert.ok(attempts.length >= 2 && attempts.length <= 6, `bounded attempts: ${attempts.length}`);
  assert.equal(await rows().count(), attempts.length, "one row per host attempt");
  for (const attempt of attempts) {
    const row = page.locator(`[data-attempt-table] tr[data-attempt="${attempt.attempt}"]`);
    const cells = await cellTexts(row);
    assert.deepEqual(cells, [String(attempt.attempt), String(attempt.crf), String(attempt.bytes), String(attempt.sizeRatioVsSource),
      String(attempt.meanSsimY), String(attempt.globalPsnrY), attempt.verdict, attempt.attempt === host.report.chosenAttempt ? "Chosen" : "—"]);
    assert.equal(await row.getAttribute("data-feasible"), String(attempt.feasible));
  }
  assert.equal(await page.locator("[data-attempt-table] tr[data-chosen='true']").count(), 1, "exactly one chosen row");
  assert.equal(await page.locator("[data-chosen-version]").textContent(), host.chosen.artifactVersionId);
  assert.equal(await page.locator("[data-chosen-artifact]").textContent(), host.chosen.artifactId);
  assert.equal(await page.locator("[data-report-artifact]").first().textContent(), host.reportArtifact.artifactId);
  assert.ok((await page.locator("[data-quality-status]").textContent()).includes(`Selected attempt ${host.report.chosenAttempt}`));
  assert.equal(await page.locator("[data-attempt-table] caption").count(), 1);
  assert.ok(await page.locator("[data-attempt-table] thead th[scope='col']").count() >= 8);
  assert.equal(await page.locator("[data-head-version]").textContent(), host.chosen.artifactVersionId, "the head is the chosen version");
  assert.equal(await page.locator("[data-head-kind]").textContent(), "APPLY");
  assert.equal(await page.locator("[data-undoable]").textContent(), "Yes");
  assert.equal(await page.locator("[data-event-table] tbody tr").count(), 2);
  emit({ event: "optimized", lineageId, requestId: sent.requestId, reportArtifactId: host.reportArtifact.artifactId,
    reportSha: host.reportSha256, chosenArtifactId: host.chosen.artifactId, chosenVersion: host.chosen.artifactVersionId,
    chosenAttempt: host.report.chosenAttempt, attempts: attempts.length });

  // ---- 4. Undo restores the previous head exactly (the source version), nothing is copied ----
  const undoPost = page.waitForResponse(isPost(`/dev/v1/quality/lineages/${lineageId}/undo`), { timeout: 60_000 });
  await page.getByRole("button", { name: "Undo to the previous version" }).click();
  const undoResponse = await undoPost;
  assert.equal(undoResponse.status(), 201, await undoResponse.text());
  const undoSent = JSON.parse(undoResponse.request().postData());
  assert.equal(undoSent.expectedHeadArtifactVersionId, host.chosen.artifactVersionId);
  await page.locator("[data-undo-note]", { hasText: "Undone" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("[data-head-version]").textContent(), sourceVersion);
  assert.equal(await page.locator("[data-head-artifact]").textContent(), sourceId);
  assert.equal(await page.locator("[data-undoable]").textContent(), "No");
  assert.equal(await page.getByRole("button", { name: "Undo to the previous version" }).isDisabled(), true);
  assert.deepEqual(await page.locator("[data-event-table] tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-kind"))),
    ["BASE", "APPLY", "UNDO"]);
  emit({ event: "undone", headVersion: sourceVersion });

  // ---- 5. An unreachable target abstains: typed outcome, no chosen row, no lineage, nothing to undo ----
  await page.getByLabel("Lineage id").fill(`ui-abstain-${runId}`);
  await page.getByLabel("Minimum quality").fill("0.9999");
  await page.getByLabel("Lowest CRF to try").fill("30");
  const abstainPost = page.waitForResponse(isPost("/dev/v1/quality/optimizations"), { timeout: 600_000 });
  await page.getByRole("button", { name: "Run search" }).click();
  const abstainResponse = await abstainPost;
  assert.equal(abstainResponse.status(), 201, await abstainResponse.text());
  const abstained = await abstainResponse.json();
  assert.equal(abstained.outcome, "ABSTAINED");
  await page.locator("[data-quality-result][data-outcome='ABSTAINED']").waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Abstained: no attempt met the target", level: 3 }).waitFor();
  assert.equal(await page.locator("[data-attempt-table] tr[data-chosen='true']").count(), 0, "no attempt is marked chosen");
  assert.equal(await page.locator("[data-quality-chosen]").count(), 0);
  assert.equal(await page.locator("[data-quality-lineage]").count(), 0, "an abstention creates no lineage");
  assert.equal(await rows().count(), abstained.report.attempts.length);
  for (const row of await rows().all()) assert.equal(await row.getAttribute("data-feasible"), "false");
  assert.ok((await page.locator("[data-quality-summary]").textContent()).includes("NO_ATTEMPT_MET_TARGET"));
  assert.ok((await page.locator("[data-quality-summary]").textContent()).includes("head did not move"));
  emit({ event: "abstained", reportArtifactId: abstained.reportArtifact.artifactId, attempts: abstained.report.attempts.length });

  // ---- 6. Cancel mid-search: the host kills the encode, nothing is registered, the failure is a typed alert ----
  const cancelLineage = `ui-cancel-${runId}`;
  await page.getByLabel("Lineage id").fill(cancelLineage);
  await page.getByLabel("Minimum quality").fill("0.90");
  await page.getByLabel("Lowest CRF to try").fill("16");
  await page.getByLabel("Maximum attempts").fill("8");
  expectedErrors.push({ pathname: "/dev/v1/quality/optimizations", status: 409 });
  const cancelledPost = page.waitForResponse(isPost("/dev/v1/quality/optimizations"), { timeout: 600_000 });
  await page.getByRole("button", { name: "Run search" }).click();
  const cancelButton = page.getByRole("button", { name: "Cancel search" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Cancel search" && !b.disabled), null, { timeout: 15_000 });
  await delay(1500); // let the first real encode start
  const cancelPost = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/cancel") && response.request().method() === "POST", { timeout: 30_000 });
  await cancelButton.click();
  assert.equal((await cancelPost).status(), 200);
  const cancelled = await cancelledPost;
  assert.equal(cancelled.status(), 409);
  assert.equal((await cancelled.json()).error.code, "OPTIMIZATION_CANCELLED");
  await page.locator("[data-quality-failure]", { hasText: "OPTIMIZATION_CANCELLED" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("[data-quality-failure]").getAttribute("role"), "alert");
  assert.equal(await page.locator("[data-quality-result]").count(), 0);
  emit({ event: "cancelled", lineageId: cancelLineage });

  // ---- 7. After the host restarts: a clean page reopens the lineage from the durable ledger ----
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function nextCommand(prefix) {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error(`stdin closed before ${prefix}`);
      if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
    }
  }
  const freshToken = await nextCommand("host-restarted ");
  assert.ok(freshToken, "the integration host must restart and issue a fresh token before readback");
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await connect(freshToken);
  assert.equal(await page.locator("[data-quality-result]").count(), 0, "a reloaded page must not claim a result it never read");
  await page.getByLabel("Lineage id").fill(lineageId);
  const lineageGet = page.waitForResponse(isGet(`/dev/v1/quality/lineages/${lineageId}`), { timeout: 60_000 });
  await page.getByRole("button", { name: "Open lineage" }).click();
  assert.equal((await lineageGet).status(), 200);
  await page.locator("[data-quality-lineage]").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("[data-head-version]").textContent(), sourceVersion, "the undo survived the restart");
  assert.deepEqual(await page.locator("[data-event-table] tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-kind"))),
    ["BASE", "APPLY", "UNDO"]);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "readback must not mutate");
  const missing = `missing-${runId}`;
  expectedErrors.push({ pathname: `/dev/v1/quality/lineages/${missing}`, status: 404 });
  await page.getByLabel("Lineage id").fill(missing);
  await page.getByRole("button", { name: "Open lineage" }).click();
  await page.locator("[data-quality-failure]", { hasText: "QUALITY_LINEAGE_NOT_FOUND" }).waitFor({ timeout: 30_000 });
  emit({ event: "readback", headVersion: sourceVersion });

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !expectedErrors.some((expected) => expected.pathname === pathname && text.includes(`status of ${expected.status}`)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token) && !stored.includes(freshToken), "token must never be persisted");
  for (const entry of apiRequests) assert.ok(!entry.url.includes("Bearer") && !entry.url.includes(token), `token must not be in a URL: ${entry.url}`);
  input.close();
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
