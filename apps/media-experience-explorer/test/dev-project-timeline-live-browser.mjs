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
const token = requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TOKEN");
const expectedTenant = requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TENANT");
const expectedPrincipal = requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_PRINCIPAL");
const expectedArtifactId = requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_ID");
const expectedArtifactSha256 = requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_BROWSER_ARTIFACT_SHA256");
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

const vitePort = 4178;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_PROJECT_TIMELINE_BROWSER_TOKEN;
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
  const networkFailures = [];
  const apiRequests = [];
  const apiResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => networkFailures.push(`${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/") || request.url().includes("/api/v1/artifacts/")) {
      apiRequests.push({ method: request.method(), url: request.url(), body: request.postData() });
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/dev/v1/") || response.url().includes("/api/v1/artifacts/")) {
      apiResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`${baseUrl}/dev-project-timeline.html`);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Read host context" }).click();
  try {
    await page.getByText(expectedTenant, { exact: true }).waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`DEV_ONLY context was not rendered: status=${await page.locator("#status").textContent()}; `
      + `responses=${JSON.stringify(apiResponses)}; requests=${JSON.stringify(apiRequests)}; cause=${error.message}`);
  }
  await page.getByText(expectedPrincipal, { exact: true }).waitFor();
  assert.equal(await page.locator("#dev-token").inputValue(), "", "the page must clear the token input after connecting");
  assert.ok(apiRequests.some(({ method, url }) => method === "GET" && url.endsWith("/dev/v1/context")),
    "the browser must read host context through the same-origin Vite proxy");

  const title = "  Live host browser project 🎞  ";
  await page.getByLabel("Project title").fill(title);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByText(/Created DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  const created = await jsonFrom(page.locator("#project-json"));
  const initialRevisionId = created.initialRevision.revisionId;
  const projectId = created.project.projectId;
  assert.equal(created.scope, "DEV_ONLY");
  assert.equal(created.project.title, title, "the submitted Unicode title and surrounding spaces must be preserved");
  assert.deepEqual(created.initialRevision.timelines, [], "new projects must have an empty initial revision");

  await page.getByRole("button", { name: "Replay same create request" }).click();
  await page.getByText(/Replayed DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  const projectPosts = apiRequests.filter(({ method, url }) => method === "POST" && url.endsWith("/dev/v1/projects"));
  assert.equal(projectPosts.length, 2, "the page must send create and one exact replay");
  assert.deepEqual(JSON.parse(projectPosts[1].body), JSON.parse(projectPosts[0].body),
    "the replay must preserve the exact requestId and payload");
  const replayed = await jsonFrom(page.locator("#project-json"));
  assert.equal(replayed.createdNow, false);
  assert.equal(replayed.project.projectId, projectId);
  assert.equal(replayed.initialRevision.revisionId, initialRevisionId);

  const timelineId = `browser-${crypto.randomUUID()}`;
  await page.getByLabel("Timeline ID").fill(timelineId);
  await page.getByRole("button", { name: "Create timeline", exact: true }).click();
  await page.getByText(new RegExp(`Created empty timeline ${timelineId}; exact revision .* reopened\\.`)).waitFor();
  const timelineResult = await jsonFrom(page.locator("#timeline-json"));
  const timelineRevisionId = timelineResult.revision.revisionId;
  assert.equal(timelineResult.scope, "DEV_ONLY");
  assert.equal(timelineResult.revision.parentRevisionId, initialRevisionId);
  assert.equal(timelineResult.revision.timelines.length, 1);
  assert.equal(timelineResult.revision.timelines[0].graph.timelineId, timelineId);
  assert.deepEqual(timelineResult.revision.timelines[0].graph.scenes, []);
  assert.deepEqual(timelineResult.revision.timelines[0].graph.tracks, []);
  assert.deepEqual(timelineResult.revision.timelines[0].graph.clips, []);

  await page.getByRole("button", { name: "Create timeline", exact: true }).click();
  await page.getByText(new RegExp(`Timeline ${timelineId} is already present in the current owner head .*; no mutation was sent\\.`)).waitFor();
  assert.equal(apiRequests.filter(({ method, url }) => method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines`)).length, 1,
    "reopening the existing timeline must use the owner head read, never duplicate the mutation");

  const sceneId = `scene-${crypto.randomUUID()}`;
  await page.getByLabel("New scene ID").fill(sceneId);
  await page.getByLabel("Scene order").fill("0");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByText(/Committed and reopened addScene in revision .*\./u).waitFor();
  const sceneRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(sceneRevision.parentRevisionId, timelineRevisionId);
  assert.deepEqual(sceneRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(sceneRevision.timelines[0].graph.tracks, []);

  const trackId = `track-${crypto.randomUUID()}`;
  await page.getByLabel("New track ID").fill(trackId);
  await page.locator(`input[name="track-parent-scene"][value="${sceneId}"]`).check();
  await page.locator('input[name="track-kind"][value="VIDEO"]').check();
  await page.getByLabel("Order within scene").fill("0");
  await page.getByRole("button", { name: "Add track", exact: true }).click();
  await page.getByText(/Committed and reopened addTrack in revision .*\./u).waitFor();
  const trackRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(trackRevision.parentRevisionId, sceneRevision.revisionId);
  assert.deepEqual(trackRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(trackRevision.timelines[0].graph.tracks, [{ trackId, sceneId, kind: "VIDEO", order: 0 }]);
  assert.deepEqual(trackRevision.timelines[0].graph.clips, []);
  const trackRevisionId = trackRevision.revisionId;

  await page.getByLabel("Source artifact ID to inspect").fill(expectedArtifactId);
  await page.getByRole("button", { name: "Read source artifact" }).click();
  const inspectedArtifact = page.getByLabel("Inspected source artifact");
  await inspectedArtifact.getByText(expectedArtifactId, { exact: true }).waitFor();
  await inspectedArtifact.getByText(`sha256:${expectedArtifactSha256}`, { exact: true }).waitFor();
  const artifactRead = apiRequests.find(({ method, url }) =>
    method === "GET" && new URL(url).pathname === `/api/v1/artifacts/${expectedArtifactId}`);
  assert.ok(artifactRead, "Chromium must inspect the exact owner artifact through the Vite proxy before attaching it");
  await page.getByRole("note", { name: "Development scope" }).getByText("DEV_ONLY · NOT_ADMITTED").waitFor();
  await page.getByText(/does not verify decoder clock mapping, current rights, or render output/u).waitFor();
  const clipIdPattern = await page.locator("#clip-id").getAttribute("pattern");
  assert.ok(clipIdPattern?.includes("\\x2d"),
    `the browser must receive the escaped hyphen in the ID pattern; received ${clipIdPattern}`);

  const clipId = `clip-${crypto.randomUUID()}`;
  await page.locator("#clip-id").fill(clipId);
  await page.locator(`input[name="clip-track-id"][value="${trackId}"]`).check();
  await page.getByLabel("Source in ticks").fill("9007199254740993");
  await page.getByLabel("Source out ticks").fill("9007199254748993");
  await page.getByLabel("Source rate numerator").fill("8000");
  await page.getByLabel("Source rate denominator").fill("1");
  await page.getByLabel("Story start ticks").fill("0");
  await page.getByLabel("Story duration ticks").fill("24");
  await page.getByLabel("Story rate numerator").fill("24");
  await page.getByLabel("Story rate denominator").fill("1");
  await page.getByRole("button", { name: "Add or update clip reference" }).click();
  await page.getByText(/Committed and reopened putClip in revision .*\./u).waitFor();
  const clipRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(clipRevision.parentRevisionId, trackRevisionId);
  const expectedClip = {
    clipId,
    sceneId,
    trackId,
    source: { artifactId: expectedArtifactId, artifactVersionId: `sha256:${expectedArtifactSha256}` },
    sourceIn: {
      ticks: "9007199254740993", rateNumerator: "8000", rateDenominator: "1", clock: "SOURCE_PRESENTATION",
    },
    sourceOut: {
      ticks: "9007199254748993", rateNumerator: "8000", rateDenominator: "1", clock: "SOURCE_PRESENTATION",
    },
    storyStart: { ticks: "0", rateNumerator: "24", rateDenominator: "1", clock: "STORY" },
    storyDuration: { ticks: "24", rateNumerator: "24", rateDenominator: "1", clock: "STORY" },
  };
  assert.deepEqual(clipRevision.timelines[0].graph.clips, [expectedClip],
    "the committed graph must pin the inspected exact SHA256 version and decimal-string rational times");
  const clipEditRequest = apiRequests.find(({ method, url, body }) =>
    method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`)
      && body && JSON.parse(body).edits?.some((edit) => edit.type === "putClip"));
  assert.ok(clipEditRequest, "Chromium must commit the clip through the DEV_ONLY timeline edit route");
  assert.deepEqual(JSON.parse(clipEditRequest.body).edits[0].clip, expectedClip,
    "wire times must remain exact decimal strings from form submission through timeline CAS");
  const clipRevisionId = clipRevision.revisionId;

  const editPostCountBeforeBlockedTrackRemove = apiRequests.filter(({ method, url }) =>
    method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`)).length;
  await page.locator(`input[name="remove-track-id"][value="${trackId}"]`).check();
  await page.getByRole("button", { name: "Remove track" }).click();
  await page.getByText(new RegExp(
    `Track ID ${trackId} still owns clips\\. Remove its clips before removing the track; no mutation was sent\\.`, "u",
  )).waitFor();
  assert.equal(apiRequests.filter(({ method, url }) =>
    method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`)).length,
  editPostCountBeforeBlockedTrackRemove, "a track with a remaining clip must be rejected before an edit POST");

  await page.locator(`input[name="remove-clip-id"][value="${clipId}"]`).check();
  await page.getByRole("button", { name: "Remove clip" }).click();
  await page.getByText(/Committed and reopened removeClip in revision .*\./u).waitFor();
  const removeClipRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(removeClipRevision.parentRevisionId, clipRevisionId);
  assert.deepEqual(removeClipRevision.timelines[0].graph.clips, []);

  const editPostCountBeforeBlockedRemove = apiRequests.filter(({ method, url }) =>
    method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`)).length;
  await page.locator(`input[name="remove-scene-id"][value="${sceneId}"]`).check();
  await page.getByRole("button", { name: "Remove scene" }).click();
  await page.getByText(new RegExp(
    `Scene ID ${sceneId} still owns tracks\\. Remove its tracks before removing the scene; no mutation was sent\\.`, "u",
  )).waitFor();
  assert.equal(apiRequests.filter(({ method, url }) =>
    method === "POST" && url.endsWith(`/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`)).length,
  editPostCountBeforeBlockedRemove, "a scene with a remaining track must be rejected before an edit POST");

  await page.locator(`input[name="remove-track-id"][value="${trackId}"]`).check();
  await page.getByRole("button", { name: "Remove track" }).click();
  await page.getByText(/Committed and reopened removeTrack in revision .*\./u).waitFor();
  const removeTrackRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(removeTrackRevision.parentRevisionId, removeClipRevision.revisionId);
  assert.deepEqual(removeTrackRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(removeTrackRevision.timelines[0].graph.tracks, []);
  assert.deepEqual(removeTrackRevision.timelines[0].graph.clips, []);
  const removeTrackRevisionId = removeTrackRevision.revisionId;

  await page.locator(`input[name="remove-scene-id"][value="${sceneId}"]`).check();
  await page.getByRole("button", { name: "Remove scene" }).click();
  await page.getByText(/Committed and reopened removeScene in revision .*\./u).waitFor();
  const removeSceneRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(removeSceneRevision.parentRevisionId, removeTrackRevisionId);
  assert.deepEqual(removeSceneRevision.timelines[0].graph.scenes, []);
  assert.deepEqual(removeSceneRevision.timelines[0].graph.tracks, []);
  assert.deepEqual(removeSceneRevision.timelines[0].graph.clips, []);
  const removeSceneRevisionId = removeSceneRevision.revisionId;

  await page.getByLabel("Exact revision ID").fill(trackRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${trackRevisionId} from project ${projectId}\\.`) }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Restore as new project head" }).isEnabled(), true,
    "restore is enabled only after reading an exact immutable target");
  await page.getByRole("button", { name: "Restore as new project head" }).click();
  await page.getByText(/Restored exact graph state from .* as new head .*; prior revisions remain available\./u).waitFor();
  const undoRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.equal(undoRevision.parentRevisionId, removeSceneRevisionId);
  assert.deepEqual(undoRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(undoRevision.timelines[0].graph.tracks, [{ trackId, sceneId, kind: "VIDEO", order: 0 }]);
  const undoRevisionId = undoRevision.revisionId;

  await page.getByLabel("Exact revision ID").fill(removeSceneRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${removeSceneRevisionId} from project ${projectId}\\.`) }).waitFor();
  await page.getByRole("button", { name: "Restore as new project head" }).click();
  await page.getByText(/Restored exact graph state from .* as new head .*; prior revisions remain available\./u).waitFor();
  const redoRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.notEqual(redoRevision.revisionId, removeSceneRevisionId);
  assert.equal(redoRevision.parentRevisionId, undoRevision.revisionId);
  assert.deepEqual(redoRevision.timelines[0].graph.scenes, []);
  assert.deepEqual(redoRevision.timelines[0].graph.tracks, []);
  const editedRevisionId = redoRevision.revisionId;

  await page.getByLabel("Exact revision ID").fill(trackRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${trackRevisionId} from project ${projectId}\\.`) }).waitFor();
  const exactHistoricalTrackRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.deepEqual(exactHistoricalTrackRevision.timelines[0].graph.tracks,
    [{ trackId, sceneId, kind: "VIDEO", order: 0 }], "remove undo/redo must leave the original track revision immutable");
  await page.getByLabel("Exact revision ID").fill(removeTrackRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${removeTrackRevisionId} from project ${projectId}\\.`) }).waitFor();
  const exactHistoricalRemoveTrackRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.equal(exactHistoricalRemoveTrackRevision.parentRevisionId, removeClipRevision.revisionId);
  assert.deepEqual(exactHistoricalRemoveTrackRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(exactHistoricalRemoveTrackRevision.timelines[0].graph.tracks, [],
    "track removal must remain an immutable intermediate revision");
  await page.getByLabel("Exact revision ID").fill(removeSceneRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${removeSceneRevisionId} from project ${projectId}\\.`) }).waitFor();
  const exactHistoricalRemoveSceneRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.equal(exactHistoricalRemoveSceneRevision.parentRevisionId, removeTrackRevisionId);
  assert.deepEqual(exactHistoricalRemoveSceneRevision.timelines[0].graph.scenes, []);
  assert.deepEqual(exactHistoricalRemoveSceneRevision.timelines[0].graph.tracks, [],
    "scene removal must remain an immutable empty-graph revision");

  const requestCountBeforeRestart = apiRequests.length;
  process.stdout.write(`${JSON.stringify({
    event: "created",
    projectId,
    title,
    initialRevisionId,
    timelineId,
    timelineRevisionId: editedRevisionId,
    sceneRevisionId: sceneRevision.revisionId,
    trackRevisionId,
    clipRevisionId,
    removeClipRevisionId: removeClipRevision.revisionId,
    removeTrackRevisionId,
    removeSceneRevisionId,
    undoRevisionId: undoRevision.revisionId,
    redoRevisionId: redoRevision.revisionId,
    artifactId: expectedArtifactId,
    artifactSha256: expectedArtifactSha256,
    sceneId,
    trackId,
    browserApiRequests: apiRequests.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
  })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let restarted = false;
  for await (const line of input) {
    if (line === "host-restarted") { restarted = true; break; }
  }
  input.close();
  assert.equal(restarted, true, "the integration host must restart between creation and exact browser readback");

  await page.getByRole("button", { name: "Reopen current project" }).click();
  await page.getByText(new RegExp(`Reopened project ${projectId} at head ${editedRevisionId}\\.`)).waitFor();
  const reopened = await jsonFrom(page.locator("#readback-json"));
  assert.equal(reopened.project.projectId, projectId);
  assert.equal(reopened.currentRevision.revisionId, editedRevisionId);
  assert.equal(reopened.currentRevision.timelines[0].graph.timelineId, timelineId);

  await page.getByLabel("Exact revision ID").fill(editedRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${editedRevisionId} from project ${projectId}\\.`) }).waitFor();
  const exact = await jsonFrom(page.locator("#readback-json"));
  const exactRevision = exact.revision;
  assert.equal(exact.scope, "DEV_ONLY");
  assert.equal(exactRevision.revisionId, editedRevisionId);
  assert.equal(exactRevision.projectId, projectId);
  assert.equal(exactRevision.parentRevisionId, undoRevision.revisionId);
  assert.equal(exactRevision.timelines[0].graph.timelineId, timelineId);
  assert.deepEqual(exactRevision.timelines[0].graph.scenes, []);
  assert.deepEqual(exactRevision.timelines[0].graph.tracks, []);
  assert.deepEqual(exactRevision.timelines[0].graph.clips, []);

  await page.getByLabel("Exact revision ID").fill(clipRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${clipRevisionId} from project ${projectId}\\.`) }).waitFor();
  const exactClipRevision = (await jsonFrom(page.locator("#readback-json"))).revision;
  assert.equal(exactClipRevision.revisionId, clipRevisionId);
  assert.equal(exactClipRevision.parentRevisionId, trackRevisionId);
  assert.deepEqual(exactClipRevision.timelines[0].graph.clips, [expectedClip],
    "launcher restart must preserve the exact immutable clip revision with its source SHA256 and rational strings");
  assert.ok(!apiRequests.slice(requestCountBeforeRestart).some(({ method }) => method === "POST"),
    "the post-restart read phase must not mutate");
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.deepEqual(networkFailures, [], `browser network failures: ${JSON.stringify(networkFailures)}`);
  assert.ok(apiResponses.every((entry) => entry.includes("127.0.0.1")), "all DEV_ONLY calls must stay on loopback Vite origin");

  process.stdout.write(`${JSON.stringify({
    event: "readback",
    projectId,
    timelineRevisionId: editedRevisionId,
    timelineId,
    sceneId,
    trackId,
    removeTrackRevisionId,
    removeSceneRevisionId,
    undoRevisionId: undoRevision.revisionId,
    redoRevisionId: redoRevision.revisionId,
    clipRevisionId,
    removeClipRevisionId: removeClipRevision.revisionId,
    artifactId: expectedArtifactId,
    artifactSha256: expectedArtifactSha256,
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
