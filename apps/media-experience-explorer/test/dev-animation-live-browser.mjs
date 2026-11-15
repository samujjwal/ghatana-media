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
const token = requiredEnv("MEDIA_DEV_ANIM_BROWSER_TOKEN");
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

const assetOkId = requiredEnv("MEDIA_DEV_ANIM_ASSET_OK_ID");
const assetOkVersion = requiredEnv("MEDIA_DEV_ANIM_ASSET_OK_VERSION");
const assetDeniedId = requiredEnv("MEDIA_DEV_ANIM_ASSET_DENIED_ID");
const assetDeniedVersion = requiredEnv("MEDIA_DEV_ANIM_ASSET_DENIED_VERSION");
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
delete viteEnvironment.MEDIA_DEV_ANIM_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The easing math the page's example scene is authored with (box: ease-in-out then ease-out), independent of the page code.
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const boxOffset = (frame) => (frame <= 24 ? 200 * easeInOut(frame / 24) : 200 + (100 - 200) * easeOut((frame - 24) / 23));

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-animation.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual animation page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The deliberate typed 422/403 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (422|403)/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const renderPost = (timeout = 120_000) => page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/animations/renders"
    && response.request().method() === "POST", { timeout });

  // 1. Connect; the limits come FROM THE HOST (captured from the real response).
  await page.goto(`${baseUrl}/dev-animation.html`, { waitUntil: "networkidle" });
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-animation.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/animations/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "2D animation", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.ready, true);
  const line = await page.locator("[data-status-line]").textContent();
  assert.ok(line.includes(`${status.limits.maxWidth} by ${status.limits.maxHeight} pixels, ${status.limits.maxFrames} frames`), line);
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");

  // 2. Preview by KEYBOARD: focus the frame slider, press End; the text description and the canvas follow the easing math.
  await page.locator("#animation-preview-frame").focus();
  await page.keyboard.press("End");
  const description = await page.locator("[data-preview-description]").textContent();
  assert.ok(description.includes("box: offset 100.00, 0.00"), description);
  assert.ok(description.includes("ball: offset 0.00, 60.00; scale 1.50 by 1.50"), description);
  await page.locator("#animation-preview-frame").fill("12");
  const mid = await page.locator("[data-preview-description]").textContent();
  assert.ok(mid.includes(`box: offset ${boxOffset(12).toFixed(2)}, 0.00`), mid);
  const previewPixel = await page.locator("canvas.animation-canvas").evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(40 + 100, 40, 1, 1).data; // box at frame 12 is offset 100: its centre
    return [data[0], data[1], data[2]];
  });
  assert.ok(previewPixel[0] > 200 && previewPixel[1] < 100, `the preview draws the box at its eased position: ${previewPixel}`);

  // 3. Invalid scene: the host's typed 422 names the JSON path; focus moves to that field.
  await page.locator("#animation-shape-0-key-1-frame").fill("0");
  const invalidPost = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  const invalidResponse = await invalidPost;
  assert.equal(invalidResponse.status(), 422, await invalidResponse.text());
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.error.code, "ANIMATION_SPEC_INVALID");
  assert.equal(invalidBody.error.details.path, "$.shapes[0].keyframes[1].frame");
  const invalidFailure = page.locator('[data-failure-code="ANIMATION_SPEC_INVALID"]');
  await invalidFailure.waitFor({ timeout: 15_000 });
  assert.equal(await invalidFailure.getAttribute("data-failure-path"), "$.shapes[0].keyframes[1].frame");
  await page.waitForFunction(() => document.activeElement?.id === "animation-shape-0-key-1-frame", null, { timeout: 5_000 });
  assert.equal(await page.locator("[data-render-result]").count(), 0, "nothing was rendered");
  await page.locator("#animation-shape-0-key-1-frame").fill("24");

  // 4. Over budget: 241 frames is a typed 422 with the ceiling; the page shows it and renders nothing.
  await page.locator("#animation-frame-count").fill("241");
  const budgetPost = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  const budgetResponse = await budgetPost;
  assert.equal(budgetResponse.status(), 422);
  assert.equal((await budgetResponse.json()).error.code, "ANIMATION_BUDGET_EXCEEDED");
  const budgetFailure = page.locator('[data-failure-code="ANIMATION_BUDGET_EXCEEDED"]');
  await budgetFailure.waitFor({ timeout: 15_000 });
  assert.ok((await budgetFailure.textContent()).includes("requested 241"), await budgetFailure.textContent());
  await page.locator("#animation-frame-count").fill("48");

  // 5. Image asset without a rights statement: typed 403, shown with its path; nothing is rendered.
  await page.getByRole("button", { name: "Add a shape" }).click();
  await page.locator("#animation-shape-2-primitive").selectOption("RASTER_ASSET");
  await page.locator("#animation-shape-2-id").fill("pic");
  await page.locator("#animation-shape-2-x").fill("24");
  await page.locator("#animation-shape-2-y").fill("110");
  await page.locator("#animation-shape-2-width").fill("32");
  await page.locator("#animation-shape-2-height").fill("32");
  await page.locator("#animation-shape-2-asset").fill("sticker");
  await page.getByRole("button", { name: "Add an image asset" }).click();
  await page.locator("#animation-asset-0-id").fill("sticker");
  await page.locator("#animation-asset-0-artifact").fill(assetDeniedId);
  await page.locator("#animation-asset-0-version").fill(assetDeniedVersion);
  const deniedPost = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  const deniedResponse = await deniedPost;
  assert.equal(deniedResponse.status(), 403, await deniedResponse.text());
  const deniedBody = await deniedResponse.json();
  assert.equal(deniedBody.error.code, "RIGHTS_NOT_ADMITTED");
  assert.equal(deniedBody.error.details.verdict, "DENIED");
  const denied = page.locator('[data-failure-code="RIGHTS_NOT_ADMITTED"]');
  await denied.waitFor({ timeout: 15_000 });
  assert.equal(await denied.getAttribute("data-failure-tone"), "denied");
  assert.ok((await denied.textContent()).includes("Nothing was read, rendered or registered"));
  assert.equal(await page.locator("[data-render-result]").count(), 0);

  // 6. The attested asset: render, then the host's verified result.
  await page.locator("#animation-asset-0-artifact").fill(assetOkId);
  await page.locator("#animation-asset-0-version").fill(assetOkVersion);
  const okPost = renderPost(180_000);
  await page.getByRole("button", { name: "Render", exact: true }).click();
  const okResponse = await okPost;
  assert.equal(okResponse.status(), 201, await okResponse.text());
  const created = await okResponse.json();
  const sent = JSON.parse(okResponse.request().postData());
  assert.match(sent.requestId, /^anim-/u);
  assert.deepEqual(sent.encoder, { crf: 14 });
  assert.equal(sent.spec.assets[0].artifactId, assetOkId);
  const result = page.locator("[data-render-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "animation-result-title", null, { timeout: 5_000 });
  const summary = await result.locator("[data-render-summary]").textContent();
  assert.ok(summary.includes("48 frames of 320 by 180 at 24/1"), summary);
  assert.ok((await result.locator("[data-verification]").textContent()).includes("every frame time exact: yes"));
  assert.equal((await result.locator("[data-frame-set-sha256]").textContent()), created.manifest.frameSetSha256);
  await result.locator("summary").click();
  assert.equal(await result.locator("[data-frame-table] tbody tr").count(), 48);
  assert.ok((await result.locator('tr[data-frame-index="24"]').textContent()).includes("12816"), "frame 24 is at tick 12816 (24 x 534)");

  // 7. Verified playback in a real <video>: the bytes are hashed against the registered digest before the element exists.
  assert.equal(await result.locator("video").count(), 0, "no video before verification");
  await result.getByRole("button", { name: /^Load the video/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  const verifiedText = await result.locator("[data-playback-status]").textContent();
  assert.ok(verifiedText.includes(created.video.sha256), "the verified message carries the registered digest");
  const video = result.locator("video[data-verified-preview='animation-video']");
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
  assert.equal(playback.height, 180);
  assert.ok(Math.abs(playback.duration - 2) < 0.05, `decoded duration ${playback.duration}s is 48 frames at 24 fps`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);

  // The browser's own decode of sampled frames matches the easing math (box left edge, +-2 px for YUV420 chroma and seek rounding).
  const seeks = [];
  for (const frame of [0, 12, 24, 36, 47]) {
    const measured = await video.evaluate(async (element, targetFrame) => {
      element.pause();
      await new Promise((resolveSeek, rejectSeek) => {
        element.addEventListener("seeked", () => resolveSeek(), { once: true });
        setTimeout(() => rejectSeek(new Error("seek timed out")), 10_000);
        element.currentTime = (targetFrame + 0.5) / 24;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(element, 0, 0, 320, 180);
      const { data } = context.getImageData(0, 0, 320, 180);
      for (let x = 0; x < 320; x += 1) {
        let hits = 0;
        for (let y = 20; y < 60; y += 1) {
          const i = (y * 320 + x) * 4;
          if (data[i] > 170 && data[i + 1] < 120 && data[i + 2] < 120) hits += 1;
        }
        if (hits >= 20) return x;
      }
      return -1;
    }, frame);
    const expected = Math.ceil(20 + boxOffset(frame) - 0.5);
    seeks.push({ frame, expected, measured });
    assert.ok(Math.abs(measured - expected) <= 2, `frame ${frame}: box left edge ${measured} vs easing math ${expected}`);
  }

  // 8. The same scene again is a replay under the same request identifier: no second video.
  const replayPost = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  const replayResponse = await replayPost;
  assert.equal(replayResponse.status(), 200, await replayResponse.text());
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.renderId, created.renderId);
  assert.equal(JSON.parse(replayResponse.request().postData()).requestId, sent.requestId);
  await result.getByText(/Replayed: the same request identifier/u).waitFor({ timeout: 15_000 });

  // 9. Accessibility structure.
  const audit = await page.evaluate(() => {
    const unlabelled = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((element) => {
      const labelled = element.labels?.length > 0 || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
      return !labelled;
    }).map((element) => element.id || element.name);
    const tables = [...document.querySelectorAll("table")].map((table) => ({
      caption: !!table.querySelector("caption")?.textContent?.trim(), scopedHeaders: table.querySelectorAll("thead th[scope=col]").length > 0 }));
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const unnamedButtons = [...document.querySelectorAll("button")].filter((button) => !button.textContent?.trim()).length;
    const regions = [...document.querySelectorAll("[role=region]")].filter((region) => !region.getAttribute("aria-label")).length;
    const canvasAlt = document.querySelector("canvas")?.getAttribute("aria-label");
    const groups = [...document.querySelectorAll("fieldset")].filter((group) => !group.querySelector(":scope > legend")).length;
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, regions, canvasAlt, groups,
      lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 1 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.equal(audit.groups, 0, "every fieldset has a legend");
  assert.ok(audit.canvasAlt?.startsWith("Approximate preview of frame"), "the preview canvas has a text alternative");
  assert.equal(audit.lang, "en");
  const focusRing = await page.evaluate(() => { document.querySelector("#animation-width").focus(); const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);

  // 10. Responsive: a phone viewport has no horizontal page scroll and comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=range]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const renderBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/animations/renders").map((entry) => JSON.parse(entry.body));
  assert.equal(renderBodies.length, 5);
  assert.equal(new Set(renderBodies.map((body) => body.requestId)).size, 4, "each different scene gets a fresh identifier; the replay reuses one");
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${created.video.artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}`, "If-Match": created.video.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), created.video.sha256);
  process.stdout.write(`${JSON.stringify({
    event: "animated", renderId: created.renderId, videoId: created.video.artifactId, videoSha256: created.video.sha256,
    frameSetSha256: created.manifest.frameSetSha256, playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced,
    videoWidth: playback.width, videoHeight: playback.height, seeks, requestIds: renderBodies.map((body) => body.requestId),
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
