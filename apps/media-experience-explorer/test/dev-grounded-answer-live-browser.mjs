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
const token = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_TOKEN");
const answerId = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_ANSWER_ID");
const documentPath = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_DOCUMENT_PATH");
const unattestedId = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_UNATTESTED_ID");
const unattestedVersion = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_UNATTESTED_VERSION");
const garbageId = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_GARBAGE_ID");
const garbageVersion = requiredEnv("MEDIA_DEV_GROUNDED_BROWSER_GARBAGE_VERSION");
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

const vitePort = 4181;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_GROUNDED_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-grounded-answer.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual grounded-answer page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const expectedErrors = []; // { pathname, status }
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
    apiRequests.push({ method: request.method(), path: url.pathname, search: url.search, headers: request.headers() });
  });

  const view = JSON.parse(await readFile(documentPath, "utf8"));
  const doc = view.document;
  const clock = doc.sourceClock;
  const startMicros = clock.containerStartMicros;
  const expectedSeconds = (item) => Math.max(0, (item.startMicros - startMicros) / 1_000_000);
  const byId = new Map(doc.evidence.map((item) => [item.evidenceId, item]));
  const claims = doc.answer.claims;
  assert.ok(claims.length >= 1, "the real answer has at least one grounded claim");

  await page.goto(`${baseUrl}/dev-grounded-answer.html`);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: /Grounded answer · DEV_ONLY/u }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- reopen the REAL answer registered by the real models, then verify the exact source bytes load ----
  await page.getByLabel("Reopen answer by output ID").fill(answerId);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  const result = page.locator("#grounded-result");
  await result.waitFor({ timeout: 30_000 });
  assert.equal(await result.getAttribute("data-output-id"), answerId);
  assert.equal(await result.getAttribute("data-via"), "reopened");
  assert.equal(await result.getAttribute("data-status"), doc.answer.status);
  const videoLocator = page.locator("video[aria-label='Source video for the grounded answer']");
  await videoLocator.waitFor({ timeout: 30_000 });
  const metadata = await videoLocator.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    const done = () => resolveLoad({ duration: element.duration, width: element.videoWidth, height: element.videoHeight, src: element.src });
    if (element.readyState >= 1) return done();
    element.addEventListener("loadedmetadata", done, { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code}: ${element.error?.message}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("video metadata did not load")), 20_000);
  }));
  assert.match(metadata.src, /^blob:/u, "the player must play verified bytes through a blob URL");
  assert.equal(metadata.width, clock.video.width);
  assert.equal(metadata.height, clock.video.height);
  // The browser timeline is relative to the container start: its duration is the container duration on the clock.
  assert.ok(Math.abs(metadata.duration - clock.containerDurationMicros / 1_000_000) < 0.25,
    `player duration ${metadata.duration}s must match the clock duration ${clock.containerDurationMicros / 1e6}s`);
  const contentCall = apiRequests.find(({ path }) => path === `/dev/v1/artifacts/${doc.source.artifactId}/content`);
  assert.ok(contentCall, "the source version is read through the exact-version content route");
  assert.equal(contentCall.headers["if-match"], doc.source.artifactVersionId, "exact version travels in If-Match");
  assert.ok(apiRequests.every(({ search }) => search === ""), "no query strings, so no ids or tokens in URLs");

  // ---- claims, citations and not-grounded claims are exactly what the host validated ----
  const claimList = page.getByRole("list", { name: "Grounded claims" });
  for (const claim of claims) {
    const item = claimList.locator(`li[data-claim-id='${claim.claimId}']`);
    assert.equal((await item.locator("p").first().textContent()).trim(), claim.text);
    for (const evidenceId of claim.evidenceIds) {
      assert.equal(await item.locator(`button[data-evidence-id='${evidenceId}']`).count(), 1, `claim ${claim.claimId} cites ${evidenceId}`);
    }
  }
  assert.equal(await page.locator("li[data-flagged='true']").count(), doc.answer.flaggedClaims.length);
  assert.equal(await page.locator("li[data-flagged='true'] button").count(), 0, "a not-grounded claim has no seek control");
  assert.ok((await page.getByTestId("answer-status").textContent()).includes(doc.answer.status.replaceAll("_", " ")));
  const children = page.getByRole("table", { name: "Evidence children" });
  assert.match(await children.textContent(), /DOCUMENT INTELLIGENCEUNAVAILABLE/u);

  // ---- citation -> seek -> highlight (keyboard first, then pointer) ----
  async function seekedTime() {
    await page.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.seeking; }, null, { timeout: 15_000 });
    return videoLocator.evaluate((element) => element.currentTime);
  }
  const cited = [...new Set(claims.flatMap((claim) => claim.evidenceIds))].map((id) => byId.get(id));
  const boxed = cited.find((item) => item.box && item.kind === "FRAME_TEXT") ?? cited.find((item) => item.box);
  assert.ok(boxed, "the grounded answer cites at least one on-screen region");
  const boxedButton = result.locator(`button[data-evidence-id='${boxed.evidenceId}']`).first();
  assert.equal(await boxedButton.getAttribute("aria-pressed"), "false");
  assert.match(await boxedButton.getAttribute("aria-label"), /Seek the video to this evidence/u);
  await boxedButton.focus();
  await page.keyboard.press("Enter");
  const boxedTime = await seekedTime();
  assert.ok(Math.abs(boxedTime - expectedSeconds(boxed)) < 0.06,
    `keyboard citation ${boxed.evidenceId} must seek to ${expectedSeconds(boxed)}s, player is at ${boxedTime}s`);
  assert.equal(await boxedButton.getAttribute("aria-pressed"), "true");
  const box = page.getByTestId("citation-box");
  await box.waitFor();
  assert.equal(await box.getAttribute("data-evidence-id"), boxed.evidenceId);
  assert.equal(await box.getAttribute("role"), "img");
  assert.ok((await box.getAttribute("aria-label")).includes(boxed.text));
  // Geometry: the overlay occupies the cited box's fraction of the rendered video.
  const geometry = await page.evaluate(() => {
    const v = document.querySelector("video").getBoundingClientRect();
    const b = document.querySelector("[data-testid='citation-box']").getBoundingClientRect();
    return { left: (b.left - v.left) / v.width, top: (b.top - v.top) / v.height, width: b.width / v.width, height: b.height / v.height };
  });
  const frame = boxed.frame;
  const expected = { left: boxed.box.x / frame.width, top: boxed.box.y / frame.height, width: boxed.box.width / frame.width, height: boxed.box.height / frame.height };
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(geometry[key] - expected[key]) < 0.01, `overlay ${key} ${geometry[key]} must equal ${expected[key]}`);
  }
  // Pixels: the highlighted region of the sought frame really contains the cited text (dark ink), unlike empty area.
  const ink = await videoLocator.evaluate((element, region) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(element, 0, 0);
    const dark = (x, y, w, h) => {
      const data = context.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h))).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) count += 1;
      return count / (data.length / 4);
    };
    return { inside: dark(region.x, region.y, region.width, region.height), blank: dark(element.videoWidth - region.width - 4, element.videoHeight - 40, region.width, 30) };
  }, boxed.box);
  assert.ok(ink.inside > 0.03, `the highlighted region must contain the cited text, dark-pixel ratio ${ink.inside}`);
  assert.ok(ink.blank < 0.005, `an empty control region must not, ratio ${ink.blank}`);
  const announcement = await page.getByTestId("citation-announcement").textContent();
  assert.match(announcement, /Player moved to/u);
  assert.ok(announcement.includes(boxed.evidenceId));
  assert.equal(await page.locator(`.ga-evidence li[data-evidence-id='${boxed.evidenceId}']`).getAttribute("aria-current"), "true");

  const spoken = cited.find((item) => item.kind === "TRANSCRIPT_SEGMENT");
  if (spoken) {
    await result.locator(`button[data-evidence-id='${spoken.evidenceId}']`).first().click();
    const spokenTime = await seekedTime();
    assert.ok(Math.abs(spokenTime - expectedSeconds(spoken)) < 0.06,
      `spoken citation ${spoken.evidenceId} must seek to ${expectedSeconds(spoken)}s, player is at ${spokenTime}s`);
    assert.equal(await page.getByTestId("citation-box").count(), 0, "a spoken citation has no box");
    assert.equal(await page.locator(`.ga-evidence li[data-evidence-id='${spoken.evidenceId}']`).getAttribute("aria-current"), "true");
    assert.equal(await page.locator(`.ga-evidence li[data-evidence-id='${boxed.evidenceId}']`).getAttribute("aria-current"), null);
  }
  const snapshot = await result.getByRole("list", { name: "Grounded claims" }).ariaSnapshot();
  assert.match(snapshot, /button "[^"]*Seek the video to this evidence"/u, "citations are named buttons in the accessibility tree");

  // ---- typed refusals shown in the UI: rights missing, unreadable clock, unknown id ----
  async function askRefusal(artifactId, version, code, status) {
    expectedErrors.push({ pathname: "/dev/v1/grounded-answers", status });
    await page.getByLabel("Source video artifact ID").fill(artifactId);
    await page.getByLabel(/Exact source version/u).fill(version);
    await page.getByLabel(/Question about the video/u).fill("What is said?");
    await page.getByRole("button", { name: "Ask with citations" }).click();
    const alert = page.locator("#grounded-status[role='alert']");
    await alert.getByText(new RegExp(code, "u")).waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("#grounded-result").count(), 0, "a refused request shows no answer");
  }
  await askRefusal(unattestedId, unattestedVersion, "RIGHTS_DENIED", 403);
  await askRefusal(garbageId, garbageVersion, "SOURCE_CLOCK_UNDETERMINED", 422);
  const missing = `missing-${crypto.randomUUID()}`;
  expectedErrors.push({ pathname: `/dev/v1/grounded-answers/${missing}`, status: 404 });
  await page.getByLabel("Reopen answer by output ID").fill(missing);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.locator("#grounded-status[role='alert']").getByText(/GROUNDED_OUTPUT_NOT_FOUND/u).waitFor({ timeout: 30_000 });

  // ---- narrow viewport: no horizontal scroll once the answer is shown again ----
  await page.getByLabel("Reopen answer by output ID").fill(answerId);
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await result.waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 375, height: 900 });
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 375px, overflow ${overflow}px`);

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !expectedErrors.some((e) => e.pathname === pathname && text.includes(`status of ${e.status}`)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({ event: "grounded-answer-browser", answerId, boxed: boxed.evidenceId, boxedTime,
    expectedBoxedSeconds: expectedSeconds(boxed), spoken: spoken?.evidenceId ?? null, ink, playerDuration: metadata.duration })}\n`);
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

