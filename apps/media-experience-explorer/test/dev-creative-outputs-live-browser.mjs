import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const token = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_TOKEN");
const wavId = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_WAV_ID");
const wavSha256 = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_WAV_SHA256");
const sourceRigJson = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_RIG_JSON");
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT"));
const tenantId = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_TENANT_ID");
const principalId = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_PRINCIPAL_ID");
const viteBinary = requiredEnv("MEDIA_DEV_VITE_BINARY");
const playwrightModule = requiredEnv("MEDIA_DEV_PLAYWRIGHT_MODULE");
const expectedViteVersion = requiredEnv("MEDIA_DEV_VITE_VERSION");
const expectedPlaywrightVersion = "1.63.0";
const expectedChromiumRevision = "1243";
const expectedChromiumVersion = "153.0.8010.12";
const clientModule = await import("@audio-video/client/dev-creative-output");
const { MediaDevOnlyCreativeOutputClient } = clientModule;
assert.equal(typeof MediaDevOnlyCreativeOutputClient, "function", "the installed client export must be available");
assert.match(import.meta.resolve("@audio-video/client/dev-creative-output"), /\/libs\/audio-video-client\/dist\/dev-creative-output\.js$/u,
  "the live journey must import the compiled installed client package");
const simulationModule = await import("@audio-video/client/dev-simulation");
const { MediaDevOnlySimulationClient } = simulationModule;
assert.equal(typeof MediaDevOnlySimulationClient, "function", "the installed simulation client export must be available");
assert.match(import.meta.resolve("@audio-video/client/dev-simulation"), /\/libs\/audio-video-client\/dist\/dev-simulation\.js$/u,
  "PNG lineage must use the compiled installed simulation client");
const projectTimelineModule = await import("@audio-video/client/dev-project-timeline");
const { MediaDevProjectTimelineClient } = projectTimelineModule;
assert.equal(typeof MediaDevProjectTimelineClient, "function", "the installed project timeline client export must be available");
assert.match(import.meta.resolve("@audio-video/client/dev-project-timeline"), /\/libs\/audio-video-client\/dist\/dev-project-timeline\.js$/u,
  "project lineage must use the compiled installed project timeline client");
const projectRenderModule = await import("@audio-video/client/dev-project-render");
const { MediaDevOnlyProjectRenderClient } = projectRenderModule;
assert.equal(typeof MediaDevOnlyProjectRenderClient, "function", "the installed project render client export must be available");
assert.match(import.meta.resolve("@audio-video/client/dev-project-render"), /\/libs\/audio-video-client\/dist\/dev-project-render\.js$/u,
  "GIF output must use the compiled installed project render client");
const require = createRequire(import.meta.url);
const validator = require("gltf-validator");
const validatorPackage = JSON.parse(await readFile(resolve(dirname(require.resolve("gltf-validator")), "package.json"), "utf8"));
assert.equal(validatorPackage.version, "2.0.0-dev.3.10", "GLB verification must use the pinned Khronos validator");
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

const vitePort = 4179;
const viteEnvironment = {
  ...process.env,
  MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort),
  MEDIA_DEV_VITE_DISABLE_WATCH: "1",
};
delete viteEnvironment.MEDIA_DEV_CREATIVE_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readWithInstalledClient(client, outputId, expectedKind, expectedSha, label,
                                       expectedProjectRevisionRef, expectedSources, expectedSourceVersion) {
  const output = await client.getCreativeOutput(outputId);
  assert.equal(output.lineage.kind, expectedKind, `${label}: installed client kind`);
  assert.equal(output.artifact.sha256, expectedSha, `${label}: installed client registered digest`);
  if (expectedProjectRevisionRef !== undefined) {
    assert.equal(output.lineage.sourceProjectRevisionRef, expectedProjectRevisionRef,
      `${label}: installed client project revision lineage`);
  }
  if (expectedSources !== undefined) {
    assert.deepEqual(output.lineage.sources.map(({ artifactId, artifactVersionId }) => ({ artifactId, artifactVersionId })),
      expectedSources, `${label}: installed client source versions`);
  }
  if (expectedSourceVersion !== undefined) {
    assert.deepEqual({ artifactId: output.lineage.source.artifactId,
      artifactVersionId: output.lineage.source.artifactVersionId, sha256: output.lineage.source.sha256 },
    expectedSourceVersion, `${label}: installed client exact source artifact version`);
  }
  const bytes = await client.readContent(output);
  assert.equal(sha256Of(bytes), expectedSha, `${label}: installed client content digest`);
  return Buffer.from(bytes);
}

async function decodeBrowserImage(bytes, contentType, expectedWidth, expectedHeight, label) {
  const decoded = await diagnosticPage.evaluate(async ({ base64, type }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, complete: image.complete };
    } finally { URL.revokeObjectURL(url); }
  }, { base64: Buffer.from(bytes).toString("base64"), type: contentType });
  assert.deepEqual(decoded, { width: expectedWidth, height: expectedHeight, complete: true },
    `${label}: Chromium must decode the exact installed-client ${contentType} bytes`);
  return decoded;
}

