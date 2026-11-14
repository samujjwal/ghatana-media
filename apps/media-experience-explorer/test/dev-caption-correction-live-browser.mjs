import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Real Chromium drives the caption correction page against a REAL launcher (PostgreSQL + S3, real Whisper output
 * already registered by the integration test). Keyboard-only editing, an unknown outcome that is retried with the same
 * request identity, a stale-base conflict, the owner assigning a reviewer and a second browser context (the assigned
 * reviewer) accepting the exact version, then readback after a launcher restart.
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_TOKEN");
const principal = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_PRINCIPAL");
const reviewerToken = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_REVIEWER_TOKEN");
const reviewerPrincipal = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_REVIEWER_PRINCIPAL");
const machineId = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_MACHINE_ID");
const machineVersion = requiredEnv("MEDIA_DEV_CAPTION_BROWSER_MACHINE_VERSION");
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT"));
const viteBinary = requiredEnv("MEDIA_DEV_VITE_BINARY");
const playwrightModule = requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE");
const expectedViteVersion = requiredEnv("MEDIA_DEV_VITE_VERSION");
const expectedPlaywrightVersion = "1.63.0";
const expectedChromiumRevision = "1243";
const expectedChromiumVersion = "153.0.8010.12";
const vitePackageRoot = dirname(dirname(await realpath(viteBinary)));
const vitePackage = JSON.parse(await readFile(resolve(vitePackageRoot, "package.json"), "utf8"));
assert.equal(vitePackage.version, expectedViteVersion, `Vite version mismatch: expected ${expectedViteVersion}, found ${vitePackage.version}`);
const playwrightEntry = await realpath(playwrightModule);
const playwrightEntryRoot = dirname(playwrightEntry);
const playwrightEntryPackage = JSON.parse(await readFile(resolve(playwrightEntryRoot, "package.json"), "utf8"));
assert.equal(playwrightEntryPackage.version, expectedPlaywrightVersion, `Playwright runner must be ${expectedPlaywrightVersion}`);
const playwrightRuntimeRoot = playwrightEntryPackage.name === "@playwright/test"
  ? resolve(playwrightEntryRoot, "node_modules/playwright")
  : playwrightEntryRoot;
