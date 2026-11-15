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
const token = requiredEnv("MEDIA_DEV_LIVE_BROWSER_TOKEN");
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


const consentId = requiredEnv("MEDIA_DEV_LIVE_CONSENT_ID");
const consentVersion = requiredEnv("MEDIA_DEV_LIVE_CONSENT_VERSION");
const voiceId = requiredEnv("MEDIA_DEV_LIVE_VOICE_ID");
const voiceVersion = requiredEnv("MEDIA_DEV_LIVE_VOICE_VERSION");
const voiceAttestation = requiredEnv("MEDIA_DEV_LIVE_VOICE_ATTESTATION");
const pollMillis = Number(requiredEnv("MEDIA_DEV_LIVE_POLL_MS"));
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
delete viteEnvironment.MEDIA_DEV_LIVE_BROWSER_TOKEN;
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
      const response = await fetch(`${baseUrl}/dev-live-session.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual live page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
  // Deliberate typed refusals (410/403/404) and the deliberately offline window are logged by Chromium as failed loads.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (410|403|404|409)/u.test(message.text()) && !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, headers: request.headers() });
  });
  const text = async (selector) => (await page.locator(selector).textContent()).trim();
  const number = async (selector) => Number(await text(selector));
  const connect = async () => {
    await page.goto(`${baseUrl}/dev-live-session.html`, { waitUntil: "networkidle" });
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Capture and stream", level: 2 }).waitFor({ timeout: 30_000 });
  };
  const startWith = async (id, version, scope, lease = "30") => {
    await page.locator("#live-consent-id").fill(id);
    await page.locator("#live-consent-version").fill(version);
    await page.locator("#live-scope").selectOption(scope);
    await page.locator("#live-lease").fill(lease);
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/live-sessions" && response.request().method() === "POST", { timeout: 30_000 });
    await page.getByRole("button", { name: "Start live capture", exact: true }).click();
    const response = await created;
    return { status: response.status(), body: await response.json() };
  };

  // 1. Connect and read the limits from the host.
  await connect();
  assert.ok((await text("#connection-status")).includes("lease up to 300 s"));
  assert.ok(await page.locator("[aria-live='polite']").count() >= 2, "live regions announce status");

  // 2. A consent subject without any statement is refused with the typed 403 and nothing starts.
  const refused = await startWith("not-a-real-artifact", consentVersion, "PROCESSING");
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  await page.locator("#live-failure[data-failure-code]").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("#live-failure").getAttribute("data-failure-code"), "CONSENT_SUBJECT_NOT_FOUND");
  assert.equal(await text("[data-session-id]"), "none");
  assert.equal(await page.locator("#live-start").isDisabled(), false);

  // 3. A real live capture: the WebAudio tone is streamed; the network is cut mid-stream and comes back.
  const opened = await startWith(consentId, consentVersion, "PROCESSING");
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const sessionId = opened.body.sessionId;
  await page.waitForFunction(() => Number(document.querySelector("[data-acked]")?.textContent) >= 50, null, { timeout: 30_000 });
  const ackedBeforeCut = await number("[data-acked]");
  await context.setOffline(true);
  await delay(1_800);
  await context.setOffline(false);
  await page.waitForFunction((before) => Number(document.querySelector("[data-network-errors]")?.textContent) > 0
    && Number(document.querySelector("[data-acked]")?.textContent) > before + 20, ackedBeforeCut, { timeout: 30_000 });
  const networkErrors = await number("[data-network-errors]");
  assert.ok(networkErrors >= 1, "the page observed the outage and survived it");
  await page.waitForFunction(() => Number(document.querySelector("[data-acked]")?.textContent) >= 200, null, { timeout: 30_000 });

  // 4. End the stream: stored, and the page's own read-back equals what it sent.
  const eos = page.waitForResponse((response) => new URL(response.url()).pathname === `/dev/v1/live-sessions/${sessionId}/eos`, { timeout: 60_000 });
  await page.getByRole("button", { name: "Stop and store", exact: true }).click();
  const eosResponse = await eos;
  assert.equal(eosResponse.status(), 201, await eosResponse.text());
  const stored = await eosResponse.json();
  assert.equal(stored.state, "COMPLETED");
  await page.locator("#live-result:not([hidden])").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /^yes/u.test(document.querySelector("[data-verified]")?.textContent ?? ""), null, { timeout: 30_000 });
  const sentSha = await text("[data-sent-sha256]");
  assert.equal(sentSha, stored.outputs.pcmSha256, "the host stored exactly the PCM the page sent");
  assert.equal(await text("[data-stored-frames]"), String(stored.outputs.frameCount));
  assert.ok(stored.outputs.frameCount >= 200);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "live-result-heading", "focus moves to the result");

  // 5. Consent revoked while live: the host ends the session within its bound and the page shows the typed outcome.
  const voice = await startWith(voiceId, voiceVersion, "VOICE_OR_LIKENESS_USE");
  assert.equal(voice.status, 201, JSON.stringify(voice.body));
  await page.waitForFunction(() => Number(document.querySelector("[data-acked]")?.textContent) >= 40, null, { timeout: 30_000 });
  const revokeAt = Date.now();
  const revoke = await fetch(`${baseUrl}/dev/v1/rights/attestations/${voiceAttestation}/revoke`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "TEST: revoked while the browser stream is live" }) });
  assert.equal(revoke.status, 200);
  await page.locator('#live-failure[data-failure-code="SESSION_REVOKED"]').waitFor({ timeout: 10_000 });
  const revokedAfterMs = Date.now() - revokeAt;
  assert.ok(revokedAfterMs <= 2 * pollMillis + 3_000, `the page saw the revocation within the bound, took ${revokedAfterMs} ms`);
  assert.equal(await text("[data-state]"), "REVOKED");
  assert.ok((await page.locator("#live-status").textContent()).includes("Nothing was stored"));
  assert.equal(await page.locator("#live-result").isHidden(), true);
  const ackedAtRevoke = await number("[data-acked]");
  await delay(1_000);
  assert.equal(await number("[data-acked]"), ackedAtRevoke, "capture stopped: nothing is sent after the revocation");

  // 6. Abort discards.
  const aborted = await startWith(consentId, consentVersion, "PROCESSING");
  assert.equal(aborted.status, 201);
  await page.waitForFunction(() => Number(document.querySelector("[data-acked]")?.textContent) >= 10, null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Abort and discard", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-state]")?.textContent === "ABORTED", null, { timeout: 10_000 });
  assert.equal(await page.locator("#live-result").isHidden(), true);

  // 7. Responsive and clean.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; }).map((element) => element.id));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const kept = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!kept.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "live", sessionId, wavId: stored.outputs.wav.artifactId, wavSha256: stored.outputs.wav.sha256, indexId: stored.outputs.ptsIndex.artifactId,
    frames: stored.outputs.frameCount, sentPcmSha256: sentSha, networkErrorsSurvived: networkErrors, revokedSessionId: voice.body.sessionId,
    revokedAfterMs, abortedSessionId: aborted.body.sessionId,
  })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
