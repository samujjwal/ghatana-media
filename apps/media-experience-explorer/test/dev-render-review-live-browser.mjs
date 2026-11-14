import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_TOKEN");
const expectedTenant = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_TENANT");
const expectedPrincipal = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_PRINCIPAL");
const expectedArtifactId = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_ID");
const expectedArtifactSha256 = requiredEnv("MEDIA_DEV_RENDER_REVIEW_BROWSER_ARTIFACT_SHA256");
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
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const diagnostics = [];
  page.on("requestfailed", (request) => diagnostics.push(`FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => { if (response.url().includes("/dev/v1/")) diagnostics.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/")) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() });
  });

  async function connect() {
    await page.goto(`${baseUrl}/dev-project-timeline.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Read host context" }).click();
    await page.getByText(expectedTenant, { exact: true }).waitFor({ timeout: 10_000 });
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
  const renderId = await renderArticle.getAttribute("data-render-id");
  assert.ok(renderId, "the render result must carry its registered render id");
  const renderText = await renderArticle.textContent();
  assert.ok(renderText.includes(renderedRevisionId), "the render must show the exact rendered revision");
  assert.ok(renderText.includes(`${expectedArtifactId}@sha256:${expectedArtifactSha256}`), "the render must show exact source lineage");
  const renderSha = (await renderArticle.locator("dt", { hasText: "SHA-256" }).locator("xpath=following-sibling::dd").textContent()).trim();
  assert.match(renderSha, /^[0-9a-f]{64}$/u);

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

  await page.locator("#review-reason").fill("Matches the intended storyboard.");
  const decideButton = page.getByRole("button", { name: "Record DEV_ONLY decision" });
  assert.equal(await decideButton.isDisabled(), true, "decision must stay disabled until the explicit confirmation");
  await page.locator("#review-confirm").check();
  assert.equal(await decideButton.isEnabled(), true);
  await decideButton.click();
  await page.locator("#review-status").filter({ hasText: /Recorded DEV_ONLY decision \(HTTP 201\).*establishesApproval=false/u }).waitFor();
  await page.getByLabel("Review records").getByText(/DEV_ONLY decision ACCEPT.*CURRENT/u).waitFor();
  assert.equal(await page.locator("#review-confirm").isChecked(), false, "confirmation must reset after a decision");
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
  assert.equal(await page.getByRole("button", { name: "Record DEV_ONLY decision" }).isDisabled(), true);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore,
    "post-restart readback must not mutate");

  // Full reload against the restarted host: the page starts clean (no render/review state leaks) and still works.
  await connect();
  assert.equal(await page.locator("#dev-project-outputs").count(), 0,
    "a reloaded page has no open project, so no render or review panel state may survive");
  assert.equal(await page.locator("[data-render-id]").count(), 0, "a reloaded page must not claim a render it never read");
  assert.equal(await page.locator("[data-review-case]").count(), 0);

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  process.stdout.write(`${JSON.stringify({ event: "readback", projectId, renderId, reviewCaseId, renderSha })}\n`);
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
