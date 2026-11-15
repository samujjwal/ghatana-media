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
const token = requiredEnv("MEDIA_DEV_AUDIO_BROWSER_TOKEN");
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
delete viteEnvironment.MEDIA_DEV_AUDIO_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceId = requiredEnv("MEDIA_DEV_AUDIO_SOURCE_ID");
const sourceVersion = requiredEnv("MEDIA_DEV_AUDIO_SOURCE_VERSION");
const referenceId = requiredEnv("MEDIA_DEV_AUDIO_REFERENCE_ID");
const referenceVersion = requiredEnv("MEDIA_DEV_AUDIO_REFERENCE_VERSION");
const referenceText = requiredEnv("MEDIA_DEV_AUDIO_REFERENCE_TEXT");

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-audio-restoration.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual audio-restoration page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // net::ERR_NETWORK_CHANGED is Chromium reacting to host network-interface churn (other containers starting), not the page.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("net::ERR_NETWORK_CHANGED")) consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });

  // 1. Connect and read the engine status FROM THE HOST. Vite may re-optimize dependencies on a cold cache and reload the
  // page once; warm it first, then connect (retrying a connect that a late reload interrupted).
  await page.goto(`${baseUrl}/dev-audio-restoration.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-audio-restoration.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/audio/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "Audio restoration A/B", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.engine.ready, true, "the real FFmpeg engine must be ready on this host");
  assert.equal(status.transcriptDiff.ready, true, "the real Whisper model must be ready on this host");
  await page.locator("[data-audio-engine-status]").getByText(/is ready/u).waitFor({ timeout: 10_000 });
  assert.ok((await page.locator("[data-audio-engine-status]").textContent()).includes(status.engine.version), "the engine version shown is the host's");

  // 2. Accessible names and live regions.
  for (const label of ["Source artifact id", "Source exact version", "Reference artifact id", "Reference exact version",
    "Remove mains hum", /^Declip threshold/u, /^Noise reduction in dB/u, /^Target loudness/u]) {
    await page.getByLabel(label).first().waitFor({ timeout: 5_000 });
  }
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");
  assert.equal(await page.getByLabel(/Normalize loudness/u).isChecked(), false, "loudness normalization is off by default");

  // 3. Invalid parameters are refused in the page before any request is made.
  const requestsBefore = apiRequests.filter((entry) => entry.method === "POST").length;
  await page.getByRole("button", { name: "Restore and measure", exact: true }).click();
  const formAlert = page.locator("ul[role='alert']");
  await formAlert.waitFor({ timeout: 5_000 });
  assert.match(await formAlert.textContent(), /source artifact id/u);
  await page.getByLabel("Source artifact id").fill(sourceId);
  await page.getByLabel("Source exact version").fill(sourceVersion);
  await page.getByLabel(/^Noise reduction in dB/u).fill("99");
  await page.getByRole("button", { name: "Restore and measure", exact: true }).click();
  assert.match(await formAlert.textContent(), /Noise reduction must be a number from 1 to 40/u);
  assert.equal(apiRequests.filter((entry) => entry.method === "POST").length, requestsBefore, "no request for an invalid form");
  await page.getByLabel(/^Noise reduction in dB/u).fill("20");
  await page.getByLabel(/^Noise floor in dB/u).fill("-40");

  // 4. Restore and measure with the mouse: declip + 50 Hz dehum + denoise against the clean reference, with Whisper diff.
  await page.getByLabel("Reference artifact id").fill(referenceId);
  await page.getByLabel("Reference exact version").fill(referenceVersion);
  await page.getByLabel("Remove mains hum").selectOption("50");
  await page.getByLabel(/Also diff the Whisper transcript/u).check();
  await page.getByLabel(/^Known clean text/u).fill(referenceText);
  const restorePost = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/audio/restorations" && response.request().method() === "POST", { timeout: 120_000 });
  const comparePost = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/audio/comparisons" && response.request().method() === "POST", { timeout: 300_000 });
  await page.getByRole("button", { name: "Restore and measure", exact: true }).click();
  const restoreResponse = await restorePost;
  assert.equal(restoreResponse.status(), 201);
  const restored = await restoreResponse.json();
  const compareResponse = await comparePost;
  assert.equal(compareResponse.status(), 201);
  const compared = await compareResponse.json();
  const result = page.locator("[data-audio-result]");
  await result.waitFor({ timeout: 300_000 });
  await page.locator("[data-audio-measurement]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "audio-result-title", null, { timeout: 5_000 });

  // 5. The page shows the HOST's numbers and the HOST's verdict, never its own.
  const metrics = compared.report.metrics;
  const cellText = (metric, cell) => result.locator(`[data-metric='${metric}'] [data-cell='${cell}']`).textContent();
  assert.equal(await cellText("snr", "source"), metrics.source.snrDb.toFixed(2));
  assert.equal(await cellText("snr", "restored"), metrics.restored.snrDb.toFixed(2));
  assert.equal(await cellText("segmental-snr", "restored"), metrics.restored.segmentalSnrDb.toFixed(2));
  assert.equal(await cellText("clipped", "source"), String(metrics.source.clippedSamples));
  assert.equal(await cellText("clipped", "restored"), String(metrics.restored.clippedSamples));
  assert.equal(await cellText("noise-floor", "restored"), metrics.restored.noiseFloor.rmsDbfs.toFixed(2));
  assert.equal(await cellText("flatness", "source"), metrics.source.noiseFloor.spectralFlatness.toFixed(3));
  assert.equal(await result.locator("[data-audio-measurement]").getAttribute("data-verdict"), compared.report.verdict.overall);
  assert.equal(compared.report.verdict.overall, "IMPROVED");
  assert.match(await result.locator("[data-verdict-text]").textContent(), /closer to it than the source/u);
  assert.ok(metrics.restored.snrDb > metrics.source.snrDb, "SNR vs the clean reference rose");
  assert.ok(metrics.restored.clippedSamples < metrics.source.clippedSamples, "clipped samples fell");
  const transcriptNote = await result.locator("[data-transcript-status='MEASURED']").textContent();
  assert.match(transcriptNote, /word error rate/u);
  assert.equal(compared.report.transcript.status, "MEASURED");
  assert.ok((await result.locator("[data-filter-graph]").textContent()).includes("afftdn=nr=20.0:nf=-40.0"), "the exact filter graph is shown");
  assert.equal(await result.locator("[data-restored-version]").textContent(), restored.artifact.artifactVersionId);

  // 6. A/B playback: both clips are verified before the player exists; one player switches at the same position.
  const ab = page.locator("[data-audio-ab]");
  assert.equal(await ab.locator("audio").count(), 0, "no player before the bytes are verified");
  await ab.getByRole("button", { name: /^Load both clips/u }).click();
  await ab.getByText(/Both clips verified against their registered versions/u).waitFor({ timeout: 60_000 });
  const abStatus = await ab.locator("[data-ab-status]").textContent();
  assert.ok(abStatus.includes(sourceVersion.slice("sha256:".length)), "the source SHA-256 is shown");
  assert.ok(abStatus.includes(restored.artifact.sha256), "the restored SHA-256 is shown");
  const audio = ab.locator("audio");
  await audio.waitFor({ timeout: 10_000 });
  assert.match(await audio.getAttribute("src"), /^blob:/u);
  assert.equal(await audio.getAttribute("data-ab-current"), "A");
  const urlA = await audio.getAttribute("src");
  const metadataReady = () => audio.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad(element.duration);
    element.addEventListener("loadedmetadata", () => resolveLoad(element.duration), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`audio error ${element.error?.code}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("audio metadata did not load")), 15_000);
  }));
  const durationA = await metadataReady();
  await audio.evaluate(async (element) => { element.muted = true; element.currentTime = 1.0; await element.play(); });
  await delay(600);
  // Switch with the mouse (toggle button) while playing.
  await ab.getByRole("button", { name: /^Switch to restored/u }).click();
  await page.waitForFunction(() => document.querySelector("audio[data-ab-current='B']") !== null, null, { timeout: 5_000 });
  const urlB = await audio.getAttribute("src");
  assert.notEqual(urlB, urlA, "B is a different verified clip");
  const durationB = await metadataReady();
  await delay(500);
  const afterSwitch = await audio.evaluate((element) => ({ time: element.currentTime, paused: element.paused }));
  assert.ok(Math.abs(durationA - durationB) < 0.05, `A and B have the same length (${durationA} vs ${durationB})`);
  assert.ok(afterSwitch.time >= 1.4 && afterSwitch.time < 3.0, `playback continued at the same position, got ${afterSwitch.time}`);
  assert.equal(afterSwitch.paused, false, "still playing after the switch");
  assert.match(await ab.locator("[data-ab-announce]").textContent(), /Restored \(B\)/u);
  // Switch back with the keyboard only: the radio group.
  await page.getByLabel("Restored (B)", { exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.querySelector("audio[data-ab-current='A']") !== null, null, { timeout: 5_000 });
  assert.equal(await page.getByLabel("Source (A)", { exact: true }).isChecked(), true);
  assert.equal(await audio.getAttribute("src"), urlA);
  const playback = await audio.evaluate(async (element) => { await new Promise((r) => setTimeout(r, 500)); return { time: element.currentTime, duration: element.duration }; });
  assert.ok(playback.time > 1.4, `playback advanced, got ${playback.time}`);
  await audio.evaluate((element) => element.pause());

  // 7. Focus indicator and responsive layout.
  await page.getByRole("button", { name: "Restore and measure", exact: true }).focus();
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const wide = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 6).map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className} right=${Math.round(element.getBoundingClientRect().right)}`)) : [];
  assert.ok(overflow <= 1, `no horizontal scroll at 375px, overflow ${overflow}: ${JSON.stringify(wide)}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, textarea, input:not([type=checkbox]):not([type=radio]), label:has(> input[type=checkbox]), label:has(> input[type=radio])")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim().slice(0, 40)));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const restoreBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/audio/restorations").map((entry) => JSON.parse(entry.body));
  assert.equal(restoreBodies.length, 1);
  assert.deepEqual(restoreBodies[0].operations, {
    declip: { threshold: 10 }, dehum: { frequencyHz: 50 }, denoise: { reductionDb: 20, noiseFloorDb: -40, trackNoise: true },
  });
  assert.equal(restoreBodies[0].operations.normalize, undefined, "normalization was not requested");
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "restored",
    restored: { artifactId: restored.artifact.artifactId, artifactVersionId: restored.artifact.artifactVersionId, sha256: restored.artifact.sha256 },
    comparisonId: compared.outputId,
    snrSource: metrics.source.snrDb, snrRestored: metrics.restored.snrDb,
    clippedSource: metrics.source.clippedSamples, clippedRestored: metrics.restored.clippedSamples,
    verdict: compared.report.verdict.overall, playbackSeconds: playback.time, durationSeconds: durationA,
  })}\n`);
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
