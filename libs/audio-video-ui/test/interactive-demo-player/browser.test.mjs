import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build, preview } from "vite";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const mediaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const outputDirectory = resolve(mediaRoot, process.env.MEDIA_CREATIVE_PREVIEW_DIR
  || "examples/media-creative-preview/build/media-creative-preview");
const audioFilename = "interactive-demo-preview.wav";
const playerName = "Interactive demonstration player";
const durationMs = 2_000;
const timeout = 10_000;
const expectedPlaywrightVersion = "1.63.0";
const expectedChromiumVersion = "153.0.8010.12";
const expectedChromiumRevision = "1243";
const resolveDependency = createRequire(import.meta.url).resolve;

let temporaryDirectory;
let server;
let browser;
let origin;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

before(async () => {
  const playwrightPackage = JSON.parse(await readFile(resolveDependency("playwright/package.json"), "utf8"));
  assert.equal(playwrightPackage.version, expectedPlaywrightVersion,
    `Update the pinned Playwright/browser evidence together; expected Playwright ${expectedPlaywrightVersion}.`);
  const chromiumBinary = chromium.executablePath();
  assert.match(chromiumBinary, new RegExp(`(?:chromium|chromium_headless_shell)-${expectedChromiumRevision}/`),
    `Expected the Playwright-pinned Chromium revision ${expectedChromiumRevision}; found ${chromiumBinary}`);
  const chromiumVersion = await promisify(execFile)(chromiumBinary, ["--version"]);
  assert.ok(chromiumVersion.stdout.includes(expectedChromiumVersion),
    `Expected Chromium ${expectedChromiumVersion}; found ${chromiumVersion.stdout.trim()}`);

  const manifestBytes = await readFile(join(outputDirectory, "preview-manifest.json")).catch((error) => {
    throw new Error(`Generate the Media creative preview before running this check. Expected preview-manifest.json in ${outputDirectory}`, { cause: error });
  });
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.kind, "LOCAL_PREVIEW_ONLY");
  assert.ok(typeof manifest.sourceVersion === "string" && manifest.sourceVersion.startsWith("local-fixture:"));
  const audio = manifest.outputs?.interactiveDemoAudio;
  assert.equal(audio?.filename, audioFilename, "Regenerate the creative preview with the interactive demo WAV output.");
  assert.equal(audio.sourceVersion, manifest.sourceVersion);
  const clock = manifest.clocks?.interactiveDemoAudio;
  assert.equal(clock?.fixtureVersionRef, "local-interactive-demo-tone-v1");
  assert.equal(clock?.sampleRateHz, 48_000);
  assert.equal(clock.channels, 2);
  assert.equal(clock.sampleFormat, "PCM_S16LE");
  assert.equal(clock.frameCount * 1_000 / clock.sampleRateHz, durationMs);
  assert.equal(clock.durationMs, durationMs);
  const audioBytes = await readFile(join(outputDirectory, audioFilename));
  assert.equal(sha256(audioBytes), audio.sha256, "Generated WAV must match the persisted preview manifest.");

  temporaryDirectory = await mkdtemp(join(tmpdir(), "media-preview-player-"));
  // Build the public entry with the package's compiler and a fresh incremental state.
  await promisify(execFile)(process.execPath, [
    resolveDependency("typescript/bin/tsc"),
    "--tsBuildInfoFile",
    join(temporaryDirectory, "ui.tsbuildinfo"),
  ], { cwd: packageRoot });
  await promisify(execFile)(process.execPath, [
    resolveDependency("typescript/bin/tsc"),
    "--project",
    join(fixtureRoot, "tsconfig.json"),
  ], { cwd: packageRoot });
  const config = {
    root: fixtureRoot,
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: "error",
    // Resolve the linked Shared UI's browser dependencies from this consumer.
    resolve: { dedupe: ["react", "react-dom", "lucide-react"] },
    build: { outDir: join(temporaryDirectory, "site"), target: "es2022" },
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  };
  await build({
    ...config,
    define: {
      __LOCAL_PREVIEW_FIXTURE__: JSON.stringify({
        sourceVersion: manifest.sourceVersion,
        previewManifestSha256: sha256(manifestBytes),
        audioSha256: audio.sha256,
        durationMs,
      }),
    },
    plugins: [{
      name: "verified-local-preview-wav",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: audioFilename, source: audioBytes });
      },
    }],
  });
  server = await preview(config);
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  assert.equal(browser.version(), expectedChromiumVersion);
  console.log(JSON.stringify({
    verification: "LOCAL_PREVIEW_ONLY",
    playwrightVersion: playwrightPackage.version,
    browser: { engine: "Chromium", version: browser.version() },
    fixture: { filename: audioFilename, sha256: audio.sha256, durationMs, sourceVersion: manifest.sourceVersion },
  }));
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

