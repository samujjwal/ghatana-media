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
const token = requiredEnv("MEDIA_DEV_STORYBOARD_BROWSER_TOKEN");
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
delete viteEnvironment.MEDIA_DEV_STORYBOARD_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });


const sources = JSON.parse(requiredEnv("MEDIA_DEV_STORYBOARD_SOURCES"));
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-storyboard.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the storyboard page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The deliberate typed 422 / 409 / 403 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (422|409|403|404)/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const isPost = (path) => (response) => new URL(response.url()).pathname === path && response.request().method() === "POST";
  const status = () => page.locator("[data-storyboard-status]").textContent();
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  // 1. Connect.
  await page.goto(`${baseUrl}/dev-storyboard.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-storyboard.html`, { waitUntil: "networkidle" });
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: "Brief to reviewed media", level: 2 }).waitFor({ timeout: 20_000 });
      break;
    } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.locator("[data-capabilities-status]").getByText(/composite available, animation available, review available/u).waitFor({ timeout: 15_000 });

  // 2. A brief becomes a versioned storyboard of placeholder shots; render is disabled and the reasons are typed per shot.
  await page.getByLabel("Brief title").fill("Spring thaw");
  await page.getByLabel(/^Brief text/u).fill("Snow on a field.\n\nThe snow melts.\n\nBirds return.");
  const createPost = page.waitForResponse(isPost("/dev/v1/storyboards"), { timeout: 30_000 });
  await page.getByRole("button", { name: "Create storyboard from brief" }).click();
  const createdResponse = await createPost;
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  const storyboardId = (await createdResponse.json()).storyboardId;
  await page.locator("[data-storyboard-id]").getByText(storyboardId).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("[data-version]").textContent(), "1");
  assert.equal(await page.locator("[data-timeline-shot]").count(), 3);
  assert.equal(await page.locator("[data-shot-state]").count(), 3);
  for (const row of await page.locator("[data-shot-state]").all()) {
    assert.match(await row.textContent(), /BLOCKED/u);
    assert.equal(await row.locator("[data-reason='PLACEHOLDER_NOT_RENDERABLE']").count(), 1);
  }
  assert.equal(await page.getByRole("button", { name: "Render storyboard" }).isDisabled(), true, "render is not enabled with placeholders");
  assert.match(await page.locator("[data-render-hint]").textContent(), /disabled until every shot is renderable/u);

  // 3. Edit the plan in the editor: scene 1 gets an animation shot and a stored shot; scenes 2 and 3 get stored shots.
  const scene = (n) => page.getByRole("group", { name: `Scene ${n}`, exact: true });
  const shot = (n, m) => page.getByRole("group", { name: `Scene ${n} shot ${m}`, exact: true });
  await page.getByRole("button", { name: "Add shot to scene 1" }).click();
  const animationSpec = JSON.stringify({ background: "#FF8000", shapes: [] });
  const setShot = async (n, m, { id, ms, kind, asset, inMs, spec }) => {
    const row = shot(n, m);
    await row.getByLabel("Shot id").fill(id);
    await row.getByLabel("Duration (ms)").fill(String(ms));
    await row.getByLabel("Source kind").selectOption(kind);
    if (kind === "ASSET") {
      await row.getByLabel("Asset artifact id").fill(asset.id);
      await row.getByLabel("Asset exact version").fill(asset.version);
      await row.getByLabel("Asset start (ms)").fill(String(inMs));
    } else if (kind === "ANIMATION") {
      await row.getByLabel(/^Animation spec/u).fill(spec);
    }
  };
  await scene(1).getByLabel("Scene id").first().fill("intro");
  await scene(2).getByLabel("Scene id").first().fill("middle");
  await scene(3).getByLabel("Scene id").first().fill("outro");
  await setShot(1, 1, { id: "s1", ms: 1000, kind: "ANIMATION", spec: animationSpec });
  await setShot(1, 2, { id: "s2", ms: 530, kind: "ASSET", asset: sources.a, inMs: 1000 });
  await setShot(2, 1, { id: "s3", ms: 1000, kind: "ASSET", asset: sources.b, inMs: 2000 });
  await setShot(3, 1, { id: "s5", ms: 1000, kind: "ASSET", asset: sources.a, inMs: 3000 });
  // A malformed number is refused client-side and nothing is sent.
  await shot(3, 1).getByLabel("Duration (ms)").fill("one second");
  const editsBefore = apiRequests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/versions")).length;
  await page.getByRole("button", { name: "Save new version" }).click();
  await page.locator("[data-form-errors]").getByText(/Scene 3 shot 1 duration must be a whole number/u).waitFor({ timeout: 5_000 });
  assert.equal(apiRequests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/versions")).length, editsBefore, "nothing was sent");
  await shot(3, 1).getByLabel("Duration (ms)").fill("1000");
  // The host refuses a duration that is not a whole number of frames, with the typed path.
  const refusedPost = page.waitForResponse(isPost(`/dev/v1/storyboards/${storyboardId}/versions`), { timeout: 30_000 });
  await page.getByRole("button", { name: "Save new version" }).click();
  const refused = await refusedPost;
  assert.equal(refused.status(), 422, await refused.text());
  await page.locator("[data-failure-code]").getByText("DURATION_NOT_FRAME_ALIGNED").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("[data-failure-path]").textContent(), "$.scenes[0].shots[1].durationMs");
  assert.equal(await page.locator("[data-version]").textContent(), "1", "a refused edit wrote nothing");
  await shot(1, 2).getByLabel("Duration (ms)").fill("1000");
  const savePost = page.waitForResponse(isPost(`/dev/v1/storyboards/${storyboardId}/versions`), { timeout: 30_000 });
  await page.getByRole("button", { name: "Save new version" }).click();
  const saved = await savePost;
  assert.equal(saved.status(), 201, await saved.text());
  const savedBody = JSON.parse(saved.request().postData());
  assert.equal(savedBody.expectedVersion, 1);
  await page.getByText(/Saved version 2\./u).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("[data-version]").textContent(), "2");
  // derived story time of the saved version
  const timeline = await page.locator("[data-timeline] tbody tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.textContent)));
  assert.deepEqual(timeline, [
    ["intro", "s1", "ANIMATION", "0", "1000", "0", "25"],
    ["intro", "s2", "ASSET", "1000", "2000", "25", "25"],
    ["middle", "s3", "ASSET", "2000", "3000", "50", "25"],
    ["outro", "s5", "ASSET", "3000", "4000", "75", "25"],
  ]);

  // 4. Readiness: the stored shots are renderable, the authored animation lacks the owner's rights statement.
  assert.match(await page.locator("[data-shot-state='s1']").textContent(), /BLOCKED.*AUTHORED_RIGHTS_DENIED/u);
  for (const id of ["s2", "s3", "s5"]) assert.match(await page.locator(`[data-shot-state='${id}']`).textContent(), /RENDERABLE/u);
  assert.equal(await page.getByRole("button", { name: "Render storyboard" }).isDisabled(), true);
  await page.locator("[data-attest-form]").waitFor();
  assert.equal(await page.getByRole("button", { name: "Record my rights statement" }).isDisabled(), true, "no statement without the explicit confirmation");
  await page.getByLabel("Basis of your statement").fill("TEST: authored procedural animation in an automated browser test; a statement by a synthetic test principal");
  await page.getByLabel(/I am the rights holder/u).check();
  const attestPost = page.waitForResponse(isPost("/dev/v1/rights/attestations"), { timeout: 30_000 });
  await page.getByRole("button", { name: "Record my rights statement" }).click();
  assert.equal((await attestPost).status(), 201);
  await page.getByText(/Your statement about this exact storyboard version was recorded/u).waitFor({ timeout: 15_000 });
  await page.getByText("Every shot is renderable now.").waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole("button", { name: "Render storyboard" }).isEnabled(), true);

  // 5. Render: one MP4; exact frames; every shot's source in the lineage; bytes verified before playback.
  const renderPost = page.waitForResponse(isPost(`/dev/v1/storyboards/${storyboardId}/renders`), { timeout: 120_000 });
  await page.getByRole("button", { name: "Render storyboard" }).click();
  const renderResponse = await renderPost;
  assert.equal(renderResponse.status(), 201, await renderResponse.text());
  const created = await renderResponse.json();
  const renderBody = JSON.parse(renderResponse.request().postData());
  assert.deepEqual(Object.keys(renderBody).sort(), ["requestId", "storyboardVersion"]);
  assert.equal(renderBody.storyboardVersion, 2);
  const result = page.locator("[data-render-result]");
  await result.waitFor({ timeout: 30_000 });
  assert.equal(await result.locator("[data-render-frames]").textContent(), "100");
  assert.equal(await result.locator("[data-render-sha256]").textContent(), created.artifact.sha256);
  assert.equal(created.lineage.annotations.storyboardVersion, 2);
  const sourceRows = await result.locator("[data-lineage] tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-source-clip")));
  assert.deepEqual(sourceRows.sort(), ["clip-s1", "clip-s2", "clip-s3", "clip-s5"]);
  await result.getByRole("button", { name: /^Preview MP4/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  const video = result.locator("video[data-verified-preview='mp4']");
  await video.waitFor({ timeout: 10_000 });
  assert.match(await video.getAttribute("src"), /^blob:/u);
  await video.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad();
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("video metadata did not load")), 15_000);
  }));
  const playback = await video.evaluate(async (element) => {
    const meta = { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
    element.muted = true;
    await element.play();
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const advanced = element.currentTime;
    element.pause();
    return { ...meta, advanced };
  });
  assert.ok(Math.abs(playback.duration - 4) < 0.06, `decoded duration ${playback.duration}s`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);
  // The browser's own decode at the first frame of each shot: scene order and the story-time boundaries.
  const sample = (frame, x, y) => video.evaluate(async (element, [targetFrame, px, py]) => {
    element.pause();
    await new Promise((resolveSeek, rejectSeek) => {
      element.addEventListener("seeked", () => resolveSeek(), { once: true });
      setTimeout(() => rejectSeek(new Error("seek timed out")), 10_000);
      element.currentTime = (targetFrame + 0.5) / 25;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
    canvasContext.drawImage(element, 0, 0, 320, 240);
    const { data } = canvasContext.getImageData(px, py, 1, 1);
    return [data[0], data[1], data[2]];
  }, [frame, x, y]);
  const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 30);
  const sampled = [];
  for (const [frame, x, y, expected, label] of [
    [2, 160, 200, [255, 128, 0], "s1 animation (orange)"], [22, 160, 200, [255, 128, 0], "s1 animation last frames"],
    [27, 160, 200, [0, 255, 0], "s2 stored A at 1 s (green)"], [47, 160, 200, [0, 255, 0], "s2 last frames"],
    [52, 250, 60, [255, 0, 255], "s3 stored B at 2 s (magenta)"], [72, 250, 60, [255, 0, 255], "s3 last frames"],
    [77, 160, 200, [255, 255, 0], "s5 stored A at 3 s (yellow)"], [97, 160, 200, [255, 255, 0], "s5 last frames"],
  ]) {
    const actual = await sample(frame, x, y);
    sampled.push({ label, actual });
    assert.ok(near(actual, expected), `${label}: frame ${frame} pixel ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
  const registered = await page.evaluate(async ({ id, version, tokenValue }) => {
    const response = await fetch(`/dev/v1/artifacts/${id}/content`, { headers: { Authorization: `Bearer ${tokenValue}`, "If-Match": version } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { status: response.status, digest: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
  }, { id: created.artifact.artifactId, version: created.artifact.artifactVersionId, tokenValue: token });
  assert.equal(registered.status, 200);
  assert.equal(registered.digest, created.artifact.sha256);

  // 6. Review handoff of this exact render.
  const reviewPost = page.waitForResponse(isPost(`/dev/v1/storyboards/${storyboardId}/versions/2/review`), { timeout: 30_000 });
  await page.getByRole("button", { name: "Open render for review" }).click();
  assert.equal((await reviewPost).status(), 201);
  await page.locator("[data-review-currentness]").getByText("CURRENT").waitFor({ timeout: 15_000 });
  const reviewCaseId = (await page.locator("[data-review-case]").textContent()).trim();
  assert.ok(reviewCaseId.length > 0 && reviewCaseId !== "none yet");
  assert.equal(await page.locator("[data-review-approval]").textContent(), "false");
  assert.equal(await page.locator("[data-review-stale]").count(), 0);

  // 7. Another editor saves version 3 (out of band); this page's review state goes STALE and its own stale save is refused.
  const viewed = await api("GET", `/dev/v1/storyboards/${storyboardId}/versions/2`);
  assert.equal(viewed.status, 200);
  const outOfBand = await api("POST", `/dev/v1/storyboards/${storyboardId}/versions`, {
    requestId: `oob-${Date.now()}`, expectedVersion: 2, brief: { title: "Edited elsewhere", text: viewed.body.brief.text },
    format: viewed.body.format, scenes: viewed.body.scenes,
  });
  assert.equal(outOfBand.status, 201, JSON.stringify(outOfBand.body));
  await page.getByRole("button", { name: "Refresh review state" }).click();
  await page.locator("[data-review-currentness]").getByText("STALE").waitFor({ timeout: 15_000 });
  await page.locator("[data-review-stale]").waitFor();
  await shot(2, 1).getByLabel("Duration (ms)").fill("1040");
  const stalePost = page.waitForResponse(isPost(`/dev/v1/storyboards/${storyboardId}/versions`), { timeout: 30_000 });
  await page.getByRole("button", { name: "Save new version" }).click();
  const stale = await stalePost;
  assert.equal(stale.status(), 409, await stale.text());
  await page.locator("[data-failure-code]").getByText("STORYBOARD_VERSION_STALE").waitFor({ timeout: 10_000 });
  // reload the head: version 3 has no statement of its own, so it is not renderable and the render button is disabled again
  await page.getByRole("button", { name: "Reload head version" }).click();
  await page.locator("[data-version]").getByText("3", { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator("[data-shot-state='s1'] [data-reason='AUTHORED_RIGHTS_DENIED']").waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole("button", { name: "Render storyboard" }).isDisabled(), true);

  // 8. Accessibility and responsiveness.
  const audit = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")];
    const unlabelled = controls.filter((c) => !(c.labels && c.labels.length) && !c.getAttribute("aria-label")).map((c) => c.id || c.name || c.type);
    const ids = [...document.querySelectorAll("[id]")].map((n) => n.id);
    return { unlabelled, duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i), unnamedButtons: [...document.querySelectorAll("button")].filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label")).length,
      tables: [...document.querySelectorAll("table")].map((t) => ({ caption: !!t.querySelector("caption"), scoped: [...t.querySelectorAll("thead th")].every((th) => th.getAttribute("scope") === "col") })), lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.ok(audit.tables.length >= 2 && audit.tables.every((t) => t.caption && t.scoped));
  assert.equal(audit.lang, "en");
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "storyboarded", storyboardId, renderId: created.renderId, artifactSha256: created.artifact.sha256, sizeBytes: created.artifact.sizeBytes,
    frameCount: created.lineage.frameCount, playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced,
    sampled, reviewCaseId, headVersion: 3,
  })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
