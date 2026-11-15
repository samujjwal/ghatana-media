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
const token = requiredEnv("MEDIA_DEV_REFSCENE_BROWSER_TOKEN");
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

const heroId = requiredEnv("MEDIA_DEV_REFSCENE_HERO_ID");
const heroVersion = requiredEnv("MEDIA_DEV_REFSCENE_HERO_VERSION");
const logoId = requiredEnv("MEDIA_DEV_REFSCENE_LOGO_ID");
const logoVersion = requiredEnv("MEDIA_DEV_REFSCENE_LOGO_VERSION");
const strangerId = requiredEnv("MEDIA_DEV_REFSCENE_STRANGER_ID");
const strangerVersion = requiredEnv("MEDIA_DEV_REFSCENE_STRANGER_VERSION");
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
delete viteEnvironment.MEDIA_DEV_REFSCENE_BROWSER_TOKEN;
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
      const response = await fetch(`${baseUrl}/dev-reference-scenes.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual reference scenes page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The deliberate typed 403/422/503 refusals are logged by Chromium as failed resource loads; nothing else is tolerated.
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (403|422|503)/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const post = (suffix, timeout = 120_000) => page.waitForResponse((response) => new URL(response.url()).pathname === `/dev/v1/reference-scenes/${suffix}`
    && response.request().method() === "POST", { timeout });
  const path = (value) => page.locator(`[data-path="${value}"]`);
  const focusedPath = (value) => page.waitForFunction((expected) => document.activeElement?.getAttribute("data-path") === expected, value, { timeout: 5_000 });

  // 1. Connect; the capabilities come FROM THE HOST.
  await page.goto(`${baseUrl}/dev-reference-scenes.html`, { waitUntil: "networkidle" });
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-reference-scenes.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/reference-scenes/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "Host capabilities", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.ready, true);
  assert.equal(status.model.available, false);
  const modelState = await page.locator("#rs-model-state").textContent();
  assert.ok(modelState.includes("unavailable") && modelState.includes("NO_ADMITTED_GENERATIVE_MODEL"), modelState);

  // 2. A reference without a rights statement: the typed 403 names the reference; focus moves to its field; nothing is stored.
  await path("$.references[0].referenceId").fill("hero");
  await path("$.references[0].artifactId").fill(strangerId);
  await path("$.references[0].artifactVersionId").fill(strangerVersion);
  const deniedPost = post("reference-sets");
  await page.getByRole("button", { name: "Register reference set", exact: true }).click();
  const deniedResponse = await deniedPost;
  assert.equal(deniedResponse.status(), 403);
  const deniedBody = await deniedResponse.json();
  assert.equal(deniedBody.error.code, "RIGHTS_NOT_ADMITTED");
  assert.equal(deniedBody.error.details.verdict, "DENIED");
  await page.locator("#rs-error").waitFor({ timeout: 15_000 });
  assert.ok((await page.locator("#rs-error").textContent()).includes("RIGHTS_NOT_ADMITTED"));
  await focusedPath("$.references[0].artifactId");
  assert.equal(await page.locator("#rs-set-result").count(), 0, "no set was registered");

  // 3. The attested references: hero and logo.
  await path("$.references[0].artifactId").fill(heroId);
  await path("$.references[0].artifactVersionId").fill(heroVersion);
  await page.getByRole("button", { name: "Add reference", exact: true }).click();
  await path("$.references[1].referenceId").fill("logo");
  await path("$.references[1].artifactId").fill(logoId);
  await path("$.references[1].artifactVersionId").fill(logoVersion);
  const setPost = post("reference-sets");
  await page.getByRole("button", { name: "Register reference set", exact: true }).click();
  const setResponse = await setPost;
  assert.equal(setResponse.status(), 201, await setResponse.text());
  const setView = await setResponse.json();
  await page.locator("#rs-set-result").waitFor({ timeout: 15_000 });
  const setText = await page.locator("#rs-set-result").textContent();
  assert.ok(setText.includes("hero 48×64") && setText.includes("logo 64×64"), setText);

  // 4. MODEL mode: typed unavailability, no scenes, no template fallback.
  await page.getByLabel("Generative model (unavailable on this host)").check();
  const modelPost = post("runs");
  await page.getByRole("button", { name: "Ask the model", exact: true }).click();
  const modelResponse = await modelPost;
  assert.equal(modelResponse.status(), 503);
  const modelBody = await modelResponse.json();
  assert.equal(modelBody.error.code, "MODEL_UNAVAILABLE");
  assert.equal(modelBody.error.details.artifactsCreated, 0);
  await page.locator("#rs-model-note").waitFor({ timeout: 15_000 });
  assert.ok((await page.locator("#rs-model-note").textContent()).includes("no template was substituted"));
  assert.equal(await page.locator("img[data-scene]").count(), 0, "no scene was shown");
  await page.getByLabel("Authored template (deterministic)").check();

  // 5. Template: slot 1 hero, slot 2 logo with a recolour.
  await page.getByRole("button", { name: "Add slot", exact: true }).click();
  await path("$.parameters.slots[0].referenceId").fill("hero");
  await path("$.parameters.slots[0].x").fill("0.3");
  await path("$.parameters.slots[0].height").fill("0.55");
  await path("$.parameters.slots[1].referenceId").fill("logo");
  await path("$.parameters.slots[1].x").fill("0.75");
  await path("$.parameters.slots[1].height").fill("0.3");
  await path("$.parameters.slots[1].tint.color").fill("#38BDF8");
  await path("$.parameters.slots[1].tint.strength").fill("0.1");
  await path("$.parameters.sparkles").fill("20");

  // 5a. Invalid height: the typed 422 names the JSON path and focus moves to that field.
  await path("$.parameters.slots[0].height").fill("3");
  const invalidPost = post("runs");
  await page.getByRole("button", { name: "Generate scenes", exact: true }).click();
  const invalidResponse = await invalidPost;
  assert.equal(invalidResponse.status(), 422);
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.error.code, "REFERENCE_SCENE_SPEC_INVALID");
  assert.equal(invalidBody.error.details.path, "$.parameters.slots[0].height");
  await focusedPath("$.parameters.slots[0].height");
  await path("$.parameters.slots[0].height").fill("0.55");

  // 5b. A slot naming a reference that is not in the set: typed 422 REFERENCE_NOT_IN_SET, focus on the field.
  await path("$.parameters.slots[1].referenceId").fill("stranger");
  const outsiderPost = post("runs");
  await page.getByRole("button", { name: "Generate scenes", exact: true }).click();
  const outsiderBody = await (await outsiderPost).json();
  assert.equal(outsiderBody.error.code, "REFERENCE_NOT_IN_SET");
  assert.equal(outsiderBody.error.details.path, "$.parameters.slots[1].referenceId");
  await focusedPath("$.parameters.slots[1].referenceId");
  await path("$.parameters.slots[1].referenceId").fill("logo");

  // 5c. A continuity threshold the scenes cannot meet: typed failure with the failing metrics; nothing is shown.
  await path("$.continuity.maxHistogramDistance").fill("0.0001");
  const strictPost = post("runs");
  await page.getByRole("button", { name: "Generate scenes", exact: true }).click();
  const strictResponse = await strictPost;
  assert.equal(strictResponse.status(), 422);
  const strictBody = await strictResponse.json();
  assert.equal(strictBody.error.code, "CONTINUITY_THRESHOLD_FAILED");
  await page.locator("#rs-error").waitFor({ timeout: 15_000 });
  const violationsText = await page.locator("[role=alert] table").textContent();
  assert.ok(violationsText.includes("histogramDistance"), violationsText);
  assert.equal(await page.locator("img[data-scene]").count(), 0, "a continuity failure shows no scene");
  await path("$.continuity.maxHistogramDistance").fill("");

  // 6. The real run.
  const runPost = post("runs");
  await page.getByRole("button", { name: "Generate scenes", exact: true }).click();
  const runResponse = await runPost;
  assert.equal(runResponse.status(), 201, await runResponse.text());
  const created = await runResponse.json();
  assert.equal(created.outcome, "CONTINUITY_PASSED");
  assert.equal(created.scenes.length, 3);
  await page.locator("img[data-scene]").nth(2).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => [...document.querySelectorAll("img[data-scene]")].every((img) => img.complete && img.naturalWidth === 320), null, { timeout: 30_000 });
  assert.equal(await page.locator("img[data-scene]").count(), 3);
  await page.waitForFunction(() => document.activeElement?.id === "rs-result", null, { timeout: 5_000 });
  const metricsRows = await page.locator("#rs-metrics tbody tr").count();
  assert.equal(metricsRows, 6, "three scenes times two slots");
  // The browser's own decode of the displayed scene: the hero rectangle holds the reference's yellow, the logo's is recoloured.
  const heroRect = created.manifest.scenes[1].metrics.slots[0].rect;
  const decoded = await page.locator('img[data-scene="1"]').evaluate((img, rect) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { topLeft: pixel(rect.x + 1, rect.y + 1), topRight: pixel(rect.x + rect.width - 2, rect.y + 1) };
  }, heroRect);
  assert.deepEqual(decoded.topLeft, [0xFF, 0xD0, 0x00], "hero left half is the reference's yellow in the browser decode");
  assert.deepEqual(decoded.topRight, [0x20, 0x60, 0xFF], "hero right half is the reference's blue in the browser decode");

  // 7. Fetch the stored bytes independently of the page: SHA-256 equals the registered one.
  for (const scene of created.scenes) {
    const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${scene.artifactId}/content`, {
      headers: { Authorization: `Bearer ${token}`, "If-Match": scene.artifactVersionId } });
    assert.equal(independent.status, 200);
    assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), scene.sha256);
  }

  // 8. Regenerate: byte-identical, nothing registered.
  const regeneratePost = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/regenerations"), { timeout: 60_000 });
  await page.getByRole("button", { name: "Regenerate and compare", exact: true }).click();
  const regenerated = await (await regeneratePost).json();
  assert.equal(regenerated.byteIdentical, true);
  assert.equal(regenerated.artifactsCreated, 0);
  await page.locator("#rs-proof").waitFor({ timeout: 15_000 });
  assert.ok((await page.locator("#rs-proof").textContent()).startsWith("Byte-identical"));

  // 9. The same inputs again reuse the request id: the host replays, registering nothing new.
  const replayPost = post("runs");
  await page.getByRole("button", { name: "Generate scenes", exact: true }).click();
  const replayResponse = await replayPost;
  assert.equal(replayResponse.status(), 200);
  assert.equal((await replayResponse.json()).replayed, true);
  await page.waitForFunction(() => document.querySelectorAll("img[data-scene]").length === 3, null, { timeout: 30_000 });

  // 10. Accessibility and responsiveness.
  const audit = await page.evaluate(() => {
    const labelled = (element) => element.labels?.length > 0 || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
    const unlabelled = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((element) => !labelled(element)).map((element) => element.id || element.name || element.type);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    return {
      unlabelled,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      tables: [...document.querySelectorAll("table")].map((table) => ({ caption: !!table.querySelector("caption"), scopedHeaders: [...table.querySelectorAll("th")].every((th) => th.getAttribute("scope") === "col") })),
      unnamedButtons: [...document.querySelectorAll("button")].filter((button) => !button.textContent?.trim() && !button.getAttribute("aria-label")).length,
      altless: [...document.querySelectorAll("img")].filter((img) => !img.getAttribute("alt")).length,
      groups: [...document.querySelectorAll("fieldset")].filter((fieldset) => !fieldset.querySelector("legend")).length,
      liveRegions: document.querySelectorAll("[aria-live='polite']").length,
      lang: document.documentElement.lang,
    };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 1 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.altless, 0, "every scene image has alternative text");
  assert.equal(audit.groups, 0, "every fieldset has a legend");
  assert.ok(audit.liveRegions >= 2, "status is announced");
  assert.equal(audit.lang, "en");
  await page.locator("#rs-regenerate").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // keyboard-initiated focus, so :focus-visible applies
  const focusRing = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=radio])")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; })
    .map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  const runBodies = apiRequests.filter((entry) => entry.method === "POST" && entry.path === "/dev/v1/reference-scenes/runs").map((entry) => JSON.parse(entry.body));
  assert.equal(runBodies.filter((body) => body.mode === "MODEL").length, 1);
  const templateBodies = runBodies.filter((body) => body.mode === "TEMPLATE");
  assert.equal(templateBodies.length, 5);
  assert.equal(templateBodies[3].requestId, templateBodies[4].requestId, "the replay reuses the request identifier");
  assert.equal(new Set(templateBodies.map((body) => body.requestId)).size, 4);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  process.stdout.write(`${JSON.stringify({
    event: "reference-scenes", setId: setView.referenceSetId, runId: created.runId,
    sceneIds: created.scenes.map((scene) => scene.artifactId), sceneSha256: created.scenes.map((scene) => scene.sha256),
    canonicalSha256: created.manifest.scenes.map((scene) => scene.canonicalPngSha256), requestIds: templateBodies.map((body) => body.requestId),
    byteIdentical: regenerated.byteIdentical,
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