const playwrightCoreRoot = resolve(playwrightRuntimeRoot, "../playwright-core");
const browserManifest = JSON.parse(await readFile(resolve(playwrightCoreRoot, "browsers.json"), "utf8"));
const pinnedChromium = browserManifest.browsers.find((browser) => browser.name === "chromium");
assert.equal(pinnedChromium?.revision, expectedChromiumRevision);
assert.equal(pinnedChromium?.browserVersion, expectedChromiumVersion);
const { chromium } = await import(playwrightModule);
const chromiumBinary = chromium.executablePath();
assert.ok(chromiumBinary.includes(`chromium-${expectedChromiumRevision}/`), `Playwright must select Chromium revision ${expectedChromiumRevision}`);
const chromiumVersionOutput = await execFile(chromiumBinary, ["--version"]);
assert.ok(chromiumVersionOutput.stdout.includes(expectedChromiumVersion), `Chromium binary must be ${expectedChromiumVersion}`);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real-host browser integration.`);
  return value;
}
function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT must be a valid TCP port.");
  return port;
}

// Distinct from the other live pages (4179-4181 are taken by sibling journeys); strictPort fails instead of drifting.
const vitePort = 4187;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_CAPTION_BROWSER_TOKEN;
delete viteEnvironment.MEDIA_DEV_CAPTION_BROWSER_REVIEWER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
  cwd: appRoot, env: viteEnvironment, stdio: ["ignore", "pipe", "pipe"],
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
    try { if ((await fetch(`${baseUrl}/dev-caption-correction.html`)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual caption correction page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    let pathname = "";
    try { pathname = new URL(message.location()?.url ?? "").pathname; } catch { pathname = ""; }
    consoleErrors.push({ text: message.text(), pathname });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });

  async function connect(target, bearer) {
    await target.goto(`${baseUrl}/dev-caption-correction.html`);
    await target.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
    await target.getByRole("button", { name: "Connect", exact: true }).click();
    await target.getByRole("heading", { name: "Correct captions" }).waitFor({ timeout: 15_000 });
  }
  const status = (target) => target.locator("#caption-status");
  async function openCaption(target, id) {
    await target.getByLabel("Caption version id").fill(id);
    await target.getByRole("button", { name: "Open caption version" }).click();
    await target.locator("#caption-version-id").filter({ hasText: id }).waitFor({ timeout: 15_000 });
  }
  const savePosts = () => apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/captions/corrections");

  await connect(page, token);
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- 1. Open the real machine caption (Whisper output); the review lane says it is not accepted ----
  await openCaption(page, machineId);
  assert.match(await page.locator("#caption-lineage").textContent(), /machine caption \(unreviewed Whisper output\)/u);
  assert.match(await page.locator("#caption-review").textContent(), /must accept this exact version/u);
  const machineCueCount = await page.getByRole("list", { name: "Caption cues" }).locator("> li").count();
  assert.ok(machineCueCount >= 1, "the real transcript has at least one cue");
  const machineFirstText = await page.getByLabel("Cue 1 text").inputValue();
  assert.ok(machineFirstText.length > 0);
  assert.equal(await page.getByRole("button", { name: "Save as new caption version" }).isDisabled(), true, "no edit, no save");

  // ---- 2. Validation is reported accessibly and blocks saving ----
  await page.getByLabel("Cue 1 end").fill("00:00.000");
  const endInput = page.getByLabel("Cue 1 end");
  assert.equal(await endInput.getAttribute("aria-invalid"), "true");
  const errorId = await endInput.getAttribute("aria-describedby");
  assert.match(await page.locator(`#${errorId}`).textContent(), /end must be after/u);
  assert.equal(await page.getByRole("button", { name: "Save as new caption version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Discard edits" }).click();
  assert.equal(await page.getByLabel("Cue 1 text").inputValue(), machineFirstText, "discard restores the opened version");

  // ---- 3. Keyboard-only edit and save: focus, select all, type, Ctrl+Enter ----
  const humanText1 = "And so, my fellow Americans, ask not what your country can do for you;";
  await page.getByLabel("Cue 1 text").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(humanText1);
  assert.match(await page.locator("#caption-dirty").textContent(), /unsaved edits/u);
  await page.keyboard.press("Control+Enter");
  await status(page).filter({ hasText: /Saved \(HTTP 201\) as new version/u }).waitFor({ timeout: 30_000 });
  const v1 = (await page.locator("#caption-version-id").textContent()).trim();
  assert.notEqual(v1, machineId, "a correction is a NEW version");
  assert.equal((await page.locator("#caption-parent").textContent()).trim(), machineId);
  assert.equal((await page.locator("#caption-machine").textContent()).trim(), machineId);
  assert.equal((await page.locator("#caption-corrector").textContent()).trim(), principal);
  assert.equal(await page.getByLabel("Cue 1 text").inputValue(), humanText1);
  const firstSave = JSON.parse(savePosts()[0].body);
  assert.equal(firstSave.baseArtifactId, machineId);
  assert.equal(firstSave.expectedVersionId, machineVersion, "the request binds the exact edited version");
  assert.equal(firstSave.cues[0].text, humanText1);
  assert.equal(Object.hasOwn(firstSave, "principalId"), false, "no request field names the corrector");
  assert.match(await page.locator("#caption-edit").textContent(), /[1-9]\d* text/u);

  // ---- 4. Unknown outcome: the host registers the version but the browser sees a failure; retry is idempotent ----
  const humanText2 = `${humanText1} [second pass]`;
  await page.getByLabel("Cue 1 text").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(humanText2);
  let dropped = false;
  await page.route("**/dev/v1/captions/corrections", async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();       // the real host receives and registers the correction ...
    await route.abort("failed"); // ... but the browser never observes the answer.
  });
  await page.getByRole("button", { name: "Save as new caption version" }).click();
  await page.locator("#caption-outcome").filter({ hasText: "OUTCOME UNKNOWN" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("#caption-outcome").getAttribute("data-outcome-code"), "OUTCOME_UNKNOWN");
  assert.equal((await status(page).textContent()).trim(), "The save outcome is unknown.");
  await page.getByRole("button", { name: "Save as new caption version" }).click();
  await status(page).filter({ hasText: /Replayed \(HTTP 200\)/u }).waitFor({ timeout: 30_000 });
  const v2 = (await page.locator("#caption-version-id").textContent()).trim();
  assert.notEqual(v2, v1);
  assert.equal((await page.locator("#caption-parent").textContent()).trim(), v1);
  const retryBodies = savePosts().slice(1).map(({ body }) => JSON.parse(body));
  assert.equal(retryBodies.length, 2);
  assert.equal(retryBodies[0].requestId, retryBodies[1].requestId, "the retry reuses the same request identity");
  assert.equal(retryBodies[0].baseArtifactId, v1);
  await page.unroute("**/dev/v1/captions/corrections");

  // ---- 5. Stale base: the machine version already has a correction, so editing it again is a conflict ----
  await openCaption(page, machineId);
  await page.getByLabel("Cue 1 text").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("A competing edit of the already corrected machine version");
  await page.getByRole("button", { name: "Save as new caption version" }).click();
  await page.locator("#caption-outcome").filter({ hasText: "CONFLICT" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("#caption-outcome").getAttribute("data-outcome-code"), "CAPTION_VERSION_CONFLICT");
  assert.equal((await status(page).textContent()).trim(), "Nothing was saved.");
  assert.equal((await page.locator("#caption-version-id").textContent()).trim(), machineId, "the editor still shows the version being edited");

  // ---- 6. Review: open v2, the owner opens a case on the exact version and assigns the reviewer ----
  await openCaption(page, v2);
  await page.getByRole("button", { name: "Open review case" }).click();
  await page.locator("#review-status").filter({ hasText: /Opened DEV_ONLY review case .* No approval exists\./u }).waitFor({ timeout: 15_000 });
  const reviewCaseId = await page.locator("[data-review-case]").getAttribute("data-review-case");
  assert.ok(reviewCaseId);
  await page.getByLabel("Reviewer principal ID").fill(reviewerPrincipal);
  await page.getByRole("checkbox", { name: "QUALITY", exact: true }).check();
  await page.getByLabel(/Expires in days/u).fill("1");
  await page.getByRole("button", { name: "Assign reviewer" }).click();
  await page.locator("#review-status").filter({ hasText: /Assigned \(HTTP 201\).*not human approval/u }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true, "the owner cannot decide");

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  const reviewerErrors = [];
  reviewerPage.on("pageerror", (error) => reviewerErrors.push(error.message));
  reviewerPage.on("console", (message) => { if (message.type() === "error") reviewerErrors.push(message.text()); });
  await connect(reviewerPage, reviewerToken);
  assert.equal(await reviewerPage.locator("#caption-edit-form").count(), 0, "no caption is open for the reviewer");
  await reviewerPage.getByLabel("Known review case ID").fill(reviewCaseId);
  await reviewerPage.getByRole("button", { name: "Reopen known review case" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Reopened review case .*: CURRENT/u }).waitFor();
  await reviewerPage.locator("#review-scope").selectOption("QUALITY");
  await reviewerPage.locator("#review-reason").fill("TEST: DEV_ONLY assigned-reviewer decision on the exact corrected caption version.");
  await reviewerPage.locator("#review-confirm").check();
  await reviewerPage.getByRole("button", { name: "Record DEV_ONLY decision" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Recorded DEV_ONLY decision \(HTTP 201\).*establishesApproval=false/u }).waitFor();
  assert.ok((await reviewerPage.locator("[data-review-case]").textContent()).includes("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT"));

  // The owner reopens the exact version: it is now accepted by the assigned reviewer, never an approval.
  await openCaption(page, v2);
  await page.locator("#caption-review").filter({ hasText: /Accepted by an assigned reviewer for this exact version/u }).waitFor();
  assert.match(await page.locator("#caption-review").textContent(), /not an approval/u);
  // The earlier version is not accepted: review binds the exact version.
  await openCaption(page, v1);
  assert.match(await page.locator("#caption-review").textContent(), /Not accepted for use/u);

  process.stdout.write(`${JSON.stringify({ event: "created", machineId, v1, v2, reviewCaseId, humanText2 })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let restarted = false;
  for await (const line of input) {
    if (line === "host-restarted") { restarted = true; break; }
  }
  input.close();
  assert.equal(restarted, true, "the integration host must restart before readback");

  // ---- 7. Readback after the host restart (same pages, no mutation) ----
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await openCaption(page, v2);
  await page.locator("#caption-review").filter({ hasText: /Accepted by an assigned reviewer/u }).waitFor();
  assert.equal((await page.locator("#caption-parent").textContent()).trim(), v1);
  assert.equal(await page.getByLabel("Cue 1 text").inputValue(), humanText2);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "readback must not mutate");
  await reviewerPage.getByRole("button", { name: "Re-read review case" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Re-read review case .*: CURRENT/u }).waitFor();
  assert.match(await reviewerPage.getByLabel("Review records").textContent(), /DEV_ASSIGNED_REVIEWER_ACCEPT/u);

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  // Only the deliberate unknown-outcome abort and the deliberate conflict may log.
  const unexpected = consoleErrors.filter(({ text, pathname }) =>
    !(pathname === "/dev/v1/captions/corrections" && /status of 409|ERR_FAILED|Failed to load resource/u.test(text)));
  assert.deepEqual(unexpected, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.deepEqual(reviewerErrors, [], `reviewer page errors: ${JSON.stringify(reviewerErrors)}`);
  process.stdout.write(`${JSON.stringify({ event: "readback", v1, v2, reviewCaseId })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => viteProcess.once("exit", resolveExit)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
