import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * Browser check of the audio restoration page against the REAL Vite-served page with a scripted host (page.route), so
 * layout, accessibility names, focus, the A/B switch and the phone viewport are exercised without models. The live
 * real-host journey is dev-audio-restoration-live-browser.mjs (driven by MediaDevExplorerAudioRestorationLiveIT).
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(appRoot, "package.json"));
const { chromium } = require("playwright");
const viteBinary = resolve(appRoot, "node_modules/vite/bin/vite.js");

const vitePort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const wav = (seconds, hz) => {
  const rate = 8000; const frames = rate * seconds; const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + frames * 2, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return buffer;
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = wav(4, 220);
const restoredBytes = wav(4, 330);
const SRC = sha(sourceBytes);
const OUT = sha(restoredBytes);
const side = (over) => ({ clippedSamples: 0, peakAbs: 9000, rmsDbfs: -20, noiseFloor: { rmsDbfs: -40, spectralFlatness: 0.7, frames: 40 }, snrDb: null, segmentalSnrDb: null, ...over });
const comparison = {
  schema: "media.dev.audio-comparison.v1", kind: "COMPARISON", scope: "DEV_ONLY", outputId: "cmp-1", replayed: false,
  report: {
    reference: { artifactId: "ref-1" },
    metrics: {
      source: side({ clippedSamples: 346, snrDb: 9.98, segmentalSnrDb: 2.87 }), restored: side({ snrDb: 11.51, segmentalSnrDb: 4.14 }),
      reference: side({}), delta: { snrDb: 1.53, segmentalSnrDb: 1.27, clippedSamples: -346, noiseFloorDbfs: -4.18, noiseFloorSpectralFlatness: 0.166 },
    },
    verdict: { overall: "IMPROVED", snr: "IMPROVED", segmentalSnr: "IMPROVED", clipping: "REDUCED", noiseFloorLevel: "LOWER" },
    transcript: { status: "NOT_REQUESTED" },
  },
};
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try { if ((await fetch(`${baseUrl}/dev-audio-restoration.html`)).ok) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the audio-restoration page:\n${viteOutput}`);
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // net::ERR_NETWORK_CHANGED is Chromium reacting to host network-interface churn (other containers starting), not the page.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("net::ERR_NETWORK_CHANGED")) errors.push(message.text()); });
  const posts = [];
  await page.route("**/dev/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/dev/v1/context") return json(route, 200, { scope: "DEV_ONLY", selectedAuthorizedWorkspaceId: "ws" });
    if (path === "/dev/v1/audio/status") return json(route, 200, { scope: "DEV_ONLY", engine: { ready: true, version: "ffmpeg version 7.0.2" }, transcriptDiff: { ready: false }, limits: {} });
    if (path === "/dev/v1/audio/restorations") {
      posts.push(JSON.parse(request.postData()));
      return json(route, 201, { schema: "media.dev.audio-restoration.v1", kind: "RESTORATION", scope: "DEV_ONLY", outputId: "out-1", replayed: false,
        artifact: { artifactId: "out-1", artifactVersionId: `sha256:${OUT}`, contentType: "audio/wav", sizeBytes: restoredBytes.length, sha256: OUT },
        lineage: { kind: "LOCAL_AUDIO_RESTORED", source: { artifactId: "src-1", artifactVersionId: `sha256:${SRC}`, sha256: SRC },
          filterGraph: "adeclip=threshold=10:window=55:overlap=75:method=a,bandreject=f=50:t=q:w=30,afftdn=nr=20.0:nf=-40.0:tn=1,aformat=sample_fmts=s16,apad=whole_len=234000,atrim=end_sample=234000",
          engine: { version: "ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/" } } });
    }
    if (path === "/dev/v1/audio/comparisons") return json(route, 201, comparison);
    const content = /^\/dev\/v1\/artifacts\/([^/]+)\/content$/u.exec(path);
    if (content) {
      const bytes = request.headers()["if-match"] === `sha256:${SRC}` ? sourceBytes : restoredBytes;
      return route.fulfill({ status: 200, contentType: "audio/wav", body: bytes, headers: { "Content-Length": String(bytes.length) } });
    }
    return json(route, 404, { error: { code: "NOT_FOUND", message: "unscripted" } });
  });

  await page.goto(`${baseUrl}/dev-audio-restoration.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  for (let attempt = 1; ; attempt += 1) {
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill("test-token");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { await page.locator("[data-audio-engine-status]").getByText(/is ready/u).waitFor({ timeout: 20_000 }); break; } catch (error) { if (attempt >= 3) throw error; await page.goto(`${baseUrl}/dev-audio-restoration.html`, { waitUntil: "networkidle" }); }
  }
  await page.getByLabel("Source artifact id").fill("src-1");
  await page.getByLabel("Source exact version").fill(`sha256:${SRC}`);
  await page.getByLabel("Reference artifact id").fill("ref-1");
  await page.getByLabel("Reference exact version").fill(`sha256:${"c".repeat(64)}`);
  await page.getByRole("button", { name: "Restore and measure", exact: true }).click();
  await page.locator("[data-audio-measurement]").waitFor({ timeout: 20_000 });
  assert.deepEqual(posts[0].operations, { declip: { threshold: 10 }, denoise: { reductionDb: 12, noiseFloorDb: -50, trackNoise: true } });
  const ab = page.locator("[data-audio-ab]");
  await ab.getByRole("button", { name: /^Load both clips/u }).click();
  await ab.locator("audio").waitFor({ timeout: 20_000 });

  for (const [name, width, height] of [["desktop", 1100, 1000], ["phone", 375, 812], ["narrow", 320, 700]]) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const wide = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll("body *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8).map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className} sw=${element.scrollWidth} cw=${element.clientWidth} right=${Math.round(element.getBoundingClientRect().right)}`)) : [];
    assert.ok(overflow <= 1, `${name}: no horizontal scroll, overflow ${overflow}: ${JSON.stringify(wide)}`);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, textarea, input:not([type=checkbox]):not([type=radio]), label:has(> input[type=checkbox]), label:has(> input[type=radio])")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim().slice(0, 40)));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");
  assert.deepEqual(errors, [], `browser errors: ${JSON.stringify(errors)}`);
  process.stdout.write("audio restoration page browser check passed\n");
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((r) => viteProcess.once("exit", r)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