async function decodeBrowserWav(bytes, label) {
  const decoded = await diagnosticPage.evaluate(async ({ base64 }) => {
    const binary = atob(base64);
    const content = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([content], { type: "audio/wav" }));
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = url;
    try {
      await new Promise((resolveLoad, rejectLoad) => {
        const timeout = setTimeout(() => rejectLoad(new Error("WAV metadata did not load")), 15_000);
        audio.addEventListener("loadedmetadata", () => { clearTimeout(timeout); resolveLoad(); }, { once: true });
        audio.addEventListener("error", () => { clearTimeout(timeout); rejectLoad(new Error(`WAV decoder error ${audio.error?.code}`)); }, { once: true });
      });
      return { duration: audio.duration, readyState: audio.readyState };
    } finally {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    }
  }, { base64: Buffer.from(bytes).toString("base64") });
  assert.ok(decoded.readyState >= 1 && decoded.duration > 0.9 && decoded.duration < 1.1,
    `${label}: Chromium must decode the exact installed-client 8 kHz WAV bytes (~1 s), got ${JSON.stringify(decoded)}`);
  return decoded;
}

async function createScientificSimulation() {
  const requestId = `m06-simulation-${crypto.randomUUID()}`;
  const q = (value, unit) => ({ value, unit });
  const scenario = {
    model: { type: "DAMPED_SPRING", mass: q(0.5, "kg"), springConstant: q(200, "N/m"), damping: q(1.2, "kg/s") },
    initial: { position: q(0.1, "m"), velocity: q(0.3, "m/s") },
    solver: {
      duration: q(2, "s"), maxStep: q(0.05, "s"), minStep: q(1e-5, "s"),
      positionTolerance: q(1e-9, "m"), velocityTolerance: q(1e-9, "m/s"),
      maxAcceptedSteps: 5000, maxIterations: 100_000, mode: "ADAPTIVE",
    },
    render: { plot: true, video: false },
  };
  const response = await fetch(`http://127.0.0.1:${proxyPort}/dev/v1/simulations`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${activeToken}`,
      "X-Tenant-ID": tenantId,
      "X-Principal-Id": principalId,
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({ requestId, scenario }),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 201, `scientific simulation PNG registration: ${JSON.stringify(responseBody)}`);
  assert.equal(responseBody.outcome, "COMPLETED");
  assert.equal(responseBody.scope, "DEV_ONLY");
  assert.equal(responseBody.lineage.productionEligible, false);
  return responseBody;
}

async function validateInstalledGlb(bytes, expectedSha, label) {
  assert.equal(sha256Of(bytes), expectedSha, `${label}: validator input is the exact client-read content`);
  const report = await validator.validateBytes(new Uint8Array(bytes), {
    uri: "client-read-preview.glb",
    maxIssues: 1_000,
  });
  assert.equal(report.issues.numErrors, 0,
    `${label}: pinned Khronos validator errors: ${JSON.stringify(report.issues.messages)}`);
  return {
    validator: "KhronosGroup/glTF-Validator",
    version: validatorPackage.version,
    assetSha256: sha256Of(bytes),
    issueCounts: {
      errors: report.issues.numErrors,
      warnings: report.issues.numWarnings,
      infos: report.issues.numInfos,
      hints: report.issues.numHints,
    },
  };
}

async function assertProjectRevisionReadback(projectId, revisionId, timelineId, sceneId, trackId, expectedClips) {
  const projectRead = await projectTimelineClient.getProject(projectId);
  assert.equal(projectRead.scope, "DEV_ONLY");
  assert.equal(projectRead.project.projectId, projectId);
  assert.equal(projectRead.project.headRevisionId, revisionId, "project read must expose the exact expected head");
  assert.equal(projectRead.currentRevision.revisionId, revisionId);
  const revisionRead = await projectTimelineClient.getRevision(projectId, revisionId);
  assert.equal(revisionRead.scope, "DEV_ONLY");
  assert.equal(revisionRead.revision.projectId, projectId);
  assert.equal(revisionRead.revision.revisionId, revisionId);
  const snapshots = revisionRead.revision.timelines.filter((snapshot) => snapshot.graph.timelineId === timelineId);
  assert.equal(snapshots.length, 1, "the exact project revision must contain the selected timeline");
  const graph = snapshots[0].graph;
  assert.deepEqual(graph.scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(graph.tracks, [{ trackId, sceneId, kind: "VIDEO", order: 0 }]);
  assert.deepEqual(graph.clips, expectedClips, "the exact project revision must retain both seeded PNG source versions");
  return { project: projectRead.project, revision: revisionRead.revision };
}

async function createSourceProjectRevision() {
  const baseRig = JSON.parse(sourceRigJson);
  assert.ok(baseRig && Array.isArray(baseRig.sourceVersions) && baseRig.sourceVersions.length === 2,
    "the spatial rig fixture must name both seeded PNG versions");
  const context = await projectTimelineClient.getContext();
  assert.equal(context.scope, "DEV_ONLY");
  assert.equal(context.tenantId, tenantId);
  assert.equal(context.principalId, principalId);
  assert.equal(context.capabilities.artifactRead, true,
    "project source binding requires the verified artifact-read capability");

  const sourceVersions = [];
  for (const requested of baseRig.sourceVersions) {
    const ownerArtifact = await projectTimelineClient.getOwnedArtifact(requested.artifactId);
    assert.equal(ownerArtifact.tenantId, tenantId);
    assert.equal(ownerArtifact.principalId, principalId);
    assert.equal(ownerArtifact.contentType, "image/png");
    assert.equal(ownerArtifact.artifactVersionId, requested.artifactVersionId,
      "each project clip must pin the exact owner-read PNG artifact version");
    sourceVersions.push({ artifactId: ownerArtifact.artifactId, artifactVersionId: ownerArtifact.artifactVersionId });
  }

  const projectCreated = await projectTimelineClient.createProject({
    selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
    title: `Spatial GLB source project ${crypto.randomUUID()}`,
    requestId: `m06-project-${crypto.randomUUID()}`,
  });
  assert.equal(projectCreated.scope, "DEV_ONLY");
  assert.equal(projectCreated.createdNow, true);
  assert.equal(projectCreated.initialRevision.timelines.length, 0,
    "the owner-created project begins with an empty revision");
  const projectId = projectCreated.project.projectId;
  const timelineId = `m06-timeline-${crypto.randomUUID()}`;
  const timelineCreated = await projectTimelineClient.createTimeline(projectId, {
    expectedHeadRevisionId: projectCreated.initialRevision.revisionId,
    timelineId,
    requestId: `m06-timeline-create-${crypto.randomUUID()}`,
  });
  const sceneId = `m06-scene-${crypto.randomUUID()}`;
  const trackId = `m06-track-${crypto.randomUUID()}`;
  const structure = await projectTimelineClient.editTimeline(projectId, timelineId, {
    expectedHeadRevisionId: timelineCreated.revision.revisionId,
    requestId: `m06-timeline-structure-${crypto.randomUUID()}`,
    edits: [
      { type: "addScene", sceneId, order: 0 },
      { type: "addTrack", trackId, sceneId, trackKind: "VIDEO", order: 0 },
    ],
  });
  const sourceTime = (ticks, clock) => ({
    ticks: String(ticks), rateNumerator: "24", rateDenominator: "1", clock,
  });
  const clips = sourceVersions.map((source, index) => ({
    clipId: `m06-clip-${index}-${crypto.randomUUID()}`,
    sceneId,
    trackId,
    source,
    sourceIn: sourceTime(0, "SOURCE_PRESENTATION"),
    sourceOut: sourceTime(24, "SOURCE_PRESENTATION"),
    storyStart: sourceTime(index * 24, "STORY"),
    storyDuration: sourceTime(24, "STORY"),
  }));
  const clipsRevision = await projectTimelineClient.editTimeline(projectId, timelineId, {
    expectedHeadRevisionId: structure.revision.revisionId,
    requestId: `m06-timeline-clips-${crypto.randomUUID()}`,
    edits: clips.map((clip) => ({ type: "putClip", clip })),
  });
  const revisionId = clipsRevision.revision.revisionId;
  await assertProjectRevisionReadback(projectId, revisionId, timelineId, sceneId, trackId, clips);
  const sourceProjectRevisionRef = `project_revision:${projectId}@${revisionId}`;
  const rig = { ...baseRig, sourceVersions, sourceProjectRevisionRef };
  assert.deepEqual(rig.sourceVersions, sourceVersions);
  return {
    projectId, revisionId, timelineId, sceneId, trackId, sourceVersions, clips,
    sourceProjectRevisionRef, rigJson: JSON.stringify(rig),
  };
}

let browser;
let diagnosticPage;
let activeToken = token;
const creativeOutputClient = new MediaDevOnlyCreativeOutputClient({
  baseUrl: `http://127.0.0.1:${proxyPort}`,
  tenantId,
  getAccessToken: () => activeToken,
  defaultHeaders: { "X-Principal-Id": principalId },
});
const simulationClient = new MediaDevOnlySimulationClient({
  baseUrl: `http://127.0.0.1:${proxyPort}`,
  tenantId,
  getAccessToken: () => activeToken,
  defaultHeaders: { "X-Principal-Id": principalId },
});
const projectTimelineClient = new MediaDevProjectTimelineClient({
  baseUrl: `http://127.0.0.1:${proxyPort}`,
  bearerToken: () => activeToken,
});
const projectRenderClient = new MediaDevOnlyProjectRenderClient({
  baseUrl: `http://127.0.0.1:${proxyPort}`,
  tenantId,
  getAccessToken: () => activeToken,
  defaultHeaders: { "X-Principal-Id": principalId },
});
const browserDiagnostics = {
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  non2xxResponses: [],
  recoveredReconnectFailures: [],
};

