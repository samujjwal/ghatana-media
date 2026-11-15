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
const token = requiredEnv("MEDIA_DEV_COMPOSITE_BROWSER_TOKEN");
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
delete viteEnvironment.MEDIA_DEV_COMPOSITE_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });


const projectId = requiredEnv("MEDIA_DEV_COMPOSITE_PROJECT_ID");
const sources = JSON.parse(requiredEnv("MEDIA_DEV_COMPOSITE_SOURCES"));
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-composite-render.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the composite render page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The deliberate typed 422 / 409 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (422|409)/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const isPost = (path) => (response) => new URL(response.url()).pathname === path && response.request().method() === "POST";
  const status = () => page.locator("[data-composite-status]").textContent();

  // 1. Connect; the host limits come FROM THE HOST.
  await page.goto(`${baseUrl}/dev-composite-render.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-composite-render.html`, { waitUntil: "networkidle" });
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: "Multitrack finished master", level: 2 }).waitFor({ timeout: 20_000 });
      break;
    } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.locator("[data-capabilities-status]").getByText(/Limits: 64 clips/u).waitFor({ timeout: 15_000 });

  // 2. Project, head revision from the host.
  await page.getByLabel("Project id").fill(projectId);
  await page.getByRole("button", { name: "Load head revision" }).click();
  await page.getByText(/Head revision .* loaded\./u).waitFor({ timeout: 15_000 });
  const initialHead = await page.getByLabel("Head revision id").inputValue();
  assert.ok(initialHead.length > 0);

  // 3. Place the clips (two video clips of different fps/geometry, narration, music, a PNG graphic, WebVTT) on the real timeline.
  const plan = [
    ["VIDEO", "v-a", "video-main", sources.a, 1000, 3000, 0, 2000],
    ["VIDEO", "v-b", "video-main", sources.b, 0, 2000, 2000, 2000],
    ["AUDIO", "aud-nar", "audio-nar", sources.narration, 0, 4000, 0, 4000],
    ["AUDIO", "aud-mus", "audio-mus", sources.music, 0, 4000, 0, 4000],
    ["OVERLAY", "ov-1", "overlay-main", sources.graphic, 0, 2000, 2000, 2000],
    ["CAPTION", "cap-1", "caption-main", sources.vtt, 0, 4000, 0, 4000],
  ];
  for (const [kind] of plan) await page.getByRole("button", { name: `Add ${kind.toLowerCase()} clip` }).click();
  assert.equal(await page.locator("[data-clip-row]").count(), 6);
  for (let index = 0; index < plan.length; index += 1) {
    const [kind, clipId, trackId, source, inMs, outMs, start, duration] = plan[index];
    const row = page.getByRole("group", { name: `Clip ${index + 1}`, exact: true });
    assert.equal(await row.getByLabel("Track kind").inputValue(), kind);
    await row.getByLabel("Clip id").fill(clipId);
    await row.getByLabel("Track id").fill(trackId);
    await row.getByLabel("Artifact id").fill(source.id);
    await row.getByLabel("Exact version").fill(source.version);
    await row.getByLabel("Source in (ms)").fill(String(inMs));
    await row.getByLabel("Source out (ms)").fill(String(outMs));
    await row.getByLabel("Story start (ms)").fill(String(start));
    await row.getByLabel("Story duration (ms)").fill(String(duration));
  }
  // A malformed version is refused client-side with a named clip and nothing is sent.
  const goodVersion = sources.a.version;
  await page.getByRole("group", { name: "Clip 1", exact: true }).getByLabel("Exact version").fill("sha256:abc");
  const beforeEdits = apiRequests.filter((entry) => entry.path.endsWith("/edits")).length;
  await page.getByRole("button", { name: "Place clips on the timeline" }).click();
  await page.locator("[data-form-errors]").getByText(/Clip 1: the exact version must be sha256/u).waitFor({ timeout: 5_000 });
  assert.equal(apiRequests.filter((entry) => entry.path.endsWith("/edits")).length, beforeEdits, "nothing was sent");
  await page.getByRole("group", { name: "Clip 1", exact: true }).getByLabel("Exact version").fill(goodVersion);
  await page.getByLabel(/Create the scene and tracks first/u).check();
  const editsPost = page.waitForResponse(isPost(`/dev/v1/projects/${projectId}/timelines/timeline-main/edits`), { timeout: 30_000 });
  await page.getByRole("button", { name: "Place clips on the timeline" }).click();
  const editsResponse = await editsPost;
  assert.equal(editsResponse.status(), 201, await editsResponse.text());
  const editsBody = JSON.parse(editsResponse.request().postData());
  assert.equal(editsBody.expectedHeadRevisionId, initialHead);
  assert.deepEqual(editsBody.edits.map((edit) => edit.type), ["addScene", "addTrack", "addTrack", "addTrack", "addTrack", "addTrack", ...Array(6).fill("putClip")]);
  await page.getByText(/Placed 6 clips; the new head revision/u).waitFor({ timeout: 15_000 });
  const placedHead = await page.getByLabel("Head revision id").inputValue();
  assert.notEqual(placedHead, initialHead);

  // 4. Settings: music gain, caption mode, a typed refusal first (the overlay has no placement), then the placement.
  await page.getByRole("button", { name: "Add audio gain" }).click();
  const gain = page.getByRole("group", { name: "Audio gain 1", exact: true });
  await gain.getByLabel("Audio clip id").fill("aud-mus");
  await gain.getByLabel("Gain (dB)").fill("-12");
  await page.getByLabel(/^Captions/u).selectOption("BOTH");
  const refusedPost = page.waitForResponse(isPost("/dev/v1/composite-renders"), { timeout: 60_000 });
  await page.getByRole("button", { name: "Render finished master" }).click();
  const refused = await refusedPost;
  assert.equal(refused.status(), 422, await refused.text());
  await page.locator("[data-failure]").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("[data-failure-path]").textContent(), "composition.overlays");
  assert.ok((await status()).includes("OVERLAY_PLACEMENT_REQUIRED"), await status());
  assert.equal(await page.locator("[data-composite-result]").count(), 0, "a refusal shows no result");

  await page.getByRole("button", { name: "Add overlay placement" }).click();
  const overlay = page.getByRole("group", { name: "Overlay 1", exact: true });
  await overlay.getByLabel("Overlay clip id").fill("ov-1");
  await overlay.getByLabel("X (px)").fill("20");
  await overlay.getByLabel("Y (px)").fill("100");

  // 5. Cancel mid-render: a large frame makes the encoder run long enough to press Cancel; nothing is registered.
  await page.getByLabel("Width (px)").fill("1280");
  await page.getByLabel("Height (px)").fill("720");
  const cancelledPost = page.waitForResponse(isPost("/dev/v1/composite-renders"), { timeout: 120_000 });
  await page.getByRole("button", { name: "Render finished master" }).click();
  const cancelButton = page.getByRole("button", { name: "Cancel render" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Cancel render" && !b.disabled), null, { timeout: 15_000 });
  const activeRequestId = JSON.parse(apiRequests.filter((entry) => entry.path === "/dev/v1/composite-renders").at(-1).body).requestId;
  const cancelPost = page.waitForResponse(isPost(`/dev/v1/composite-renders/${activeRequestId}/cancel`), { timeout: 30_000 });
  await delay(1_000);
  await cancelButton.click();
  const cancelResponse = await cancelPost;
  assert.equal(cancelResponse.status(), 200, await cancelResponse.text());
  const cancelled = await cancelledPost;
  assert.equal(cancelled.status(), 409, await cancelled.text());
  await page.locator("[data-failure][data-tone='cancelled']").waitFor({ timeout: 10_000 });
  assert.ok((await status()).includes("RENDER_CANCELLED"), await status());
  assert.equal(await page.locator("[data-composite-result]").count(), 0);

  // 6. The real render at the output geometry; the same requestId is reused only for an unchanged request.
  await page.getByLabel("Width (px)").fill("320");
  await page.getByLabel("Height (px)").fill("240");
  const renderPost = page.waitForResponse(isPost("/dev/v1/composite-renders"), { timeout: 240_000 });
  await page.getByRole("button", { name: "Render finished master" }).click();
  const renderResponse = await renderPost;
  assert.equal(renderResponse.status(), 201, await renderResponse.text());
  const created = await renderResponse.json();
  const renderBody = JSON.parse(renderResponse.request().postData());
  assert.deepEqual(renderBody.overlays, [{ clipId: "ov-1", x: 20, y: 100, opacity: 1 }]);
  assert.deepEqual(renderBody.audio, [{ clipId: "aud-mus", gainDb: -12 }]);
  assert.equal(renderBody.revisionId, placedHead);
  assert.equal(renderBody.captionMode, "BOTH");
  assert.match(renderBody.requestId, /^composite-/u);
  const result = page.locator("[data-composite-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "composite-result", null, { timeout: 5_000 });
  assert.ok((await result.locator("[data-result-picture]").textContent()).includes("320 x 240 at 25 fps, 100 frames (4.000000000 s)"));
  assert.ok((await result.locator("[data-result-streams]").textContent()).includes("video h264, audio aac, subtitles mov_text"));
  assert.equal(await result.locator("[data-result-sha256]").textContent(), created.artifact.sha256, "the checksum shown is the host's");
  const sourceRows = await result.locator("[data-sources] tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-source-clip")));
  assert.deepEqual(sourceRows.sort(), ["aud-mus", "aud-nar", "cap-1", "ov-1", "v-a", "v-b"]);
  assert.equal(created.lineage.sources.length, 6);

  // 7. Verified playback: bytes are hashed against the registered digest before the element exists, then decoded by Chromium.
  assert.equal(await result.locator("video").count(), 0, "no video before verification");
  await result.getByRole("button", { name: /^Preview MP4/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  assert.ok((await result.getByText(/Bytes verified against the registered version/u).first().textContent()).includes(created.artifact.sha256));
  const video = result.locator("video[data-verified-preview='mp4']");
  await video.waitFor({ timeout: 10_000 });
  assert.match(await video.getAttribute("src"), /^blob:/u);
  await video.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad();
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code} ${element.error?.message}`)), { once: true });
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
  assert.equal(playback.width, 320);
  assert.equal(playback.height, 240);
  assert.ok(Math.abs(playback.duration - 4) < 0.06, `decoded duration ${playback.duration}s`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);
  // The browser's own decode at each clip's timeline position (colour of the first clip's trim, the conformed second clip, the graphic).
  const sample = (frame, x, y) => video.evaluate(async (element, [targetFrame, px, py]) => {
    element.pause();
    await new Promise((resolveSeek, rejectSeek) => {
      element.addEventListener("seeked", () => resolveSeek(), { once: true });
      setTimeout(() => rejectSeek(new Error("seek timed out")), 10_000);
      element.currentTime = (targetFrame + 0.5) / 25;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(element, 0, 0, 320, 240);
    const { data } = context.getImageData(px, py, 1, 1);
    return [data[0], data[1], data[2]];
  }, [frame, x, y]);
  const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 30);
  const probes = [
    [10, 250, 60, [0, 255, 0], "first clip (green second of the trimmed 25 fps source)"],
    [35, 250, 60, [0, 0, 255], "first clip (blue second)"],
    [60, 250, 60, [255, 255, 255], "second clip (30 fps, 640x360 conformed) white"],
    [85, 250, 60, [0, 0, 0], "second clip black"],
    [60, 250, 5, [0, 0, 0], "letterbox bar of the conformed clip"],
    [60, 30, 110, [255, 0, 255], "overlay graphic inside its window"],
    [35, 30, 110, [0, 0, 255], "no overlay before its window"],
  ];
  const sampled = [];
  for (const [frame, x, y, expected, label] of probes) {
    const actual = await sample(frame, x, y);
    sampled.push({ label, actual });
    assert.ok(near(actual, expected), `${label}: frame ${frame} pixel ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
  // The independent check of the registered bytes: the downloaded-equivalent digest of what the page verified.
  const registered = await page.evaluate(async ({ id, version, tokenValue }) => {
    const response = await fetch(`/dev/v1/artifacts/${id}/content`, { headers: { Authorization: `Bearer ${tokenValue}`, "If-Match": version } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { status: response.status, digest: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
  }, { id: created.artifact.artifactId, version: created.artifact.artifactVersionId, tokenValue: token });
  assert.equal(registered.status, 200);
  assert.equal(registered.digest, created.artifact.sha256);

  // 8. Replay: the same request again returns the registered artifact (200) instead of a second one.
  const replayPost = page.waitForResponse(isPost("/dev/v1/composite-renders"), { timeout: 60_000 });
  await page.getByRole("button", { name: "Render finished master" }).click();
  const replay = await replayPost;
  assert.equal(replay.status(), 200, await replay.text());
  assert.equal((await replay.json()).renderId, created.renderId);
  assert.equal(JSON.parse(replay.request().postData()).requestId, renderBody.requestId, "an unchanged request reuses its requestId");

  // 9. Accessibility and responsiveness.
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
  assert.ok(audit.tables.length >= 1 && audit.tables.every((t) => t.caption && t.scoped));
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
  const renderBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/composite-renders").map((entry) => JSON.parse(entry.body));
  process.stdout.write(`${JSON.stringify({
    event: "composited", renderId: created.renderId, artifactSha256: created.artifact.sha256, sizeBytes: created.artifact.sizeBytes,
    frameCount: created.lineage.frameCount, playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced,
    sampled, requestIds: renderBodies.map((body) => body.requestId), headRevision: placedHead,
  })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
