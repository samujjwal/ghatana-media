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
const token = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_TOKEN");
const wavId = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_WAV_ID");
const wavSha256 = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_WAV_SHA256");
const rigJson = requiredEnv("MEDIA_DEV_CREATIVE_BROWSER_RIG_JSON");
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

const vitePort = 4179;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_CREATIVE_BROWSER_TOKEN;
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
      const response = await fetch(`${baseUrl}/dev-creative-outputs.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual creative-outputs page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  const contentRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Console errors carry the resource URL so each deliberate 4xx is tolerated only by its exact path and status.
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
    if (path.endsWith("/content")) contentRequests.push({ url: request.url(), headers: request.headers() });
  });

  async function connect(bearer) {
    await page.goto(`${baseUrl}/dev-creative-outputs.html`);
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(bearer);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: /Creative outputs · DEV_ONLY/u }).waitFor({ timeout: 15_000 });
  }
  const result = page.locator("#creative-result");
  const ddOf = async (scope, term) => (await scope.locator("dt", { hasText: term }).first().locator("xpath=following-sibling::dd").textContent()).trim();

  // Verified preview (when previewable) and Download of one registered output; the saved file is hashed independently.
  async function assertVerifiedContent(outputId, kind, expectedSha, label) {
    const noun = kind.toUpperCase();
    const section = result.getByRole("region", { name: `${noun} content` });
    if (kind === "wav") {
      await section.getByRole("button", { name: /^Preview WAV/u }).click();
      await section.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
      const audio = section.locator("audio[data-verified-preview='wav']");
      await audio.waitFor({ timeout: 10_000 });
      assert.match(await audio.getAttribute("src"), /^blob:/u, `${label}: preview must be a blob URL`);
      await audio.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
        if (element.readyState >= 1) return resolveLoad();
        element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
        element.addEventListener("error", () => rejectLoad(new Error(`audio error ${element.error?.code}: ${element.error?.message}`)), { once: true });
        setTimeout(() => rejectLoad(new Error("audio metadata did not load")), 15_000);
      }));
      const loaded = await audio.evaluate((element) => ({ readyState: element.readyState, duration: element.duration }));
      assert.ok(loaded.readyState >= 1 && loaded.duration > 0.9 && loaded.duration < 1.1, `${label}: the 8000-frame 8 kHz WAV must report ~1 s, got ${JSON.stringify(loaded)}`);
      assert.ok((await section.textContent()).includes(expectedSha), `${label}: verified message must carry the sha256`);
    } else {
      assert.equal(await section.getByRole("button", { name: /^Preview/u }).count(), 0, `${label}: ${noun} is download-only`);
    }
    const downloading = page.waitForEvent("download");
    await section.getByRole("button", { name: new RegExp(`^Download ${noun}`, "u") }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), `${outputId}.${kind}`);
    const saved = sha256Of(await readFile(await download.path()));
    assert.equal(saved, expectedSha, `${label}: downloaded ${noun} must hash to the registered sha256`);
  }

  async function readSimulationTable(label, expectedSha) {
    const table = page.getByLabel("Simulated observation series");
    await table.waitFor({ timeout: 30_000 });
    assert.ok((await result.textContent()).includes("Bytes verified against the registered version before this table was built."), `${label}: table must come from verified bytes`);
    assert.match(await table.locator("thead").textContent(), /totalEnergy \(JOULE\)/u);
    const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.ok(rows.length >= 2, `${label}: observation rows`);
    const last = rows[rows.length - 1].map(Number);
    // 6 N on 2 kg for 2 s from rest: acceleration 3, terminal velocity 6, terminal position 6. The reported total
    // energy is conserved for a constant force (kinetic 36 J minus the potential F*x = 36 J), so it stays at 0.
    assert.ok(Math.abs(last[0] - 2) < 1e-9 && Math.abs(last[1] - 6) < 1e-6 && Math.abs(last[2] - 6) < 1e-6 && Math.abs(last[3] - 3) < 1e-6,
      `${label}: terminal observation ${JSON.stringify(rows[rows.length - 1])}`);
    assert.ok(rows.every((row) => Math.abs(Number(row[4])) < 1e-5), `${label}: total energy must be conserved at 0: ${JSON.stringify(rows)}`);
    assert.equal(await ddOf(result, "SHA-256"), expectedSha);
    return rows.length;
  }

  await connect(token);
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // ---- Audio repair of the seeded clipped WAV ----
  await page.getByLabel("Source artifact ID").fill(wavId);
  await page.getByLabel("Exact source artifact version").fill(`sha256:${wavSha256}`);
  await page.getByLabel(/Clipping threshold/u).fill("0.94");
  await page.getByLabel(/Maximum clipped run/u).fill("64");
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "AUDIO_REPAIR_CANDIDATE");
  const audioId = await result.getAttribute("data-output-id");
  assert.ok(audioId && audioId !== wavId, "the repaired output must be a NEW artifact");
  const audioSha = await ddOf(result, "SHA-256");
  assert.match(audioSha, /^[0-9a-f]{64}$/u);
  assert.notEqual(audioSha, wavSha256, "the repaired bytes must differ from the clipped source");
  assert.equal(await ddOf(result, "Artifact version"), `sha256:${audioSha}`);
  assert.match(await ddOf(result, "Content type and size"), /^audio\/wav · \d+ bytes$/u);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source artifact"), wavId);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source SHA-256"), wavSha256);
  await result.getByRole("heading", { name: "Engine sample statistics" }).waitFor();
  assert.match(await result.textContent(), /not a quality assessment/u);
  const statistics = page.getByLabel("Engine sample statistics");
  const changed = Number(await ddOf(statistics, "changedSampleCount"));
  assert.ok(Number.isFinite(changed) && changed > 0, `a hard-clipped sine must change samples, got ${changed}`);
  await assertVerifiedContent(audioId, "wav", audioSha, "audio output");
  // Same request identity again: replay, not a second registration.
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "Replayed (HTTP 200)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-output-id"), audioId);
  const audioPosts = apiRequests.filter(({ method, path }) => method === "POST" && path === "/dev/v1/creative-outputs/audio-repairs");
  assert.equal(audioPosts.length, 2);
  assert.equal(JSON.parse(audioPosts[0].body).requestId, JSON.parse(audioPosts[1].body).requestId, "replay must reuse the request identity");

  // ---- REJECTED simulation, then the corrected run ----
  assert.match(await page.getByLabel("Simulated output label").textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  await page.getByRole("button", { name: /Load worked example/u }).click();
  await page.locator("#sim-invariant-expected-value").fill("7"); // the model's terminal position is 6, not 7
  expectedErrors.push({ pathname: "/dev/v1/creative-outputs/simulations", status: 422 });
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "SIMULATION_VALIDATION_REJECTED" }).waitFor({ timeout: 60_000 });
  const findings = await page.getByLabel("Validator findings").textContent();
  assert.match(findings, /terminal-position/u, "the validator finding must name the failed invariant");
  assert.equal(await page.locator("#creative-result[data-kind='SIMULATED_OUTPUT_NOT_MEASUREMENT']").count(), 0, "a REJECTED run must show no output");
  assert.equal(await result.getAttribute("data-output-id"), audioId, "the earlier audio result is untouched by the rejection");
  const rejectedFindings = findings.trim();

  await page.locator("#sim-invariant-expected-value").fill("6");
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "SIMULATED_OUTPUT_NOT_MEASUREMENT");
  assert.match(await result.textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  assert.equal(await ddOf(result.getByLabel("Simulation lineage"), "Validation disposition"), "VALID");
  const simId = await result.getAttribute("data-output-id");
  const simSha = await ddOf(result, "SHA-256");
  assert.equal(await ddOf(result, "Artifact version"), `sha256:${simSha}`);
  const simRows = await readSimulationTable("created simulation", simSha);
  assert.doesNotMatch(await result.textContent(), /no DEV_ONLY content route/u);

  // ---- Spatial GLB from seeded source artifacts ----
  await page.getByLabel("Rig JSON").fill(rigJson);
  await page.getByRole("button", { name: "Export GLB" }).click();
  await page.locator("#spatial-status", { hasText: "Created (HTTP 201)" }).waitFor({ timeout: 60_000 });
  assert.equal(await result.getAttribute("data-kind"), "SPATIAL_GLB_EXPORT");
  const glbId = await result.getAttribute("data-output-id");
  const glbSha = await ddOf(result, "SHA-256");
  assert.match(await ddOf(result, "Content type and size"), /^model\/gltf-binary · \d+ bytes$/u);
  assert.match(await result.textContent(), /productionGrant=false/u);
  assert.match(await result.textContent(), /float32LossFields/u);
  await assertVerifiedContent(glbId, "glb", glbSha, "spatial GLB");

  // Content reads never carry the token or the version in a URL and never use Range.
  assert.ok(contentRequests.length >= 3);
  for (const entry of contentRequests) {
    assert.ok(!entry.url.includes("?") && !entry.url.includes("Bearer") && !entry.url.includes(token), `token/version must not be in the URL: ${entry.url}`);
    assert.match(entry.headers["if-match"], /^sha256:[0-9a-f]{64}$/u);
    assert.equal(entry.headers.range, undefined);
  }

  process.stdout.write(`${JSON.stringify({ event: "created", audioId, audioSha, simId, simSha, glbId, glbSha, simRows, rejectedFindings })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let freshToken = null;
  for await (const line of input) {
    if (line.startsWith("host-restarted ")) { freshToken = line.slice("host-restarted ".length).trim(); break; }
  }
  input.close();
  assert.ok(freshToken, "the integration host must restart and issue a fresh token before readback");

  // ---- After the restart: a clean page reopens each output by id from the durable host ----
  const postsBefore = apiRequests.filter(({ method }) => method === "POST").length;
  await connect(freshToken);
  assert.equal(await result.count(), 0, "a reloaded page must not claim an output it never read");
  async function reopenById(id, kind) {
    await page.getByLabel("Output ID").fill(id);
    await page.getByRole("button", { name: "Reopen output from the host" }).click();
    await page.locator("#reopen-status", { hasText: `Reopened output ${id}` }).waitFor({ timeout: 30_000 });
    assert.equal(await result.getAttribute("data-output-id"), id);
    assert.equal(await result.getAttribute("data-kind"), kind);
  }
  await reopenById(audioId, "AUDIO_REPAIR_CANDIDATE");
  assert.equal(await ddOf(result, "SHA-256"), audioSha);
  assert.equal(await ddOf(result.getByLabel("Audio repair lineage"), "Source SHA-256"), wavSha256);
  await assertVerifiedContent(audioId, "wav", audioSha, "reopened audio output");
  await reopenById(simId, "SIMULATED_OUTPUT_NOT_MEASUREMENT");
  assert.equal(await readSimulationTable("reopened simulation", simSha), simRows);
  await reopenById(glbId, "SPATIAL_GLB_EXPORT");
  assert.equal(await ddOf(result, "SHA-256"), glbSha);
  await assertVerifiedContent(glbId, "glb", glbSha, "reopened spatial GLB");

  // A plain (non-output) artifact id and an unknown id are typed 404s; each is tolerated only by its exact path.
  for (const unknown of [wavId, `missing-${crypto.randomUUID()}`]) {
    expectedErrors.push({ pathname: `/dev/v1/creative-outputs/${unknown}`, status: 404 });
    await page.getByLabel("Output ID").fill(unknown);
    await page.getByRole("button", { name: "Reopen output from the host" }).click();
    await page.locator("#reopen-status", { hasText: "CREATIVE_OUTPUT_NOT_FOUND" }).waitFor({ timeout: 30_000 });
  }
  assert.equal(apiRequests.filter(({ method }) => method === "POST").length, postsBefore, "post-restart readback must not mutate");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter(({ text, pathname }) =>
    !expectedErrors.some((expected) => expected.pathname === pathname && text.includes(`status of ${expected.status}`)));
  assert.deepEqual(unexpectedConsoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token) && !stored.includes(freshToken), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({ event: "readback", audioId, simId, glbId, audioSha, simSha, glbSha })}\n`);
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
