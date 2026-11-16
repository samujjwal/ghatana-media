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
const token = requiredEnv("MEDIA_DEV_RIG_BROWSER_TOKEN");
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

const assetOkId = requiredEnv("MEDIA_DEV_RIG_ASSET_OK_ID");
const assetOkVersion = requiredEnv("MEDIA_DEV_RIG_ASSET_OK_VERSION");
const assetDeniedId = requiredEnv("MEDIA_DEV_RIG_ASSET_DENIED_ID");
const assetDeniedVersion = requiredEnv("MEDIA_DEV_RIG_ASSET_DENIED_VERSION");
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
delete viteEnvironment.MEDIA_DEV_RIG_BROWSER_TOKEN;
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
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-rig.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual rig page:\n${viteOutput}`);

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
  const renderPost = (timeout = 120_000) => page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/rigs/renders"
    && response.request().method() === "POST", { timeout });
  const specField = page.locator("#rig-spec");
  await page.goto(`${baseUrl}/dev-rig.html`, { waitUntil: "networkidle" });

  // 1. Connect; the limits come FROM THE HOST.
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-rig.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/rigs/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "3D rig", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.ready, true);
  const line = await page.locator("[data-status-line]").textContent();
  assert.ok(line.includes(`${status.limits.maxWidth} by ${status.limits.maxHeight} pixels, ${status.limits.maxFrames} frames, ${status.limits.maxBones} bones`), line);
  const sampleText = await specField.inputValue();
  const sample = JSON.parse(sampleText);
  const setSpec = async (spec) => specField.fill(JSON.stringify(spec, null, 2));
  const clone = () => JSON.parse(sampleText);
  const failureOf = async (code) => {
    const failure = page.locator(`[data-failure-code="${code}"]`);
    await failure.waitFor({ timeout: 15_000 });
    return failure;
  };

  // 2. Not valid JSON: nothing is sent.
  const requestsBefore = apiRequests.filter((entry) => entry.method === "POST").length;
  await specField.fill("{ not json");
  await page.getByRole("button", { name: "Render", exact: true }).click();
  await page.locator("[data-parse-error]").waitFor({ timeout: 5_000 });
  assert.equal(apiRequests.filter((entry) => entry.method === "POST").length, requestsBefore, "an unparseable spec is never sent");
  await page.waitForFunction(() => document.activeElement?.id === "rig-spec", null, { timeout: 5_000 });

  // 3. Joint limit: shoulder limited to 120 degrees, keyframe asks for 125. The host's typed 422 names the JSON path.
  const over = clone();
  over.bones[0].keyframes[1].rotation.degrees = 125;
  await setSpec(over);
  let post = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  let response = await post;
  assert.equal(response.status(), 422, await response.text());
  let body = await response.json();
  assert.equal(body.error.code, "JOINT_LIMIT_EXCEEDED");
  assert.equal(body.error.details.path, "$.bones[0].keyframes[1].rotation");
  let failure = await failureOf("JOINT_LIMIT_EXCEEDED");
  assert.equal(await failure.getAttribute("data-failure-path"), "$.bones[0].keyframes[1].rotation");
  await page.waitForFunction(() => document.activeElement?.id === "rig-spec", null, { timeout: 5_000 });
  assert.equal(await page.locator("[data-render-result]").count(), 0, "nothing was rendered");

  // 4. Left-handed frame: unsupported convention, with its path.
  const left = clone();
  left.coordinateFrame.handedness = "LEFT_HANDED";
  await setSpec(left);
  post = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  response = await post;
  assert.equal(response.status(), 422);
  failure = await failureOf("COORDINATE_PROFILE_UNSUPPORTED");
  assert.equal(await failure.getAttribute("data-failure-path"), "$.coordinateFrame.handedness");

  // 5. Over budget.
  const big = clone();
  big.frameCount = 241;
  await setSpec(big);
  post = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  response = await post;
  assert.equal(response.status(), 422);
  failure = await failureOf("RIG_BUDGET_EXCEEDED");
  assert.ok((await failure.textContent()).includes("requested 241"), await failure.textContent());

  // 6. Floor texture without a rights statement: typed 403 with the path; nothing is rendered.
  const textured = (id, version) => {
    const spec = clone();
    spec.floor.textureAssetId = "floorTexture";
    spec.assets = [{ id: "floorTexture", artifactId: id, artifactVersionId: version }];
    return spec;
  };
  await setSpec(textured(assetDeniedId, assetDeniedVersion));
  post = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  response = await post;
  assert.equal(response.status(), 403, await response.text());
  body = await response.json();
  assert.equal(body.error.code, "RIGHTS_NOT_ADMITTED");
  assert.equal(body.error.details.verdict, "DENIED");
  failure = await failureOf("RIGHTS_NOT_ADMITTED");
  assert.ok((await failure.textContent()).includes("Rights verdict DENIED"));
  assert.equal(await page.locator("[data-render-result]").count(), 0);

  // 7. The attested texture: render, then the host's verified result.
  await setSpec(textured(assetOkId, assetOkVersion));
  post = renderPost(180_000);
  await page.getByRole("button", { name: "Render", exact: true }).click();
  response = await post;
  assert.equal(response.status(), 201, await response.text());
  const created = await response.json();
  const sent = JSON.parse(response.request().postData());
  assert.match(sent.requestId, /^rig-[0-9a-f]{24}$/u);
  assert.equal(sent.spec.assets[0].artifactId, assetOkId);
  const result = page.locator("[data-render-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "rig-result-title", null, { timeout: 5_000 });
  const summary = await result.locator("[data-render-summary]").textContent();
  assert.ok(summary.includes("48 frames of 320 by 240 at 24/1"), summary);
  assert.ok((await result.locator("[data-verification]").textContent()).includes("every frame time exact: yes"));
  assert.equal(await result.locator("[data-frame-set-sha256]").textContent(), created.manifest.frameSetSha256);
  assert.ok((await result.locator("[data-coordinate-frame]").textContent()).includes("RIGHT_HANDED POS_X/POS_Y/POS_Z (Y up), metres"));

  // 8. Joint angles by KEYBOARD: focus the slider, End -> frame 47, Home -> frame 0; keyframe frames show their authored angles.
  assert.equal(await result.locator("video").count(), 0, "no video before verification");
  await page.locator("#rig-frame").focus();
  await page.keyboard.press("Home");
  assert.equal((await result.locator('[data-joint-angle="shoulder"]').textContent()), "0.00");
  await page.locator("#rig-frame").fill("24");
  assert.equal(await result.locator('[data-joint-angle="shoulder"]').textContent(), "55.00");
  assert.equal(await result.locator('[data-joint-angle="elbow"]').textContent(), "80.00");
  await page.keyboard.press("End");
  assert.equal(await result.locator('[data-joint-angle="shoulder"]').textContent(), "15.00", "deviation from rest is an unsigned magnitude");
  assert.equal(await result.locator('[data-joint-angle="wrist"]').textContent(), "60.00");
  for (const bone of sample.bones) {
    const limit = await result.locator(`tr[data-bone="${bone.id}"] td`).nth(1).textContent();
    assert.equal(limit, String(bone.maxDeviationDegrees));
  }
  // the displayed angles equal the host manifest, frame by frame
  for (const index of [0, 10, 24, 33, 47]) {
    await page.locator("#rig-frame").fill(String(index));
    for (const bone of sample.bones) {
      const shown = Number(await result.locator(`[data-joint-angle="${bone.id}"]`).textContent());
      const reported = created.manifest.frames[index].jointAnglesDegrees[bone.id];
      assert.ok(Math.abs(shown - reported) < 0.006, `frame ${index} ${bone.id}: ${shown} vs ${reported}`);
    }
  }

  // 9. Verified playback in a real <video>; the browser's OWN decode shows the marker where the host projected the end effector.
  await result.getByRole("button", { name: /^Load the video/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  assert.ok((await result.locator("[data-playback-status]").textContent()).includes(created.video.sha256));
  const video = result.locator("video[data-verified-preview='rig-video']");
  await video.waitFor({ timeout: 10_000 });
  assert.match(await video.getAttribute("src"), /^blob:/u);
  assert.equal(await video.getAttribute("aria-label"), "Rendered 3D rig animation");
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
  assert.ok(Math.abs(playback.duration - 2) < 0.05, `decoded duration ${playback.duration}s is 48 frames at 24 fps`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);
  const seeks = [];
  for (const frame of [0, 12, 24, 36, 47]) {
    // the slider seeks the video to the frame centre; the page reports the host's projected end-effector pixel
    await page.locator("#rig-frame").fill(String(frame));
    await video.evaluate((element) => new Promise((resolveSeek) => {
      if (!element.seeking) return resolveSeek();
      element.addEventListener("seeked", () => resolveSeek(), { once: true });
      setTimeout(resolveSeek, 5_000);
    }));
    await delay(150);
    const measured = await video.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 240;
      const context2d = canvas.getContext("2d", { willReadFrequently: true });
      context2d.drawImage(element, 0, 0, 320, 240);
      const { data } = context2d.getImageData(0, 0, 320, 240);
      let sx = 0; let sy = 0; let n = 0;
      for (let y = 0; y < 240; y += 1) for (let x = 0; x < 320; x += 1) {
        const i = (y * 320 + x) * 4;
        if (data[i] > 170 && data[i + 1] < 110 && data[i + 2] > 170) { sx += x + 0.5; sy += y + 0.5; n += 1; }
      }
      return n === 0 ? null : { x: sx / n, y: sy / n, n };
    });
    const expected = created.manifest.frames[frame].endEffector.pixel;
    assert.ok(measured, `marker pixels in the browser's decode of frame ${frame}`);
    const error = Math.hypot(measured.x - expected.x, measured.y - expected.y);
    seeks.push({ frame, expected: [expected.x, expected.y], measured: [measured.x, measured.y], errorPx: error });
    assert.ok(error <= 2, `frame ${frame}: browser-decoded marker (${measured.x}, ${measured.y}) vs projected (${expected.x}, ${expected.y})`);
    const shown = await page.locator("[data-end-effector]").textContent();
    assert.ok(shown.includes(`pixel ${expected.x.toFixed(2)}, ${expected.y.toFixed(2)}`), shown);
  }

  // 10. The GLB export: bytes verified against the registered digest, header and nodes parsed in the browser.
  await result.getByRole("button", { name: "Verify the GLB export" }).click();
  await result.getByText(/GLB 2\.0 verified/u).waitFor({ timeout: 30_000 });
  const glbText = await result.locator("[data-glb-status]").textContent();
  assert.ok(glbText.includes(created.glb.sha256) && glbText.includes("3 nodes (elbow, shoulder, wrist)") && glbText.includes("6 animation channels")
    && glbText.includes("RIGHT_HANDED POS_X/POS_Y/POS_Z"), glbText);

  // 11. The same spec again is a replay under the same request identifier: no second set of artifacts.
  post = renderPost();
  await page.getByRole("button", { name: "Render", exact: true }).click();
  response = await post;
  assert.equal(response.status(), 200, await response.text());
  const replay = await response.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.renderId, created.renderId);
  assert.equal(JSON.parse(response.request().postData()).requestId, sent.requestId);
  await result.getByText(/Replayed: the same request identifier/u).waitFor({ timeout: 15_000 });

  // 12. Accessibility structure.
  const audit = await page.evaluate(() => {
    const unlabelled = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((element) => {
      const labelled = element.labels?.length > 0 || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
      return !labelled;
    }).map((element) => element.id || element.name);
    const tables = [...document.querySelectorAll("table")].map((table) => ({
      caption: !!table.querySelector("caption")?.textContent?.trim(), scopedHeaders: table.querySelectorAll("thead th[scope=col]").length > 0 }));
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const unnamedButtons = [...document.querySelectorAll("button")].filter((button) => !button.textContent?.trim()).length;
    const regions = [...document.querySelectorAll("[role=region]")].filter((region) => !region.getAttribute("aria-label") && !region.getAttribute("aria-labelledby")).length;
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, regions,
      lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 1 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.equal(audit.lang, "en");
  const focusRing = await page.evaluate(() => { document.querySelector("#rig-spec").focus(); const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);

  // 13. Responsive: a phone viewport has no horizontal page scroll and comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=range]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const renderBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/rigs/renders").map((entry) => JSON.parse(entry.body));
  assert.equal(renderBodies.length, 6);
  assert.equal(new Set(renderBodies.map((entry) => entry.requestId)).size, 5, "each different spec gets a fresh identifier; the replay reuses one");
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${created.video.artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}`, "If-Match": created.video.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), created.video.sha256);
  process.stdout.write(`${JSON.stringify({
    event: "rigged", renderId: created.renderId, videoId: created.video.artifactId, videoSha256: created.video.sha256,
    glbId: created.glb.artifactId, glbSha256: created.glb.sha256, frameSetSha256: created.manifest.frameSetSha256,
    playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced, videoWidth: playback.width,
    videoHeight: playback.height, seeks, requestIds: renderBodies.map((entry) => entry.requestId),
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
