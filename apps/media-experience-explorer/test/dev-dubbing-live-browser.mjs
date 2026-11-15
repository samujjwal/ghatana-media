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
const token = requiredEnv("MEDIA_DEV_DUB_BROWSER_TOKEN");
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

const transcriptId = requiredEnv("MEDIA_DEV_DUB_TRANSCRIPT_ID");
const transcriptVersion = requiredEnv("MEDIA_DEV_DUB_TRANSCRIPT_VERSION");
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
delete viteEnvironment.MEDIA_DEV_DUB_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EDIT_CANDIDATES = ["Bienvenidos a nuestra presentación del informe trimestral.", "Bienvenidos a la presentación del informe trimestral."];
const LONG_FIRST = "Bienvenidos a todos ustedes a esta presentación extraordinariamente larga del informe trimestral de resultados "
  + "financieros de nuestra empresa, que de ninguna manera cabe dentro de la ventana de tiempo original del primer segmento.";


let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-dubbing.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual dubbing page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The deliberate typed 422 overflow refusal is logged by Chromium as a failed resource load; nothing else is tolerated.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 422/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const isPost = (path) => (response) => new URL(response.url()).pathname === path && response.request().method() === "POST";

  // 1. Connect; the admitted targets, voices and policies come FROM THE HOST (captured from the real response).
  await page.goto(`${baseUrl}/dev-dubbing.html`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  let capabilitiesResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-dubbing.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/translations/capabilities", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { capabilitiesResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "Translate and dub", level: 2 }).waitFor({ timeout: 30_000 });
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.translation.ready, true, "the real Qwen translation engine must be admitted on this host");
  assert.equal(capabilities.dubbing.ready, true, "the real Kokoro model must be verified on this host");
  const hostTargets = capabilities.translation.admittedTargets.en;
  const optionValues = async (label) => page.getByLabel(label, { exact: true }).locator("option").evaluateAll((options) => options.map((option) => option.value));
  await page.waitForFunction(() => document.querySelector("#dubbing-target")?.options.length > 0, null, { timeout: 10_000 });
  assert.deepEqual(await optionValues("Target language"), hostTargets, "targets come from the host");
  assert.deepEqual(hostTargets, ["es"], "only Spanish is admitted");
  assert.ok(!(await optionValues("Target language")).includes("de"), "an unadmitted target (de) is not offered");
  const hostVoices = Object.keys(capabilities.dubbing.voices).sort();
  assert.deepEqual(hostVoices, ["ef_dora", "em_alex", "em_santa"], "the three Spanish stock voices");
  const facts = await page.locator("[data-dubbing-facts]").textContent();
  for (const voice of hostVoices) assert.ok(facts.includes(voice), `voice ${voice} is listed`);
  assert.ok(facts.includes("Not supported"), "voice cloning status is shown");
  assert.ok(facts.includes("0.8 to 1.25"), "tempo bounds are the host's");
  assert.ok(await page.locator("[aria-live='polite']").count() >= 3, "live regions announce status");

  // 2. Translate by KEYBOARD ONLY: type both ids, Tab to the target select and then Translate, press Enter.
  await page.getByLabel("Transcript artifact id").focus();
  await page.keyboard.type(transcriptId);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dubbing-transcript-version");
  await page.keyboard.type(transcriptVersion);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dubbing-target");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Translate");
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  const translatePost = page.waitForResponse(isPost("/dev/v1/translations"), { timeout: 480_000 });
  await page.keyboard.press("Enter");
  const translateResponse = await translatePost;
  assert.equal(translateResponse.status(), 201, await translateResponse.text());
  const translation = await translateResponse.json();
  const translateBody = JSON.parse(translateResponse.request().postData());
  assert.deepEqual({ ...translateBody, requestId: "x" }, { requestId: "x", transcriptArtifactId: transcriptId,
    transcriptArtifactVersionId: transcriptVersion, sourceLanguage: "en", targetLanguage: "es" });
  assert.match(translateBody.requestId, /^dub-/u);
  await page.locator("[data-segment-table]").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "dubbing-segments-title", null, { timeout: 5_000 });
  const rows = page.locator("[data-segment-table] tbody tr");
  assert.equal(await rows.count(), translation.segments.length);
  assert.ok(translation.segments.length >= 2, "the narration has at least two segments");
  for (const segment of translation.segments) {
    const row = page.locator(`[data-segment-table] tr[data-segment-id="${segment.segmentId}"]`);
    assert.equal(await row.locator("textarea").inputValue(), segment.text, "the translation shown is the host's");
    assert.ok((await row.textContent()).includes(segment.sourceText), "the source text is shown");
  }
  assert.equal(await page.getByRole("button", { name: "Dub", exact: true }).isDisabled(), false);
  assert.equal(await page.getByRole("button", { name: "Save revision" }).isDisabled(), true, "nothing to save yet");
  assert.deepEqual(await optionValues("Spanish stock voice"), hostVoices, "only the host's Spanish voices are offered");

  // The edit must differ from whatever the real model produced.
  const EDITED_FIRST = EDIT_CANDIDATES.find((candidate) => candidate !== translation.segments[0].text);
  // 3. Edit segment 1: Dub is refused for unsaved edits, then Save revision creates a NEW version.
  await page.getByLabel("Translation of seg-0001").fill(EDITED_FIRST);
  assert.equal(await page.getByRole("button", { name: "Dub", exact: true }).isDisabled(), true, "unsaved edits cannot be dubbed");
  const revisePost = page.waitForResponse(isPost("/dev/v1/translations/revisions"));
  await page.getByRole("button", { name: "Save revision" }).click();
  const reviseResponse = await revisePost;
  assert.equal(reviseResponse.status(), 201, await reviseResponse.text());
  const revised = await reviseResponse.json();
  const reviseBody = JSON.parse(reviseResponse.request().postData());
  assert.equal(reviseBody.baseArtifactId, translation.translation.artifact.artifactId);
  assert.equal(reviseBody.baseArtifactVersionId, translation.translation.artifact.artifactVersionId);
  assert.deepEqual(reviseBody.segments.map((segment) => segment.segmentId), translation.segments.map((segment) => segment.segmentId));
  assert.equal(reviseBody.segments[0].text, EDITED_FIRST);
  assert.equal(revised.translation.lineage.kind, "LOCAL_TRANSLATED_TRANSCRIPT_USER_REVISED");
  assert.notEqual(revised.translation.artifact.artifactVersionId, translation.translation.artifact.artifactVersionId);
  await page.waitForFunction((version) => document.querySelector("[data-translation-version]")?.getAttribute("data-translation-version") === version,
    revised.translation.artifact.artifactVersionId, { timeout: 15_000 });
  assert.equal(await page.getByLabel("Translation of seg-0001").inputValue(), EDITED_FIRST);
  assert.equal(await page.getByRole("button", { name: "Dub", exact: true }).isDisabled(), false);

  // 4. Dub the saved revision (ALLOW_SPILL: a segment is kept whole when it does not collide with the next one).
  await page.getByLabel("Overflow policy").selectOption("ALLOW_SPILL");
  await page.getByLabel("Spanish stock voice").selectOption("ef_dora");
  const dubPost = page.waitForResponse(isPost("/dev/v1/dubs"), { timeout: 300_000 });
  await page.getByRole("button", { name: "Dub", exact: true }).click();
  const dubResponse = await dubPost;
  assert.equal(dubResponse.status(), 201, await dubResponse.text());
  const dub = await dubResponse.json();
  const dubBody = JSON.parse(dubResponse.request().postData());
  assert.deepEqual({ ...dubBody, requestId: "x" }, { requestId: "x", translatedArtifactId: revised.translation.artifact.artifactId,
    translatedArtifactVersionId: revised.translation.artifact.artifactVersionId, voice: "ef_dora", overflowPolicy: "ALLOW_SPILL" });
  const result = page.locator("[data-dub-result]");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "dubbing-result-title", null, { timeout: 5_000 });
  // The timing table is the host's measured JSON, row by row.
  const hostSegments = dub.timing.segments;
  const fitText = { FITS: "Fits (no change)", TEMPO_ADJUSTED: "Fits after tempo adjustment", OVERFLOW: "Overflow" };
  const tableRows = result.locator("tbody tr");
  assert.equal(await tableRows.count(), hostSegments.length);
  for (const segment of hostSegments) {
    const text = await result.locator(`tr[data-segment-id="${segment.segmentId}"]`).textContent();
    assert.ok(text.includes(`${segment.naturalDurationMillis} ms`), `natural ${segment.naturalDurationMillis} in ${text}`);
    assert.ok(text.includes(`${segment.dubDurationMillis} ms`), `dub ${segment.dubDurationMillis} in ${text}`);
    assert.ok(text.includes(segment.tempoFactor.toFixed(4)), `tempo ${segment.tempoFactor} in ${text}`);
    assert.ok(text.includes(fitText[segment.fit]), `fit ${segment.fit} in ${text}`);
    assert.equal(await result.locator(`tr[data-segment-id="${segment.segmentId}"]`).getAttribute("data-fit"), segment.fit);
  }
  const totals = await result.locator("[data-timing-totals]").textContent();
  assert.ok(totals.includes(`Track ${(dub.timing.totals.trackDurationMillis / 1000).toFixed(2)} s`), totals);
  assert.ok(totals.includes("voice ef_dora"), totals);
  assert.ok((await result.locator("[data-lip-timing-note]").textContent()).includes("source speech window"), "the lip timing note is shown");
  assert.ok((await result.textContent()).includes("Disclose it as synthetic"), "synthetic speech disclosure is shown");

  // 5. Verified playback: both digests are checked before the audio element exists; it loads, matches and advances.
  await result.getByRole("button", { name: /^Load dubbed audio/u }).click();
  await result.getByText(/Bytes verified against the registered versions/u).waitFor({ timeout: 30_000 });
  const audioArtifact = dub.outputs.audio.artifact;
  const captionsArtifact = dub.outputs.captions.artifact;
  const verifiedText = await result.locator("[data-playback-status]").textContent();
  assert.ok(verifiedText.includes(audioArtifact.sha256) && verifiedText.includes(captionsArtifact.sha256), "the verified message carries both registered digests");
  const audio = result.locator("audio[data-verified-preview='dub-audio']");
  await audio.waitFor({ timeout: 10_000 });
  assert.match(await audio.getAttribute("src"), /^blob:/u);
  assert.equal(await audio.locator("track").getAttribute("kind"), "captions");
  assert.equal(await audio.locator("track").getAttribute("srclang"), "es");
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    const advanced = element.currentTime;
    element.pause();
    const track = element.textTracks[0];
    return { duration, advanced, readyState: element.readyState, trackKind: track?.kind, trackLanguage: track?.language };
  });
  const trackMillis = dub.timing.totals.trackDurationMillis;
  assert.ok(Math.abs(playback.duration * 1000 - trackMillis) < 60, `decoded duration ${playback.duration}s must match the host's ${trackMillis} ms track`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);
  assert.equal(playback.trackKind, "captions");
  // The same exact version fetched independently of the page hashes to the registered digest.
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${audioArtifact.artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}`, "If-Match": audioArtifact.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), audioArtifact.sha256);

  // 6. Overflow: a far-too-long first segment is a typed refusal with the host's per-segment fit; nothing is dubbed.
  await page.getByLabel("Translation of seg-0001").fill(LONG_FIRST);
  const longRevise = page.waitForResponse(isPost("/dev/v1/translations/revisions"));
  await page.getByRole("button", { name: "Save revision" }).click();
  { const lr = await longRevise; assert.equal(lr.status(), 201, await lr.text()); }
  assert.equal(await page.locator("[data-dub-result]").count(), 0, "a new version clears the previous dub result");
  await page.getByLabel("Overflow policy").selectOption("REFUSE");
  const overflowPost = page.waitForResponse(isPost("/dev/v1/dubs"), { timeout: 300_000 });
  await page.getByRole("button", { name: "Dub", exact: true }).click();
  const overflowResponse = await overflowPost;
  assert.equal(overflowResponse.status(), 422, await overflowResponse.text());
  const overflowBody = await overflowResponse.json();
  assert.equal(overflowBody.error.code, "DUB_TIMING_OVERFLOW");
  const failure = page.locator('[data-failure-code="DUB_TIMING_OVERFLOW"]');
  await failure.waitFor({ timeout: 15_000 });
  assert.equal(await failure.getAttribute("data-failure-tone"), "overflow");
  assert.equal(await page.locator("[data-dub-result]").count(), 0, "nothing was dubbed");
  const failureText = await failure.textContent();
  assert.ok(failureText.includes("Nothing was registered and no audio was truncated"), failureText);
  const overflowDetails = overflowBody.error.details;
  assert.equal(overflowDetails.overflowSegments[0].segmentId, "seg-0001");
  assert.ok(overflowDetails.overflowSegments[0].requiredTempoFactor > 1.25);
  assert.equal(await failure.locator("[data-overflow-segment]").count(), overflowDetails.overflowSegments.length);
  assert.equal(await failure.locator("tbody tr").count(), overflowDetails.segments.length);
  assert.equal(await failure.locator('tr[data-segment-id="seg-0001"]').getAttribute("data-fit"), "OVERFLOW");
  assert.ok((await failure.locator('tr[data-segment-id="seg-0001"]').textContent()).includes("Overflow"));

  // 7. Accessibility structure: labelled controls, captioned tables with scoped headers, unique ids, alerts.
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
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index), unnamedButtons, regions,
      alerts: document.querySelectorAll("[role=alert]").length, lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 2 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.ok(audit.alerts >= 1, "the typed refusal is an alert");
  assert.equal(audit.lang, "en");

  // 8. Responsive: a phone viewport has no horizontal page scroll and comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input, textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const dubBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/dubs").map((entry) => JSON.parse(entry.body));
  assert.equal(dubBodies.length, 2);
  assert.ok(dubBodies.every((body) => typeof body.requestId === "string" && body.voiceReference === undefined && body.likenessReference === undefined));
  assert.notEqual(dubBodies[0].requestId, dubBodies[1].requestId, "a different request gets a fresh identifier");
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "dubbed",
    translationId: translation.translationId, revisedId: revised.translationId,
    revisedVersion: revised.translation.artifact.artifactVersionId, dubId: dub.dubId,
    segments: hostSegments.length, trackMillis, playbackDurationSeconds: playback.duration, playbackAdvancedSeconds: playback.advanced,
    fits: hostSegments.map((segment) => `${segment.segmentId}:${segment.fit}:${segment.tempoFactor}`),
    overflowSegments: overflowDetails.overflowSegments.map((segment) => `${segment.segmentId}:${segment.requiredTempoFactor}`),
    audioSha256: audioArtifact.sha256, requestIds: dubBodies.map((body) => body.requestId),
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
