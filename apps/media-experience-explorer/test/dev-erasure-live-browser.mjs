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
const token = requiredEnv("MEDIA_DEV_ERASURE_BROWSER_TOKEN");
const rootId = requiredEnv("MEDIA_DEV_ERASURE_BROWSER_ROOT_ID");
const childId = requiredEnv("MEDIA_DEV_ERASURE_BROWSER_CHILD_ID");
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
delete viteEnvironment.MEDIA_DEV_ERASURE_BROWSER_TOKEN;
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
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-erasure.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual erasure page:\n${viteOutput}`);

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

  const connect = async () => {
    let connected = false;
    for (let attempt = 1; attempt <= 3 && !connected; attempt += 1) {
      await page.goto(`${baseUrl}/dev-erasure.html`);
      await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      try {
        await page.getByRole("heading", { name: /Erasure and legal hold · DEV_ONLY/u }).waitFor({ timeout: 15_000 });
        connected = true;
      } catch {
        if (attempt === 3) throw new Error(`panel did not render after ${attempt} loads; status="${await page.locator("#connection-status").textContent()}" pageErrors=${JSON.stringify(pageErrors)}`);
        consoleErrors.length = 0;
      }
    }
    assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");
  };
  await connect();

  // ---- 1. Review the tree: the exact tree is shown before anything is erased ----
  await page.getByLabel("Root artifact ID").fill(rootId);
  await page.getByRole("button", { name: "Review tree" }).click();
  const plan = page.locator("#erasure-plan");
  await plan.waitFor({ timeout: 30_000 });
  const table = page.getByRole("table", { name: "Artifacts that will be erased" });
  const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ id: tr.getAttribute("data-artifact-id"), kind: tr.getAttribute("data-kind"), depth: tr.getAttribute("data-depth") })));
  assert.deepEqual(rows.map((row) => row.id), [rootId, childId], "the tree lists the root and its derived render");
  assert.deepEqual(rows.map((row) => row.kind), ["SOURCE_ARTIFACT", "RENDER"]);
  assert.deepEqual(rows.map((row) => row.depth), ["0", "1"]);
  assert.equal(await plan.getAttribute("data-erasable"), "true");
  assert.match(await page.locator("#erasure-status").textContent(), /2 artifacts would be erased/u);
  const eraseButton = page.getByRole("button", { name: "Erase this tree…" });
  assert.equal(await eraseButton.isEnabled(), true);

  // ---- 2. Legal hold through the UI: it blocks the erase control until released, and records who and why ----
  await page.getByLabel(/Reason for a new legal hold/u).fill("TEST legal hold placed from the Explorer");
  await page.getByRole("button", { name: "Place legal hold" }).click();
  const holds = page.getByRole("list", { name: "Active legal holds" });
  await holds.waitFor({ timeout: 30_000 });
  assert.match(await holds.textContent(), /TEST legal hold placed from the Explorer/u);
  assert.match(await holds.textContent(), /Placed by test-principal-owner/u);
  assert.match(await holds.textContent(), /DEV_ISSUED/u);
  assert.equal(await eraseButton.isDisabled(), true, "a legal hold disables erasure");
  assert.match(await page.locator("#erasure-plan").textContent(), /Erasure is blocked while a legal hold covers this tree/u);
  process.stdout.write(`${JSON.stringify({ event: "held" })}\n`);
  const holdInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const holdLines = holdInput[Symbol.asyncIterator]();
  assert.equal((await holdLines.next()).value, "hold-verified", "the host refused the erase API under the hold");
  await page.getByLabel(/Reason for releasing hold/u).fill("TEST matter closed from the Explorer");
  await page.getByRole("button", { name: "Release hold" }).click();
  await page.locator("#erasure-status").filter({ hasText: /released by test-principal-owner[^:]*: TEST matter closed from the Explorer/u }).waitFor({ timeout: 30_000 });
  await page.getByText("No legal hold covers this tree.").waitFor();
  assert.equal(await eraseButton.isEnabled(), true, "releasing the hold re-enables erasure");

  // ---- 3. Confirmation: keyboard-operable, gated by a checkbox and the typed id, Escape cancels ----
  await eraseButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  const heading = dialog.getByRole("heading", { name: "Confirm permanent erasure" });
  assert.equal(await heading.evaluate((node) => document.activeElement === node), true, "focus moves into the dialog");
  assert.match(await dialog.textContent(), /cannot be undone and is not the same as revoking rights/u);
  const confirmErase = dialog.getByRole("button", { name: "Erase permanently" });
  assert.equal(await confirmErase.isDisabled(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await eraseButton.evaluate((node) => document.activeElement === node), true, "focus returns to the trigger after cancel");
  assert.equal(apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/erasures").length, 0, "cancel sent nothing");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.getByLabel("I understand this is permanent").check();
  assert.equal(await confirmErase.isDisabled(), true, "the checkbox alone is not enough");
  await dialog.getByLabel("Type the root artifact ID to confirm").fill(`${rootId}-wrong`);
  assert.equal(await confirmErase.isDisabled(), true, "a wrong id does not confirm");
  await dialog.getByLabel("Type the root artifact ID to confirm").fill(rootId);
  assert.equal(await confirmErase.isEnabled(), true);
  await confirmErase.click();

  // ---- 4. The receipt: kinds, counts and digests of the removed objects, never content ----
  const receipt = page.locator("#erasure-receipt");
  await receipt.waitFor({ timeout: 60_000 });
  assert.equal(await receipt.getAttribute("data-complete"), "true");
  const erasureId = await receipt.getAttribute("data-erasure-id");
  assert.ok(erasureId && erasureId.startsWith("ui-"));
  const items = await receipt.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({
    kind: tr.getAttribute("data-kind"), count: Number(tr.querySelector("td").textContent),
    digests: [...tr.querySelectorAll("code[title]")].map((code) => code.getAttribute("title")),
  })));
  const kinds = items.map((item) => item.kind);
  for (const expected of ["SOURCE_ARTIFACT", "RENDER", "S3_OBJECT", "UPLOAD_SESSION"]) assert.ok(kinds.includes(expected), `${expected} is in the receipt: ${kinds}`);
  for (const item of items) for (const digest of item.digests) assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(items.find((item) => item.kind === "S3_OBJECT").count, 2);
  assert.equal(items.find((item) => item.kind === "RENDER").digests.length, 1);
  assert.match(await receipt.textContent(), /No content is shown/u);
  assert.equal(await page.locator("#erasure-plan").count(), 0, "the tree is gone once it is erased");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  process.stdout.write(`${JSON.stringify({ event: "erased", erasureId, items })}\n`);

  // ---- 5. After erasure: the same root answers "already erased"; nothing is disclosed ----
  await page.getByLabel("Root artifact ID").fill(rootId);
  await page.getByRole("button", { name: "Review tree" }).click();
  await page.locator("#erasure-status[role='alert']").filter({ hasText: /ARTIFACT_ERASED/u }).waitFor({ timeout: 30_000 });
  assert.match(await page.locator("#erasure-status").textContent(), /already erased/u);
  assert.equal(await page.locator("#erasure-plan").count(), 0);

  // ---- 6. After the host restarts, the receipt still reads back, complete ----
  assert.equal((await holdLines.next()).value, "host-restarted", "the integration host must restart before readback");
  holdInput.close();
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await page.getByLabel("Reopen receipt by erasure ID").fill(erasureId);
  await page.getByRole("button", { name: "Reopen receipt" }).click();
  await page.locator("#erasure-receipt[data-complete='true']").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("#erasure-receipt").getAttribute("data-erasure-id"), erasureId);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "readback must not mutate");
  await page.getByLabel("Root artifact ID").fill(rootId);
  await page.getByRole("button", { name: "Review tree" }).click();
  await page.locator("#erasure-status[role='alert']").filter({ hasText: /ARTIFACT_ERASED/u }).waitFor({ timeout: 30_000 });

  // ---- 7. Accessibility and layout basics: names, live regions, no horizontal scroll at a narrow width ----
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, input:not([type=hidden]), table, [role=alertdialog]")]
    .filter((node) => !(node.getAttribute("aria-label") || node.getAttribute("aria-labelledby") || node.labels?.length || node.textContent.trim())).length);
  assert.equal(unnamed, 0, "every control and table has an accessible name");
  assert.equal(await page.locator("h1").count(), 1);
  assert.ok(await page.locator("[aria-live]").count() >= 1);
  await page.setViewportSize({ width: 375, height: 900 });
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 375px, overflow ${overflow}px`);

  // Only the DEV routes of this lane were called, never DELETE, and the token was never persisted.
  const allowed = [/^\/dev\/v1\/context$/u, /^\/dev\/v1\/erasure-plans\/[^/]+$/u, /^\/dev\/v1\/erasures(\/[^/]+)?$/u, /^\/dev\/v1\/legal-holds(\/[^/]+(\/release)?)?$/u];
  for (const request of apiRequests) {
    assert.ok(allowed.some((pattern) => pattern.test(request.path)), `unexpected API call ${request.method} ${request.path}`);
    assert.notEqual(request.method, "DELETE");
    assert.equal(request.search, "", "no query strings are sent");
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  // Only the deliberate 410 answers for an erased root may log a network error.
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !(pathname.startsWith("/dev/v1/erasure-plans/") && /status of 410/u.test(text)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({ event: "erasure-browser", erasureId, rows: rows.length })}\n`);
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
