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
const token = requiredEnv("MEDIA_DEV_VISION_BROWSER_TOKEN");
const videoId = requiredEnv("MEDIA_DEV_VISION_BROWSER_VIDEO_ID");
const videoSha256 = requiredEnv("MEDIA_DEV_VISION_BROWSER_VIDEO_SHA256");
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

const vitePort = 4187;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_VISION_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });


// Ground truth of the generated video (see TrackingVideoFixture in the launcher tests): 640x360, a car sprite moving
// right at 90 px/s (x = 20 + 90 t, y = 250, 160x77) and a person sprite moving down at 50 px/s
// (x = 500, y = 40 + 50 t, 68x151).
const truth = {
  car: (t) => [20 + 90 * t, 250, 160, 77],
  person: (t) => [500, 40 + 50 * t, 68, 151],
};
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
};

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-vision-tracks.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual video tracking page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
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
    await page.goto(`${baseUrl}/dev-vision-tracks.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      await page.getByRole("heading", { name: /Video tracking · DEV_ONLY/u }).waitFor({ timeout: 120_000 });
    } catch (error) {
      const connection = await page.locator("#connection-status").textContent().catch(() => "<unreadable>");
      throw new Error(`The tracking panel did not render. status=${JSON.stringify(connection)} pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors)} api=${JSON.stringify(apiRequests.map(({ method, path }) => `${method} ${path}`))}`, { cause: error });
    }
  }
  const result = page.locator("#vision-result");
  const ddOf = async (term) => (await result.locator("dt", { hasText: term }).first().locator("xpath=following-sibling::dd[1]").textContent()).trim();

  // Load the video, seek to just past an exact sampled-frame PTS and wait until that frame is presented.
  async function seekPresented(seconds) {
    await page.evaluate(async (target) => {
      const video = document.querySelector("video.vto-video");
      if (video.readyState < 1) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
      await new Promise((resolveSeek) => {
        const done = () => { video.removeEventListener("seeked", done); resolveSeek(); };
        video.addEventListener("seeked", done);
        video.currentTime = target;
      });
      await new Promise((resolveFrame) => {
        if (typeof video.requestVideoFrameCallback === "function") {
          const timer = setTimeout(resolveFrame, 1500);
          video.requestVideoFrameCallback(() => { clearTimeout(timer); resolveFrame(); });
        } else setTimeout(resolveFrame, 400);
      });
    }, seconds);
  }
  async function overlayState() {
    return page.evaluate(() => {
      const svg = document.querySelector("svg.vto-overlay");
      if (!svg) return null;
      return {
        frameIndex: svg.getAttribute("data-frame-index"),
        ptsMicros: Number(svg.getAttribute("data-frame-pts-micros")),
        sync: svg.getAttribute("data-sync"),
        label: svg.getAttribute("aria-label"),
        boxes: [...svg.querySelectorAll("g[data-track-id]")].map((g) => {
          const rect = g.querySelector("rect");
          const screen = rect.getBoundingClientRect();
          return {
            trackId: g.getAttribute("data-track-id"), label: g.getAttribute("data-label"),
            box: ["x", "y", "width", "height"].map((a) => Number(rect.getAttribute(a))),
            screen: [screen.x, screen.y, screen.width, screen.height],
          };
        }),
      };
    });
  }
  // RGB at the centre of a source-pixel box, read from the presented video frame itself.
  async function videoPixel(x, y) {
    return page.evaluate(([px, py]) => {
      const video = document.querySelector("video.vto-video");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context2d = canvas.getContext("2d");
      context2d.drawImage(video, 0, 0);
      const data = context2d.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }, [x, y]);
  }

  await connect(token);
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- Track the exact uploaded video version ----
  await page.getByLabel("Source artifact ID").fill(videoId);
  await page.getByLabel("Exact source artifact version").fill(`sha256:${videoSha256}`);
  await page.getByLabel(/Frames to sample/u).fill("16");
  await page.getByRole("button", { name: "Track exact source version" }).click();
  await page.locator("#vision-track-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 600_000 });
  const outputId = await result.getAttribute("data-output-id");
  assert.ok(outputId && outputId !== videoId, "the tracks output must be a NEW artifact");
  const outputSha = await ddOf("SHA-256");
  assert.match(outputSha, /^[0-9a-f]{64}$/u);
  assert.equal(await ddOf("Source artifact"), videoId);
  assert.equal(await ddOf("Source SHA-256"), videoSha256);
  assert.match(await ddOf("Time base"), /^1\/\d+$/u);
  const sampledFrames = Number(await ddOf("Sampled frames"));
  assert.ok(sampledFrames >= 10, `sampled frames: ${sampledFrames}`);
  const video = page.locator("video.vto-video");
  assert.match(await video.getAttribute("src"), /^blob:/u, "the source video is shown only from verified bytes (blob URL)");
  assert.equal(await video.getAttribute("aria-label"), `Source video ${videoId} with tracked object boxes`);
  assert.ok((await result.textContent()).includes("Boxes are in source pixels (640x360)"));
  await video.evaluate((element) => element.readyState >= 1 ? undefined : new Promise((resolveLoad, rejectLoad) => {
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code}: ${element.error?.message}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("video metadata did not load")), 20_000);
  }));
  const dimensions = await video.evaluate((element) => ({ w: element.videoWidth, h: element.videoHeight, d: element.duration }));
  assert.deepEqual([dimensions.w, dimensions.h], [640, 360]);
  assert.ok(dimensions.d > 2.8 && dimensions.d < 3.2, `duration ${dimensions.d}`);

  // ---- The overlay follows the playhead on exact source PTS and matches the video content ----
  const checks = [];
  for (const second of [0.0, 0.6, 1.2, 1.8, 2.4]) {
    await seekPresented(second + 0.001);
    const state = await overlayState();
    assert.ok(state, "overlay must be present");
    assert.ok(state.ptsMicros <= (second + 0.001) * 1e6 + 1 && (second + 0.001) * 1e6 - state.ptsMicros < 250_000,
      `overlay frame PTS ${state.ptsMicros} must govern playhead ${second}`);
    const t = state.ptsMicros / 1e6;
    assert.match(state.label, new RegExp(`^Tracked object boxes at ${t.toFixed(3)} s$`, "u"));
    for (const [name, expected] of [["car", truth.car(t)], ["person", truth.person(t)]]) {
      const best = state.boxes.map((b) => ({ b, score: iou(b.box, expected) })).sort((a, b) => b.score - a.score)[0];
      assert.ok(best && best.score >= 0.7, `${name} box at PTS ${t}s must match ground truth ${JSON.stringify(expected)}; boxes ${JSON.stringify(state.boxes.map((b) => b.box))}`);
      // The rect really is on that object in the presented video frame (red car body / blue shirt).
      const cx = best.b.box[0] + best.b.box[2] / 2;
      const cy = best.b.box[1] + (name === "car" ? best.b.box[3] * 0.6 : best.b.box[3] * 0.4);
      const [r, g, b] = await videoPixel(cx, cy);
      if (name === "car") assert.ok(r > 140 && g < 100 && b < 100, `car pixel at (${cx},${cy}) should be red, got ${[r, g, b]}`);
      else assert.ok(b > 140 && r < 100, `person pixel at (${cx},${cy}) should be blue, got ${[r, g, b]}`);
      // The drawn rectangle sits at the same relative place in the on-screen video as in the source raster.
      const videoRect = await video.boundingBox();
      const scale = videoRect.width / 640;
      assert.ok(Math.abs(best.b.screen[0] - (videoRect.x + best.b.box[0] * scale)) < 2 && Math.abs(best.b.screen[2] - best.b.box[2] * scale) < 2,
        `on-screen box must scale with the video: ${JSON.stringify(best.b.screen)} vs ${videoRect.x + best.b.box[0] * scale}`);
      checks.push({ t, name, iou: Math.round(best.score * 1000) / 1000, pixel: [r, g, b] });
    }
  }

  // ---- Accessibility and the list of tracks ----
  assert.equal(await page.getByRole("group", { name: /^Tracked object boxes at / }).count(), 1);
  const status = page.getByTestId("vto-status");
  assert.equal(await status.getAttribute("aria-live"), "polite");
  assert.match(await status.textContent(), /tracked object/u);
  const list = page.getByRole("list", { name: "Tracks" });
  const itemCount = await list.getByRole("listitem").count();
  assert.ok(itemCount >= 2, `track list items: ${itemCount}`);
  const personButton = list.getByRole("button", { name: /· person$/u }).first();
  await personButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(await personButton.getAttribute("aria-pressed"), "true", "keyboard activation must select the track");
  assert.ok(await page.locator("svg.vto-overlay g.is-selected").count() >= 1);
  await page.keyboard.press("Enter");
  assert.equal(await personButton.getAttribute("aria-pressed"), "false");
  const seekButton = list.getByRole("button", { name: /^Seek to the first observation of person/u }).first();
  await seekButton.click();
  // The person is already present in the first sampled frame, so "seek to start" rewinds from 2.4 s to 0.001 s.
  await page.waitForFunction(() => document.querySelector("video.vto-video").currentTime < 0.05);
  await page.waitForFunction(() => document.querySelector("svg.vto-overlay")?.getAttribute("data-frame-index") === "0");
  await page.getByRole("checkbox", { name: "Show boxes on the video" }).uncheck();
  assert.equal(await page.locator("svg.vto-overlay").count(), 0);
  await page.getByRole("checkbox", { name: "Show boxes on the video" }).check();
  assert.equal(await page.locator("svg.vto-overlay").count(), 1);

  // Replay with the same inputs is the same request identity: 200 replayed, same artifact.
  await page.getByRole("button", { name: "Track exact source version" }).click();
  await page.locator("#vision-track-status", { hasText: "Replayed (HTTP 200)" }).waitFor({ timeout: 600_000 });
  assert.equal(await result.getAttribute("data-output-id"), outputId);
  const posts = apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/vision/tracks");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).requestId, JSON.parse(posts[1].body).requestId, "replay must reuse the request identity");

  const referenceState = await (async () => { await seekPresented(1.201); return overlayState(); })();
  process.stdout.write(`${JSON.stringify({ event: "created", outputId, outputSha, sampledFrames, checks })}\n`);
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

  // ---- After the restart: a clean page reopens the registered tracks by id from the durable host ----
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await connect(freshToken);
  assert.equal(await result.count(), 0, "a reloaded page must not claim a result it never read");
  await page.getByLabel("Output ID").fill(outputId);
  await page.getByRole("button", { name: "Reopen tracks from the host" }).click();
  await page.locator("#vision-reopen-status", { hasText: `Reopened output ${outputId}` }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-via"), "reopened");
  assert.equal(await ddOf("SHA-256"), outputSha);
  assert.equal(await ddOf("Source SHA-256"), videoSha256);
  await seekPresented(1.201);
  const reopened = await overlayState();
  assert.deepEqual({ ...reopened, screen: undefined, boxes: reopened.boxes.map((b) => b.box) },
    { ...referenceState, screen: undefined, boxes: referenceState.boxes.map((b) => b.box) }, "the reopened tracks must draw the same boxes");
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "readback must not mutate");
  // An unknown output is a typed 404 tolerated only by its exact path.
  const missing = `missing-${crypto.randomUUID()}`;
  expectedErrors.push({ pathname: `/dev/v1/vision/outputs/${missing}`, status: 404 });
  await page.getByLabel("Output ID").fill(missing);
  await page.getByRole("button", { name: "Reopen tracks from the host" }).click();
  await page.locator("#vision-reopen-status", { hasText: "VISION_OUTPUT_NOT_FOUND" }).waitFor({ timeout: 30_000 });
  process.stdout.write(`${JSON.stringify({ event: "readback", outputId, outputSha })}\n`);

  // ---- Rights revoked by the host: a new tracking request is denied and nothing new appears ----
  await nextCommand("rights-revoked");
  // The reloaded page has a blank form: enter the same exact source version with a different frame count.
  await page.getByLabel("Source artifact ID").fill(videoId);
  await page.getByLabel("Exact source artifact version").fill(`sha256:${videoSha256}`);
  await page.getByLabel("Frames to sample (1 to 64)").fill("8");
  expectedErrors.push({ pathname: "/dev/v1/vision/tracks", status: 403 });
  await page.getByRole("button", { name: "Track exact source version" }).click();
  try {
    await page.locator("#vision-track-status[data-failure='RIGHTS_REVOKED']").waitFor({ timeout: 60_000 });
  } catch (error) {
    throw new Error(`revoked request was not shown as denied: ${await page.locator("#vision-track-status").evaluate((node) => node.outerHTML)} api=${JSON.stringify(apiRequests.slice(-3).map(({ method, path, body }) => `${method} ${path} ${body ?? ""}`))}`, { cause: error });
  }
  assert.equal(await page.locator("#vision-track-status").getAttribute("data-tone"), "denied");
  assert.equal(await page.locator("#vision-track-status").getAttribute("role"), "alert");
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