async function openPlayer(t, query = "") {
  const context = await browser.newContext({ serviceWorkers: "block" });
  // Capture and abort attempted external fetches. No CSP masks a player policy regression.
  await context.route((url) => url.origin !== origin, (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  const requests = [];
  const responses = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push(response));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "The local preview page must run without browser errors.");
    assert.deepEqual(requests.filter((url) => new URL(url).origin !== origin), [], "No external requests are permitted.");
  });
  const response = await page.goto(`${origin}/${query}`);
  assert.equal(response?.status(), 200);
  const player = page.getByRole("region", { name: playerName });
  await player.waitFor();
  return { page, player, requests, responses };
}

async function expectStatus(player, message) {
  const status = player.getByRole("status").filter({ hasText: message });
  await status.waitFor();
  assert.equal(await status.textContent(), message);
}

async function expectCaption(player, message) {
  const caption = player.getByLabel("Captions", { exact: true }).filter({ hasText: message });
  await caption.waitFor();
  assert.equal(await caption.textContent(), message);
}

async function expectNativePosition(page, positionMs) {
  await page.waitForFunction((position) => {
    const audio = document.querySelector("audio");
    return audio && audio.readyState >= HTMLMediaElement.HAVE_METADATA && audio.paused && !audio.seeking
      && Math.abs(audio.currentTime - position / 1_000) < 0.0005;
  }, positionMs, { timeout });
}

async function expectFocus(locator) {
  assert.ok(await locator.evaluate((element) => element === element.ownerDocument.activeElement));
}

async function tabTo(page, locator) {
  await page.keyboard.press("Tab");
  await expectFocus(locator);
}

test("decodes the digest-bound WAV, plays, pauses and seeks to the matching caption with the keyboard", async (t) => {
  const { page, player, responses } = await openPlayer(t);
  await page.getByText("LOCAL_PREVIEW_ONLY · Synthetic tone · Local test verifier").waitFor();
  await expectStatus(player, "Simulated demonstration ready. Introduction.");
  await expectCaption(player, "Opening tone.");
  await expectNativePosition(page, 0);
  const audio = player.locator("audio");
  assert.deepEqual(await audio.evaluate((media) => ({
    url: media.currentSrc,
    duration: media.duration,
    error: media.error,
    crossOrigin: media.crossOrigin,
  })), { url: `${origin}/${audioFilename}`, duration: durationMs / 1_000, error: null, crossOrigin: "anonymous" });
  const mediaResponse = responses.find((response) => response.url() === `${origin}/${audioFilename}`);
  assert.ok(mediaResponse && [200, 206].includes(mediaResponse.status()), "Chromium must fetch the WAV from the loopback server.");
  assert.match(mediaResponse.headers()["content-type"], /^audio\/(x-)?wav\b/);

  const play = player.getByRole("button", { name: "Play Introduction" });
  await play.and(page.locator(":enabled")).waitFor();
  await tabTo(page, play);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const media = document.querySelector("audio");
    return media && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && !media.paused && media.currentTime >= 0.1;
  }, null, { timeout });
  await player.getByRole("button", { name: "Pause Introduction" }).click();
  await expectStatus(player, "Paused Introduction.");
  assert.ok(await audio.evaluate((media) => media.paused && media.currentTime >= 0.1 && !media.error));

  const seek = player.getByRole("slider", { name: "Seek within Introduction" });
  await play.focus();
  await tabTo(page, player.getByRole("button", { name: "Replay current demonstration path" }));
  await tabTo(page, player.getByRole("button", { name: "Exit demonstration" }));
  await tabTo(page, seek);
  await page.keyboard.press("Home");
  await expectNativePosition(page, 0);
  await expectCaption(player, "Opening tone.");
  for (let step = 0; step < 5; step += 1) await page.keyboard.press("PageUp");
  const soughtMs = Number(await seek.inputValue());
  assert.ok(soughtMs >= durationMs / 2 && soughtMs < durationMs, `Expected a keyboard seek into the closing cue, got ${soughtMs} ms.`);
  await expectNativePosition(page, soughtMs);
  await expectCaption(player, "Closing tone.");
  await expectStatus(player, `Seeked to Introduction, ${soughtMs} milliseconds.`);
  await play.click();
  await expectStatus(player, "Finished Introduction. Choose a path or replay.");
  await expectNativePosition(page, durationMs);
});

