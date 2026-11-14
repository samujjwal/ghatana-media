import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const token = "bounded-dev-only-browser-fixture-token";
const context = {
  tenantId: "local-tenant",
  principalId: "local-owner",
  selectedAuthorizedWorkspaceId: "local-owner-workspace",
  workspaceName: "Local owner workspace",
  authority: "DEV_ONLY_LOCAL_FIXTURE",
  capabilities: { artifactUpload: false, artifactRead: true },
  scope: "DEV_ONLY",
};
// A real 1x1 GIF so Chromium decodes the verified preview; its SHA-256 is what the fixture registers.
const RENDER_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const RENDER_SHA = createHash("sha256").update(RENDER_BYTES).digest("hex");
const fixture = {
  contentRequests: [],
  corruptContent: false,
  requests: [],
  projectRequests: [],
  timelineRequests: [],
  graphEditRequests: [],
  restoreRequests: [],
  projectPostAttempts: 0,
  failNextInitialRevisionRead: false,
  timelinePostAttempts: 0,
  graphEditPostAttempts: 0,
  restorePostAttempts: 0,
  projectReadAttempts: 0,
  projectReadHeads: [],
  artifactReadRequests: [],
  loseNextClipResponse: false,
  exportRequests: [],
  exportReads: 0,
  project: null,
  revision: null,
  revisions: new Map(),
};