function redact(value) {
  let text = String(value ?? "");
  for (const secret of [token, activeToken]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<unavailable>";
  }
}

async function writeFailureDiagnostics(error, baseUrl) {
  const outputDir = resolve(appRoot, "../../integration-tests/build/test-results/test");
  const fileStem = `media-dev-explorer-creative-outputs-live-browser-failure-${process.pid}`;
  const jsonPath = resolve(outputDir, `${fileStem}.json`);
  const screenshotPath = resolve(outputDir, `${fileStem}.png`);
  let pageState = { url: baseUrl, title: "", bodyText: "", screenshot: null };
  await mkdir(outputDir, { recursive: true });

  if (diagnosticPage) {
    try {
      await diagnosticPage.evaluate(() => {
        const tokenInput = document.querySelector("#dev-token");
        if (tokenInput instanceof HTMLInputElement) tokenInput.value = "";
      });
      const snapshot = await diagnosticPage.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyText: document.body?.innerText ?? "",
      }));
      pageState = {
        url: safeUrl(snapshot.url),
        title: redact(snapshot.title),
        bodyText: redact(snapshot.bodyText).slice(0, 8_000),
        screenshot: null,
      };
      await diagnosticPage.screenshot({ path: screenshotPath, fullPage: true });
      pageState.screenshot = screenshotPath;
    } catch (snapshotError) {
      pageState.snapshotError = redact(snapshotError?.stack ?? snapshotError);
    }
  }

  const report = {
    error: redact(error?.stack ?? error),
    page: pageState,
    pageErrors: browserDiagnostics.pageErrors.map(redact),
    consoleErrors: browserDiagnostics.consoleErrors.map((entry) => ({ ...entry, text: redact(entry.text) })),
    failedRequests: browserDiagnostics.failedRequests.map((entry) => ({ ...entry, failure: redact(entry.failure) })),
    recoveredReconnectFailures: browserDiagnostics.recoveredReconnectFailures,
    non2xxResponses: browserDiagnostics.non2xxResponses,
    viteOutput: redact(viteOutput).slice(-12_000),
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Browser failure diagnostics: ${jsonPath}\n`);
  if (pageState.screenshot) process.stderr.write(`Browser failure screenshot: ${screenshotPath}\n`);
}

try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-creative-outputs.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual creative-outputs page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  diagnosticPage = page;
  const pageErrors = browserDiagnostics.pageErrors;
  const consoleErrors = browserDiagnostics.consoleErrors;
  const apiRequests = [];
  const contentRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Console errors carry the resource URL so each deliberate 4xx is tolerated only by its exact path and status.
  const expectedErrors = []; // { pathname, status }
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch { pathname = ""; }
    consoleErrors.push({ text: message.text(), pathname });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/dev/v1/")) return;
    apiRequests.push({ method: request.method(), path, body: request.postData(), url: request.url(), headers: request.headers() });
    if (path.endsWith("/content")) contentRequests.push({ url: request.url(), headers: request.headers() });
  });
  page.on("requestfailed", (request) => {
    browserDiagnostics.failedRequests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      failure: request.failure()?.errorText ?? "unknown request failure",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 200 && response.status() < 300) return;
    browserDiagnostics.non2xxResponses.push({
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
      statusText: response.statusText(),
    });
  });

  async function connect(bearer, { retryStaticNetworkChange = false } = {}) {
    activeToken = bearer;
    const failuresStart = browserDiagnostics.failedRequests.length;
    const consoleStart = consoleErrors.length;
    const pageErrorsStart = pageErrors.length;
    const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
    const attempt = async () => {
      await page.goto(`${baseUrl}/dev-creative-outputs.html`);
      await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByRole("heading", { name: /Creative outputs · DEV_ONLY/u }).waitFor({ timeout: 15_000 });
    };
    try {
      await attempt();
    } catch (error) {
      const failed = browserDiagnostics.failedRequests.slice(failuresStart);
      const newConsoleErrors = consoleErrors.slice(consoleStart);
      const newPageErrors = pageErrors.slice(pageErrorsStart);
      const recoverableFailure = (entry) =>
        (entry.method === "GET" && entry.path.startsWith("/@fs/") && entry.failure === "net::ERR_NETWORK_CHANGED")
        || (entry.method === "GET" && /^\/dev\/v1\/artifacts\/[^/]+\/content$/u.test(entry.path)
          && entry.failure === "net::ERR_ABORTED");
      const recoverableConsole = (entry) => entry.pathname.startsWith("/@fs/")
        && entry.text.includes("net::ERR_NETWORK_CHANGED");
      if (!retryStaticNetworkChange || failed.length === 0 || !failed.every(recoverableFailure)
          || !newConsoleErrors.every(recoverableConsole) || newPageErrors.length !== 0) {
        throw error;
      }

      assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore,
        "a failed static-page reconnect must not produce a write");
      browserDiagnostics.recoveredReconnectFailures.push({
        attempt: 1,
        failedRequests: failed.map(({ method, path, failure }) => ({ method, path, failure })),
        consoleErrors: newConsoleErrors.map(({ pathname, text }) => ({ pathname, text })),
        note: "one clean-page retry after Chromium reported a transient network change during local static module loads",
      });
      browserDiagnostics.failedRequests.splice(failuresStart, failed.length);
      consoleErrors.splice(consoleStart, newConsoleErrors.length);
      await delay(250);
      await attempt();
    }
  }
  const result = page.locator("#creative-result");
  const ddOf = async (scope, term) => (await scope.locator("dt", { hasText: term }).first().locator("xpath=following-sibling::dd").textContent()).trim();

  // Verified preview (when previewable) and Download of one registered output; the saved file is hashed independently.
  async function assertVerifiedContent(outputId, kind, expectedSha, label) {
    const noun = kind.toUpperCase();
    const section = result.getByRole("region", { name: `${noun} content` });
    if (kind === "wav") {
      await section.getByRole("button", { name: /^Preview WAV/u }).click();
      await section.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
      const audio = section.locator("audio[data-verified-preview='wav']");
      await audio.waitFor({ timeout: 10_000 });
      assert.match(await audio.getAttribute("src"), /^blob:/u, `${label}: preview must be a blob URL`);
      await audio.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
        if (element.readyState >= 1) return resolveLoad();
        element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
        element.addEventListener("error", () => rejectLoad(new Error(`audio error ${element.error?.code}: ${element.error?.message}`)), { once: true });
        setTimeout(() => rejectLoad(new Error("audio metadata did not load")), 15_000);
      }));
      const loaded = await audio.evaluate((element) => ({ readyState: element.readyState, duration: element.duration }));
      assert.ok(loaded.readyState >= 1 && loaded.duration > 0.9 && loaded.duration < 1.1, `${label}: the 8000-frame 8 kHz WAV must report ~1 s, got ${JSON.stringify(loaded)}`);
      assert.ok((await section.textContent()).includes(expectedSha), `${label}: verified message must carry the sha256`);
    } else {
      assert.equal(await section.getByRole("button", { name: /^Preview/u }).count(), 0, `${label}: ${noun} is download-only`);
    }
    const downloading = page.waitForEvent("download");
    await section.getByRole("button", { name: new RegExp(`^Download ${noun}`, "u") }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), `${outputId}.${kind}`);
    const saved = sha256Of(await readFile(await download.path()));
    assert.equal(saved, expectedSha, `${label}: downloaded ${noun} must hash to the registered sha256`);
  }

  async function readSimulationTable(label, expectedSha) {
    const table = page.getByLabel("Simulated observation series");
    await table.waitFor({ timeout: 30_000 });
    assert.ok((await result.textContent()).includes("Bytes verified against the registered version before this table was built."), `${label}: table must come from verified bytes`);
    assert.match(await table.locator("thead").textContent(), /totalEnergy \(JOULE\)/u);
    const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.ok(rows.length >= 2, `${label}: observation rows`);
    const last = rows[rows.length - 1].map(Number);
    // 6 N on 2 kg for 2 s from rest: acceleration 3, terminal velocity 6, terminal position 6. The reported total
    // energy is conserved for a constant force (kinetic 36 J minus the potential F*x = 36 J), so it stays at 0.
    assert.ok(Math.abs(last[0] - 2) < 1e-9 && Math.abs(last[1] - 6) < 1e-6 && Math.abs(last[2] - 6) < 1e-6 && Math.abs(last[3] - 3) < 1e-6,
      `${label}: terminal observation ${JSON.stringify(rows[rows.length - 1])}`);
    assert.ok(rows.every((row) => Math.abs(Number(row[4])) < 1e-5), `${label}: total energy must be conserved at 0: ${JSON.stringify(rows)}`);
    assert.equal(await ddOf(result, "SHA-256"), expectedSha);
    return rows.length;
  }

  await connect(token);
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- Audio repair of the seeded clipped WAV ----
  await page.getByLabel("Source artifact ID").fill(wavId);
  await page.getByLabel("Exact source artifact version").fill(`sha256:${wavSha256}`);
  await page.getByLabel(/Clipping threshold/u).fill("0.94");
  await page.getByLabel(/Maximum clipped run/u).fill("64");
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "AUDIO_REPAIR_CANDIDATE");
  const audioId = await result.getAttribute("data-output-id");
  assert.ok(audioId && audioId !== wavId, "the repaired output must be a NEW artifact");
  const audioSha = await ddOf(result, "SHA-256");
  assert.match(audioSha, /^[0-9a-f]{64}$/u);
  assert.notEqual(audioSha, wavSha256, "the repaired bytes must differ from the clipped source");
  assert.equal(await ddOf(result, "Artifact version"), `sha256:${audioSha}`);
  assert.match(await ddOf(result, "Content type and size"), /^audio\/wav · \d+ bytes$/u);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source artifact"), wavId);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source SHA-256"), wavSha256);
  await result.getByRole("heading", { name: "Engine sample statistics" }).waitFor();
  assert.match(await result.textContent(), /not a quality assessment/u);
  const statistics = page.getByLabel("Engine sample statistics");
  const changed = Number(await ddOf(statistics, "changedSampleCount"));
  assert.ok(Number.isFinite(changed) && changed > 0, `a hard-clipped sine must change samples, got ${changed}`);
  await assertVerifiedContent(audioId, "wav", audioSha, "audio output");
  // Same request identity again: replay, not a second registration.
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "Replayed (HTTP 200)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-output-id"), audioId);
  const audioPosts = apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/creative-outputs/audio-repairs");
  assert.equal(audioPosts.length, 2);
  assert.equal(JSON.parse(audioPosts[0].body).requestId, JSON.parse(audioPosts[1].body).requestId, "replay must reuse the request identity");

  // ---- REJECTED simulation, then the corrected run ----
  assert.match(await page.getByLabel("Simulated output label").textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  await page.getByRole("button", { name: /Load worked example/u }).click();
  await page.locator("#sim-invariant-expected-value").fill("7"); // the model's terminal position is 6, not 7
  expectedErrors.push({ pathname: "/dev/v1/creative-outputs/simulations", status: 422 });
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "SIMULATION_VALIDATION_REJECTED" }).waitFor({ timeout: 60_000 });
  const findings = await page.getByLabel("Validator findings").textContent();
  assert.match(findings, /terminal-position/u, "the validator finding must name the failed invariant");
  assert.equal(await page.locator("#creative-result[data-kind='SIMULATED_OUTPUT_NOT_MEASUREMENT']").count(), 0, "a REJECTED run must show no output");
  assert.equal(await result.getAttribute("data-output-id"), audioId, "the earlier audio result is untouched by the rejection");
  const rejectedFindings = findings.trim();

  await page.locator("#sim-invariant-expected-value").fill("6");
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "SIMULATED_OUTPUT_NOT_MEASUREMENT");
  assert.match(await result.textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  assert.equal(await ddOf(result.getByLabel("Simulation lineage"), "Validation disposition"), "VALID");
  const simId = await result.getAttribute("data-output-id");
  const simSha = await ddOf(result, "SHA-256");
  assert.equal(await ddOf(result, "Artifact version"), `sha256:${simSha}`);
  const simRows = await readSimulationTable("created simulation", simSha);
  assert.doesNotMatch(await result.textContent(), /no DEV_ONLY content route/u);

  // ---- Registered scientific PNG plot, read through the installed simulation client ----
  const scientificCreated = await createScientificSimulation();
  const scientificSimulationId = scientificCreated.simulationId;
  assert.equal(scientificCreated.lineage.scenarioSha256, scientificCreated.result.scenarioSha256,
    "the registered scientific result lineage must bind its exact scenario digest");
  const scientificSimulation = await simulationClient.getSimulation(scientificSimulationId);
  assert.equal(scientificSimulation.outcome, "COMPLETED");
  assert.equal(scientificSimulation.scope, "DEV_ONLY");
  assert.equal(scientificSimulation.lineage.productionEligible, false);
  const scientificResultSha = scientificSimulation.resultArtifact.sha256;
  const scientificScenarioSha = scientificSimulation.lineage.scenarioSha256;
  assert.equal(scientificSimulation.resultArtifact.artifactId, scientificSimulationId);
  assert.equal(scientificCreated.resultArtifact.sha256, scientificResultSha);
  assert.equal(scientificSimulation.lineage.requestId, scientificCreated.lineage.requestId);
  assert.equal(scientificSimulation.lineage.scenarioSha256, scientificCreated.lineage.scenarioSha256);
  const pngArtifact = scientificSimulation.plotArtifact;
  assert.ok(pngArtifact, "completed plot-enabled simulation must register a PNG artifact");
  const pngBytes = Buffer.from(await simulationClient.readPlotContent(scientificSimulation));
  const pngSha = sha256Of(pngBytes);
  assert.equal(pngArtifact.contentType, "image/png");
  assert.equal(pngArtifact.artifactVersionId, `sha256:${pngSha}`);
  assert.deepEqual(scientificSimulation.lineage.siblings.plot, {
    artifactId: pngArtifact.artifactId,
    artifactVersionId: pngArtifact.artifactVersionId,
    sha256: pngSha,
  });
  const pngDecode = await decodeBrowserImage(pngBytes, "image/png", 800, 400, "created scientific simulation plot");

  // ---- Spatial GLB from seeded source artifacts ----
  const projectLineage = await createSourceProjectRevision();
  const gifRender = await projectRenderClient.renderProject(projectLineage.projectId, {
    requestId: `m06-gif-${crypto.randomUUID()}`,
    revisionId: projectLineage.revisionId,
    timelineId: projectLineage.timelineId,
    width: 64,
    height: 64,
    framesPerSecond: 20,
    format: "gif",
  });
  assert.equal(gifRender.lineage.scope, "DEV_ONLY");
  assert.equal(gifRender.lineage.projectId, projectLineage.projectId);
  assert.equal(gifRender.lineage.revisionId, projectLineage.revisionId);
  assert.equal(gifRender.lineage.timelineId, projectLineage.timelineId);
  assert.equal(gifRender.lineage.format, "gif");
  assert.equal(gifRender.artifact.contentType, "image/gif");
  assert.deepEqual(gifRender.lineage.sources.map(({ artifactId, artifactVersionId }) => ({ artifactId, artifactVersionId })),
    projectLineage.sourceVersions, "GIF lineage must pin the same source artifact versions in the exact project revision");
  const gifBytes = Buffer.from(await projectRenderClient.readRenderContent(gifRender));
  const gifSha = sha256Of(gifBytes);
  assert.equal(gifRender.artifact.sha256, gifSha);
  assert.equal(gifRender.artifact.artifactVersionId, `sha256:${gifSha}`);
  const gifDecode = await decodeBrowserImage(gifBytes, "image/gif", 64, 64, "created project GIF render");
  await page.getByLabel("Rig JSON").fill(projectLineage.rigJson);
  await page.getByRole("button", { name: "Export GLB" }).click();
  await page.locator("#spatial-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "SPATIAL_GLB_EXPORT");
  const glbId = await result.getAttribute("data-output-id");
  const glbSha = await ddOf(result, "SHA-256");
  assert.match(await ddOf(result, "Content type and size"), /^model\/gltf-binary · \d+ bytes$/u);
  assert.match(await result.textContent(), /productionGrant=false/u);
  assert.match(await result.textContent(), /float32LossFields/u);
  const spatialPost = apiRequests.find(({ method, path }) =>
    method === "POST" && path === "/dev/v1/creative-outputs/spatial-glb");
  assert.ok(spatialPost, "the browser must register the GLB through the owner route");
  const submittedRig = JSON.parse(spatialPost.body).rig;
  assert.equal(submittedRig.sourceProjectRevisionRef, projectLineage.sourceProjectRevisionRef);
  assert.deepEqual(submittedRig.sourceVersions, projectLineage.sourceVersions);
  await assertVerifiedContent(glbId, "glb", glbSha, "spatial GLB");

  const installedClientBytes = new Map();
  const clientAudioBytes = await readWithInstalledClient(creativeOutputClient, audioId,
    "AUDIO_REPAIR_CANDIDATE", audioSha, "created audio", undefined, undefined,
    { artifactId: wavId, artifactVersionId: `sha256:${wavSha256}`, sha256: wavSha256 });
  installedClientBytes.set(audioId, clientAudioBytes);
  const wavDecode = await decodeBrowserWav(clientAudioBytes, "created repaired WAV");
  installedClientBytes.set(simId, await readWithInstalledClient(creativeOutputClient, simId,
    "SIMULATED_OUTPUT_NOT_MEASUREMENT", simSha, "created simulation"));
  const clientGlbBytes = await readWithInstalledClient(creativeOutputClient, glbId,
    "SPATIAL_GLB_EXPORT", glbSha, "created spatial GLB",
    projectLineage.sourceProjectRevisionRef, projectLineage.sourceVersions);
  installedClientBytes.set(glbId, clientGlbBytes);
  const glbValidation = await validateInstalledGlb(clientGlbBytes, glbSha, "created spatial GLB");
  installedClientBytes.set(pngArtifact.artifactId, pngBytes);
  installedClientBytes.set(gifRender.renderId, gifBytes);

  // Content reads never carry the token or the version in a URL and never use Range.
  assert.ok(contentRequests.length >= 3);
  for (const entry of contentRequests) {
    assert.ok(!entry.url.includes("?") && !entry.url.includes("Bearer") && !entry.url.includes(token), `token/version must not be in the URL: ${entry.url}`);
    assert.match(entry.headers["if-match"], /^sha256:[0-9a-f]{64}$/u);
    assert.equal(entry.headers.range, undefined);
  }

  process.stdout.write(`${JSON.stringify({ event: "created", audioId, audioSha, simId, simSha, scientificSimulationId,
    scientificResultSha, scientificScenarioSha,
    pngArtifactId: pngArtifact.artifactId, pngSha, pngDecode, gifId: gifRender.renderId, gifSha, gifDecode,
    wavDecode, glbId, glbSha, simRows, rejectedFindings, installedClient: true, glbValidation,
    projectId: projectLineage.projectId, projectRevisionId: projectLineage.revisionId,
    sourceProjectRevisionRef: projectLineage.sourceProjectRevisionRef })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let freshToken = null;
  for await (const line of input) {
    if (line.startsWith("host-restarted ")) { freshToken = line.slice("host-restarted ".length).trim(); break; }
  }
  input.close();
  assert.ok(freshToken, "the integration host must restart and issue a fresh token before readback");

  // ---- After the restart: a clean page reopens each output by id from the durable host ----
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await connect(freshToken, { retryStaticNetworkChange: true });
  await assertProjectRevisionReadback(projectLineage.projectId, projectLineage.revisionId,
    projectLineage.timelineId, projectLineage.sceneId, projectLineage.trackId, projectLineage.clips);
  assert.equal(await result.count(), 0, "a reloaded page must not claim an output it never read");
  async function reopenById(id, kind) {
    await page.getByLabel("Output ID").fill(id);
    await page.getByRole("button", { name: "Reopen output from the host" }).click();
    await page.locator("#reopen-status", { hasText: `Reopened output ${id}` }).waitFor({ timeout: 30_000 });
    assert.equal(await result.getAttribute("data-output-id"), id);
    assert.equal(await result.getAttribute("data-kind"), kind);
  }
  await reopenById(audioId, "AUDIO_REPAIR_CANDIDATE");
  assert.equal(await ddOf(result, "SHA-256"), audioSha);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source SHA-256"), wavSha256);
  await assertVerifiedContent(audioId, "wav", audioSha, "reopened audio output");
  assert.deepEqual(await readWithInstalledClient(creativeOutputClient, audioId,
    "AUDIO_REPAIR_CANDIDATE", audioSha, "restarted audio"), installedClientBytes.get(audioId));
  await reopenById(simId, "SIMULATED_OUTPUT_NOT_MEASUREMENT");
  assert.equal(await readSimulationTable("reopened simulation", simSha), simRows);
  assert.deepEqual(await readWithInstalledClient(creativeOutputClient, simId,
    "SIMULATED_OUTPUT_NOT_MEASUREMENT", simSha, "restarted simulation"), installedClientBytes.get(simId));
  const restartedScientific = await simulationClient.getSimulation(scientificSimulationId);
  assert.equal(restartedScientific.simulationId, scientificSimulationId);
  assert.equal(restartedScientific.resultArtifact.sha256, scientificResultSha);
  assert.equal(restartedScientific.plotArtifact.artifactId, pngArtifact.artifactId);
  assert.equal(restartedScientific.plotArtifact.artifactVersionId, pngArtifact.artifactVersionId);
  assert.equal(restartedScientific.lineage.scenarioSha256, scientificSimulation.lineage.scenarioSha256);
  assert.equal(restartedScientific.lineage.requestId, scientificSimulation.lineage.requestId);
  const restartedPngBytes = Buffer.from(await simulationClient.readPlotContent(restartedScientific));
  assert.deepEqual(restartedPngBytes, installedClientBytes.get(pngArtifact.artifactId),
    "installed client PNG readback after restart must preserve the exact source-bound plot bytes");
  const restartedPngDecode = await decodeBrowserImage(restartedPngBytes, "image/png", 800, 400, "restarted scientific simulation plot");
  assert.deepEqual(restartedPngDecode, pngDecode);
  const restartedGif = await projectRenderClient.getRender(projectLineage.projectId, gifRender.renderId);
  assert.equal(restartedGif.lineage.projectId, projectLineage.projectId);
  assert.equal(restartedGif.lineage.revisionId, projectLineage.revisionId);
  assert.equal(restartedGif.lineage.timelineId, projectLineage.timelineId);
  assert.deepEqual(restartedGif.lineage.sources.map(({ artifactId, artifactVersionId }) => ({ artifactId, artifactVersionId })),
    projectLineage.sourceVersions);
  const restartedGifBytes = Buffer.from(await projectRenderClient.readRenderContent(restartedGif));
  assert.deepEqual(restartedGifBytes, installedClientBytes.get(gifRender.renderId),
    "installed client GIF readback after restart must preserve the exact project-revision render bytes");
  const restartedGifDecode = await decodeBrowserImage(restartedGifBytes, "image/gif", 64, 64, "restarted project GIF render");
  assert.deepEqual(restartedGifDecode, gifDecode);
  await reopenById(glbId, "SPATIAL_GLB_EXPORT");
  assert.equal(await ddOf(result, "SHA-256"), glbSha);
  await assertVerifiedContent(glbId, "glb", glbSha, "reopened spatial GLB");
  const restartedGlbBytes = await readWithInstalledClient(creativeOutputClient, glbId,
    "SPATIAL_GLB_EXPORT", glbSha, "restarted spatial GLB",
    projectLineage.sourceProjectRevisionRef, projectLineage.sourceVersions);
  assert.deepEqual(restartedGlbBytes, installedClientBytes.get(glbId),
    "installed client readback after restart must preserve the exact GLB bytes");
  const restartedGlbValidation = await validateInstalledGlb(restartedGlbBytes, glbSha, "restarted spatial GLB");
  assert.deepEqual(restartedGlbValidation, glbValidation,
    "pinned validator result must remain stable across restart");

  // A plain (non-output) artifact id and an unknown id are typed 404s; each is tolerated only by its exact path.
  for (const unknown of [wavId, `missing-${crypto.randomUUID()}`]) {
    expectedErrors.push({ pathname: `/dev/v1/creative-outputs/${unknown}`, status: 404 });
    await page.getByLabel("Output ID").fill(unknown);
    await page.getByRole("button", { name: "Reopen output from the host" }).click();
    await page.locator("#reopen-status", { hasText: "CREATIVE_OUTPUT_NOT_FOUND" }).waitFor({ timeout: 30_000 });
  }
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "post-restart readback must not mutate");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !expectedErrors.some((expected) => expected.pathname === pathname && text.includes(`status of ${expected.status}`)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token) && !stored.includes(freshToken), "token must never be persisted");
  const restartedAudioBytes = await readWithInstalledClient(creativeOutputClient, audioId,
    "AUDIO_REPAIR_CANDIDATE", audioSha, "restarted audio", undefined, undefined,
    { artifactId: wavId, artifactVersionId: `sha256:${wavSha256}`, sha256: wavSha256 });
  assert.deepEqual(restartedAudioBytes, installedClientBytes.get(audioId));
  const restartedWavDecode = await decodeBrowserWav(restartedAudioBytes, "restarted repaired WAV");
  assert.deepEqual(restartedWavDecode, wavDecode);
  process.stdout.write(`${JSON.stringify({ event: "readback", audioId, simId, scientificSimulationId,
    scientificResultSha, scientificScenarioSha,
    pngArtifactId: pngArtifact.artifactId, pngSha, pngDecode: restartedPngDecode, gifId: gifRender.renderId, gifSha,
    gifDecode: restartedGifDecode, wavDecode: restartedWavDecode, glbId, audioSha, simSha, glbSha,
    installedClient: true, glbValidation: restartedGlbValidation, projectId: projectLineage.projectId,
    projectRevisionId: projectLineage.revisionId, sourceProjectRevisionRef: projectLineage.sourceProjectRevisionRef })}\n`);
} catch (error) {
  try {
    await writeFailureDiagnostics(error, `http://127.0.0.1:${vitePort}/dev-creative-outputs.html`);
  } catch (diagnosticError) {
    process.stderr.write(`Could not write browser failure diagnostics: ${redact(diagnosticError?.stack ?? diagnosticError)}\n`);
  }
  throw error;
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
