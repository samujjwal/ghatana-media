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
const token = requiredEnv("MEDIA_DEV_MASTER_BROWSER_TOKEN");
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

const deniedId = requiredEnv("MEDIA_DEV_MASTER_DENIED_ID");
const deniedVersion = requiredEnv("MEDIA_DEV_MASTER_DENIED_VERSION");
const silentId = requiredEnv("MEDIA_DEV_MASTER_SILENT_ID");
const silentVersion = requiredEnv("MEDIA_DEV_MASTER_SILENT_VERSION");
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
delete viteEnvironment.MEDIA_DEV_MASTER_BROWSER_TOKEN;
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-masters.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual masters page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const failedRequests = [];
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  // The deliberate typed 422/403 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
  page.on("console", (message) => {
    // net::ERR_NETWORK_CHANGED is a host-network event (another process bringing a network interface up on this shared
    // machine), not a page error; it is tolerated only while no /dev/v1 request failed (asserted at the end).
    if (message.type() === "error" && !/status of (422|403)/u.test(message.text()) && !/ERR_NETWORK_CHANGED/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const masterPost = (path = "/dev/v1/masters", timeout = 120_000) => page.waitForResponse((response) => new URL(response.url()).pathname === path
    && response.request().method() === "POST", { timeout });


  // 1. Connect; the limits come FROM THE HOST (captured from the real response).
  await page.goto(`${baseUrl}/dev-masters.html`, { waitUntil: "networkidle" });
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-masters.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/masters/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "Stems, foley and master", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.masterReady, true);
  const line = await page.locator("[data-status-line]").textContent();
  assert.ok(line.includes(`${status.limits.minStemMs} to ${status.limits.maxStemMs} ms`), line);
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");

  // 2. Build three ORIGINAL stems through the form: a tone, a kick and a stereo footstep.
  const buildStem = async () => {
    const post = masterPost("/dev/v1/masters/stems");
    await page.getByRole("button", { name: "Build stem", exact: true }).click();
    const response = await post;
    assert.equal(response.status(), 201, await response.text());
    return response.json();
  };
  await page.locator("#master-stem-duration").fill("1500");
  const tone = await buildStem();
  assert.equal(tone.lineage.generatorSpec.frequencyHz, 440);
  assert.equal(tone.lineage.generator.origin, "ORIGINAL_PROCEDURAL_SYNTHESIS");
  await page.locator("#master-stem-kind").selectOption("DRUM");
  await page.locator("#master-stem-duration").fill("400");
  const kick = await buildStem();
  await page.locator("#master-stem-kind").selectOption("FOLEY");
  await page.locator("#master-stem-foley").selectOption("FOOTSTEP");
  await page.locator("#master-stem-channels").fill("2");
  await page.locator("#master-stem-seed").fill("5");
  const step = await buildStem();
  assert.equal(await page.locator("[data-stem-table] tbody tr").count(), 3);
  assert.ok((await page.locator("[data-stem-status]").textContent()).includes("3 stems built"));

  // 3. Mix by keyboard-reachable controls: add each stem, place it on an exact sample, gain, pan and fades.
  await page.getByRole("button", { name: `Add TONE ${tone.artifact.artifactId} to the mix` }).click();
  await page.getByRole("button", { name: `Add DRUM ${kick.artifact.artifactId} to the mix` }).click();
  await page.getByRole("button", { name: `Add FOLEY ${step.artifact.artifactId} to the mix` }).click();
  assert.equal(await page.locator("[data-placement-index]").count(), 3);
  await page.locator("#master-placement-0-gain").fill("-8");
  await page.locator("#master-placement-0-fade-in").fill("480");
  await page.locator("#master-placement-0-fade-out").fill("2400");
  await page.locator("#master-placement-1-start").fill("9600");
  await page.locator("#master-placement-1-pan").fill("-0.4");
  await page.locator("#master-placement-2-start").fill("33600");
  await page.locator("#master-placement-2-pan").fill("0.5");
  await page.locator("#master-placement-2-gain").fill("-3");

  // 4. Invalid pan: the host's typed 422 names the JSON path; focus moves to that field and nothing is mastered.
  await page.locator("#master-placement-1-pan").fill("3");
  const invalidPost = masterPost();
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  const invalidResponse = await invalidPost;
  assert.equal(invalidResponse.status(), 422, await invalidResponse.text());
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.error.code, "MASTER_PARAMETERS_INVALID");
  assert.equal(invalidBody.error.details.path, "$.stems[1].pan");
  const invalidFailure = page.locator('[data-failure-code="MASTER_PARAMETERS_INVALID"]');
  await invalidFailure.waitFor({ timeout: 15_000 });
  assert.equal(await invalidFailure.getAttribute("data-failure-path"), "$.stems[1].pan");
  await page.waitForFunction(() => document.activeElement?.id === "master-placement-1-pan", null, { timeout: 5_000 });
  assert.equal(await page.locator("[data-master-result]").count(), 0, "nothing was mastered");
  await page.locator("#master-placement-1-pan").fill("-0.4");

  // 5. A non-number is refused locally with its path and never sent.
  const before = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/masters").length;
  await page.locator("#master-placement-2-start").fill("soon");
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  await page.locator("[data-problems]").waitFor({ timeout: 5_000 });
  assert.ok((await page.locator("[data-problems]").textContent()).includes("$.stems[2].startFrame"));
  await page.waitForFunction(() => document.activeElement?.id === "master-placement-2-start", null, { timeout: 5_000 });
  assert.equal(apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/masters").length, before, "nothing was sent");
  await page.locator("#master-placement-2-start").fill("33600");

  // 6. An uploaded stem without a rights statement: typed 403 with its path; nothing is mastered.
  await page.getByRole("button", { name: "Add an uploaded stem to the mix" }).click();
  await page.locator("#master-placement-3-artifact").fill(deniedId);
  await page.locator("#master-placement-3-version").fill(deniedVersion);
  const deniedPost = masterPost();
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  const deniedResponse = await deniedPost;
  assert.equal(deniedResponse.status(), 403, await deniedResponse.text());
  const deniedBody = await deniedResponse.json();
  assert.equal(deniedBody.error.code, "RIGHTS_NOT_ADMITTED");
  assert.equal(deniedBody.error.details.verdict, "DENIED");
  assert.equal(deniedBody.error.details.path, "$.stems[3].artifactId");
  const denied = page.locator('[data-failure-code="RIGHTS_NOT_ADMITTED"]');
  await denied.waitFor({ timeout: 15_000 });
  assert.equal(await denied.getAttribute("data-failure-tone"), "denied");
  assert.ok((await denied.textContent()).includes("Nothing was read, mixed or registered"));
  assert.equal(await page.locator("[data-master-result]").count(), 0);

  // 7. A silent (but attested) stem alone: the host abstains, the page says so and shows no result.
  await page.getByRole("button", { name: "Remove stem 4 from the mix" }).click();
  for (const index of [2, 1, 0]) await page.getByRole("button", { name: `Remove stem ${index + 1} from the mix` }).click();
  await page.getByRole("button", { name: "Add an uploaded stem to the mix" }).click();
  await page.locator("#master-placement-0-artifact").fill(silentId);
  await page.locator("#master-placement-0-version").fill(silentVersion);
  const silentPost = masterPost();
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  const silentResponse = await silentPost;
  assert.equal(silentResponse.status(), 422, await silentResponse.text());
  const silentBody = await silentResponse.json();
  assert.equal(silentBody.error.code, "MASTER_LOUDNESS_TARGET_UNREACHABLE");
  assert.equal(silentBody.error.details.reason, "SILENT_INPUT");
  const abstained = page.locator('[data-failure-code="MASTER_LOUDNESS_TARGET_UNREACHABLE"]');
  await abstained.waitFor({ timeout: 15_000 });
  assert.equal(await abstained.getAttribute("data-failure-tone"), "abstained");
  assert.ok((await abstained.textContent()).includes("abstained"));
  assert.equal(await page.locator("[data-master-result]").count(), 0);
  await page.getByRole("button", { name: "Remove stem 1 from the mix" }).click();

  // 8. Re-add the three original stems with the same placements and master for real.
  await page.getByRole("button", { name: `Add TONE ${tone.artifact.artifactId} to the mix` }).click();
  await page.getByRole("button", { name: `Add DRUM ${kick.artifact.artifactId} to the mix` }).click();
  await page.getByRole("button", { name: `Add FOLEY ${step.artifact.artifactId} to the mix` }).click();
  await page.locator("#master-placement-0-gain").fill("-8");
  await page.locator("#master-placement-0-fade-in").fill("480");
  await page.locator("#master-placement-0-fade-out").fill("2400");
  await page.locator("#master-placement-1-start").fill("9600");
  await page.locator("#master-placement-1-pan").fill("-0.4");
  await page.locator("#master-placement-2-start").fill("33600");
  await page.locator("#master-placement-2-pan").fill("0.5");
  await page.locator("#master-placement-2-gain").fill("-3");
  const okPost = masterPost("/dev/v1/masters", 180_000);
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  const okResponse = await okPost;
  assert.equal(okResponse.status(), 201, await okResponse.text());
  const created = await okResponse.json();
  const sent = JSON.parse(okResponse.request().postData());
  assert.match(sent.requestId, /^master-/u);
  assert.deepEqual(sent.target, { integratedLufs: -16, truePeakDbtp: -1 });
  assert.deepEqual(sent.stems.map((stem) => stem.startFrame), [0, 9600, 33600]);
  assert.equal(sent.stems[0].fadeInFrames, 480);
  const result = page.locator("[data-master-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "master-result-title", null, { timeout: 5_000 });
  const m = created.report.measurement;
  assert.equal(await result.locator("[data-measure='integrated-lufs']").textContent(), `${m.integratedLufs.toFixed(2)} LUFS`);
  assert.equal(await result.locator("[data-measure='true-peak']").textContent(), `${m.truePeakDbtp.toFixed(2)} dBTP`);
  assert.equal(await result.locator("[data-measure='clipped']").textContent(), "0");
  assert.ok(Math.abs(m.integratedLufs + 16) <= 0.25, `host loudness ${m.integratedLufs}`);
  assert.ok(m.truePeakDbtp <= -1, `host true peak ${m.truePeakDbtp}`);
  assert.ok((await result.locator("[data-target-met]").textContent()).includes("target and the ceiling are met"));
  await result.locator("summary").click();
  assert.equal(await result.locator("[data-lineage-table] tbody tr").count(), 3);
  assert.ok((await result.locator('tr[data-stem-index="1"]').textContent()).includes("9600"));
  const summary = await result.locator("[data-master-summary]").textContent();
  assert.ok(summary.includes(`${created.report.format.frames} samples`), summary);

  // 9. Verified playback in a real <audio>: the bytes are hashed against the registered digest before the element exists.
  assert.equal(await result.locator("audio").count(), 0, "no audio before verification");
  await result.getByRole("button", { name: /^Load the WAV master/u }).click();
  await result.locator("[data-playback-kind='WAV']").getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  const verifiedText = await result.locator("[data-playback-kind='WAV'] [data-playback-status]").textContent();
  assert.ok(verifiedText.includes(created.wav.sha256), "the verified message carries the registered digest");
  const wavAudio = result.locator("audio[data-verified-preview='master-wav']");
  await wavAudio.waitFor({ timeout: 10_000 });
  assert.match(await wavAudio.getAttribute("src"), /^blob:/u);
  const waitMetadata = (locator) => locator.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad();
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`audio error ${element.error?.code} ${element.error?.message}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("audio metadata did not load")), 15_000);
  }));
  await waitMetadata(wavAudio);
  const playback = await wavAudio.evaluate(async (element) => {
    const meta = { duration: element.duration };
    element.muted = true;
    await element.play();
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const advanced = element.currentTime;
    element.pause();
    return { ...meta, advanced };
  });
  const expectedSeconds = created.report.format.frames / 48000;
  assert.ok(Math.abs(playback.duration - expectedSeconds) < 0.02, `decoded duration ${playback.duration}s vs ${expectedSeconds}s`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);

  // The browser's OWN decode of both stored masters: stereo, 48 kHz, exact length, the FLAC identical to the WAV sample for
  // sample, and the sample peak equal to the host's report and under the ceiling.
  await result.getByRole("button", { name: /^Load the FLAC master/u }).click();
  const flacAudio = result.locator("audio[data-verified-preview='master-flac']");
  await flacAudio.waitFor({ timeout: 30_000 });
  await waitMetadata(flacAudio);
  const decoded = await page.evaluate(async ({ wav: wavRef, flac: flacRef, bearer }) => {
    const context = new AudioContext({ sampleRate: 48000 });
    // the page CSP does not allow fetching blob: URLs, so the same exact versions are read through the content route
    const read = async (ref) => {
      const response = await fetch(`/dev/v1/artifacts/${ref.artifactId}/content`, { headers: { Authorization: `Bearer ${bearer}`, "If-Match": ref.artifactVersionId } });
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      let peak = 0;
      for (let i = 0; i < left.length; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      return { channels: buffer.numberOfChannels, rate: buffer.sampleRate, length: buffer.length, peak, left, right };
    };
    const wav = await read(wavRef);
    const flac = await read(flacRef);
    let different = 0;
    for (let i = 0; i < wav.left.length; i += 1) if (wav.left[i] !== flac.left[i] || wav.right[i] !== flac.right[i]) different += 1;
    await context.close();
    return { wav: { channels: wav.channels, rate: wav.rate, length: wav.length, peak: wav.peak }, flac: { channels: flac.channels, length: flac.length, peak: flac.peak }, different };
  }, { wav: created.wav, flac: created.flac, bearer: token });
  assert.equal(decoded.wav.channels, 2);
  assert.equal(decoded.wav.rate, 48000);
  assert.equal(decoded.wav.length, created.report.format.frames);
  assert.equal(decoded.flac.length, created.report.format.frames);
  assert.equal(decoded.different, 0, "the FLAC decodes to exactly the WAV samples in the browser");
  const peakDbfs = 20 * Math.log10(decoded.wav.peak);
  assert.ok(Math.abs(peakDbfs - m.samplePeakDbfs) < 0.01, `browser sample peak ${peakDbfs} dBFS vs host ${m.samplePeakDbfs}`);
  assert.ok(peakDbfs <= -1, "no sample above the ceiling");

  // 10. The same request again is a replay under the same request identifier: no second master.
  const replayPost = masterPost();
  await page.getByRole("button", { name: "Mix and master", exact: true }).click();
  const replayResponse = await replayPost;
  assert.equal(replayResponse.status(), 200, await replayResponse.text());
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.masterId, created.masterId);
  assert.equal(JSON.parse(replayResponse.request().postData()).requestId, sent.requestId);
  await result.getByText(/Replayed: the same request identifier/u).waitFor({ timeout: 15_000 });

  // 11. Accessibility structure.
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
    const unnamedAudio = [...document.querySelectorAll("audio")].filter((audio) => !audio.getAttribute("aria-label")).length;
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, regions, groups, unnamedAudio,
      lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 2 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.equal(audit.groups, 0, "every fieldset has a legend");
  assert.equal(audit.unnamedAudio, 0, "every audio element has an accessible name");
  assert.equal(audit.lang, "en");
  const focusRing = await page.evaluate(() => { document.querySelector("#master-stem-duration").focus(); const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);

  // 12. Responsive: a phone viewport has no horizontal page scroll and comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=range]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(failedRequests.filter((entry) => entry.includes("/dev/v1/")), [], "no API request failed at the network level");
  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}; failed requests: ${JSON.stringify(failedRequests)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${created.wav.artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}`, "If-Match": created.wav.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), created.wav.sha256);
  process.stdout.write(`${JSON.stringify({
    event: "mastered", masterId: created.masterId, wavId: created.wav.artifactId, wavSha256: created.wav.sha256, flacId: created.flac.artifactId,
    flacSha256: created.flac.sha256, hostLufs: m.integratedLufs, hostTruePeakDbtp: m.truePeakDbtp, frames: created.report.format.frames,
    playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced, browserSamplePeakDbfs: peakDbfs,
    flacIdenticalToWavInBrowser: decoded.different === 0, stemIds: [tone.artifact.artifactId, kick.artifact.artifactId, step.artifact.artifactId],
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