test("keyboard choices focus each authored scene and replay its exact start position", async (t) => {
  const passages = [
    { name: "First passage", startMs: durationMs / 4 },
    { name: "Second passage", startMs: durationMs / 2 },
  ];
  for (const passage of passages) {
    const { page, player } = await openPlayer(t);
    await expectStatus(player, "Simulated demonstration ready. Introduction.");
    const seek = player.getByRole("slider", { name: "Seek within Introduction" });
    await seek.focus();
    const firstChoice = player.getByRole("button", { name: "Hear the first passage; continue to First passage" });
    await tabTo(page, firstChoice);
    if (passage.name === "Second passage") {
      await tabTo(page, player.getByRole("button", { name: "Hear the second passage; continue to Second passage" }));
    }
    await page.keyboard.press("Enter");
    const scene = player.getByRole("group", { name: passage.name, exact: true });
    await expectStatus(player, `Showing ${passage.name}.`);
    await expectCaption(player, `${passage.name} tone.`);
    await expectFocus(scene.getByText(passage.name, { exact: true }));
    await expectNativePosition(page, passage.startMs);

    const branchSeek = player.getByRole("slider", { name: `Seek within ${passage.name}` });
    await branchSeek.press("PageUp");
    const movedMs = Number(await branchSeek.inputValue());
    assert.ok(movedMs > passage.startMs);
    await expectNativePosition(page, movedMs);
    const replay = player.getByRole("button", { name: "Replay current demonstration path" });
    await replay.press("Enter");
    await expectStatus(player, `Showing ${passage.name}.`);
    assert.equal(await branchSeek.inputValue(), String(passage.startMs));
    await expectNativePosition(page, passage.startMs);
    await expectCaption(player, `${passage.name} tone.`);
  }
});

test("keyboard opens the exact cue transcript and branch selection replaces its scene content", async (t) => {
  const { page, player } = await openPlayer(t);
  const seek = player.getByRole("slider", { name: "Seek within Introduction" });
  const firstChoice = player.getByRole("button", { name: "Hear the first passage; continue to First passage" });
  const secondChoice = player.getByRole("button", { name: "Hear the second passage; continue to Second passage" });
  const summary = player.locator("details > summary");

  await seek.focus();
  await tabTo(page, firstChoice);
  await tabTo(page, secondChoice);
  await tabTo(page, summary);
  await expectFocus(summary);
  await page.keyboard.press("Enter");

  const transcript = player.getByRole("list", { name: "Transcript for Introduction" });
  await transcript.waitFor();
  assert.deepEqual(await transcript.locator("li").allTextContents(), [
    "00:00:00.000 Opening tone.",
    "00:00:01.000 Closing tone.",
  ]);
  assert.deepEqual(await transcript.locator("time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)), ["PT0S", "PT1S"]);

  await firstChoice.press("Enter");
  const branchTranscript = player.getByRole("list", { name: "Transcript for First passage" });
  await branchTranscript.waitFor();
  assert.deepEqual(await branchTranscript.locator("li").allTextContents(), [
    `00:00:${String(Math.floor(durationMs / 4 / 1_000)).padStart(2, "0")}.${String(Math.floor(durationMs / 4) % 1_000).padStart(3, "0")} First passage tone.`,
  ]);
  assert.equal(await player.getByText("Opening tone.").count(), 0);
});

for (const denied of ["asset", "caption"]) {
  test(`denies the wrong origin capability for ${denied} before attaching or fetching media`, async (t) => {
    const { player, requests } = await openPlayer(t, `?denied=${denied}`);
    await expectStatus(player, `Interactive demonstration denied: unauthorized ${denied} origin.`);
    assert.equal(await player.getAttribute("data-demo-status"), "POLICY_DENIED");
    assert.equal(await player.locator("audio, video, track").count(), 0);
    assert.equal(await player.getByRole("group", { name: "Playback controls" }).count(), 0);
    assert.deepEqual(requests.filter((url) => /\.(?:wav|vtt)$/.test(new URL(url).pathname)), []);
  });
}
