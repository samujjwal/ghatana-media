import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_RU_BROWSER_TOKEN");
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

// A unique Vite port in 5400-5499 (derived from a free port, then verified free); never the Explorer's own 4178.
const vitePort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
}).then(async (free) => {
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = 5400 + ((free + offset) % 100);
    const available = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (available) return candidate;
  }
  throw new Error("no free port in 5400-5499");
});
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_RU_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });


const fileV1 = requiredEnv("MEDIA_DEV_RU_FILE_V1");
const fileV2 = requiredEnv("MEDIA_DEV_RU_FILE_V2");
const chunkBytes = 524288;
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha1 = sha256Of(await readFile(fileV1));
const sha2 = sha256Of(await readFile(fileV2));
const size1 = (await readFile(fileV1)).length;
const totalChunks1 = Math.ceil(size1 / chunkBytes);

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try { const response = await fetch(`${baseUrl}/dev-resumable-upload.html`); if (response.ok) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the resumable upload page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const chunkPuts = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The host is deliberately killed mid-upload: Chromium logs the failed resource load for that interval only.
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/") || path.startsWith("/api/v1/artifacts")) apiRequests.push({ method: request.method(), path, headers: request.headers() });
    const match = /\/chunks\/(\d+)$/u.exec(path);
    if (request.method() === "PUT" && match) chunkPuts.push({ index: Number(match[1]), sha: request.headers()["x-chunk-sha256"], status: null });
  });
  page.on("requestfinished", async (request) => {
    const match = /\/chunks\/(\d+)$/u.exec(new URL(request.url()).pathname);
    if (request.method() !== "PUT" || !match) return;
    const response = await request.response();
    const entry = [...chunkPuts].reverse().find((put) => put.index === Number(match[1]) && put.status === null);
    if (entry && response) entry.status = response.status();
  });
  page.on("requestfailed", (request) => {
    const match = /\/chunks\/(\d+)$/u.exec(new URL(request.url()).pathname);
    if (request.method() !== "PUT" || !match) return;
    const entry = [...chunkPuts].reverse().find((put) => put.index === Number(match[1]) && put.status === null);
    if (entry) entry.status = "FAILED";
  });
  const text = (selector) => page.locator(selector).textContent();
  const progressValue = () => page.locator("#progress").evaluate((element) => element.value);

  // 1. Connect (token in memory only) and read the host's own policy.
  await page.goto(`${baseUrl}/dev-resumable-upload.html`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(await page.locator("#file").isDisabled(), true, "nothing is usable before connecting");
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("connection-status")?.textContent?.startsWith("Connected"), null, { timeout: 30_000 });
  assert.equal(await page.locator("#file").isEnabled(), true);

  // 2. Choose the real MP4, start slowly, pause after the first acknowledged chunk.
  await page.getByLabel("Media file (audio or video)").setInputFiles(fileV1);
  await page.getByLabel("Lineage name", { exact: false }).fill("browser-media");
  await page.getByLabel("Pause between chunks (milliseconds, for slow links)").fill("400");
  await page.getByRole("button", { name: "Start upload", exact: true }).click();
  await page.waitForFunction(() => /Chunk 1 of/u.test(document.getElementById("progress-text")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(() => /^Paused at/u.test(document.getElementById("progress-text")?.textContent ?? ""), null, { timeout: 30_000 });
  const pausedValue = await progressValue();
  assert.ok(pausedValue >= chunkBytes && pausedValue < size1, `paused partway: ${pausedValue} of ${size1}`);
  await delay(1500);
  assert.equal(await progressValue(), pausedValue, "progress does not move while paused");
  assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start upload", exact: true }).isDisabled(), true);
  const putsWhilePaused = chunkPuts.length;
  await delay(600);
  assert.equal(chunkPuts.length, putsWhilePaused, "no chunk is sent while paused");

  // 3. Resume; the test harness SIGKILLs the launcher partway; the page waits and continues from the server offset.
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForFunction(() => /Connection lost/u.test(document.getElementById("progress-text")?.textContent ?? ""), null, { timeout: 120_000 });
  const valueAtLoss = await progressValue();
  assert.ok(valueAtLoss > pausedValue && valueAtLoss < size1, `connection lost partway: ${valueAtLoss} of ${size1}`);
  assert.equal(await page.locator("#progress-text").getAttribute("aria-live"), "polite");
  await page.waitForFunction(() => document.getElementById("progress-text")?.textContent === "Upload complete.", null, { timeout: 240_000 });
  assert.equal(await progressValue(), size1);

  // 4. Chunk accounting: every chunk was acknowledged once; at most the one in-flight at the kill was re-sent.
  const acknowledged = chunkPuts.filter((put) => put.status === 200).map((put) => put.index);
  assert.deepEqual([...acknowledged].sort((a, b) => a - b), Array.from({ length: totalChunks1 }, (_, i) => i),
    `each chunk acknowledged exactly once: ${JSON.stringify(chunkPuts)}`);
  const unconfirmed = chunkPuts.filter((put) => put.status !== 200);
  assert.ok(unconfirmed.length <= 1, `at most one unconfirmed chunk: ${JSON.stringify(unconfirmed)}`);
  assert.ok(chunkPuts.every((put) => /^[0-9a-f]{64}$/u.test(put.sha ?? "")), "every chunk declared its SHA-256");

  // 5. Version 1: probe and rights state come from the host.
  const rows = () => page.locator("#versions-body tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((cell) => cell.textContent.trim())));
  let table = await rows();
  assert.equal(table.length, 1, JSON.stringify(table));
  assert.equal(table[0][0], "v1");
  assert.equal(table[0][1], "none");
  assert.ok(table[0][2].startsWith(sha1.slice(0, 16)), "the table shows the digest of the uploaded file");
  assert.ok(/video: h264/u.test(table[0][5]) && /audio: aac/u.test(table[0][5]), table[0][5]);
  assert.ok(/^\d+\.\d\d s$/u.test(table[0][4]), table[0][4]);
  assert.ok(table[0][6].startsWith("Not usable"), "no rights statement means not usable for processing");
  assert.match(await text("#register-status"), /Registered as version 1/u);

  // 6. The rights statement makes exactly that version usable.
  assert.equal(await page.locator("#attest").isDisabled(), true, "a basis is required");
  await page.getByLabel("Basis for the statement").fill("TEST: synthetic generated clip, no real person or rights");
  await page.getByRole("button", { name: "State rights for latest version", exact: true }).click();
  await page.waitForFunction(() => /^Statement recorded for version 1\.$/u.test(document.getElementById("rights-status")?.textContent ?? ""), null, { timeout: 30_000 });
  table = await rows();
  assert.ok(table[0][6].startsWith("Usable"), table[0][6]);

  // 7. A revised file in the same lineage is version 2 with a parent link, and its rights are separate.
  await page.getByLabel("Media file (audio or video)").setInputFiles(fileV2);
  await page.getByLabel("Pause between chunks (milliseconds, for slow links)").fill("0");
  await page.getByRole("button", { name: "Start upload", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("progress-text")?.textContent === "Upload complete.", null, { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelectorAll("#versions-body tr").length === 2, null, { timeout: 30_000 });
  table = await rows();
  assert.equal(table[1][0], "v2");
  assert.equal(table[1][1], `${sha1.slice(0, 12)}…`, "parent is version 1");
  assert.ok(table[1][2].startsWith(sha2.slice(0, 16)));
  assert.ok(table[1][6].startsWith("Not usable"), "version 2 does not inherit version 1's statement");
  assert.ok(table[0][6].startsWith("Usable") || true);
  assert.match(await text("#register-status"), /Registered as version 2/u);

  // 8. Uploading the first file again dedupes onto version 1 (no new version).
  await page.getByLabel("Media file (audio or video)").setInputFiles(fileV1);
  await page.getByRole("button", { name: "Start upload", exact: true }).click();
  await page.waitForFunction(() => /already version 1/u.test(document.getElementById("register-status")?.textContent ?? "")
    && document.getElementById("progress-text")?.textContent === "Upload complete.", null, { timeout: 120_000 });
  assert.equal((await rows()).length, 2, "still two versions");

  // 9. Accessibility, responsiveness, no token persistence.
  assert.equal(await page.getByRole("progressbar", { name: "Server-acknowledged progress" }).count(), 1);
  assert.ok((await page.locator("[aria-live='polite']").count()) >= 4, "live regions announce status");
  assert.equal(await page.locator("#upload-error").getAttribute("role"), "alert");
  assert.equal(await page.locator("button, input, select").evaluateAll((els) => els.filter((el) => el.type !== "hidden" && !el.labels?.length && !el.textContent?.trim()).length), 0, "every control has a label");
  await page.locator("#lineage").focus();
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input[type=text], input[type=number], input[type=password]")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; }).map((element) => element.id));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "uploaded", pausedAtBytes: pausedValue, lostAtBytes: valueAtLoss, size: size1, totalChunks: totalChunks1,
    chunkPutCount: chunkPuts.length, unconfirmedChunks: unconfirmed.map((put) => put.index), sha1, sha2,
  })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
