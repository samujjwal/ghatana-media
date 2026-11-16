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
const uploaderToken = requiredEnv("MEDIA_DEV_REVIEW_UPLOADER_TOKEN");
const reviewerToken = requiredEnv("MEDIA_DEV_REVIEW_REVIEWER_TOKEN");
const reviewerPrincipal = requiredEnv("MEDIA_DEV_REVIEW_REVIEWER_PRINCIPAL");
const lineageId = requiredEnv("MEDIA_DEV_REVIEW_LINEAGE_ID");
const expectedV1Sha = requiredEnv("MEDIA_DEV_REVIEW_V1_SHA256");
const expectedV2Sha = requiredEnv("MEDIA_DEV_REVIEW_V2_SHA256");
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
delete viteEnvironment.MEDIA_DEV_REVIEW_UPLOADER_TOKEN;
delete viteEnvironment.MEDIA_DEV_REVIEW_REVIEWER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

import { createInterface } from "node:readline";

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stdinLines = createInterface({ input: process.stdin });
const queuedLines = [];
const lineWaiters = [];
stdinLines.on("line", (line) => { const waiter = lineWaiters.shift(); if (waiter) waiter(line); else queuedLines.push(line); });
const nextLine = (prefix, timeoutMs = 600_000) => new Promise((resolveLine, rejectLine) => {
  const accept = (line) => (line.startsWith(prefix) ? resolveLine(line) : rejectLine(new Error(`expected "${prefix}" from the host test, got "${line}"`)));
  if (queuedLines.length > 0) return accept(queuedLines.shift());
  const timer = setTimeout(() => rejectLine(new Error(`timed out waiting for "${prefix}"`)), timeoutMs);
  lineWaiters.push((line) => { clearTimeout(timer); accept(line); });
});
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-review.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual review page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  // Two separate browser contexts: distinct cookies/storage, distinct test tokens (uploader and reviewer).
  const uploaderContext = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const reviewerContext = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const uploaderPage = await uploaderContext.newPage();
  const reviewerPage = await reviewerContext.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  const watch = (target, who) => {
    target.on("pageerror", (error) => pageErrors.push(`${who}: ${error.message}`));
    // The deliberate typed 403/409/422 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
    target.on("console", (message) => {
      if (message.type() === "error" && !/status of (403|409|422)/u.test(message.text())) consoleErrors.push(`${who}: ${message.text()}`);
    });
    target.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/dev/v1/")) apiRequests.push({ who, method: request.method(), path, body: request.postData(), headers: request.headers() });
    });
  };
  watch(uploaderPage, "uploader");
  watch(reviewerPage, "reviewer");

  async function connect(target, bearer) {
    for (let attempt = 1; ; attempt += 1) {
      await target.goto(`${baseUrl}/dev-review.html`, { waitUntil: "networkidle" });
      const pending = target.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/reviews" && response.request().method() === "GET", { timeout: 45_000 });
      pending.catch(() => {});
      await target.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
      await target.getByRole("button", { name: "Connect", exact: true }).click();
      try { await pending; break; } catch (error) { if (attempt >= 3) throw error; }
    }
    await target.getByRole("heading", { name: "Versioned review", level: 2 }).waitFor({ timeout: 30_000 });
  }
  const versionRow = (target, number) => target.locator(`[data-version-table] tr[data-version-number='${number}']`);
  const expectRow = async (target, number, state, head) => {
    const row = versionRow(target, number);
    await row.waitFor({ timeout: 15_000 });
    await target.waitForFunction(({ n, s }) => document.querySelector(`[data-version-table] tr[data-version-number='${n}']`)?.getAttribute("data-state") === s,
      { n: number, s: state }, { timeout: 15_000 });
    assert.equal(await row.getAttribute("data-head"), String(head), `v${number} head`);
    return row;
  };
  const post = (target, suffix) => target.waitForResponse((response) => new URL(response.url()).pathname.endsWith(suffix)
    && response.request().method() === "POST", { timeout: 60_000 });
  const showLineage = async (target) => {
    const loaded = target.waitForResponse((response) => new URL(response.url()).pathname === `/dev/v1/review-lineages/${lineageId}`, { timeout: 30_000 });
    await target.locator("#review-lineage-id").fill(lineageId);
    await target.locator("#review-lineage-id").press("Enter");
    return (await loaded).json();
  };
  const alertOf = async (target, code) => {
    const alert = target.locator(`[role='alert'][data-error-code='${code}']`);
    await alert.waitFor({ timeout: 15_000 });
    return alert;
  };
  const verifiedVideo = async (target, expectedSha) => {
    await target.getByRole("button", { name: /^Load the exact version/u }).click();
    await target.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 60_000 });
    assert.ok((await target.locator("[data-playback-status]").textContent()).includes(`sha256:${expectedSha}`));
    const video = target.locator("video[data-verified-review-video]");
    await video.waitFor({ timeout: 10_000 });
    return video.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
      const done = () => resolveLoad({ width: element.videoWidth, height: element.videoHeight, duration: element.duration });
      if (element.readyState >= 2) return done();
      element.addEventListener("loadeddata", done, { once: true });
      element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code} ${element.error?.message}`)), { once: true });
      setTimeout(() => rejectLoad(new Error("video data did not load")), 20_000);
    }));
  };

  // 1. Uploader: connect, list the lineage, start the review of v1 and assign the reviewer.
  await connect(uploaderPage, uploaderToken);
  assert.match(await uploaderPage.locator("[data-principal]").textContent(), /DEV_ONLY test identity/u);
  const ownerView = await showLineage(uploaderPage);
  assert.equal(ownerView.versions.length, 1);
  await expectRow(uploaderPage, 1, "NOT_REVIEWED", true);
  const opened = post(uploaderPage, "/dev/v1/reviews");
  await uploaderPage.getByRole("button", { name: "Start review of version 1" }).click();
  assert.equal((await opened).status(), 201);
  const ownerCase = uploaderPage.locator("[data-case-panel]");
  await ownerCase.waitFor({ timeout: 15_000 });
  assert.equal(await ownerCase.getAttribute("data-role"), "OWNER");
  const caseId1 = await ownerCase.getAttribute("data-case-id");
  await uploaderPage.waitForFunction(() => document.activeElement?.id === "review-case-title", null, { timeout: 5_000 });
  await uploaderPage.locator("#review-reviewer").fill(reviewerPrincipal);
  const assigned = post(uploaderPage, `/dev/v1/reviews/${caseId1}/assignments`);
  await uploaderPage.getByRole("button", { name: /^Assign reviewer/u }).click();
  assert.equal((await assigned).status(), 201);
  // The uploader may not decide their own revision: a typed 403 alert, nothing recorded.
  await uploaderPage.locator("#review-reason").fill("TEST: the uploader tries to accept their own revision");
  await uploaderPage.locator("#review-confirm").check();
  const selfDecision = post(uploaderPage, `/dev/v1/reviews/${caseId1}/decisions`);
  await uploaderPage.getByRole("button", { name: "Record decision", exact: true }).click();
  assert.equal((await selfDecision).status(), 403);
  const selfAlert = await alertOf(uploaderPage, "REVIEWER_NOT_ASSIGNED");
  assert.equal(await selfAlert.getAttribute("data-http-status"), "403");
  assert.equal(await uploaderPage.locator("[data-decisions] tbody tr[data-decision]").count(), 0);

  // 2. Reviewer, in a different browser context with a different token: assigned list, verified player, time-coded comments.
  await connect(reviewerPage, reviewerToken);
  const assignedRow = reviewerPage.locator(`[data-assigned-table] tr[data-case-id='${caseId1}']`);
  await assignedRow.waitFor({ timeout: 15_000 });
  await assignedRow.getByRole("button", { name: "Open this review" }).click();
  await reviewerPage.locator("[data-case-panel]").waitFor({ timeout: 15_000 });
  assert.equal(await reviewerPage.locator("[data-case-panel]").getAttribute("data-role"), "REVIEWER");
  assert.equal(await reviewerPage.getByRole("button", { name: /^Assign reviewer/u }).count(), 0, "a reviewer has no assignment controls");
  await expectRow(reviewerPage, 1, "IN_REVIEW", true);
  const media1 = await verifiedVideo(reviewerPage, expectedV1Sha);
  assert.ok(media1.width > 0 && media1.height > 0 && media1.duration > 1, JSON.stringify(media1));
  const video = reviewerPage.locator("video[data-verified-review-video]");
  const playback = await video.evaluate(async (element) => {
    element.muted = true;
    await element.play();
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    element.pause();
    return element.currentTime;
  });
  assert.ok(playback > 0.3, `the verified video played in the browser (advanced ${playback}s)`);
  await video.evaluate((element) => new Promise((resolveSeek) => { element.addEventListener("seeked", () => resolveSeek(), { once: true }); element.currentTime = 1.0; }));
  await reviewerPage.getByRole("button", { name: "Use the current video time" }).click();
  assert.ok(Math.abs(Number(await reviewerPage.locator("#review-comment-start").inputValue()) - 1.0) < 0.15);
  await reviewerPage.locator("#review-comment-text").fill("Logo flicker at one second");
  const firstComment = post(reviewerPage, `/dev/v1/reviews/${caseId1}/comments`);
  await reviewerPage.getByRole("button", { name: "Add comment", exact: true }).click();
  const firstResponse = await firstComment;
  assert.equal(firstResponse.status(), 201);
  const sentComment = JSON.parse(firstResponse.request().postData());
  assert.ok(Math.abs(sentComment.annotation.timeRange.start.ticks - 1000) <= 150, "time-coded from the player position");
  assert.equal(sentComment.annotation.timeRange.start.rateNumerator, 1000);
  await reviewerPage.waitForFunction(() => document.querySelectorAll("[data-comments] tbody tr[data-start-ms]").length === 1 && !document.querySelector("form[aria-label='Add a time-coded comment'] button[type=submit]").disabled, null, { timeout: 15_000 });
  await reviewerPage.locator("#review-comment-text").fill("Colour shifts later on");
  await reviewerPage.locator("#review-comment-start").fill("2");
  await reviewerPage.locator("#review-comment-end").fill("2.5");
  const secondComment = post(reviewerPage, `/dev/v1/reviews/${caseId1}/comments`);
  await reviewerPage.locator("#review-comment-end").press("Enter");
  assert.equal((await secondComment).status(), 201);
  const commentRows = reviewerPage.locator("[data-comments] tbody tr[data-start-ms]");
  await reviewerPage.waitForFunction(() => document.querySelectorAll("[data-comments] tbody tr[data-start-ms]").length === 2, null, { timeout: 15_000 });
  assert.equal(await commentRows.count(), 2);
  assert.ok((await commentRows.nth(1).textContent()).includes("2.0 s – 2.5 s"));
  await video.evaluate((element) => { element.currentTime = 0; });
  await commentRows.nth(1).getByRole("button", { name: /^Seek to/u }).click();
  assert.ok(Math.abs(await video.evaluate((element) => element.currentTime) - 2.0) < 0.2, "a comment seeks the player to its time");

  // 3. The reviewer accepts version 1 (APPROVAL scope). Unconfirmed is a typed 422; nothing is recorded.
  await reviewerPage.locator("#review-reason").fill("TEST reviewer statement for this exact version; not a human approval");
  await reviewerPage.locator("#review-decision").selectOption("ACCEPT");
  await reviewerPage.locator("#review-scope").selectOption("APPROVAL");
  const unconfirmed = post(reviewerPage, `/dev/v1/reviews/${caseId1}/decisions`);
  await reviewerPage.getByRole("button", { name: "Record decision", exact: true }).click();
  assert.equal((await unconfirmed).status(), 422);
  await alertOf(reviewerPage, "REVIEW_CONFIRMATION_REQUIRED");
  await reviewerPage.locator("#review-confirm").check();
  const accepted = post(reviewerPage, `/dev/v1/reviews/${caseId1}/decisions`);
  await reviewerPage.getByRole("button", { name: "Record decision", exact: true }).click();
  const acceptedResponse = await accepted;
  assert.equal(acceptedResponse.status(), 201, await acceptedResponse.text());
  assert.equal((await acceptedResponse.json()).establishesApproval, false);
  const acceptedRow = await expectRow(reviewerPage, 1, "ACCEPT_CURRENT", true);
  assert.equal(await acceptedRow.getAttribute("data-accepted-for-head"), "true");
  assert.ok((await reviewerPage.locator("[data-latest-status]").textContent()).includes("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT"));
  assert.equal(await reviewerPage.locator("[data-decisions] tbody tr[data-decision='ACCEPT'][data-currentness='CURRENT']").count(), 1);
  emit({ event: "approved", caseId1, mediaWidth: media1.width, playbackAdvancedSeconds: playback });

  // 4. The host registers revised version 2 through the intake lane.
  await nextLine("REVISED");

  // 5. Uploader: the earlier acceptance is STALE and the new head is not reviewed.
  await showLineage(uploaderPage);
  const v1Owner = await expectRow(uploaderPage, 1, "ACCEPT_STALE", false);
  assert.ok((await v1Owner.textContent()).includes("STALE"));
  assert.equal(await v1Owner.getAttribute("data-accepted-for-head"), "false");
  const v2Owner = await expectRow(uploaderPage, 2, "NOT_REVIEWED", true);
  assert.ok((await v2Owner.textContent()).includes("needs its own review"));
  assert.equal(await v2Owner.getAttribute("data-accepted-for-head"), "false");

  // 6. Reviewer: the old case reads STALE, the version switcher shows v1 stale and v2 not assigned, a decision is a typed 409.
  await reviewerPage.locator(`[data-assigned-table] tr[data-case-id='${caseId1}']`).getByRole("button", { name: "Open this review" }).click();
  await reviewerPage.waitForFunction(() => document.querySelector("[data-currentness-text]")?.textContent?.includes("STALE"), null, { timeout: 15_000 });
  assert.ok((await reviewerPage.locator("[data-currentness-text]").textContent()).includes("a newer version exists"));
  await expectRow(reviewerPage, 1, "ACCEPT_STALE", false);
  await expectRow(reviewerPage, 2, "NOT_ASSIGNED", true);
  await reviewerPage.locator("#review-reason").fill("TEST: a late acceptance of the superseded version");
  await reviewerPage.locator("#review-confirm").check();
  const late = post(reviewerPage, `/dev/v1/reviews/${caseId1}/decisions`);
  await reviewerPage.getByRole("button", { name: "Record decision", exact: true }).click();
  assert.equal((await late).status(), 409);
  await alertOf(reviewerPage, "REVIEW_SUBJECT_STALE");
  assert.equal(await reviewerPage.locator("[data-decisions] tbody tr[data-decision]").count(), 1, "no decision was added to the old version");

  // 7. Uploader starts the review of v2 and assigns the reviewer again; the reviewer accepts the new head.
  const openedTwo = post(uploaderPage, "/dev/v1/reviews");
  await uploaderPage.getByRole("button", { name: "Start review of version 2" }).click();
  assert.equal((await openedTwo).status(), 201);
  const caseId2 = await uploaderPage.locator("[data-case-panel]").getAttribute("data-case-id");
  assert.notEqual(caseId2, caseId1);
  await uploaderPage.locator("#review-reviewer").fill(reviewerPrincipal);
  const assignedTwo = post(uploaderPage, `/dev/v1/reviews/${caseId2}/assignments`);
  await uploaderPage.getByRole("button", { name: /^Assign reviewer/u }).click();
  assert.equal((await assignedTwo).status(), 201);
  await connect(reviewerPage, reviewerToken);
  const second = reviewerPage.locator(`[data-assigned-table] tr[data-case-id='${caseId2}']`);
  await second.waitFor({ timeout: 15_000 });
  await second.getByRole("button", { name: "Open this review" }).click();
  await reviewerPage.locator(`[data-case-panel][data-case-id='${caseId2}']`).waitFor({ timeout: 15_000 });
  await expectRow(reviewerPage, 1, "ACCEPT_STALE", false);
  await expectRow(reviewerPage, 2, "IN_REVIEW", true);
  const media2 = await verifiedVideo(reviewerPage, expectedV2Sha);
  assert.ok(media2.width > 0 && media2.duration > 1);
  await reviewerPage.locator("#review-reason").fill("TEST reviewer statement for the revised version; not a human approval");
  await reviewerPage.locator("#review-confirm").check();
  const acceptedTwo = post(reviewerPage, `/dev/v1/reviews/${caseId2}/decisions`);
  await reviewerPage.getByRole("button", { name: "Record decision", exact: true }).click();
  assert.equal((await acceptedTwo).status(), 201);
  await expectRow(reviewerPage, 1, "ACCEPT_STALE", false);
  const v2Reviewer = await expectRow(reviewerPage, 2, "ACCEPT_CURRENT", true);
  assert.equal(await v2Reviewer.getAttribute("data-accepted-for-head"), "true");
  await showLineage(uploaderPage);
  await expectRow(uploaderPage, 1, "ACCEPT_STALE", false);
  await expectRow(uploaderPage, 2, "ACCEPT_CURRENT", true);

  // 8. Accessibility, token handling and request hygiene.
  const audit = await reviewerPage.evaluate(() => {
    const controls = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")];
    const unlabelled = controls.filter((el) => !(el.labels && el.labels.length) && !el.getAttribute("aria-label")).map((el) => el.id || el.name);
    const tables = [...document.querySelectorAll("table")].map((table) => ({ caption: !!table.querySelector("caption"), scoped: [...table.querySelectorAll("th")].every((th) => th.getAttribute("scope")) }));
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    const unnamedButtons = [...document.querySelectorAll("button")].filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label")).length;
    const unnamedRegions = [...document.querySelectorAll("[role=region]")].filter((el) => !el.getAttribute("aria-label")).length;
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, unnamedRegions, lang: document.documentElement.lang,
      liveRegions: document.querySelectorAll("[aria-live='polite'], [role=status]").length };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 3 && audit.tables.every((table) => table.caption && table.scoped), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.unnamedRegions, 0);
  assert.equal(audit.lang, "en");
  assert.ok(audit.liveRegions >= 2, "status is announced");
  // keyboard: the decision form is reachable and operable without a pointer
  await reviewerPage.locator("#review-reason").focus();
  const focusRing = await reviewerPage.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await reviewerPage.setViewportSize({ width: 375, height: 812 });
  const overflowX = await reviewerPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await reviewerPage.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=checkbox]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; }).map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const expectedBearer = { uploader: `Bearer ${uploaderToken}`, reviewer: `Bearer ${reviewerToken}` };
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === expectedBearer[entry.who]), "each context sends only its own bearer, as a header");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(uploaderToken) && !entry.path.includes(reviewerToken)), "token never appears in a URL");
  for (const [target, secret] of [[uploaderPage, uploaderToken], [reviewerPage, reviewerToken]]) {
    const stored = await target.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
    assert.ok(!stored.includes(secret), "token must never be persisted");
  }
  emit({ event: "re-reviewed", caseId1, caseId2, v2Width: media2.width,
    posts: apiRequests.filter((entry) => entry.method === "POST").map((entry) => `${entry.who}:${entry.path.replace(/^\/dev\/v1\//u, "")}`) });
} finally {
  if (browser) await browser.close();
  stdinLines.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
