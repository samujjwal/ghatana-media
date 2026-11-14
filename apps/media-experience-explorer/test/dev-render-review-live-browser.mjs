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
const token = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_TOKEN");
const expectedTenant = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_TENANT");
const expectedPrincipal = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_PRINCIPAL");
const reviewerToken = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_REVIEWER_TOKEN");
const reviewerPrincipal = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_REVIEWER_PRINCIPAL");
const expectedArtifactId = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_ID");
const expectedArtifactSha256 = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_SHA256");
// Optional: a destination configured on the live host. When set, the reloaded page also exports the render to it.
const exportDestinationId = process.env.MEDIA_DEV_RENDER_REVIEW_BROWSER_DESTINATION_ID?.trim() || null;
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

function jsonFrom(locator) {
  return locator.textContent().then((value) => JSON.parse(value ?? "null"));
}

const renderFormat = process.env.MEDIA_DEV_RENDER_REVIEW_FORMAT === "mp4" ? "mp4" : "gif";
const vitePort = 4178;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_RENDER_REVIEW_BROWSER_TOKEN;
delete viteEnvironment.MEDIA_DEV_RENDER_REVIEW_BROWSER_REVIEWER_TOKEN;
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
      const response = await fetch(`${baseUrl}/dev-project-timeline.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual Explorer page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Console errors carry the resource URL so the one deliberate PROJECT_NOT_FOUND probe can be told apart.
  const expectedNotFoundPaths = new Set();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { pathname = ""; }
    consoleErrors.push({ text: message.text(), pathname });
  });
  const diagnostics = [];
  page.on("requestfailed", (request) => diagnostics.push(`FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => { if (response.url().includes("/dev/v1/")) diagnostics.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/")) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() });
  });

  let renderId = null;
  async function connect() {
    await page.goto(`${baseUrl}/dev-project-timeline.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Read host context" }).click();
    await page.getByText(expectedTenant, { exact: true }).waitFor({ timeout: 10_000 });
  }

  // Verified preview + Download of the registered render through the DEV_ONLY content route. The page verifies the
  // bytes' SHA-256 before it shows anything; here the preview element must actually load and the saved file must hash
  // to the registered render sha (independent of the page's own check).
  async function assertVerifiedPreviewAndDownload(renderScope, expectedSha, label) {
    const noun = renderFormat === "mp4" ? "MP4" : "GIF";
    const section = renderScope.getByRole("region", { name: `${noun} content` });
    await section.getByRole("button", { name: new RegExp(`^Preview ${noun}`, "u") }).click();
    await section.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
    const media = section.locator(renderFormat === "mp4" ? "video[data-verified-preview='mp4']" : "img[data-verified-preview='gif']");
    await media.waitFor({ timeout: 10_000 });
    assert.match(await media.getAttribute("src"), /^blob:/u, `${label}: the preview must be a blob URL, never a token-bearing host URL`);
    const verifiedText = await section.getByText(/Bytes verified against the registered version/u).first().textContent();
    assert.ok(verifiedText.includes(expectedSha), `${label}: the verified message must carry the registered sha256`);
    if (renderFormat === "mp4") {
      await media.evaluate((video) => new Promise((resolveLoad, rejectLoad) => {
        if (video.readyState >= 1) return resolveLoad();
        video.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
        video.addEventListener("error", () => rejectLoad(new Error(`video error code ${video.error?.code}: ${video.error?.message}`)), { once: true });
        setTimeout(() => rejectLoad(new Error("video metadata did not load")), 15_000);
      }));
      const video = await media.evaluate((element) => ({ readyState: element.readyState, duration: element.duration, width: element.videoWidth }));
      assert.ok(video.readyState >= 1, `${label}: video readyState ${video.readyState}`);
      assert.ok(Number.isFinite(video.duration) && video.duration > 0, `${label}: video duration ${video.duration}`);
    } else {
      await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await media.elementHandle(), { timeout: 10_000 });
      assert.ok((await media.evaluate((element) => element.naturalWidth)) > 0, `${label}: GIF naturalWidth`);
    }
    const downloading = page.waitForEvent("download");
    await section.getByRole("button", { name: new RegExp(`^Download ${noun}`, "u") }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), `${renderId}.${renderFormat}`);
    const savedPath = await download.path();
    const savedSha = createHash("sha256").update(await readFile(savedPath)).digest("hex");
    assert.equal(savedSha, expectedSha, `${label}: the downloaded file must hash to the registered render sha256`);
  }
  const renderStatus = page.locator("#render-status");
  const reviewStatus = page.locator("#review-status");
  const currentness = page.locator("[data-currentness]");

  await connect();
  await page.getByLabel("Project title").fill("Render and review live browser project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByText(/Created DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  const projectId = (await jsonFrom(page.locator("#project-json"))).project.projectId;

  const timelineId = `render-${crypto.randomUUID()}`;
  await page.getByLabel("Timeline ID").fill(timelineId);
  await page.getByRole("button", { name: "Create timeline", exact: true }).click();
  await page.getByText(new RegExp(`Created empty timeline ${timelineId}; exact revision .* reopened\\.`)).waitFor();

  // Before any clip exists the render control is blocked with an explicit reason.
  await page.getByRole("button", { name: "Render exact revision" }).isDisabled().then((disabled) =>
    assert.equal(disabled, true, "render must be disabled with no clip"));

  const sceneId = `scene-${crypto.randomUUID()}`;
  await page.getByLabel("New scene ID").fill(sceneId);
  await page.getByLabel("Scene order").fill("0");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByText(/Committed and reopened addScene in revision .*\./u).waitFor();
  const trackId = `track-${crypto.randomUUID()}`;
  await page.getByLabel("New track ID").fill(trackId);
  await page.locator(`input[name="track-parent-scene"][value="${sceneId}"]`).check();
  await page.locator('input[name="track-kind"][value="VIDEO"]').check();
  await page.getByLabel("Order within scene").fill("0");
  await page.getByRole("button", { name: "Add track", exact: true }).click();
  await page.getByText(/Committed and reopened addTrack in revision .*\./u).waitFor();

  await page.getByLabel("Source artifact ID to inspect").fill(expectedArtifactId);
  await page.getByRole("button", { name: "Read source artifact" }).click();
  const inspected = page.getByLabel("Inspected source artifact");
  await inspected.getByText(expectedArtifactId, { exact: true }).waitFor();
  await inspected.getByText(`sha256:${expectedArtifactSha256}`, { exact: true }).waitFor();
  const clipId = `clip-${crypto.randomUUID()}`;
  await page.locator("#clip-id").fill(clipId);
  await page.locator(`input[name="clip-track-id"][value="${trackId}"]`).check();
  // A PNG still: one source tick at 24/s, held for 24 story ticks at 24/s.
  await page.getByLabel("Source in ticks").fill("0");
  await page.getByLabel("Source out ticks").fill("1");
  await page.getByLabel("Source rate numerator").fill("24");
  await page.getByLabel("Source rate denominator").fill("1");
  await page.getByLabel("Story start ticks").fill("0");
  await page.getByLabel("Story duration ticks").fill("24");
  await page.getByLabel("Story rate numerator").fill("24");
  await page.getByLabel("Story rate denominator").fill("1");
  await page.getByRole("button", { name: "Add or update clip reference" }).click();
  await page.getByText(/Committed and reopened putClip in revision .*\./u).waitFor();
  const clipRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  const renderedRevisionId = clipRevision.revisionId;

  // Render the exact revision through the page.
  assert.match(await renderStatus.textContent(), /No render requested/u);
  await page.locator('input[name="render-format"]').and(page.locator(`[value="${renderFormat}"]`)).check();
  const renderButton = page.getByRole("button", { name: "Render exact revision" });
  await renderButton.click();
  try {
    await page.locator("#render-status").filter({ hasText: "Created (HTTP 201)" }).waitFor({ timeout: 90_000 });
  } catch (error) {
    throw new Error(`render did not complete: status=${await renderStatus.textContent()}; alert=${await page.getByRole("alert").allTextContents()}; `
      + `diagnostics=${JSON.stringify(diagnostics.slice(-6))}; console=${JSON.stringify(consoleErrors)}; viteOutput=${viteOutput.slice(-1500)}; cause=${error.message}`);
  }
  const renderArticle = page.locator("[data-render-id]");
  renderId = await renderArticle.getAttribute("data-render-id");
  assert.ok(renderId, "the render result must carry its registered render id");
  const renderText = await renderArticle.textContent();
  assert.ok(renderText.includes(renderedRevisionId), "the render must show the exact rendered revision");
  assert.ok(renderText.includes(`${expectedArtifactId}@sha256:${expectedArtifactSha256}`), "the render must show exact source lineage");
  const renderSha = (await renderArticle.locator("dt", { hasText: "SHA-256" }).locator("xpath=following-sibling::dd").textContent()).trim();
  assert.match(renderSha, /^[0-9a-f]{64}$/u);
  await assertVerifiedPreviewAndDownload(renderArticle, renderSha, "after render");

  await renderButton.click();
  await page.locator("#render-status").filter({ hasText: "Replayed (HTTP 200)" }).waitFor({ timeout: 90_000 });
  assert.equal(await renderArticle.getAttribute("data-render-id"), renderId, "replay must return the same render");
  const renderPosts = apiRequests.filter(({ method, path }) => method === "POST" && path === `/dev/v1/projects/${projectId}/renders`);
  assert.equal(renderPosts.length, 2);
  assert.equal(JSON.parse(renderPosts[0].body).requestId, JSON.parse(renderPosts[1].body).requestId,
    "the replay must reuse the exact request identity");

  await page.getByRole("button", { name: "Reopen render from the host" }).click();
  await page.locator("#render-status").filter({ hasText: `Reopened render ${renderId}` }).waitFor();

  // Review: open on the exact project revision, comment, confirm, record a decision.
  const disclaimer = page.getByRole("note", { name: "Review approval disclaimer" });
  await disclaimer.getByText("A DEV_ONLY ACCEPT is not human approval.").waitFor();
  await page.getByRole("button", { name: "Open review case" }).click();
  await page.locator("#review-status").filter({ hasText: /Opened DEV_ONLY review case .* \(CURRENT\)\. No approval exists\./u }).waitFor();
  const reviewCaseId = await page.locator("[data-review-case]").getAttribute("data-review-case");
  assert.ok(reviewCaseId);
  assert.equal(await currentness.getAttribute("data-currentness"), "CURRENT");

  await page.locator("#review-comment-text").fill("Looks right on the exact revision.");
  await page.locator("#review-comment-form").getByRole("button", { name: "Add comment" }).click();
  await page.locator("#review-status").filter({ hasText: /Recorded comment \(HTTP 201\)/u }).waitFor();
  await page.getByLabel("Review records").getByText(/comment \(OPEN\).*Looks right/u).waitFor();

  // Before any assignment nobody holds reviewer authority: the owner's decision form is disabled and says why.
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true, "no assignment means no decision");
  assert.equal(await page.locator("#review-scope").isDisabled(), true);

  // The owner assigns a second principal for APPROVAL only, through the page.
  await page.getByLabel("Reviewer principal ID").fill(reviewerPrincipal);
  await page.getByRole("checkbox", { name: "APPROVAL", exact: true }).check();
  await page.getByLabel(/Expires in days/u).fill("7");
  await page.getByRole("button", { name: "Assign reviewer" }).click();
  await page.locator("#review-status").filter({ hasText: /Assigned \(HTTP 201\).*not human approval/u }).waitFor();
  const assignmentList = page.getByLabel("Reviewer assignments", { exact: false }).locator("li");
  await assignmentList.filter({ hasText: reviewerPrincipal }).filter({ hasText: "APPROVAL" }).filter({ hasText: "ACTIVE" }).waitFor();
  const assignPost = apiRequests.find(({ method, path }) => method === "POST" && path === `/dev/v1/reviews/${reviewCaseId}/assignments`);
  assert.ok(assignPost, "the assignment must go through the assignments route");
  assert.deepEqual(JSON.parse(assignPost.body).scopes, ["APPROVAL"]);

  // The owner cannot decide: the UI explains it, and the host independently refuses with REVIEWER_NOT_ASSIGNED.
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true);
  await page.locator("[data-decision-gate='OWNER']").getByText(/owner cannot decide/u).waitFor();
  const ownerCaseRevision = Number((await page.locator("[data-review-case] dt", { hasText: "Case revision" })
    .locator("xpath=following-sibling::dd").textContent()).trim());
  const ownerAttempt = await page.request.post(`${baseUrl}/dev/v1/reviews/${reviewCaseId}/decisions`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { requestId: `owner-attempt-${crypto.randomUUID()}`, expectedCaseRevision: ownerCaseRevision, decision: "ACCEPT", scope: "APPROVAL",
      reason: "owner must not decide", confirmed: true },
  });
  assert.equal(ownerAttempt.status(), 403);
  assert.equal((await ownerAttempt.json()).error.code, "REVIEWER_NOT_ASSIGNED");

  // The assigned reviewer acts under their own DEV_ONLY identity in a separate browser context.
  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  const reviewerErrors = [];
  reviewerPage.on("pageerror", (error) => reviewerErrors.push(error.message));
  reviewerPage.on("console", (message) => { if (message.type() === "error") reviewerErrors.push(message.text()); });
  await reviewerPage.goto(`${baseUrl}/dev-project-timeline.html`);
  await reviewerPage.getByLabel("Short-lived DEV_ONLY bearer token").fill(reviewerToken);
  await reviewerPage.getByRole("button", { name: "Read host context" }).click();
  await reviewerPage.getByText(reviewerPrincipal, { exact: true }).waitFor({ timeout: 10_000 });
  const reviewerRegion = reviewerPage.locator("#reviewer-panel");
  await reviewerRegion.getByRole("heading", { name: "Review a case as an assigned reviewer" }).waitFor();
  assert.equal(await reviewerPage.locator("#dev-project-outputs").count(), 0, "the reviewer has no project workspace");
  await reviewerRegion.getByLabel("Known review case ID").fill(reviewCaseId);
  await reviewerRegion.getByRole("button", { name: "Reopen known review case" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Reopened review case .*: CURRENT/u }).waitFor();
  assert.equal(await reviewerPage.locator("[data-identity]").getAttribute("data-identity"), reviewerPrincipal);
  assert.equal(await reviewerPage.getByRole("button", { name: "Assign reviewer" }).count(), 0, "a reviewer cannot assign");
  assert.equal(await reviewerPage.locator("[data-decision-gate]").count(), 0, "an assigned reviewer has no decision gate");
  const scopeOptions = await reviewerPage.locator("#review-scope option").evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(scopeOptions, ["", "APPROVAL"], "only the assigned scope may be chosen");

  await reviewerPage.locator("#review-comment-text").fill("Reviewer comment on the exact revision.");
  await reviewerPage.locator("#review-comment-form").getByRole("button", { name: "Add comment" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Recorded comment \(HTTP 201\)/u }).waitFor();

  await reviewerPage.locator("#review-scope").selectOption("APPROVAL");
  await reviewerPage.locator("#review-reason").fill("Matches the intended storyboard.");
  const reviewerDecide = reviewerPage.getByRole("button", { name: "Record DEV_ONLY decision" });
  assert.equal(await reviewerDecide.isDisabled(), true, "decision must stay disabled until the explicit confirmation");
  await reviewerPage.locator("#review-confirm").check();
  assert.equal(await reviewerDecide.isEnabled(), true);
  await reviewerDecide.click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Recorded DEV_ONLY decision \(HTTP 201\).*establishesApproval=false/u }).waitFor();
  const reviewerRecords = reviewerPage.getByLabel("Review records");
  await reviewerRecords.getByText(/DEV_ONLY decision ACCEPT.*CURRENT/u).waitFor();
  await reviewerRecords.getByText("DEV_ASSIGNED_REVIEWER_ACCEPT", { exact: true }).waitFor();
  assert.match(await reviewerRecords.textContent(), new RegExp(`scope APPROVAL · by ${reviewerPrincipal}`, "u"));
  assert.ok((await reviewerPage.locator("[data-review-case]").textContent()).includes("DEV_ASSIGNED_REVIEWER_ACCEPT_CURRENT"));
  assert.ok((await reviewerPage.locator("[data-review-case]").textContent()).includes("humanReviewApproval=false"));
  await reviewerPage.getByRole("note", { name: "Review approval disclaimer" }).getByText("A DEV_ONLY ACCEPT is not human approval.").waitFor();
  assert.equal(await reviewerPage.locator("#review-confirm").isChecked(), false, "confirmation must reset after a decision");

  // The owner re-reads and sees the reviewer's records as DEV-only assigned-reviewer evidence.
  await page.getByRole("button", { name: "Re-read review case" }).click();
  await page.getByLabel("Review records").getByText("DEV_ASSIGNED_REVIEWER_ACCEPT", { exact: true }).waitFor();
  await disclaimer.getByText("A DEV_ONLY ACCEPT is not human approval.").waitFor();
  assert.ok((await page.locator("[data-review-case]").textContent()).includes("humanReviewApproval=false"));

  // Edit the timeline through the UI: the project head moves and the case goes STALE.
  const secondScene = `scene-${crypto.randomUUID()}`;
  await page.getByLabel("New scene ID").fill(secondScene);
  await page.getByLabel("Scene order").fill("1");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByText(/Committed and reopened addScene in revision .*\./u).waitFor();
  const editedRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.notEqual(editedRevision.revisionId, renderedRevisionId);
  await page.locator('[data-currentness="STALE"]').waitFor({ timeout: 15_000 });
  await page.getByRole("note").filter({ hasText: "Decisions are disabled because this case is STALE." }).waitFor();
  assert.equal(await page.locator("#review-confirm").isDisabled(), true);
  assert.equal(await page.locator("#review-reason").isDisabled(), true);
  assert.equal(await page.locator("#review-decision").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true);
  await disclaimer.getByText("A DEV_ONLY ACCEPT is not human approval.").waitFor();
  // The reviewer is blocked too: STALE disables the decision, and the host refuses a direct attempt.
  await reviewerPage.getByRole("button", { name: "Re-read review case" }).click();
  await reviewerPage.locator('[data-currentness="STALE"]').waitFor({ timeout: 15_000 });
  await reviewerPage.getByRole("note").filter({ hasText: "Decisions are disabled because this case is STALE." }).waitFor();
  assert.equal(await reviewerPage.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true);
  const reviewerRevision = Number((await reviewerPage.locator("[data-review-case] dt", { hasText: "Case revision" })
    .locator("xpath=following-sibling::dd").textContent()).trim());
  const staleAttempt = await reviewerPage.request.post(`${baseUrl}/dev/v1/reviews/${reviewCaseId}/decisions`, {
    headers: { Authorization: `Bearer ${reviewerToken}` },
    data: { requestId: `stale-attempt-${crypto.randomUUID()}`, expectedCaseRevision: reviewerRevision, decision: "ACCEPT", scope: "APPROVAL",
      reason: "stale must be refused", confirmed: true },
  });
  assert.equal(staleAttempt.status(), 409);
  assert.equal((await staleAttempt.json()).error.code, "REVIEW_SUBJECT_STALE");
  // The previously shown render is flagged as no longer the head.
  await page.getByText("Not the current head:").waitFor();
  const staleCaseRevision = await page.locator("[data-review-case] dt", { hasText: "Case revision" })
    .locator("xpath=following-sibling::dd").textContent();

  process.stdout.write(`${JSON.stringify({
    event: "created",
    projectId,
    timelineId,
    renderId,
    renderSha,
    renderedRevisionId,
    editedRevisionId: editedRevision.revisionId,
    reviewCaseId,
    staleCaseRevision: staleCaseRevision.trim(),
    clipId,
    renderFormat,
  })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let restarted = false;
  for await (const line of input) {
    if (line === "host-restarted") { restarted = true; break; }
  }
  input.close();
  assert.equal(restarted, true, "the integration host must restart before readback");

  // Same page after the host restart: the render and the review case read back from the durable host.
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await page.getByRole("button", { name: "Reopen render from the host" }).click();
  await page.locator("#render-status").filter({ hasText: `Reopened render ${renderId}` }).waitFor();
  assert.ok((await renderArticle.textContent()).includes(renderSha));
  await page.getByRole("button", { name: "Re-read review case" }).click();
  await page.locator("#review-status").filter({ hasText: /Re-read review case .*: STALE, case revision/u }).waitFor();
  assert.equal(await currentness.getAttribute("data-currentness"), "STALE");
  const records = await page.getByLabel("Review records").textContent();
  assert.match(records, /comment \(OPEN\)/u);
  assert.match(records, /DEV_ONLY decision ACCEPT/u);
  assert.match(records, /DEV_ASSIGNED_REVIEWER_ACCEPT/u);
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true);
  await reviewerPage.getByRole("button", { name: "Re-read review case" }).click();
  await reviewerPage.locator("#review-status").filter({ hasText: /Re-read review case .*: STALE, case revision/u }).waitFor();
  assert.match(await reviewerPage.getByLabel("Review records").textContent(), /DEV_ASSIGNED_REVIEWER_ACCEPT.*scope APPROVAL/u);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore,
    "post-restart readback must not mutate");

  // Full reload against the restarted host: the page starts clean (no render/review state leaks) and still works.
  await connect();
  assert.equal(await page.locator("#dev-project-outputs").count(), 0,
    "a reloaded page has no open project, so no render or review panel state may survive");
  assert.equal(await page.locator("[data-render-id]").count(), 0, "a reloaded page must not claim a render it never read");
  assert.equal(await page.locator("[data-review-case]").count(), 0);

  // Resume after the reload: open the existing project by id, then reopen the render and review case by id.
  const missing = `missing-${crypto.randomUUID()}`;
  expectedNotFoundPaths.add(`/dev/v1/projects/${missing}`);
  await page.getByLabel("Project ID", { exact: true }).fill(missing);
  await page.getByRole("button", { name: "Open existing project", exact: true }).click();
  await page.getByText(/PROJECT_NOT_FOUND: no project with that id exists in this tenant and owner scope/u).waitFor();
  assert.equal(await page.locator("#dev-project-outputs").count(), 0, "a failed open must not mount any workspace");
  await page.getByLabel("Project ID", { exact: true }).fill(projectId);
  await page.getByRole("button", { name: "Open existing project", exact: true }).click();
  await page.getByText(new RegExp(`Opened existing DEV_ONLY project ${projectId}; current head revision ${editedRevision.revisionId} read from the host\\.`, "u")).waitFor();
  await page.locator("#dev-project-outputs").waitFor();
  assert.equal(await page.locator("[data-render-id]").count(), 0, "opening a project must not claim a render it has not read");

  await page.getByLabel("Known render ID").fill(renderId);
  await page.getByRole("button", { name: "Reopen known render" }).click();
  await page.locator("#render-status").filter({ hasText: `Reopened render ${renderId}` }).waitFor();
  assert.ok((await renderArticle.textContent()).includes(renderSha), "the reopened render must show the same sha256");
  assert.ok((await renderArticle.textContent()).includes(renderedRevisionId));
  await page.getByText("Not the current head:").waitFor();
  // The durable bytes are still served, verified, by the restarted host for the reopened render.
  await assertVerifiedPreviewAndDownload(renderArticle, renderSha, "after restart and reopen");

  await page.getByLabel("Known review case ID").fill(reviewCaseId);
  await page.getByRole("button", { name: "Reopen known review case" }).click();
  await page.locator("#review-status").filter({ hasText: new RegExp(`Reopened review case ${reviewCaseId.replace(/\./gu, "\\.")}: STALE`, "u") }).waitFor();
  assert.equal(await currentness.getAttribute("data-currentness"), "STALE");
  const reopenedRecords = await page.getByLabel("Review records").textContent();
  assert.match(reopenedRecords, /comment \(OPEN\)/u);
  assert.match(reopenedRecords, /DEV_ONLY decision ACCEPT/u);
  assert.match(reopenedRecords, /DEV_ASSIGNED_REVIEWER_ACCEPT/u);
  assert.equal(await page.locator("[data-review-case] li[data-assignment-status='ACTIVE']").count(), 1, "the assignment reads back durably");
  assert.deepEqual(reviewerErrors.filter((text) => !/status of 409/u.test(text)), [], `reviewer page errors: ${JSON.stringify(reviewerErrors)}`);

  let exportReceipt = null;
  if (exportDestinationId) {
    await page.getByLabel("Destination ID").fill(exportDestinationId);
    await page.getByRole("button", { name: "Export render artifact" }).click();
    const exportResult = page.getByRole("article", { name: "Export result" });
    await exportResult.waitFor({ timeout: 30_000 });
    // 202 is never delivery: poll with Check again until a destination receipt exists.
    for (let attempt = 0; attempt < 20 && (await exportResult.getAttribute("data-destination-confirmed")) !== "true"; attempt += 1) {
      await page.getByRole("button", { name: "Check again" }).click();
      await delay(500);
    }
    assert.equal(await exportResult.getAttribute("data-destination-confirmed"), "true", "the export must end destination-confirmed");
    const exportText = await exportResult.textContent();
    assert.ok(exportText.includes(renderSha), "the destination digest must equal the render artifact sha256");
    exportReceipt = (await exportResult.locator("dt", { hasText: "Destination receipt" }).locator("xpath=following-sibling::dd").textContent()).trim();
    assert.ok(exportReceipt.length > 0);
    const exportPosts = apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/exports");
    assert.ok(exportPosts.length >= 1);
    const exportBody = JSON.parse(exportPosts[0].body);
    assert.equal(exportBody.artifactId, renderId);
    assert.equal(exportBody.artifactVersionId, `sha256:${renderSha}`, "the export must name the exact render artifact version");
    assert.equal(exportBody.destinationId, exportDestinationId);
    assert.ok(exportPosts.every(({ body }) => JSON.parse(body).requestId === exportBody.requestId), "all export attempts must reuse one request identity");
    // Exporting again replays the same operation: HTTP 200 with the same receipt, no second request identity.
    await page.getByRole("button", { name: "Export render artifact" }).click();
    await page.locator("#export-status").filter({ hasText: "Replayed or read back (HTTP 200)" }).waitFor();
    assert.ok((await exportResult.textContent()).includes(exportReceipt));
  }

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  // Only the deliberate missing-project probe may log a 404; any other console error fails the journey.
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !(expectedNotFoundPaths.has(pathname) && /status of 404/u.test(text)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  process.stdout.write(`${JSON.stringify({ event: "readback", exportReceipt, exportDestinationId, projectId, renderId, reviewCaseId, renderSha })}\n`);
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
