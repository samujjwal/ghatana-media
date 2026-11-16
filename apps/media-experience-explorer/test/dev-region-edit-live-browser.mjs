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
const token = requiredEnv("MEDIA_DEV_REGION_BROWSER_TOKEN");
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

const videoId = requiredEnv("MEDIA_DEV_REGION_VIDEO_ID");
const videoVersion = requiredEnv("MEDIA_DEV_REGION_VIDEO_VERSION");
const tracksId = requiredEnv("MEDIA_DEV_REGION_TRACKS_ID");
const tracksVersion = requiredEnv("MEDIA_DEV_REGION_TRACKS_VERSION");
const trackId = requiredEnv("MEDIA_DEV_REGION_TRACK_ID");
const lineageId = requiredEnv("MEDIA_DEV_REGION_LINEAGE_ID");
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
delete viteEnvironment.MEDIA_DEV_REGION_BROWSER_TOKEN;
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
      const response = await fetch(`${baseUrl}/dev-region-edit.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual region edit page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  const watch = (target) => {
    target.on("pageerror", (error) => pageErrors.push(error.message));
    // The deliberate typed 409/403 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
    target.on("console", (message) => {
      if (message.type() === "error" && !/status of (409|403|422)/u.test(message.text())) consoleErrors.push(message.text());
    });
    target.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
    });
  };
  watch(page);
  const editsPath = `/dev/v1/region-edits/lineages/${lineageId}/edits`;
  const undoPath = `/dev/v1/region-edits/lineages/${lineageId}/undo`;
  const post = (target, path, timeout = 240_000) => target.waitForResponse((response) => new URL(response.url()).pathname === path
    && response.request().method() === "POST", { timeout });

  async function connect(target, bearer) {
    for (let attempt = 1; ; attempt += 1) {
      await target.goto(`${baseUrl}/dev-region-edit.html`, { waitUntil: "networkidle" });
      const pending = target.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/region-edits/status", { timeout: 45_000 });
      pending.catch(() => {});
      await target.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
      await target.getByRole("button", { name: "Connect", exact: true }).click();
      try { await pending; break; } catch (error) { if (attempt >= 3) throw error; }
    }
    await target.getByRole("heading", { name: "Region edit", level: 2 }).waitFor({ timeout: 30_000 });
  }
  const rowsOf = (target) => target.locator("[data-version-table] tbody tr");

  // 1. Connect; limits come from the host.
  await connect(page, token);
  assert.ok((await page.locator("[data-status-line]").textContent()).includes("Region edits are available"));
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");

  // 2. Create the lineage BY KEYBOARD (Enter submits the form from the last field).
  await page.locator("#region-lineage-id").fill(lineageId);
  await page.locator("#region-video-id").fill(videoId);
  await page.locator("#region-video-version").fill(videoVersion);
  const createdPost = post(page, "/dev/v1/region-edits/lineages", 60_000);
  await page.locator("#region-video-version").press("Enter");
  assert.equal((await createdPost).status(), 201);
  await rowsOf(page).first().waitFor({ timeout: 15_000 });
  assert.equal(await rowsOf(page).count(), 1);
  assert.equal(await page.locator("tr[data-version-number='1']").getAttribute("data-version-kind"), "BASE");
  assert.equal(await page.locator("tr[data-version-number='1']").getAttribute("data-head"), "true");
  assert.equal(await page.getByRole("button", { name: "Undo the last edit" }).isDisabled(), true, "nothing to undo on the original");

  // 3. Apply a PIXELATE (browser-playable preview encode) with the real track.
  await page.locator("#region-tracks-id").fill(tracksId);
  await page.locator("#region-tracks-version").fill(tracksVersion);
  await page.locator("#region-track-id").fill(trackId);
  await page.locator("#region-effect").selectOption("PIXELATE");
  await page.locator("#region-block-size").fill("8");
  await page.locator("#region-padding").fill("6");
  await page.locator("#region-encoder").selectOption("18");
  const editPost = post(page, editsPath);
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  const editResponse = await editPost;
  assert.equal(editResponse.status(), 201, await editResponse.text());
  const edited = await editResponse.json();
  const sent = JSON.parse(editResponse.request().postData());
  assert.match(sent.requestId, /^region-/u);
  assert.equal(sent.baseVersion, 1);
  assert.deepEqual(sent.encoder, { crf: 18 });
  assert.deepEqual(sent.effect, { type: "PIXELATE", blockSize: 8 });
  const result = page.locator("[data-region-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "region-result-title", null, { timeout: 5_000 });
  assert.equal(await rowsOf(page).count(), 2);
  assert.equal(await page.locator("tr[data-version-number='2']").getAttribute("data-version-kind"), "EDIT");
  assert.equal(await page.locator("tr[data-version-number='2']").getAttribute("data-head"), "true");
  const manifest = edited.manifest;
  const summary = await result.locator("[data-edit-summary]").textContent();
  assert.ok(summary.includes(`PIXELATE on ${manifest.maskedFrames} of ${manifest.frames.length} frames`), summary);
  const verification = await result.locator("[data-verification]").textContent();
  assert.ok(verification.includes("every frame time exact: yes"), verification);
  assert.ok(verification.includes("within reported PSNR"), verification);
  assert.ok(verification.includes(`${manifest.verification.outsidePsnrDb} dB`), verification);
  assert.ok((await result.locator("[data-drift]").textContent()).includes(`${manifest.drift.observations} observations`));
  await result.locator("summary").click();
  assert.equal(await result.locator("[data-mask-table] tbody tr").count(), manifest.frames.length);
  const maskedFrames = manifest.frames.filter((frame) => frame.mask);
  assert.ok(maskedFrames.length >= 5, "the track masks several frames");
  const editedVersion = edited.version;

  // 4. Verified playback, then the overlay and the browser-decoded pixels at several manifest frames.
  assert.equal(await result.locator("video").count(), 0, "no video before verification");
  await result.getByRole("button", { name: /^Load the edited video/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 60_000 });
  assert.ok((await result.locator("[data-playback-status]").textContent()).includes(editedVersion.artifact.sha256));
  const video = result.locator("video[data-verified-preview='region-edit-video']");
  await video.waitFor({ timeout: 10_000 });
  await video.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 2) return resolveLoad();
    element.addEventListener("loadeddata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code} ${element.error?.message}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("video data did not load")), 20_000);
  }));
  // The source video (verified against its own digest) in a second, hidden element for the pixel comparison.
  const sourceInfo = await page.evaluate(async ({ id, version, bearer }) => {
    const response = await fetch(`/dev/v1/artifacts/${id}/content`, { headers: { Authorization: `Bearer ${bearer}`, "If-Match": version } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    const element = document.createElement("video");
    element.id = "source-video-for-comparison";
    element.muted = true;
    element.hidden = true;
    element.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    document.body.append(element);
    await new Promise((resolveLoad, rejectLoad) => {
      element.addEventListener("loadeddata", () => resolveLoad(), { once: true });
      element.addEventListener("error", () => rejectLoad(new Error("source video error")), { once: true });
      setTimeout(() => rejectLoad(new Error("source video did not load")), 20_000);
    });
    return { status: response.status, digest, width: element.videoWidth, height: element.videoHeight };
  }, { id: videoId, version: videoVersion, bearer: token });
  assert.equal(sourceInfo.status, 200);
  assert.equal(sourceInfo.digest, videoVersion.replace("sha256:", ""), "the source video the page compares against is the registered original");
  const dims = await video.evaluate((element) => ({ width: element.videoWidth, height: element.videoHeight }));
  assert.deepEqual(dims, { width: sourceInfo.width, height: sourceInfo.height });
  assert.equal(dims.width, manifest.videoGeometry.width);

  const probes = [];
  const picks = [maskedFrames[0], maskedFrames[Math.floor(maskedFrames.length / 2)], maskedFrames.at(-1)];
  const unmasked = manifest.frames.find((frame) => !frame.mask);
  if (unmasked) picks.push(unmasked);
  for (const frame of picks) {
    const seconds = (frame.pts * manifest.videoGeometry.timeBase.num) / manifest.videoGeometry.timeBase.den;
    const measured = await page.evaluate(async ({ time, mask, width, height }) => {
      const edit = document.querySelector("video[data-verified-preview='region-edit-video']");
      const source = document.getElementById("source-video-for-comparison");
      const seek = (element) => new Promise((resolveSeek, rejectSeek) => {
        element.pause();
        element.addEventListener("seeked", () => resolveSeek(), { once: true });
        setTimeout(() => rejectSeek(new Error("seek timed out")), 10_000);
        element.currentTime = time;
      });
      await seek(edit); await seek(source);
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      const read = (element) => {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(element, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const a = read(source); const b = read(edit);
      let inside = 0; let insideN = 0; let outside = 0; let outsideN = 0; let outsideMax = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const diff = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          if (mask && x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height) { inside += diff; insideN += 1; }
          else { outside += diff; outsideN += 1; outsideMax = Math.max(outsideMax, diff); }
        }
      }
      const overlay = document.querySelector("canvas[data-mask-overlay]");
      return { insideMean: insideN ? inside / insideN : 0, outsideMean: outside / outsideN, outsideMax,
        overlayMask: overlay.dataset.mask, overlayFrame: overlay.dataset.frameIndex, shown: document.querySelector("[data-shown-frame]").textContent };
    }, { time: seconds + 0.004, mask: frame.mask, width: dims.width, height: dims.height });
    const expectedMask = frame.mask ? `${frame.mask.x},${frame.mask.y},${frame.mask.width},${frame.mask.height}` : "none";
    probes.push({ frameIndex: frame.frameIndex, expectedMask, ...measured });
    assert.equal(measured.overlayFrame, String(frame.frameIndex), `overlay follows frame ${frame.frameIndex}: ${measured.shown}`);
    assert.equal(measured.overlayMask, expectedMask, `frame ${frame.frameIndex}: overlay equals the manifest mask`);
    assert.ok(measured.outsideMean < 3, `frame ${frame.frameIndex}: outside the mask the browser decodes the same pixels (mean diff ${measured.outsideMean})`);
    if (frame.mask) assert.ok(measured.insideMean > 4, `frame ${frame.frameIndex}: inside the mask the pixels changed (mean diff ${measured.insideMean})`);
  }
  assert.ok(await page.locator("canvas[data-mask-overlay]").evaluate((canvas) => canvas.getAttribute("role") === "img" && !!canvas.getAttribute("aria-label")));

  // 5. Undo by KEYBOARD (Space on the focused button): version 3 restores version 1 and the digest is the original's.
  const undoPost = post(page, undoPath);
  await page.getByRole("button", { name: "Undo the last edit" }).focus();
  await page.keyboard.press("Space");
  const undoResponse = await undoPost;
  assert.equal(undoResponse.status(), 201, await undoResponse.text());
  assert.equal(JSON.parse(undoResponse.request().postData()).baseVersion, 2);
  await page.locator("[data-undo-summary]").waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("[data-head-sha256]").textContent(), videoVersion.replace("sha256:", ""), "undo restored the exact original artifact");
  assert.equal(await page.locator("tr[data-version-number='3']").getAttribute("data-version-kind"), "UNDO");
  assert.ok((await page.locator("tr[data-version-number='3']").textContent()).includes("restores version 1"));
  assert.equal(await rowsOf(page).count(), 3);
  const digestsBefore = await page.locator("[data-version-table] tbody code[title]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
  assert.equal(digestsBefore[2], digestsBefore[0], "version 3 has the same content digest as version 1");

  // 6. Stale conflict: a second browser context moves the head; this page, still on version 3, gets the typed alert.
  const otherContext = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const other = await otherContext.newPage();
  watch(other);
  await connect(other, token);
  await other.locator("#region-lineage-id").fill(lineageId);
  await other.getByRole("button", { name: "Load lineage" }).click();
  await other.locator("[data-version-table]").waitFor({ timeout: 15_000 });
  assert.equal(await other.locator("[data-version-table] tbody tr").count(), 3);
  await other.locator("#region-tracks-id").fill(tracksId);
  await other.locator("#region-tracks-version").fill(tracksVersion);
  await other.locator("#region-track-id").fill(trackId);
  await other.locator("#region-effect").selectOption("BLUR");
  await other.locator("#region-radius").fill("6");
  await other.locator("#region-padding").fill("6");
  await other.locator("#region-encoder").selectOption("18");
  const otherPost = post(other, editsPath);
  await other.getByRole("button", { name: "Apply edit", exact: true }).click();
  assert.equal((await otherPost).status(), 201);
  await other.locator("tr[data-version-number='4']").waitFor({ timeout: 30_000 });
  await otherContext.close();

  await page.locator("#region-effect").selectOption("FILL");
  await page.locator("#region-color").fill("#00AA00");
  const stalePost = post(page, editsPath);
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  const staleResponse = await stalePost;
  assert.equal(staleResponse.status(), 409, await staleResponse.text());
  const staleBody = await staleResponse.json();
  assert.equal(staleBody.error.code, "STALE_BASE_VERSION");
  assert.equal(JSON.parse(staleResponse.request().postData()).baseVersion, 3);
  const stale = page.locator('[data-failure-code="STALE_BASE_VERSION"]');
  await stale.waitFor({ timeout: 15_000 });
  assert.equal(await stale.getAttribute("data-failure-tone"), "conflict");
  assert.ok((await stale.locator("[data-stale]").textContent()).includes("Sent against version 3; the head is version 4."));
  assert.equal(await rowsOf(page).count(), 3, "the stale request added no version");
  assert.equal(await page.locator("[data-region-result]").count(), 0, "a refused edit shows no result");
  await delay(1500);
  assert.equal(apiRequests.filter((entry) => entry.method === "POST" && entry.path === editsPath && JSON.parse(entry.body).baseVersion === 3
    && JSON.parse(entry.body).effect.type === "FILL").length, 1, "the page never retries a stale request on its own");
  const reload = page.locator('[data-failure-code="STALE_BASE_VERSION"]').getByRole("button", { name: "Reload lineage" });
  await reload.focus();
  await page.keyboard.press("Enter");
  await page.locator("tr[data-version-number='4']").waitFor({ timeout: 15_000 });
  assert.equal(await rowsOf(page).count(), 4);
  assert.equal(await page.locator("tr[data-version-number='4']").getAttribute("data-head"), "true");
  assert.equal(await page.locator('[data-failure-code]').count(), 0);
  const digestsAfter = await page.locator("[data-version-table] tbody code[title]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));

  // 7. Host restart: the history is durable; reconnect with a fresh token and reload.
  emit({ event: "ready-for-restart", digests: digestsAfter });
  const restarted = await nextLine("host-restarted ");
  const freshToken = restarted.slice("host-restarted ".length).trim();
  await page.getByRole("button", { name: "Forget token" }).click();
  await connect(page, freshToken);
  await page.locator("#region-lineage-id").fill(lineageId);
  await page.getByRole("button", { name: "Load lineage" }).click();
  await page.locator("[data-version-table]").waitFor({ timeout: 30_000 });
  assert.equal(await rowsOf(page).count(), 4);
  const digestsRestart = await page.locator("[data-version-table] tbody code[title]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
  assert.deepEqual(digestsRestart, digestsAfter, "the same versions with the same digests after the host restarted");

  // 8. Rights revoked by the host test: the next edit is a typed denial and registers nothing.
  emit({ event: "ready-for-revoke" });
  await nextLine("rights-revoked");
  await page.locator("#region-tracks-id").fill(tracksId);
  await page.locator("#region-tracks-version").fill(tracksVersion);
  await page.locator("#region-track-id").fill(trackId);
  await page.locator("#region-effect").selectOption("BLUR");
  await page.locator("#region-radius").fill("4");
  const deniedPost = post(page, editsPath);
  await page.getByRole("button", { name: "Apply edit", exact: true }).click();
  const deniedResponse = await deniedPost;
  assert.equal(deniedResponse.status(), 403, await deniedResponse.text());
  assert.equal((await deniedResponse.json()).error.code, "RIGHTS_DECISION_REVOKED");
  assert.equal(JSON.parse(deniedResponse.request().postData()).baseVersion, 4);
  const denied = page.locator('[data-failure-code="RIGHTS_DECISION_REVOKED"]');
  await denied.waitFor({ timeout: 15_000 });
  assert.equal(await denied.getAttribute("data-failure-tone"), "denied");
  assert.ok((await denied.textContent()).includes("Nothing was read, rendered or registered"));
  assert.equal(await rowsOf(page).count(), 4);
  assert.equal(await page.locator("[data-region-result]").count(), 0);

  // 9. Accessibility structure and responsiveness.
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
    const groups = [...document.querySelectorAll("fieldset")].filter((group) => !group.querySelector(":scope > legend")).length;
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, regions, groups, lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 1 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.equal(audit.groups, 0, "every fieldset has a legend");
  assert.equal(audit.lang, "en");
  const focusRing = await page.evaluate(() => { document.querySelector("#region-padding").focus(); const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=range]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}` || entry.headers.authorization === `Bearer ${freshToken}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token) && !stored.includes(freshToken), "token must never be persisted");
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${editedVersion.artifact.artifactId}/content`, {
    headers: { Authorization: `Bearer ${freshToken}`, "If-Match": editedVersion.artifact.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), editedVersion.artifact.sha256);
  emit({ event: "region-edited", lineageId, editedArtifactId: editedVersion.artifact.artifactId, editedSha256: editedVersion.artifact.sha256,
    maskedFrames: manifest.maskedFrames, probes, digests: digestsRestart, requestIds: apiRequests.filter((entry) => entry.method === "POST").map((entry) => JSON.parse(entry.body).requestId) });
} finally {
  if (browser) await browser.close();
  stdinLines.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
