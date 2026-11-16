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
const token = requiredEnv("MEDIA_DEV_PROVIDER_BROWSER_TOKEN");
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

const vitePort = 4231;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_PROVIDER_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-provider-status.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual provider status page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1200 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/dev/v1/")) return;
    apiRequests.push({ method: request.method(), path, url: request.url() });
  });

  await page.goto(`${baseUrl}/dev-provider-status.html`);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const panel = page.getByRole("region", { name: /Local providers/u });
  await panel.waitFor({ timeout: 60_000 });
  const table = page.getByRole("table", { name: "Local provider readiness" });
  await table.waitFor({ timeout: 60_000 });

  const rowStates = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#provider-table tbody tr")]
    .map((tr) => [tr.getAttribute("data-provider-id"), { state: tr.getAttribute("data-state"), text: tr.textContent }])));

  // ---- the page shows the real host catalog: five providers, states as visible text, no inline style, no path ----
  const initial = await rowStates();
  assert.deepEqual(Object.keys(initial).sort(), ["ffmpeg", "florence", "kokoro", "qwen", "whisper"]);
  for (const [id, row] of Object.entries(initial)) {
    assert.ok(row.text.toUpperCase().includes(row.state.replace("_", " ")), `${id} must show its state as text`);
  }
  assert.equal(await page.locator("[style]").count(), 0, "strict CSP: no inline style attributes");
  const pageText = await page.locator("main").innerText();
  assert.ok(!pageText.includes("/home/") && !pageText.includes(token), "no filesystem path or token on the page");
  assert.equal(await page.getByText("Yes", { exact: true }).count(), 0, "production eligibility is never yes");
  // Accessibility: labelled region, captioned table, labelled controls, keyboard reachable refresh.
  assert.equal(await page.locator("#provider-table caption").count(), 1);
  assert.ok(await page.getByLabel("Live refresh").isChecked(), "live refresh starts on");
  // Reach the button the way a keyboard user does (focus-visible only applies after keyboard interaction).
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.textContent?.trim() === "Refresh now")) break;
  }
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Refresh now", "Tab reaches the refresh button");
  const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(focusRing, "none", "the refresh button must show a focus indicator");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id?.endsWith("-live")), true, "Tab reaches the live refresh checkbox");
  emit({ event: "connected", states: Object.fromEntries(Object.entries(initial).map(([id, row]) => [id, row.state])) });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function nextCommand(prefix) {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error(`stdin closed before ${prefix}`);
      if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
    }
  }

  // ---- the host takes a provider down: the open page must show it without a reload ----
  const target = await nextCommand("outage ");
  assert.match(target, /^[a-z]+$/u);
  const apiBefore = apiRequests.length;
  await page.locator(`#provider-table tr[data-provider-id="${target}"][data-state="UNAVAILABLE"]`).waitFor({ timeout: 90_000 });
  const outageRow = (await rowStates())[target];
  assert.ok(apiRequests.length > apiBefore, "the state change arrived through live refresh requests, not a reload");
  assert.equal(await page.getByTestId("provider-announcement").textContent().then((t) => t.includes(`changed from READY to UNAVAILABLE`)), true,
    "the change is announced in the polite live region");
  emit({ event: "outage-observed", provider: target, state: outageRow.state, text: outageRow.text });

  // ---- recovery is shown too, and never as READY before the host says READY ----
  await nextCommand("recovered");
  await page.locator(`#provider-table tr[data-provider-id="${target}"][data-state="READY"]`).waitFor({ timeout: 90_000 });
  emit({ event: "recovery-observed", provider: target });

  // ---- live refresh can be turned off: no further requests ----
  await page.getByLabel("Live refresh").uncheck();
  const settled = apiRequests.length;
  await delay(7_500);
  assert.equal(apiRequests.length, settled, "no refresh requests while live refresh is off");
  for (const entry of apiRequests) assert.ok(entry.url.endsWith("/dev/v1/providers/catalog") || entry.path === "/dev/v1/context", entry.url);
  assert.ok(apiRequests.every((entry) => entry.method === "GET"), "the page only reads");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  for (const entry of apiRequests) assert.ok(!entry.url.includes(token), "token must not be in a URL");
  input.close();
  emit({ event: "done" });
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