const apiServer = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    fixture.requests.push(`${request.method} ${path}`);
    if (request.headers.authorization !== `Bearer ${token}`) {
      return respond(response, 401, { error: { code: "TOKEN_INVALID", message: "Fixture token required." } });
    }
    const body = await readBody(request);
    if (request.method === "GET" && path === "/dev/v1/context") return respond(response, 200, context);
    const artifactMatch = path.match(/^\/api\/v1\/artifacts\/([0-9a-f-]{36})$/iu);
    if (request.method === "GET" && artifactMatch) {
      const artifactId = decodeURIComponent(artifactMatch[1]);
      fixture.artifactReadRequests.push({ method: request.method, path, artifactId });
      if (artifactId !== "00000000-0000-4000-8000-000000000001") {
        return respond(response, 404, { error: { code: "ARTIFACT_NOT_FOUND", message: "Fixture owner artifact not found." } });
      }
      return respond(response, 200, {
        tenantId: context.tenantId,
        principalId: context.principalId,
        artifactId,
        fileName: "fixture-source.mov",
        contentType: "video/quicktime",
        sha256: "a".repeat(64),
      });
    }
    if (request.method === "POST" && path === "/dev/v1/projects") {
      fixture.projectRequests.push(JSON.parse(body));
      fixture.projectPostAttempts += 1;
      if (fixture.projectPostAttempts === 1) return request.socket.destroy();
      const payload = JSON.parse(body);
      if (fixture.project) {
        const original = fixture.projectRequests[0];
        if (JSON.stringify(original) !== JSON.stringify(payload)) {
          return respond(response, 409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "Project replay payload changed." } });
        }
        return respond(response, 200, { scope: "DEV_ONLY", createdNow: false, project: fixture.project, initialRevision: fixture.revision });
      }
      fixture.project = {
        tenantId: context.tenantId,
        projectId: "local-project-1",
        workspaceId: payload.selectedAuthorizedWorkspaceId,
        ownerPrincipalId: context.principalId,
        title: payload.title,
        headRevisionId: "revision-1",
      };
      fixture.revision = {
        tenantId: context.tenantId,
        projectId: fixture.project.projectId,
        revisionId: "revision-1",
        parentRevisionId: null,
        timelines: [],
      };
      fixture.revisions.set(fixture.revision.revisionId, fixture.revision);
      fixture.failNextInitialRevisionRead = true;
      return respond(response, 200, { scope: "DEV_ONLY", createdNow: true, project: fixture.project, initialRevision: fixture.revision });
    }
    if (request.method === "GET" && path === `/dev/v1/projects/${fixture.project?.projectId}`) {
      fixture.projectReadAttempts += 1;
      // Fail the first reconciliation read after a lost timeline POST so the
      // mounted workspace must keep UNKNOWN and expose another safe read.
      if (fixture.timelinePostAttempts === 1 && fixture.projectReadAttempts === 1) {
        return respond(response, 503, { error: { code: "FIXTURE_READ_UNAVAILABLE", message: "Temporary fixture read failure." } });
      }
      fixture.projectReadHeads.push({
        projectId: fixture.project.projectId,
        projectHeadRevisionId: fixture.project.headRevisionId,
        currentRevisionId: fixture.revision.revisionId,
      });
      return respond(response, 200, { scope: "DEV_ONLY", project: fixture.project, currentRevision: fixture.revision });
    }
    if (request.method === "POST" && path === `/dev/v1/projects/${fixture.project?.projectId}/timelines`) {
      fixture.timelineRequests.push(JSON.parse(body));
      fixture.timelinePostAttempts += 1;
      if (fixture.timelinePostAttempts === 1) return request.socket.destroy();
      const payload = JSON.parse(body);
      const revisionId = nextRevisionId();
      const timeline = {
        semanticVersionId: "semantic-v1",
        graph: { timelineId: payload.timelineId, scenes: [], tracks: [], clips: [] },
      };
      fixture.revision = {
        tenantId: context.tenantId,
        projectId: fixture.project.projectId,
        revisionId,
        parentRevisionId: payload.expectedHeadRevisionId,
        timelines: [...fixture.revision.timelines, timeline],
      };
      fixture.project = { ...fixture.project, headRevisionId: revisionId };
      fixture.revisions.set(revisionId, fixture.revision);
      if (fixture.timelinePostAttempts === 3) return request.socket.destroy();
      return respond(response, 200, { scope: "DEV_ONLY", revision: fixture.revision });
    }
    const graphEditMatch = path.match(/^\/dev\/v1\/projects\/([^/]+)\/timelines\/([^/]+)\/edits$/u);
    if (request.method === "POST" && graphEditMatch) {
      const payload = JSON.parse(body);
      fixture.graphEditRequests.push({ timelineId: decodeURIComponent(graphEditMatch[2]), ...payload });
      fixture.graphEditPostAttempts += 1;
      const timelineId = decodeURIComponent(graphEditMatch[2]);
      if (payload.expectedHeadRevisionId !== fixture.project.headRevisionId) {
        return respond(response, 409, { error: { code: "REVISION_CONFLICT", message: "Project head changed." } });
      }
      const selected = fixture.revision.timelines.find((snapshot) => snapshot.graph.timelineId === timelineId);
      if (!selected) return respond(response, 404, { error: { code: "TIMELINE_NOT_FOUND", message: "Fixture timeline not found." } });
      let graph = selected.graph;
      for (const edit of payload.edits) {
        if (edit.type === "addScene") graph = { ...graph, scenes: [...graph.scenes, { sceneId: edit.sceneId, order: edit.order }] };
        else if (edit.type === "addTrack") graph = { ...graph, tracks: [...graph.tracks, {
          trackId: edit.trackId, sceneId: edit.sceneId, kind: edit.trackKind, order: edit.order,
        }] };
        else if (edit.type === "removeScene") {
          if (graph.tracks.some((track) => track.sceneId === edit.sceneId)) {
            return respond(response, 400, { error: { code: "INVALID_REQUEST", message: "Scene still owns tracks." } });
          }
          graph = { ...graph, scenes: graph.scenes.filter((scene) => scene.sceneId !== edit.sceneId) };
        } else if (edit.type === "removeTrack") {
          if (graph.clips.some((clip) => clip.trackId === edit.trackId)) {
            return respond(response, 400, { error: { code: "INVALID_REQUEST", message: "Track still owns clips." } });
          }
          graph = { ...graph, tracks: graph.tracks.filter((track) => track.trackId !== edit.trackId) };
        } else if (edit.type === "putClip") {
          const clips = graph.clips.filter((clip) => clip.clipId !== edit.clip.clipId);
          graph = { ...graph, clips: [...clips, edit.clip] };
        } else if (edit.type === "removeClip") {
          graph = { ...graph, clips: graph.clips.filter((clip) => clip.clipId !== edit.clipId) };
        } else throw new Error(`fixture does not implement ${edit.type}`);
      }
      const timelines = fixture.revision.timelines.map((snapshot) => snapshot.graph.timelineId === timelineId
        ? { semanticVersionId: `semantic-${fixture.graphEditPostAttempts + 1}`, graph }
        : snapshot);
      const revisionId = nextRevisionId();
      fixture.revision = {
        tenantId: context.tenantId,
        projectId: fixture.project.projectId,
        revisionId,
        parentRevisionId: payload.expectedHeadRevisionId,
        timelines,
      };
      fixture.project = { ...fixture.project, headRevisionId: revisionId };
      fixture.revisions.set(revisionId, fixture.revision);
      if (fixture.loseNextClipResponse && payload.edits.some((edit) => edit.type === "removeClip")) {
        fixture.loseNextClipResponse = false;
        return request.socket.destroy();
      }
      if (fixture.graphEditPostAttempts === 1) {
        return respond(response, 503, { error: { code: "FIXTURE_AFTER_COMMIT", message: "The response failed after the edit committed." } });
      }
      if (fixture.graphEditPostAttempts === 2) {
        response.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end("{");
        return;
      }
      return respond(response, 201, { scope: "DEV_ONLY", revision: fixture.revision });
    }
    const restoreMatch = path.match(/^\/dev\/v1\/projects\/([^/]+)\/restore$/u);
    if (request.method === "POST" && restoreMatch) {
      const payload = JSON.parse(body);
      fixture.restoreRequests.push(payload);
      if (payload.expectedHeadRevisionId !== fixture.project.headRevisionId) {
        return respond(response, 409, { error: { code: "REVISION_CONFLICT", message: "Project head changed." } });
      }
      const target = fixture.revisions.get(payload.targetRevisionId);
      if (!target || target.projectId !== fixture.project.projectId) {
        return respond(response, 404, { error: { code: "REVISION_NOT_FOUND", message: "Fixture revision not found." } });
      }
      fixture.restorePostAttempts += 1;
      const revisionId = nextRevisionId();
      fixture.revision = {
        tenantId: context.tenantId,
        projectId: fixture.project.projectId,
        revisionId,
        parentRevisionId: payload.expectedHeadRevisionId,
        timelines: target.timelines.map((snapshot) => ({
          semanticVersionId: `semantic-restore-${fixture.restorePostAttempts}`,
          graph: snapshot.graph,
        })),
      };
      fixture.project = { ...fixture.project, headRevisionId: revisionId };
      fixture.revisions.set(revisionId, fixture.revision);
      if (fixture.restorePostAttempts === 1) {
        response.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end("{");
        return;
      }
      return respond(response, 201, { scope: "DEV_ONLY", revision: fixture.revision });
    }
    const revisionMatch = path.match(/^\/dev\/v1\/projects\/([^/]+)\/revisions\/([^/]+)$/u);
    if (request.method === "GET" && revisionMatch) {
      const revisionId = decodeURIComponent(revisionMatch[2]);
      if (fixture.failNextInitialRevisionRead && revisionId === "revision-1") {
        fixture.failNextInitialRevisionRead = false;
        return respond(response, 503, { error: { code: "FIXTURE_READ_UNAVAILABLE", message: "Temporary initial-revision read failure." } });
      }
      const revision = fixture.revisions.get(revisionId);
      if (!revision) {
        return respond(response, 404, { error: { code: "REVISION_NOT_FOUND", message: "Fixture revision not found." } });
      }
      return respond(response, 200, { scope: "DEV_ONLY", revision });
    }
    const renderMatch = path.match(/^\/dev\/v1\/projects\/([^/]+)\/renders\/([^/]+)$/u);
    if (request.method === "GET" && renderMatch) {
      if (renderMatch[1] !== fixture.project?.projectId || renderMatch[2] !== "render-1") {
        return respond(response, 404, { error: { code: "RENDER_NOT_FOUND", message: "Fixture render not found." } });
      }
      return respond(response, 200, {
        renderId: "render-1", replayed: true, scope: "DEV_ONLY",
        artifact: { artifactId: "render-1", artifactVersionId: `sha256:${RENDER_SHA}`, contentType: "image/gif", sizeBytes: RENDER_BYTES.length, sha256: RENDER_SHA },
        lineage: { projectId: fixture.project.projectId, revisionId: "revision-1", timelineId: "main-cut", engine: "fixture-gif", format: "gif", frameCount: 3,
          sources: [{ clipId: "clip-1", trackId: "track-1", artifactId: "src-1", artifactVersionId: `sha256:${"a".repeat(64)}` }] },
      });
    }
    const contentMatch = path.match(/^\/dev\/v1\/artifacts\/([^/]+)\/content$/u);
    if (request.method === "GET" && contentMatch) {
      fixture.contentRequests.push({ url: request.url, ifMatch: request.headers["if-match"], range: request.headers.range, authorization: request.headers.authorization });
      if (contentMatch[1] !== "render-1") return respond(response, 404, { error: { code: "ARTIFACT_NOT_FOUND", message: "Fixture artifact not found." } });
      if (request.headers["if-match"] !== `sha256:${RENDER_SHA}`) return respond(response, 412, { error: { code: "ARTIFACT_VERSION_MISMATCH", message: "Fixture version mismatch." } });
      const payload = fixture.corruptContent ? Buffer.from(RENDER_BYTES).fill(0, 20) : RENDER_BYTES;
      response.writeHead(200, { "Content-Type": "image/gif", "Content-Length": payload.length, ETag: `sha256:${RENDER_SHA}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      return response.end(payload);
    }
    if (request.method === "POST" && path === "/dev/v1/exports") {
      const payload = JSON.parse(body);
      fixture.exportRequests.push(payload);
      if (payload.destinationId === "missing-destination") {
        return respond(response, 404, { error: { code: "DESTINATION_NOT_FOUND", message: "Fixture destination not configured." } });
      }
      return respond(response, 202, { ...exportView(payload), status: "OUTCOME_UNKNOWN", destinationConfirmed: false, destinationReceiptRef: null, acknowledgedBytes: 0, replayed: false });
    }
    const exportMatch = path.match(/^\/dev\/v1\/exports\/([^/]+)$/u);
    if (request.method === "GET" && exportMatch) {
      fixture.exportReads += 1;
      const original = fixture.exportRequests.find((entry) => entry.requestId === decodeURIComponent(exportMatch[1]));
      if (!original) return respond(response, 404, { error: { code: "EXPORT_NOT_FOUND", message: "Fixture export not found." } });
      return respond(response, 200, { ...exportView(original), replayed: true });
    }
    return respond(response, 404, { error: { code: "ROUTE_NOT_FOUND", message: "Unknown bounded fixture route." } });
  } catch (error) {
    if (!response.destroyed) respond(response, 500, { error: { code: "FIXTURE_ERROR", message: String(error) } });
  }
});

function exportView(payload) {
  return {
    requestId: payload.requestId, artifactId: payload.artifactId, artifactVersionId: payload.artifactVersionId, artifactDigest: RENDER_SHA,
    destinationId: payload.destinationId, status: "DESTINATION_CONFIRMED", acknowledgedBytes: RENDER_BYTES.length, destinationConfirmed: true,
    destinationReceiptRef: "dev-local-directory-receipt:fixture", replayed: false, scope: "DEV_ONLY",
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let content = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { content += chunk; });
    request.on("end", () => resolve(content));
    request.on("error", reject);
  });
}

function respond(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function nextRevisionId() {
  const currentNumber = Number(fixture.project?.headRevisionId?.replace(/^revision-/u, ""));
  if (!Number.isSafeInteger(currentNumber) || currentNumber < 1) throw new Error("Fixture project head must have a numeric revision ID.");
  return `revision-${currentNumber + 1}`;
}

function timelineGraph(revision, timelineId) {
  const snapshot = revision.timelines.find((candidate) => candidate.graph.timelineId === timelineId);
  assert.ok(snapshot, `timeline ${timelineId} must exist in revision ${revision.revisionId}`);
  return snapshot.graph;
}

async function focusByKeyboard(page, target) {
  const count = await target.evaluate((targetElement) => {
    const focusable = [...document.querySelectorAll(
      'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
    )].filter((item) => item.getClientRects().length > 0);
    const tabStops = new Set(focusable.filter((item) => item.type !== "radio"));
    const radioGroups = new Map();
    for (const radio of focusable.filter((item) => item.type === "radio")) {
      const groupKey = `${radio.form?.id ?? ""}:${radio.name}`;
      const group = radioGroups.get(groupKey) ?? [];
      group.push(radio);
      radioGroups.set(groupKey, group);
    }
    for (const group of radioGroups.values()) tabStops.add(group.find((radio) => radio.checked) ?? group[0]);
    return { count: tabStops.size, targetIsTabStop: tabStops.has(targetElement) };
  });
  assert.ok(count.count > 0, "the page must expose keyboard-focusable controls");
  if (!count.targetIsTabStop) throw new Error("Use keyboardChooseRadio for an unchecked radio outside the Tab stop of its group.");
  for (let step = 0; step < count.count * 2 + 4; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  assert.equal(await target.evaluate((element) => element === document.activeElement), true,
    `Tab navigation must reach the requested control without pointer focus; target=${await target.evaluate((element) => element.id || element.textContent)} active=${await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.id || document.activeElement.textContent : "unknown"))}`);
}

async function keyboardFill(page, target, value) {
  await focusByKeyboard(page, target);
  await page.keyboard.press((await page.evaluate(() => navigator.platform)).includes("Mac") ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(value);
  assert.equal(await target.inputValue(), value, "keyboard text entry must replace the current field value");
}

async function keyboardActivate(page, target) {
  await focusByKeyboard(page, target);
  await page.keyboard.press("Enter");
}

async function keyboardChooseRadio(page, group, target) {
  const positions = await group.evaluate((container, selected) => {
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    return { target: radios.indexOf(selected), current: radios.findIndex((radio) => radio.checked) };
  }, await target.elementHandle());
  assert.ok(positions.target >= 0, "radio choice must belong to its labeled group");
  const startingIndex = positions.current >= 0 ? positions.current : 0;
  const current = group.locator('input[type="radio"]').nth(startingIndex);
  await focusByKeyboard(page, current);
  const delta = positions.target - startingIndex;
  if (delta !== 0) {
    const key = delta < 0 ? "ArrowUp" : "ArrowDown";
    for (let step = 0; step < Math.abs(delta); step += 1) await page.keyboard.press(key);
  } else if (positions.current < 0) await page.keyboard.press("Space");
  assert.equal(await target.isChecked(), true, "Space must select the keyboard-focused radio choice");
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const apiPort = await listen(apiServer);
const vitePort = await unusedPort();
const viteBinary = process.env.MEDIA_DEV_VITE_BINARY;
const viteCommand = viteBinary ? process.execPath : "vite";
const viteArgs = viteBinary
  ? [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)]
  : ["--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)];
const viteProcess = spawn(viteCommand, viteArgs, {
  cwd: appRoot,
  env: { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(apiPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-project-timeline.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the local route:\n${viteOutput}`);
  const proxyProbe = await fetch(`${baseUrl}/dev/v1/context`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(proxyProbe.status, 200, `loopback Vite proxy did not reach fixture API; requests=${JSON.stringify(fixture.requests)}; vite=${viteOutput}`);
  fixture.requests.length = 0;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const inputAudit = { pointerDowns: 0, pointerClicks: 0 };
    Object.defineProperty(window, "__timelineBrowserInputAudit", { value: inputAudit });
    document.addEventListener("pointerdown", () => { inputAudit.pointerDowns += 1; }, true);
    document.addEventListener("click", (event) => {
      if (event.detail > 0) inputAudit.pointerClicks += 1;
    }, true);
  });
  const pageErrors = [];
  const networkFailures = [];
  const networkRequests = [];
  const networkResponses = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => networkFailures.push(`${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("request", (request) => { if (request.url().includes("/dev/v1")) networkRequests.push(request.url()); });
  page.on("response", (response) => { if (response.url().includes("/dev/v1")) networkResponses.push(`${response.status()} ${response.url()}`); });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${baseUrl}/dev-project-timeline.html`);
  assert.equal(await page.getByRole("main").count(), 1, "the mounted workspace must not create a nested main landmark");
  await keyboardFill(page, page.getByLabel("Short-lived DEV_ONLY bearer token"), token);
  await keyboardActivate(page, page.getByRole("button", { name: "Read host context" }));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await page.locator("#status").textContent())?.includes("Connected to the local host")) break;
    await delay(100);
  }
  assert.match(await page.locator("#status").textContent(), /Connected to the local host/u,
    `context read did not connect; status=${await page.locator("#status").textContent()}; fixture requests=${JSON.stringify(fixture.requests)}; network=${JSON.stringify(networkRequests)} / ${JSON.stringify(networkResponses)} / ${JSON.stringify(networkFailures)}; console=${JSON.stringify(consoleErrors)}; page=${JSON.stringify(pageErrors)}; vite=${viteOutput}`);
  // A reviewer can open the owner's case by id without any project; the panel yields to the workspace once a project opens.
  await page.getByRole("heading", { name: "Review a case as an assigned reviewer" }).waitFor();
  assert.equal(await page.locator("#reviewer-panel #known-review-id").count(), 1, "connected page must offer a known review case id");
  assert.equal(await page.getByRole("button", { name: "Open review case" }).count(), 0, "the reviewer view must not open cases on a project");
  await page.getByText("local-owner-workspace").waitFor();
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after context read");

  await keyboardFill(page, page.getByLabel("Project title"), "   ");
  await keyboardActivate(page, page.getByRole("button", { name: "Create project", exact: true }));
  await page.getByText("Project title must contain a non-whitespace character.").waitFor();
  assert.equal(fixture.projectPostAttempts, 0);
  await keyboardFill(page, page.getByLabel("Project title"), `${"🎞".repeat(201)}`);
  await keyboardActivate(page, page.getByRole("button", { name: "Create project", exact: true }));
  await page.getByText("Project title must be at most 200 Unicode code points.").waitFor();
  assert.equal(fixture.projectPostAttempts, 0);

  const submittedTitle = "  Browser fixture project 🎞  ";
  await keyboardFill(page, page.getByLabel("Project title"), submittedTitle);
  await keyboardActivate(page, page.getByRole("button", { name: "Create project", exact: true }));
  await page.getByRole("button", { name: "Replay same create request" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Replay same create request" }).waitFor({ state: "attached" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await page.locator("#status").textContent())?.includes("OUTCOME_UNKNOWN")) break;
    await delay(100);
  }
  assert.match(await page.locator("#status").textContent(), /OUTCOME_UNKNOWN/u,
    `project create did not enter replayable unknown state; status=${await page.locator("#status").textContent()}; requests=${JSON.stringify(fixture.requests)}; bodies=${JSON.stringify(fixture.projectRequests)}; network=${JSON.stringify(networkRequests)} / ${JSON.stringify(networkResponses)} / ${JSON.stringify(networkFailures)}; vite=${viteOutput}`);
  assert.equal(await page.getByRole("button", { name: "Create project", exact: true }).isEnabled(), false,
    "a new create must be blocked while the exact project create outcome is unresolved");
  assert.equal(await page.getByRole("button", { name: "Replay same create request" }).isEnabled(), true, "unknown project create must expose its same-request replay");
  assert.equal(await page.locator("#status").getAttribute("aria-live"), "polite", "project outcome status must be announced");
  await keyboardActivate(page, page.getByRole("button", { name: "Replay same create request" }));
  await page.getByText(/Project creation was acknowledged, but its exact initial revision could not be reopened\. Replay the same request to reconcile it\./u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create project", exact: true }).isEnabled(), false,
    "an acknowledged create without exact initial-revision readback must not unlock a new request");
  assert.equal(await page.getByRole("button", { name: "Replay same create request" }).isEnabled(), true,
    "an acknowledged create without readback must remain recoverable by the exact same request");
  assert.equal(fixture.projectRequests.length, 2);
  assert.deepEqual(fixture.projectRequests[1], fixture.projectRequests[0]);
  await keyboardActivate(page, page.getByRole("button", { name: "Replay same create request" }));
  await page.getByText(/exact initial revision revision-1 reopened/u).waitFor();
  await page.getByRole("heading", { name: "Render and review · DEV_ONLY" }).waitFor();
  assert.equal(await page.locator("#reviewer-panel").isHidden(), true, "the standalone reviewer panel must not duplicate the workspace review section");
  assert.match(await page.getByRole("note", { name: "Review approval disclaimer" }).textContent(), /DEV_ONLY ACCEPT is not human approval/u,
    "the DEV_ONLY workspace must always disclose that a DEV_ONLY review is not human approval");
  assert.equal(await page.getByRole("button", { name: "Render exact revision" }).isEnabled(), false,
    "rendering must stay disabled until the exact revision has a timeline and clips");
  assert.match(await page.locator("#render-blocked").textContent(), /Select a timeline to render/u);
  assert.equal(await page.locator("#render-status").getAttribute("aria-live"), "polite", "render status must be a polite live region");
  assert.equal(await page.locator("#review-status").getAttribute("aria-live"), "polite", "review status must be a polite live region");
  assert.equal(fixture.requests.some((entry) => /\/renders|\/reviews/u.test(String(entry))), false,
    "no render or review request may be sent without a user action on an exact revision with clips");
  assert.equal(fixture.projectRequests.length, 3);
  assert.deepEqual(fixture.projectRequests[1], fixture.projectRequests[0], "replay must reuse exactly the original request payload and requestId");
  assert.deepEqual(fixture.projectRequests[2], fixture.projectRequests[0], "readback reconciliation must preserve the original request payload and requestId");
  assert.equal(fixture.projectRequests[0].title, submittedTitle, "the original Unicode title and whitespace must be preserved");

  await keyboardFill(page, page.getByLabel("Timeline ID"), "main-cut");
  await keyboardActivate(page, page.getByRole("button", { name: "Create timeline", exact: true }));
  await page.getByText(/OUTCOME_UNKNOWN: the owner head could not confirm timeline main-cut/u).waitFor();
  assert.equal(await page.locator("#workspace-status").getAttribute("role"), "status");
  assert.equal(await page.locator("#workspace-status").getAttribute("aria-live"), "polite");
  assert.equal(await page.getByRole("button", { name: "Create timeline", exact: true }).isEnabled(), false, "unresolved timeline mutation must block another write");
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(/The current project head is still unavailable/u).waitFor();
  assert.ok(networkResponses.some((entry) => entry.startsWith("503 ") && entry.includes("/dev/v1/projects/local-project-1")),
    "the structured backend read failure should pass through the Vite proxy unchanged");
  assert.equal(await page.getByRole("button", { name: "Retry after absence confirmed" }).count(), 0,
    "unavailable readback must not permit retry");
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(/A retry with this same ID is now available/u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry after absence confirmed" }).isEnabled(), true);
  assert.equal(await page.locator("#timeline-id").inputValue(), "main-cut");

  await keyboardActivate(page, page.getByRole("button", { name: "Retry after absence confirmed" }));
  await page.getByText(/Created empty timeline main-cut; exact revision revision-2 reopened/u).waitFor();
  assert.equal(fixture.timelineRequests.length, 2, "one initial unknown write and one user-requested retry should be sent");
  assert.equal(fixture.timelineRequests[1].timelineId, fixture.timelineRequests[0].timelineId);
  assert.match(await page.locator("#readback-json").textContent(), /"revisionId": "revision-2"/u);
  assert.match(await page.locator("#readback-json").textContent(), /"timelineId": "main-cut"/u);

  await keyboardFill(page, page.getByLabel("Timeline ID"), "committed-with-lost-response");
  await keyboardActivate(page, page.getByRole("button", { name: "Create timeline", exact: true }));
  await page.getByText(/OUTCOME_UNKNOWN: the owner head could not confirm timeline committed-with-lost-response/u).waitFor();
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const currentStatus = await page.locator("#workspace-status").textContent();
    if (currentStatus?.includes("Timeline outcome reconciled:") || currentStatus?.includes("OUTCOME_UNKNOWN:")) break;
    await delay(100);
  }
  assert.match(await page.locator("#workspace-status").textContent(), /Timeline outcome reconciled: committed-with-lost-response is present/u,
    `committed unknown timeline was not reconciled; status=${await page.locator("#workspace-status").textContent()}; timelineRequests=${JSON.stringify(fixture.timelineRequests)}; project=${JSON.stringify(fixture.project)}; revision=${JSON.stringify(fixture.revision)}; net=${JSON.stringify(networkRequests)} / ${JSON.stringify(networkResponses)}; vite=${viteOutput}`);
  assert.equal(fixture.timelinePostAttempts, 3, "a committed but lost timeline response must be reconciled without another POST");
  assert.match(await page.locator("#readback-json").textContent(), /"revisionId": "revision-3"/u);
  assert.match(await page.locator("#readback-json").textContent(), /"timelineId": "committed-with-lost-response"/u);

  const sceneId = "fixture-scene";
  await keyboardFill(page, page.getByLabel("New scene ID"), sceneId);
  await keyboardActivate(page, page.getByRole("button", { name: "Add scene", exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(/Graph edit outcome reconciled: addScene is present in owner head revision-4/u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 1, "a committed but lost graph-edit response must not be retried");
  assert.deepEqual(fixture.revision.timelines.find((value) => value.graph.timelineId === "committed-with-lost-response")
    .graph.scenes, [{ sceneId, order: 0 }]);

  await keyboardFill(page, page.getByLabel("New track ID"), "fixture-track");
  await keyboardChooseRadio(page, page.getByRole("group", { name: "Parent scene ID" }), page.getByRole("group", { name: "Parent scene ID" }).getByRole("radio", { name: sceneId, exact: true }));
  await focusByKeyboard(page, page.getByRole("group", { name: "Track kind" }).getByRole("radio", { name: "Video", exact: true }));
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("group", { name: "Track kind" }).getByRole("radio", { name: "Audio", exact: true }).isChecked(), true,
    "arrow navigation must change the selected track kind");
  assert.equal(await page.getByRole("button", { name: "Add track" }).isEnabled(), true, "track action must become available after valid keyboard entry");
  await keyboardActivate(page, page.getByRole("button", { name: "Add track", exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(/Graph edit outcome reconciled: addTrack is present in owner head revision-5/u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 2);
  assert.deepEqual(fixture.revision.timelines.find((value) => value.graph.timelineId === "committed-with-lost-response")
    .graph.tracks, [{ trackId: "fixture-track", sceneId, kind: "AUDIO", order: 0 }]);

  const sceneRevisionId = "revision-4";
  const trackRevisionId = fixture.revision.revisionId;
  assert.equal(await page.getByRole("button", { name: "Restore as new project head" }).isEnabled(), false,
    "a revision must be read exactly before it can be restored");
  await keyboardFill(page, page.getByLabel("Exact revision ID"), sceneRevisionId);
  await keyboardActivate(page, page.getByRole("button", { name: "Read exact revision" }));
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${sceneRevisionId} from project local-project-1\\.`) }).waitFor();
  await keyboardActivate(page, page.getByRole("button", { name: "Compare with displayed revision" }));
  await page.getByRole("heading", { name: "Exact revision comparison" }).waitFor();
  assert.match(await page.getByRole("list", { name: "Timeline graph changes" }).textContent(), /added track.*fixture-track/u,
    "the exact revision comparison must report stored graph changes");
  assert.equal(fixture.project.headRevisionId, trackRevisionId, "comparison must not change the owner head");
  assert.equal(fixture.graphEditPostAttempts, 2, "comparison must not submit a graph edit");
  assert.equal(await page.getByRole("button", { name: "Restore as new project head" }).isEnabled(), true);
  await keyboardActivate(page, page.getByRole("button", { name: "Restore as new project head" }));
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(/Restore outcome reconciled: owner head revision-6 has the exact graph state from revision-4/u).waitFor();
  assert.equal(fixture.restorePostAttempts, 1, "malformed restore response must reconcile without a duplicate POST");
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").tracks, [], "undo must remove the track in the new head");
  assert.deepEqual(timelineGraph(fixture.revisions.get(trackRevisionId), "committed-with-lost-response").tracks,
    [{ trackId: "fixture-track", sceneId, kind: "AUDIO", order: 0 }], "the original track revision remains immutable");

  await keyboardFill(page, page.getByLabel("Exact revision ID"), trackRevisionId);
  await keyboardActivate(page, page.getByRole("button", { name: "Read exact revision" }));
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${trackRevisionId} from project local-project-1\\.`) }).waitFor();
  await keyboardActivate(page, page.getByRole("button", { name: "Restore as new project head" }));
  await page.getByText(/Restored exact graph state from revision-5 as new head revision-7/u).waitFor();
  assert.equal(fixture.restorePostAttempts, 2);
  assert.equal(fixture.revision.parentRevisionId, "revision-6");
  const headBeforeRemoval = fixture.project.headRevisionId;
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").tracks,
    [{ trackId: "fixture-track", sceneId, kind: "AUDIO", order: 0 }], "redo must reapply the exact graph in a new head");
  assert.deepEqual(timelineGraph(fixture.revisions.get(sceneRevisionId), "committed-with-lost-response").tracks, []);
  assert.deepEqual(timelineGraph(fixture.revisions.get(trackRevisionId), "committed-with-lost-response").tracks,
    [{ trackId: "fixture-track", sceneId, kind: "AUDIO", order: 0 }]);

  await keyboardChooseRadio(page, page.getByRole("group", { name: "Scene ID to remove" }), page.getByRole("group", { name: "Scene ID to remove" }).getByRole("radio", { name: sceneId, exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Remove scene" }));
  await page.getByText(/Scene ID fixture-scene still owns tracks\. Remove its tracks before removing the scene; no mutation was sent\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 2, "a scene with a remaining track must be rejected before the edit POST");
  assert.equal(fixture.project.headRevisionId, headBeforeRemoval, "preflight rejection must preserve the exact owner head");

  await keyboardChooseRadio(page, page.getByRole("group", { name: "Track ID to remove" }), page.getByRole("group", { name: "Track ID to remove" }).getByRole("radio", { name: "fixture-track", exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Remove track" }));
  await page.getByText(/Committed and reopened removeTrack in revision revision-8\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 3);
  const removedTrackRevisionId = fixture.revision.revisionId;
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").scenes, [{ sceneId, order: 0 }]);
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").tracks, []);

  await keyboardChooseRadio(page, page.getByRole("group", { name: "Scene ID to remove" }), page.getByRole("group", { name: "Scene ID to remove" }).getByRole("radio", { name: sceneId, exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Remove scene" }));
  await page.getByText(/Committed and reopened removeScene in revision revision-9\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 4);
  const removedSceneRevisionId = fixture.revision.revisionId;
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").scenes, []);
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").tracks, []);

  await keyboardFill(page, page.getByLabel("Exact revision ID"), trackRevisionId);
  await keyboardActivate(page, page.getByRole("button", { name: "Read exact revision" }));
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${trackRevisionId} from project local-project-1\\.`) }).waitFor();
  await keyboardActivate(page, page.getByRole("button", { name: "Restore as new project head" }));
  await page.getByText(/Restored exact graph state from revision-5 as new head revision-10; prior revisions remain available\./u).waitFor();
  assert.equal(fixture.restorePostAttempts, 3);
  const removalUndoRevisionId = fixture.revision.revisionId;
  assert.equal(fixture.revision.parentRevisionId, removedSceneRevisionId);
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").tracks,
    [{ trackId: "fixture-track", sceneId, kind: "AUDIO", order: 0 }]);

  await keyboardFill(page, page.getByLabel("Exact revision ID"), removedSceneRevisionId);
  await keyboardActivate(page, page.getByRole("button", { name: "Read exact revision" }));
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${removedSceneRevisionId} from project local-project-1\\.`) }).waitFor();
  await keyboardActivate(page, page.getByRole("button", { name: "Restore as new project head" }));
  await page.getByText(/Restored exact graph state from revision-9 as new head revision-11; prior revisions remain available\./u).waitFor();
  assert.equal(fixture.restorePostAttempts, 4);
  assert.equal(fixture.revision.parentRevisionId, removalUndoRevisionId);
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").scenes, []);
  assert.deepEqual(timelineGraph(fixture.revisions.get(removedTrackRevisionId), "committed-with-lost-response").scenes,
    [{ sceneId, order: 0 }], "the track-removal revision remains immutable");
  assert.deepEqual(timelineGraph(fixture.revisions.get(removedSceneRevisionId), "committed-with-lost-response").scenes,
    [], "the scene-removal revision remains immutable");

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const metrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      overflowingControls: [...document.querySelectorAll("button, input, select")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ label: element.getAttribute("aria-label") || element.textContent || element.id,
          right: element.getBoundingClientRect().right }))
        .filter((element) => element.right > document.documentElement.clientWidth + 1),
    }));
    assert.ok(metrics.page <= metrics.viewport, `page must not overflow horizontally at ${viewport.width}px: ${JSON.stringify(metrics)}`);
    assert.deepEqual(metrics.overflowingControls, [], `controls must fit the viewport at ${viewport.width}px`);
  }

  // A valid graph containing a clip is supplied as an external current-head observation. The page
  // must refresh before preflighting and must never POST removal of its referenced track.
  const clipHeadRevisionId = "revision-12";
  const seededClip = {
    clipId: "fixture-clip",
    sceneId,
    trackId: "fixture-track",
    source: { artifactId: "fixture-artifact", artifactVersionId: "fixture-version" },
    sourceIn: { ticks: "0", rateNumerator: "1", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
    sourceOut: { ticks: "1", rateNumerator: "1", rateDenominator: "1", clock: "SOURCE_PRESENTATION" },
    storyStart: { ticks: "0", rateNumerator: "1", rateDenominator: "1", clock: "STORY" },
    storyDuration: { ticks: "1", rateNumerator: "1", rateDenominator: "1", clock: "STORY" },
  };
  const clipHead = {
    tenantId: context.tenantId,
    projectId: fixture.project.projectId,
    revisionId: clipHeadRevisionId,
    parentRevisionId: fixture.project.headRevisionId,
    timelines: fixture.revision.timelines.map((snapshot) => snapshot.graph.timelineId === "committed-with-lost-response"
      ? { ...snapshot, semanticVersionId: "semantic-clip-head", graph: {
        ...snapshot.graph,
        scenes: [{ sceneId, order: 0 }],
        tracks: [{ trackId: "fixture-track", sceneId, kind: "VIDEO", order: 0 }],
        clips: [seededClip],
      } }
      : snapshot),
  };
  fixture.revision = clipHead;
  fixture.project = { ...fixture.project, headRevisionId: clipHeadRevisionId };
  fixture.revisions.set(clipHeadRevisionId, clipHead);
  await keyboardActivate(page, page.getByRole("button", { name: "Reopen current project" }));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await page.locator("#workspace-status").textContent())?.includes("Reopened project local-project-1 at head revision-12")) break;
    await delay(100);
  }
  assert.match(await page.locator("#workspace-status").textContent(), /Reopened project local-project-1 at head revision-12\./u,
    `keyboard reopen did not update status: ${await page.locator("#workspace-status").textContent()}`);
  await keyboardChooseRadio(page, page.getByRole("group", { name: "Track ID to remove" }), page.getByRole("group", { name: "Track ID to remove" }).getByRole("radio", { name: "fixture-track", exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Remove track" }));
  await page.getByText(/Track ID fixture-track still owns clips\. Remove its clips before removing the track; no mutation was sent\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, 4, "a track with a clip must be rejected before the edit POST");
  assert.equal(fixture.project.headRevisionId, clipHeadRevisionId, "clip preflight must preserve the exact owner head");

  const sourceArtifactId = "00000000-0000-4000-8000-000000000001";
  const sourceSha256 = "a".repeat(64);
  await keyboardFill(page, page.getByLabel("Source artifact ID to inspect"), sourceArtifactId);
  await keyboardActivate(page, page.getByRole("button", { name: "Read source artifact" }));
  const inspectedArtifact = page.getByLabel("Inspected source artifact");
  await inspectedArtifact.getByText(sourceArtifactId, { exact: true }).waitFor();
  await inspectedArtifact.getByText(`sha256:${sourceSha256}`, { exact: true }).waitFor();
  assert.deepEqual(fixture.artifactReadRequests, [{
    method: "GET", path: `/api/v1/artifacts/${sourceArtifactId}`, artifactId: sourceArtifactId,
  }], "the mounted editor must GET the exact owner artifact UUID before constructing a clip");
  assert.ok(fixture.requests.includes(`GET /api/v1/artifacts/${sourceArtifactId}`),
    "the Vite proxy must forward the exact owner artifact route to the loopback fixture");

  const attachedClip = {
    clipId: "browser-attached-clip",
    sceneId,
    trackId: "fixture-track",
    source: { artifactId: sourceArtifactId, artifactVersionId: `sha256:${sourceSha256}` },
    sourceIn: { ticks: "3", rateNumerator: "48000", rateDenominator: "1001", clock: "SOURCE_PRESENTATION" },
    sourceOut: { ticks: "12345", rateNumerator: "48000", rateDenominator: "1001", clock: "SOURCE_PRESENTATION" },
    storyStart: { ticks: "7", rateNumerator: "24000", rateDenominator: "1001", clock: "STORY" },
    storyDuration: { ticks: "48", rateNumerator: "24000", rateDenominator: "1001", clock: "STORY" },
  };
  await keyboardFill(page, page.locator("#clip-id"), attachedClip.clipId);
  await keyboardChooseRadio(page, page.getByRole("group", { name: "Clip track" }),
    page.getByRole("group", { name: "Clip track" }).getByRole("radio", { name: /fixture-track/u }));
  await keyboardFill(page, page.getByLabel("Source in ticks"), attachedClip.sourceIn.ticks);
  await keyboardFill(page, page.getByLabel("Source out ticks"), attachedClip.sourceOut.ticks);
  await keyboardFill(page, page.getByLabel("Source rate numerator"), attachedClip.sourceIn.rateNumerator);
  await keyboardFill(page, page.getByLabel("Source rate denominator"), attachedClip.sourceIn.rateDenominator);
  await keyboardFill(page, page.getByLabel("Story start ticks"), attachedClip.storyStart.ticks);
  await keyboardFill(page, page.getByLabel("Story duration ticks"), attachedClip.storyDuration.ticks);
  await keyboardFill(page, page.getByLabel("Story rate numerator"), attachedClip.storyStart.rateNumerator);
  await keyboardFill(page, page.getByLabel("Story rate denominator"), attachedClip.storyStart.rateDenominator);
  await keyboardActivate(page, page.getByRole("button", { name: "Add or update clip reference" }));
  await page.getByText(/Committed and reopened putClip in revision revision-13\./u).waitFor();
  const attachedClipRevision = fixture.revision;
  assert.equal(attachedClipRevision.parentRevisionId, clipHeadRevisionId,
    "attaching the clip must create a successor of the exact observed owner head");
  assert.deepEqual(timelineGraph(attachedClipRevision, "committed-with-lost-response").clips,
    [seededClip, attachedClip], "the successor must include the prior fixture clip and exact attached clip");
  const putClipRequest = fixture.graphEditRequests.find(({ edits }) => edits.some((edit) => edit.type === "putClip"));
  assert.ok(putClipRequest, "the mounted editor must commit its clip through the timeline edit API");
  assert.deepEqual(putClipRequest.edits, [{ type: "putClip", clip: attachedClip }],
    "the exact SHA256 source and rational decimal-string values must be preserved in the API payload");
  assert.match(await page.locator("#readback-json").textContent(), /"revisionId": "revision-13"/u,
    "the mounted editor must reopen the exact clip successor revision");
  assert.match(await page.locator("#readback-json").textContent(), new RegExp(`"artifactVersionId": "sha256:${sourceSha256}"`, "u"),
    "successor readback must retain the inspected immutable artifact version");

  const graphEditPostsBeforeClipTrackPreflight = fixture.graphEditPostAttempts;
  await keyboardChooseRadio(page, page.getByRole("group", { name: "Track ID to remove" }),
    page.getByRole("group", { name: "Track ID to remove" }).getByRole("radio", { name: "fixture-track", exact: true }));
  await keyboardActivate(page, page.getByRole("button", { name: "Remove track" }));
  await page.getByText(/Track ID fixture-track still owns clips\. Remove its clips before removing the track; no mutation was sent\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, graphEditPostsBeforeClipTrackPreflight,
    "a track owning the mounted editor clip must be rejected before the edit POST");
  assert.equal(fixture.project.headRevisionId, attachedClipRevision.revisionId,
    "clip-owned track preflight must preserve the exact successor head");

  await keyboardChooseRadio(page, page.getByRole("group", { name: "Clip ID to remove" }),
    page.getByRole("group", { name: "Clip ID to remove" }).getByRole("radio", { name: attachedClip.clipId, exact: true }));
  fixture.loseNextClipResponse = true;
  await keyboardActivate(page, page.getByRole("button", { name: "Remove clip" }));
  await page.getByText(/OUTCOME_UNKNOWN: removeClip may have committed\./u).waitFor();
  assert.equal(fixture.graphEditPostAttempts, graphEditPostsBeforeClipTrackPreflight + 1,
    "the lost removeClip response must follow one committed POST");
  const lostClipEditRequest = fixture.graphEditRequests.at(-1);
  assert.deepEqual(lostClipEditRequest.edits, [{ type: "removeClip", clipId: attachedClip.clipId }]);
  const lostClipHeadRevisionId = fixture.project.headRevisionId;
  assert.equal(lostClipHeadRevisionId, "revision-14", "the fixture commits the clip removal before dropping the response");
  await keyboardActivate(page, page.getByRole("button", { name: "Reconcile timeline outcome" }));
  await page.getByText(new RegExp(`Graph edit outcome reconciled: removeClip is present in owner head ${lostClipHeadRevisionId}\\.`, "u")).waitFor();
  assert.equal(fixture.graphEditPostAttempts, graphEditPostsBeforeClipTrackPreflight + 1,
    "reconciliation must read the committed exact head and never duplicate the clip POST");
  assert.equal(fixture.project.headRevisionId, lostClipHeadRevisionId);
  assert.deepEqual(timelineGraph(fixture.revision, "committed-with-lost-response").clips,
    [seededClip], "the reconciled owner head must preserve the unrelated fixture clip only");
  assert.ok(fixture.requests.includes(`GET /dev/v1/projects/${fixture.project.projectId}`),
    "clip outcome reconciliation must re-read the owner project head");
  assert.deepEqual(fixture.projectReadHeads.at(-1), {
    projectId: fixture.project.projectId,
    projectHeadRevisionId: lostClipHeadRevisionId,
    currentRevisionId: lostClipHeadRevisionId,
  }, "reconciliation must read the exact current owner head and its matching immutable revision");
  assert.match(await page.locator("#readback-json").textContent(), new RegExp(`"revisionId": "${lostClipHeadRevisionId}"`, "u"),
    "the mounted editor must display exact successor-head readback after reconciliation");

  // Resume: open the existing project by id (typed 404 first), then reopen a known render and export it.
  const openProjectButton = page.getByRole("button", { name: "Open existing project", exact: true });
  await keyboardFill(page, page.getByLabel("Project ID", { exact: true }), "missing-project");
  await keyboardActivate(page, openProjectButton);
  await page.getByText(/PROJECT_NOT_FOUND: no project with that id exists in this tenant and owner scope/u).waitFor();
  await keyboardFill(page, page.getByLabel("Project ID", { exact: true }), fixture.project.projectId);
  await keyboardActivate(page, openProjectButton);
  await page.getByText(new RegExp(`Opened existing DEV_ONLY project ${fixture.project.projectId}; current head revision ${fixture.project.headRevisionId} read from the host\\.`, "u")).waitFor();
  await keyboardFill(page, page.getByLabel("Known render ID"), "render-1");
  await keyboardActivate(page, page.getByRole("button", { name: "Reopen known render" }));
  await page.locator("#render-status").filter({ hasText: "Reopened render render-1" }).waitFor();
  // Verified preview: tampered bytes show a typed digest error and no image; the exact bytes preview and download.
  fixture.corruptContent = true;
  await keyboardActivate(page, page.getByRole("button", { name: /Preview GIF/u }));
  await page.locator(".dev-content-status[data-failure='CONTENT_DIGEST_MISMATCH']").waitFor();
  assert.equal(await page.locator("img[data-verified-preview]").count(), 0, "tampered bytes must never be previewed");
  fixture.corruptContent = false;
  await keyboardActivate(page, page.getByRole("button", { name: /Preview GIF/u }));
  await page.locator("img[data-verified-preview='gif']").waitFor();
  assert.match(await page.locator(".dev-content-status").textContent(), /Bytes verified against the registered version/u);
  assert.ok(await page.locator("img[data-verified-preview='gif']").evaluate((img) => img.complete && img.naturalWidth === 1), "the verified GIF must decode");
  assert.match(await page.locator("img[data-verified-preview='gif']").getAttribute("src"), /^blob:/u);
  const download = page.waitForEvent("download");
  await keyboardActivate(page, page.getByRole("button", { name: /Download GIF/u }));
  assert.equal((await download).suggestedFilename(), "render-1.gif");
  const lastContent = fixture.contentRequests.at(-1);
  assert.equal(lastContent.ifMatch, `sha256:${RENDER_SHA}`, "the content read must name the exact version");
  assert.equal(lastContent.range, undefined);
  for (const entry of fixture.contentRequests) {
    assert.equal(entry.url, "/dev/v1/artifacts/render-1/content", "no query string: the token and version never travel in the URL");
    assert.equal(entry.authorization, `Bearer ${token}`);
  }
  await keyboardFill(page, page.getByLabel("Destination ID"), "missing-destination");
  await keyboardActivate(page, page.getByRole("button", { name: "Export render artifact" }));
  await page.locator("#export-status").filter({ hasText: "DESTINATION_NOT_FOUND" }).waitFor();
  assert.equal(await page.getByRole("article", { name: "Export result" }).count(), 0);
  await keyboardFill(page, page.getByLabel("Destination ID"), "dev-local");
  await keyboardActivate(page, page.getByRole("button", { name: "Export render artifact" }));
  await page.locator("#export-status").filter({ hasText: "NOT CONFIRMED" }).waitFor();
  const unconfirmed = page.getByRole("article", { name: "Export result" });
  assert.equal(await unconfirmed.getAttribute("data-destination-confirmed"), "false");
  assert.doesNotMatch(await unconfirmed.textContent(), /receipt:|Delivered/u, "an unconfirmed export must show no receipt and never say delivered");
  assert.equal(fixture.exportRequests.length, 2);
  assert.equal(fixture.exportRequests[1].artifactVersionId, `sha256:${RENDER_SHA}`, "the export must name the exact render artifact version");
  await keyboardActivate(page, page.getByRole("button", { name: "Check again" }));
  await page.locator("#export-status").filter({ hasText: "destination confirmed with receipt dev-local-directory-receipt:fixture" }).waitFor();
  assert.equal(await page.getByRole("article", { name: "Export result" }).getAttribute("data-destination-confirmed"), "true");
  assert.equal(fixture.exportReads, 1);
  assert.equal(fixture.exportRequests.length, 2, "Check again must read back, never re-export");

  // Offline drafts: browser-held non-extractable key, encrypted inert drafts, explicit review, CAS replay, no auto-replay.
  const draftPanel = page.getByRole("region", { name: "Offline drafts" });
  const linkState = page.getByTestId("offline-link-state");
  const draftStatus = page.getByTestId("offline-draft-status");
  await draftPanel.waitFor();
  const baseHeadBeforeOffline = fixture.project.headRevisionId;
  const postsBeforeOffline = fixture.graphEditPostAttempts;
  await page.context().setOffline(true);
  await linkState.filter({ hasText: "Offline" }).waitFor();
  await keyboardFill(page, draftPanel.getByLabel("Scene id"), "offline-secret-scene");
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Save as offline draft" }));
  await draftStatus.filter({ hasText: /Saved offline draft .* against base revision .*Nothing was sent\./u }).waitFor();
  assert.equal(fixture.graphEditPostAttempts, postsBeforeOffline, "an offline draft must never reach the host");
  const custody = await page.evaluate(async () => {
    const open = (name) => new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const rows = (db, store) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); });
    const keyDb = await open("ghatana-media-offline-draft-keys-v1");
    const keys = await rows(keyDb, "keys");
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("ghatana-media-offline-drafts-v1:"));
    let raw = ""; let draftRows = 0;
    for (const name of names) {
      const db = await open(name);
      for (const store of db.objectStoreNames) for (const row of await rows(db, store)) {
        draftRows += 1;
        raw += JSON.stringify(row, (_k, v) => v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).map((b) => String.fromCharCode(b)).join("") : v);
      }
    }
    return { keyCount: keys.length, extractable: keys.map((k) => k.key.extractable), algorithm: keys.map((k) => k.key.algorithm.name),
      keyScope: keys.map((k) => [k.tenantId, k.principalId, k.projectId]), draftRows, plaintextLeaked: raw.includes("offline-secret-scene") };
  });
  assert.equal(custody.keyCount, 1);
  assert.deepEqual(custody.extractable, [false], "the offline key must be non-extractable");
  assert.deepEqual(custody.algorithm, ["AES-GCM"]);
  assert.deepEqual(custody.keyScope[0].slice(0, 2), [context.tenantId, context.principalId], "the key is scoped to the verified tenant and principal");
  assert.equal(custody.draftRows, 1);
  assert.equal(custody.plaintextLeaked, false, "drafts must be encrypted at rest");
  await page.context().setOffline(false);
  await linkState.filter({ hasText: "Online" }).waitFor();
  await delay(300);
  assert.equal(fixture.graphEditPostAttempts, postsBeforeOffline, "reconnecting must not auto-replay a draft");
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Review and replay" }));
  await draftPanel.getByLabel("Draft review").waitFor();
  assert.equal(fixture.graphEditPostAttempts, postsBeforeOffline, "review must not send the edit");
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Confirm replay" }));
  await draftPanel.getByText(/APPLIED \(201\)/u).first().waitFor();
  assert.equal(fixture.graphEditPostAttempts, postsBeforeOffline + 1);
  const replayed = fixture.graphEditRequests.at(-1);
  assert.equal(replayed.expectedHeadRevisionId, baseHeadBeforeOffline, "replay is a CAS on the draft's exact base revision");
  assert.deepEqual(replayed.edits, [{ type: "addScene", sceneId: "offline-secret-scene", order: 0 }]);
  assert.notEqual(fixture.project.headRevisionId, baseHeadBeforeOffline);

  // A head that moved while offline yields a visible REVISION_CONFLICT and is never merged or sent.
  await page.context().setOffline(true);
  await linkState.filter({ hasText: "Offline" }).waitFor();
  await keyboardFill(page, draftPanel.getByLabel("Scene id"), "stale-offline-scene");
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Save as offline draft" }));
  await draftStatus.filter({ hasText: /Saved offline draft/u }).waitFor();
  await page.context().setOffline(false);
  await linkState.filter({ hasText: "Online" }).waitFor();
  const staleBase = fixture.project.headRevisionId;
  const movedHead = nextRevisionId();
  fixture.revision = { ...fixture.revision, revisionId: movedHead, parentRevisionId: staleBase };
  fixture.project = { ...fixture.project, headRevisionId: movedHead };
  fixture.revisions.set(movedHead, fixture.revision);
  const postsBeforeConflict = fixture.graphEditPostAttempts;
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Review and replay" }));
  await draftPanel.getByLabel("Draft review").getByText(movedHead).waitFor();
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Confirm replay" }));
  await draftPanel.getByText(new RegExp(`REVISION_CONFLICT: this draft was authored on ${staleBase} but the project head is ${movedHead}`, "u")).first().waitFor();
  assert.equal(fixture.graphEditPostAttempts, postsBeforeConflict, "a stale draft must not be sent or merged");
  await keyboardActivate(page, draftPanel.getByRole("button", { name: "Discard draft" }));
  await draftPanel.getByText("No offline drafts.").waitFor();

  await keyboardActivate(page, page.getByRole("button", { name: "Forget token and disconnect" }));
  assert.equal(await page.locator("#dev-token").inputValue(), "");
  assert.equal(await page.locator("#dev-token").isEnabled(), true);
  assert.equal(await page.locator("#context-fields").isVisible(), false);
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
  assert.deepEqual(await page.evaluate(() => window.__timelineBrowserInputAudit),
    { pointerDowns: 0, pointerClicks: 0 }, "all mounted timeline interactions must remain keyboard-only without pointer clicks");
} finally {
  await browser?.close();
  viteProcess.kill("SIGTERM");
  apiServer.close();
}
