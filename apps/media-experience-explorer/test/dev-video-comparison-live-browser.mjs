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
const token = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_TOKEN");
const referenceId = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_REFERENCE_ID");
const referenceSha = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_REFERENCE_SHA256");
const degradedId = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_DEGRADED_ID");
const degradedSha = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_DEGRADED_SHA256");
const enhancedId = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_ENHANCED_ID");
const enhancedSha = requiredEnv("MEDIA_DEV_VIDEO_BROWSER_ENHANCED_SHA256");
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

const vitePort = positivePort(requiredEnv("MEDIA_DEV_VIDEO_BROWSER_VITE_PORT"));
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_VIDEO_BROWSER_TOKEN;
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
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-video-comparison.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual video comparison page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 2200 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  });

  async function connect(bearer) {
    await page.goto(`${baseUrl}/dev-video-comparison.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: /Video comparison · DEV_ONLY/u }).waitFor({ timeout: 120_000 });
    } catch (error) {
      const connection = await page.locator("#connection-status").textContent().catch(() => "<unreadable>");
      throw new Error(`The comparison panel did not render. status=${JSON.stringify(connection)} pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors)}`, { cause: error });
    }
  }
  async function fillForm(baseline, baselineSha, candidate, candidateSha) {
    await page.getByLabel("Clean reference artifact ID (optional)").fill(referenceId);
    await page.getByLabel("Clean reference exact version (optional)").fill(`sha256:${referenceSha}`);
    await page.getByLabel("Baseline artifact ID").fill(baseline);
    await page.getByLabel("Baseline exact version").fill(`sha256:${baselineSha}`);
    await page.getByLabel("Candidate artifact ID").fill(candidate);
    await page.getByLabel("Candidate exact version").fill(`sha256:${candidateSha}`);
  }
  const result = page.locator("#video-result");

  // Independent read of the registered comparison document straight from the host (the page's own view is checked
  // against it): exact version in If-Match, bearer in a header.
  async function fetchDocument(bearer, outputId, version) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/dev/v1/artifacts/${encodeURIComponent(outputId)}/content`, {
      headers: { Authorization: `Bearer ${bearer}`, "If-Match": version },
    });
    assert.equal(response.status, 200, `document read ${response.status}`);
    return JSON.parse(await response.text());
  }

  await connect(token);
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- Measure the exact versions (clean reference + degraded vs enhanced) ----
  await fillForm(degradedId, degradedSha, enhancedId, enhancedSha);
  await page.getByRole("button", { name: "Measure exact versions" }).click();
  await page.locator("#video-compare-status", { hasText: "Measured (HTTP 201)" }).waitFor({ timeout: 600_000 });
  const outputId = await result.getAttribute("data-output-id");
  assert.ok(outputId && ![referenceId, degradedId, enhancedId].includes(outputId), "the comparison must be a NEW artifact");
  const outputSha = (await result.locator("dt", { hasText: "SHA-256" }).first().locator("xpath=following-sibling::dd[1]").textContent()).trim();
  assert.match(outputSha, /^[0-9a-f]{64}$/u);
  const doc = await fetchDocument(token, outputId, `sha256:${outputSha}`);
  assert.equal(doc.schema, "media.dev.video-comparison.v1");
  const [baseSubject, candSubject] = doc.subjects;
  assert.equal(baseSubject.source.sha256, degradedSha);
  assert.equal(candSubject.source.sha256, enhancedSha);
  assert.equal(doc.reference.sha256, referenceSha);

  // The aggregate table shows exactly the registered numbers; a regression would show as a negative delta.
  const rows = page.getByRole("table", { name: "Measured aggregates" }).locator("tbody tr");
  assert.equal(await rows.count(), 2);
  const rowText = async (index) => (await rows.nth(index).innerText()).replace(/\s+/gu, " ");
  assert.ok((await rowText(0)).includes(`${baseSubject.againstReference.meanPsnrY.toFixed(2)} dB`), await rowText(0));
  assert.ok((await rowText(1)).includes(`${candSubject.againstReference.meanPsnrY.toFixed(2)} dB`), await rowText(1));
  assert.ok((await rowText(1)).includes(candSubject.againstReference.meanSsimY.toFixed(4)), await rowText(1));
  const displayedDelta = (await page.locator(".video-delta").first().innerText()).trim();
  const delta = doc.comparisons[0];
  assert.equal(delta.verdict, "IMPROVED");
  assert.ok(displayedDelta.startsWith("candidate vs baseline: IMPROVED"), displayedDelta);
  assert.ok(candSubject.againstReference.meanPsnrY - baseSubject.againstReference.meanPsnrY >= 2.0,
    `measured PSNR gain ${candSubject.againstReference.meanPsnrY - baseSubject.againstReference.meanPsnrY}`);

  // ---- The two videos come only from verified bytes and are playable ----
  const videos = page.locator("section.vwc video");
  assert.equal(await videos.count(), 2);
  for (let i = 0; i < 2; i += 1) {
    assert.match(await videos.nth(i).getAttribute("src"), /^blob:/u, "videos are shown only from verified bytes (blob URL)");
    await videos.nth(i).evaluate((element) => element.readyState >= 1 ? undefined : new Promise((resolveLoad, rejectLoad) => {
      element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
      element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code}`)), { once: true });
      setTimeout(() => rejectLoad(new Error("video metadata did not load")), 20_000);
    }));
    assert.deepEqual(await videos.nth(i).evaluate((element) => [element.videoWidth, element.videoHeight]), [640, 360]);
  }

  // ---- Wipe slider: keyboard operable, text alternative, real clip applied ----
  const wipe = page.getByRole("slider", { name: /^Wipe position/u });
  await wipe.focus();
  assert.equal(await wipe.getAttribute("aria-valuetext"), "50% candidate, 50% baseline");
  await page.keyboard.press("ArrowRight");
  assert.equal(await wipe.getAttribute("aria-valuetext"), "51% candidate, 49% baseline");
  await page.keyboard.press("Home");
  assert.equal(await wipe.getAttribute("aria-valuetext"), "0% candidate, 100% baseline");
  await page.keyboard.press("End");
  assert.equal(await wipe.getAttribute("aria-valuetext"), "100% candidate, 0% baseline");
  await wipe.fill("25");
  const clip = await page.locator(".vwc-cand").evaluate((element) => getComputedStyle(element).clipPath);
  assert.match(clip, /inset\(0(px|%)? 75%/u, `clip-path ${clip}`);
  await wipe.fill("50");

  // ---- Frame stepping lands on the exact measured presentation times and announces both subjects' numbers ----
  const status = page.locator("#vwc-frame-status");
  assert.equal(await status.getAttribute("aria-live"), "polite");
  const seekSettled = async () => page.evaluate(async () => {
    const list = [...document.querySelectorAll("section.vwc video")];
    await Promise.all(list.map((video) => new Promise((resolveSeek) => {
      if (!video.seeking) { resolveSeek(); return; }
      video.addEventListener("seeked", () => resolveSeek(), { once: true });
    })));
    await new Promise((r) => setTimeout(r, 250));
  });
  for (let k = 1; k <= 3; k += 1) await page.getByRole("button", { name: "Next frame" }).click();
  await seekSettled();
  const f3 = { base: baseSubject.frames[3], cand: candSubject.frames[3] };
  assert.equal(await status.getAttribute("data-frame-index"), "3");
  const statusText = await status.innerText();
  assert.ok(statusText.includes(`Frame 4 of ${baseSubject.frames.length} at ${(f3.base.ptsMicros / 1e6).toFixed(3)} s`), statusText);
  assert.ok(statusText.includes(`PSNR ${f3.base.psnrY.toFixed(2)} dB`) && statusText.includes(`PSNR ${f3.cand.psnrY.toFixed(2)} dB`), statusText);
  const times = await videos.evaluateAll((list) => list.map((video) => video.currentTime));
  for (const t of times) assert.ok(Math.abs(t - f3.base.ptsMicros / 1e6) < 0.01, `video time ${t} vs frame PTS ${f3.base.ptsMicros / 1e6}`);

  // ---- In-browser, independent of the host: the presented enhanced frame is less noisy than the degraded one ----
  const browserNoise = await page.evaluate(() => {
    const sigma = (video) => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      g.drawImage(video, 0, 0);
      const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
      const w = canvas.width, h = canvas.height;
      const y = new Float32Array(w * h);
      for (let i = 0; i < w * h; i += 1) y[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
      let sum = 0;
      for (let r = 1; r < h - 1; r += 1) for (let c = 1; c < w - 1; c += 1) {
        const i = r * w + c;
        sum += Math.abs(4 * y[i] - 2 * (y[i - 1] + y[i + 1] + y[i - w] + y[i + w]) + y[i - w - 1] + y[i - w + 1] + y[i + w - 1] + y[i + w + 1]);
      }
      return sum * Math.sqrt(Math.PI / 2) / (6 * (w - 2) * (h - 2));
    };
    return [...document.querySelectorAll("section.vwc video")].map(sigma);
  });
  process.stdout.write(`${JSON.stringify({ event: "browser-noise", degraded: browserNoise[0], enhanced: browserNoise[1], hostDegraded: f3.base.noiseSigmaY, hostEnhanced: f3.cand.noiseSigmaY })}\n`);
  assert.ok(browserNoise[1] < browserNoise[0], `enhanced frame must be less noisy in the browser: ${browserNoise}`);
  assert.ok(browserNoise[0] > f3.base.noiseSigmaY * 0.5 && browserNoise[0] < f3.base.noiseSigmaY * 2, `browser noise ${browserNoise[0]} vs host ${f3.base.noiseSigmaY}`);

  // ---- Chart: exactly the measured numbers, accessible name, click and keyboard seeking ----
  const chart = page.locator("svg.vwc-chart");
  assert.equal(await chart.getAttribute("role"), "img");
  assert.match(await chart.getAttribute("aria-label"), /^PSNR \(luma\) per frame for baseline, candidate\./u);
  assert.equal(await chart.locator("path.vwc-line").count(), 2);
  const pointCount = async (index) => (await chart.locator("path.vwc-line").nth(index).getAttribute("d")).split("L").length;
  assert.equal(await pointCount(0), baseSubject.frames.length);
  assert.equal(await pointCount(1), candSubject.frames.length);
  const expectedWorse = candSubject.frames.filter((f, i) => f.psnrY < baseSubject.frames[i].psnrY).length;
  assert.equal(await chart.locator("rect.vwc-worse").count(), expectedWorse, "regression markers must equal the measured regressed frames");
  assert.equal(expectedWorse, delta.framesPsnrRegressed);
  const box = await chart.boundingBox();
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2);
  const clicked = Number(await status.getAttribute("data-frame-index"));
  assert.ok(clicked > 10 && clicked < baseSubject.frames.length - 5, `chart click should seek to a middle frame, got ${clicked}`);
  const slider = page.getByRole("slider", { name: "Frame" });
  await slider.focus();
  await page.keyboard.press("Home");
  assert.equal(await status.getAttribute("data-frame-index"), "0");
  await page.keyboard.press("ArrowRight");
  assert.equal(await status.getAttribute("data-frame-index"), "1");
  await page.getByRole("radio", { name: /SSIM/u }).check();
  assert.equal(await chart.getAttribute("data-metric"), "ssimY");
  assert.match(await chart.getAttribute("aria-label"), /^SSIM \(luma\) per frame/u);
  await page.getByRole("radio", { name: /Noise sigma estimate/u }).check();
  assert.equal(await chart.locator("rect.vwc-worse").count(), 0);
  await page.getByRole("radio", { name: /PSNR/u }).check();
  await page.getByText("Per-frame data table").click();
  assert.equal(await page.locator(".vwc-table tbody tr").count(), baseSubject.frames.length);
  assert.equal(await page.locator(".vwc-table tbody tr").nth(5).locator("td").nth(1).innerText(), String(baseSubject.frames[5].psnrY));

  // Playback: both videos play on one clock and the readout follows after pause.
  await page.getByRole("button", { name: "Play" }).click();
  await delay(700);
  const [t0, t1] = await videos.evaluateAll((list) => list.map((video) => video.currentTime));
  assert.ok(Math.abs(t0 - t1) < 0.15, `videos must stay in sync while playing: ${t0} vs ${t1}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await delay(300);
  assert.ok(Number(await status.getAttribute("data-frame-index")) > 1, "playback must advance the frame readout");

  // Replay with the same inputs is the same request identity: 200 replayed, same artifact.
  await page.getByRole("button", { name: "Measure exact versions" }).click();
  await page.locator("#video-compare-status", { hasText: "Replayed (HTTP 200)" }).waitFor({ timeout: 600_000 });
  assert.equal(await result.getAttribute("data-output-id"), outputId);
  const posts = apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/video/comparisons");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).requestId, JSON.parse(posts[1].body).requestId, "replay must reuse the request identity");

  process.stdout.write(`${JSON.stringify({ event: "created", outputId, outputSha, meanPsnr: [baseSubject.againstReference.meanPsnrY, candSubject.againstReference.meanPsnrY], meanSsim: [baseSubject.againstReference.meanSsimY, candSubject.againstReference.meanSsimY], regressedFrames: expectedWorse })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function nextCommand(prefix) {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error(`stdin closed before ${prefix}`);
      if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
    }
  }
  const freshToken = await nextCommand("host-restarted ");
  assert.ok(freshToken, "the integration host must restart and issue a fresh token before readback");

  // ---- After the restart: a clean page reopens the registered comparison by id from the durable host ----
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await connect(freshToken);
  assert.equal(await result.count(), 0, "a reloaded page must not claim a result it never read");
  await page.getByLabel("Output ID").fill(outputId);
  await page.getByRole("button", { name: "Reopen comparison from the host" }).click();
  await page.locator("#video-reopen-status", { hasText: `Reopened comparison ${outputId}` }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-via"), "reopened");
  assert.ok((await rowText(1)).includes(`${candSubject.againstReference.meanPsnrY.toFixed(2)} dB`), "reopened numbers must equal the registered ones");
  assert.equal(await page.locator("section.vwc video").count(), 2);
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "readback must not mutate");
  const missing = `missing-${crypto.randomUUID()}`;
  expectedErrors.push({ pathname: `/dev/v1/video/comparisons/${missing}`, status: 404 });
  await page.getByLabel("Output ID").fill(missing);
  await page.getByRole("button", { name: "Reopen comparison from the host" }).click();
  await page.locator("#video-reopen-status", { hasText: "VIDEO_OUTPUT_NOT_FOUND" }).waitFor({ timeout: 30_000 });
  process.stdout.write(`${JSON.stringify({ event: "readback", outputId, outputSha })}\n`);

  // ---- Rights revoked by the host: a new measurement is denied and nothing new appears ----
  await nextCommand("rights-revoked");
  await fillForm(enhancedId, enhancedSha, degradedId, degradedSha);
  expectedErrors.push({ pathname: "/dev/v1/video/comparisons", status: 403 });
  await page.getByRole("button", { name: "Measure exact versions" }).click();
  await page.locator("#video-compare-status[data-failure^='RIGHTS_']").waitFor({ timeout: 60_000 });
  assert.equal(await page.locator("#video-compare-status").getAttribute("data-tone"), "denied");
  assert.equal(await page.locator("#video-compare-status").getAttribute("role"), "alert");
  process.stdout.write(`${JSON.stringify({ event: "denied" })}\n`);

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !expectedErrors.some((expected) => expected.pathname === pathname && text.includes(`status of ${expected.status}`)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token) && !stored.includes(freshToken), "token must never be persisted");
  for (const entry of apiRequests) assert.ok(!entry.url.includes("Bearer") && !entry.url.includes(token), `token must not be in a URL: ${entry.url}`);
  input.close();
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
