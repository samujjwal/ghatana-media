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
const token = requiredEnv("MEDIA_DEV_VOICE_BROWSER_TOKEN");
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

const vitePort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_VOICE_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const TEXTS = [
  "The quick brown fox jumps over the lazy dog.",
  "Voice synthesis through the keyboard only.",
];

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-voice-synthesis.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual voice-synthesis page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });

  // 1. Connect and read the admitted voices and locales FROM THE HOST (captured from the real response).
  // Vite may re-optimize dependencies on a cold cache and reload the page once; warm it first, then connect (retrying a
  // connect that a late reload interrupted).
  await page.goto(`${baseUrl}/dev-voice-synthesis.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  let capabilitiesResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-voice-synthesis.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/speech/capabilities", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try {
      capabilitiesResponse = await pending;
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
  await page.getByRole("heading", { name: "Voice synthesis", level: 2 }).waitFor({ timeout: 30_000 });
  const capabilities = (await capabilitiesResponse.json()).textToSpeech;
  assert.equal(capabilities.ready, true, "the real Kokoro model must be verified on this host");
  const optionValues = async (label) => page.getByLabel(label, { exact: true }).locator("option").evaluateAll((options) => options.map((option) => option.value));
  assert.ok(capabilities.verifiedLanguages.includes("en"), "English stays verified");
  assert.ok(capabilities.voiceLanguages && Object.keys(capabilities.voiceLanguages).length === capabilities.voices.length, "the host reports each voice's language");
  const englishVoices = capabilities.voices.filter((name) => capabilities.voiceLanguages[name] === "en");
  assert.deepEqual(await optionValues("Voice"), englishVoices, "the voices offered for locale en are the host's English voices");
  assert.deepEqual(await optionValues("Locale"), capabilities.verifiedLanguages, "locales come from the host");
  assert.deepEqual(englishVoices, ["af_heart", "am_michael"], "the manifest-listed English stock voices");
  if (capabilities.verifiedLanguages.includes("es")) {
    await page.getByLabel("Locale", { exact: true }).selectOption("es");
    assert.deepEqual(await optionValues("Voice"), capabilities.voices.filter((name) => capabilities.voiceLanguages[name] === "es"), "Spanish locale offers only Spanish voices");
    await page.getByLabel("Locale", { exact: true }).selectOption("en");
    assert.deepEqual(await optionValues("Voice"), englishVoices);
  }
  const licence = page.locator("[data-voice-licence]");
  assert.ok((await licence.textContent()).includes(capabilities.licenseSpdx), "licence is shown");
  assert.equal((await page.locator("[data-attribution-notice]").textContent()).startsWith(capabilities.attribution.notice), true, "the attribution notice is the host's notice");
  assert.ok((await licence.textContent()).includes("not supported"), "voice cloning status is shown");

  // 2. Accessible names, live regions, focus indicator.
  for (const label of ["Voice", "Locale", "Text to speak", /^Speaking rate/u]) {
    await page.getByLabel(label).first().waitFor({ timeout: 5_000 });
  }
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");

  // 3. Synthesize with the mouse: voice am_michael, locale en.
  await page.getByLabel("Voice", { exact: true }).selectOption("am_michael");
  await page.getByLabel("Text to speak").fill(TEXTS[0]);
  const synthPost = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/speech/syntheses" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  const firstResponse = await synthPost;
  assert.equal(firstResponse.status(), 201);
  const first = await firstResponse.json();
  const result = page.locator("[data-synthesis-result]");
  await result.waitFor({ timeout: 120_000 });
  assert.equal(await result.locator("[data-result-voice]").textContent(), "am_michael");
  await page.waitForFunction(() => document.activeElement?.id === "voice-result-title", null, { timeout: 5_000 });
  const reported = first.lineage.audio.durationMillis;
  assert.ok(reported > 1000, `a sentence is longer than a second, got ${reported}`);

  // 4. Verified playback: the bytes are hashed before the audio element is created; it loads and advances.
  await result.getByRole("button", { name: /^Preview WAV/u }).click();
  await result.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  assert.ok((await result.textContent()).includes(first.artifact.sha256), "verified message carries the registered sha256");
  const audio = result.locator("audio[data-verified-preview='wav']");
  await audio.waitFor({ timeout: 10_000 });
  assert.match(await audio.getAttribute("src"), /^blob:/u);
  await audio.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad();
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`audio error ${element.error?.code}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("audio metadata did not load")), 15_000);
  }));
  const playback = await audio.evaluate(async (element) => {
    const duration = element.duration;
    element.muted = true;
    await element.play();
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const advanced = element.currentTime;
    element.pause();
    return { duration, advanced, readyState: element.readyState };
  });
  assert.ok(Math.abs(playback.duration * 1000 - reported) < 60, `decoded duration ${playback.duration}s must match the registered ${reported} ms`);
  assert.ok(playback.advanced > 0.2, `playback must advance, got ${playback.advanced}`);
  // The downloaded file is hashed independently.
  const downloading = page.waitForEvent("download");
  await result.getByRole("button", { name: /^Download WAV/u }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), `${first.artifact.artifactId}.wav`);
  assert.equal(sha256Of(await readFile(await download.path())), first.artifact.sha256);

  // 5. Add to timeline (first placement creates the project with one AUDIO track).
  await page.getByRole("button", { name: "Add to timeline" }).click();
  const placedStatus = page.locator("[data-timeline-status='placed']");
  await placedStatus.waitFor({ timeout: 30_000 });
  const placedText = await placedStatus.textContent();
  const projectMatch = /project (\S+) \(revision (\S+)\)/u.exec(placedText);
  assert.ok(projectMatch, `placement text names project and revision: ${placedText}`);
  const projectId = projectMatch[1];
  const firstRevision = projectMatch[2].replace(/\)$/u, "");

  // 6. Second synthesis by KEYBOARD ONLY: Tab order Voice, Locale, Text, Rate, Synthesize.
  await page.getByLabel("Voice", { exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.getByLabel("Voice", { exact: true }).inputValue(), "af_heart");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "voice-locale");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "voice-text");
  await page.getByLabel("Text to speak").fill(TEXTS[1]);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "voice-rate");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Synthesize");
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  const secondPost = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/speech/syntheses" && response.request().method() === "POST");
  await page.keyboard.press("Enter");
  const secondResponse = await secondPost;
  assert.equal(secondResponse.status(), 201);
  const second = await secondResponse.json();
  assert.equal(second.lineage.voice, "af_heart");
  assert.notEqual(second.artifact.artifactId, first.artifact.artifactId);
  await page.locator("[data-result-voice]", { hasText: "af_heart" }).waitFor({ timeout: 120_000 });
  // Reach "Add to timeline" with the keyboard: Tab through Preview, Download, then Add.
  await page.getByRole("button", { name: /^Preview WAV/u }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Add to timeline");
  await page.keyboard.press("Enter");
  await page.locator("[data-timeline-status='placed']").waitFor({ timeout: 30_000 });
  const secondText = await page.locator("[data-timeline-status='placed']").textContent();
  assert.ok(secondText.includes(`project ${projectId} `), "the second clip lands in the same project");
  const secondRevision = /revision (\S+)\)/u.exec(secondText)[1];
  assert.notEqual(secondRevision, firstRevision, "a second clip is a new revision");

  // 7. Responsive: a phone viewport has no horizontal scroll and keeps comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal scroll at 375px, overflow ${overflow}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input, textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const synthBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/speech/syntheses").map((entry) => JSON.parse(entry.body));
  assert.equal(synthBodies.length, 2);
  assert.ok(synthBodies.every((body) => body.locale === "en" && typeof body.requestId === "string" && body.voiceReference === undefined));
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "synthesized", projectId, firstRevision, secondRevision,
    clips: [
      { artifactId: first.artifact.artifactId, artifactVersionId: first.artifact.artifactVersionId, sha256: first.artifact.sha256, voice: "am_michael", durationMillis: reported, requestId: synthBodies[0].requestId },
      { artifactId: second.artifact.artifactId, artifactVersionId: second.artifact.artifactVersionId, sha256: second.artifact.sha256, voice: "af_heart", durationMillis: second.lineage.audio.durationMillis, requestId: synthBodies[1].requestId },
    ],
    playbackSeconds: playback.advanced,
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
