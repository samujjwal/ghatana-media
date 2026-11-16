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
const token = requiredEnv("MEDIA_DEV_SIM_BROWSER_TOKEN");
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
delete viteEnvironment.MEDIA_DEV_SIM_BROWSER_TOKEN;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", process.env.MEDIA_DEV_VITE_CONFIG?.trim() || "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");


// ---- independent truth used by the browser checks (no page or host code) ----
const spring = (mass, k, c, x0, v0, t) => {
  const w0 = Math.sqrt(k / mass); const zeta = c / (2 * Math.sqrt(k * mass));
  const wd = w0 * Math.sqrt(1 - zeta * zeta); const a = zeta * w0; const b = (v0 + a * x0) / wd; const e = Math.exp(-a * t);
  return { x: e * (x0 * Math.cos(wd * t) + b * Math.sin(wd * t)), energy: null };
};
/** Reference RK4 (fixed 1e-5 s step) of the projectile with quadratic drag until y crosses zero. */
const referenceImpact = (mass, k, y0, speed, angleRad) => {
  const g = 9.80665; const f = (s) => { const sp = Math.hypot(s[2], s[3]); return [s[2], s[3], -k * sp * s[2] / mass, -g - k * sp * s[3] / mass]; };
  let s = [0, y0, speed * Math.cos(angleRad), speed * Math.sin(angleRad)]; let t = 0; const h = 1e-5;
  for (;;) {
    const a = f(s); const b = f(s.map((v, i) => v + h / 2 * a[i])); const c = f(s.map((v, i) => v + h / 2 * b[i])); const d = f(s.map((v, i) => v + h * c[i]));
    const n = s.map((v, i) => v + h / 6 * (a[i] + 2 * b[i] + 2 * c[i] + d[i]));
    if (n[1] < 0) { const frac = s[1] / (s[1] - n[1]); return { t: t + frac * h, x: s[0] + frac * (n[0] - s[0]) }; }
    s = n; t += h;
  }
};

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 480; attempt += 1) { // up to 120 s: a cold Vite start in a fresh checkout optimizes deps first
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-simulation.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual simulation page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (404|422|403)/u.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/dev/v1/")) apiRequests.push({ method: request.method(), path, body: request.postData(), headers: request.headers() });
  });
  const runPost = (timeout = 120_000) => page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/simulations"
    && response.request().method() === "POST", { timeout });
  const runButton = page.getByRole("button", { name: "Run simulation", exact: true });
  const run = async (expectedStatus, timeout) => {
    const pending = runPost(timeout);
    await runButton.click();
    const response = await pending;
    assert.equal(response.status(), expectedStatus, await response.text());
    return { response, body: await response.json(), sent: JSON.parse(response.request().postData()) };
  };

  // 1. Connect; the limits come FROM THE HOST.
  await page.goto(`${baseUrl}/dev-simulation.html`, { waitUntil: "networkidle" });
  let statusResponse;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await page.goto(`${baseUrl}/dev-simulation.html`, { waitUntil: "networkidle" });
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/simulations/status", { timeout: 45_000 });
    pending.catch(() => {});
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    try { statusResponse = await pending; break; } catch (error) { if (attempt >= 3) throw error; }
  }
  await page.getByRole("heading", { name: "Scientific simulation", level: 2 }).waitFor({ timeout: 30_000 });
  const status = await statusResponse.json();
  assert.equal(status.ready, true);
  const line = await page.locator("[data-status-line]").textContent();
  assert.ok(line.includes(`at most ${status.limits.maxAcceptedSteps} accepted steps`), line);
  assert.ok(line.includes("Animation: available"), line);

  // 2. Run the default damped spring: COMPLETED, verified plot, observables against the closed form.
  const first = await run(201, 60_000);
  assert.match(first.sent.requestId, /^sim-/u);
  assert.equal(first.sent.scenario.model.mass.unit, "kg");
  assert.equal(first.body.outcome, "COMPLETED");
  const result = page.locator("[data-sim-result][data-outcome='COMPLETED']");
  await result.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.id === "sim-result-title", null, { timeout: 5_000 });
  const finalX = Number(await result.locator("[data-observable='positionXMeters']").textContent());
  const truth = spring(0.5, 200, 1.2, 0.1, 0.3, 2.0).x;
  assert.ok(Math.abs(finalX - truth) < 1e-7, `final position ${finalX} vs closed form ${truth}`);
  assert.equal(Number(await result.locator("[data-observable='timeSeconds']").textContent()), 2);
  assert.ok((await result.locator("[data-energy-law]").textContent()).startsWith("DISSIPATIVE_NON_INCREASING"));
  assert.ok((await result.locator("[data-result-summary]").textContent()).includes(`${first.body.result.verification.acceptedSteps} accepted steps`));
  // the plot is shown only after its SHA-256 matched; its curve pixels sit on the closed-form curve through the host's stored transform
  await result.locator("img[data-verified-plot]").waitFor({ timeout: 30_000 });
  assert.ok((await result.locator("[data-plot-status]").textContent()).includes(first.body.plotArtifact.sha256));
  const panel = first.body.result.plot.panels[0];
  const rows = first.body.result.trace.rows;
  const plotCheck = await result.locator("img[data-verified-plot]").evaluate(async (image, args) => {
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hits = 0;
    for (const [px, py] of args.points) {
      let found = false;
      for (let dx = -3; dx <= 3 && !found; dx += 1) for (let dy = -3; dy <= 3 && !found; dy += 1) {
        const x = px + dx; const y = py + dy; if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
        const i = (y * canvas.width + x) * 4; if (data[i] === 0xC8 && data[i + 1] === 0 && data[i + 2] === 0) found = true;
      }
      if (found) hits += 1;
    }
    return { width: image.naturalWidth, height: image.naturalHeight, hits };
  }, { points: rows.map((row) => {
    const t = row[0]; const x = spring(0.5, 200, 1.2, 0.1, 0.3, t).x; const r = panel.pixelRect;
    return [Math.round(r.x0 + (t - panel.xMin) / (panel.xMax - panel.xMin) * (r.x1 - r.x0)), Math.round(r.y1 - (x - panel.yMin) / (panel.yMax - panel.yMin) * (r.y1 - r.y0))];
  }) });
  assert.equal(plotCheck.width, 800);
  assert.equal(plotCheck.hits, rows.length, "every closed-form curve point is on the drawn curve in the browser's own decode");
  assert.ok((await result.locator("img[data-verified-plot]").getAttribute("alt")).startsWith("Left panel: the simulated path"));
  await result.locator("summary").click();
  assert.equal(await result.locator("table[data-trace] tbody tr").count(), Math.min(rows.length, 300));

  // 3. Immediately again: the same scenario reuses its request identifier and is a replay.
  const replay = await run(200);
  assert.equal(replay.sent.requestId, first.sent.requestId);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.simulationId, first.body.simulationId);
  await page.locator("[data-replayed]").waitFor({ timeout: 15_000 });

  // 4. A unit of the wrong dimension: the host's typed 422 names the path; focus moves to that field; nothing is solved.
  await page.locator("#f-model-mass-unit").selectOption("m");
  const mismatch = await run(422);
  assert.equal(mismatch.body.error.code, "SIMULATION_UNIT_MISMATCH");
  assert.equal(mismatch.body.error.details.path, "$.model.mass.unit");
  const mismatchFailure = page.locator('[data-failure-code="SIMULATION_UNIT_MISMATCH"]');
  await mismatchFailure.waitFor({ timeout: 15_000 });
  assert.equal(await mismatchFailure.getAttribute("data-failure-path"), "$.model.mass.unit");
  await page.waitForFunction(() => document.activeElement?.id === "f-model-mass-unit", null, { timeout: 5_000 });
  assert.equal(await page.locator("[data-sim-result]").count(), 0, "nothing is shown for a refused scenario");
  await page.locator("#f-model-mass-unit").selectOption("kg");

  // 5. Over budget: a typed 422 with the ceiling; focus moves to the budget field.
  await page.locator("#f-solver-maxAcceptedSteps").fill("10001");
  const budget = await run(422);
  assert.equal(budget.body.error.code, "SIMULATION_BUDGET_EXCEEDED");
  const budgetFailure = page.locator('[data-failure-code="SIMULATION_BUDGET_EXCEEDED"]');
  await budgetFailure.waitFor({ timeout: 15_000 });
  assert.ok((await budgetFailure.textContent()).includes("requested 10001"), await budgetFailure.textContent());
  await page.waitForFunction(() => document.activeElement?.id === "f-solver-maxAcceptedSteps", null, { timeout: 5_000 });
  await page.locator("#f-solver-maxAcceptedSteps").fill("5000");

  // 6. A non-finite number never reaches the host: the page names the field and sends nothing.
  const postsBefore = apiRequests.filter((entry) => entry.method === "POST").length;
  await page.locator("#f-model-mass-value").fill("1e999");
  await runButton.click();
  await page.locator("[data-field-errors]").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "f-model-mass-value", null, { timeout: 5_000 });
  assert.equal(apiRequests.filter((entry) => entry.method === "POST").length, postsBefore, "no request for a non-finite number");
  await page.locator("#f-model-mass-value").fill("0.5");

  // 7. J-15 abstention (step budget): reasons, counters and NO values, trace or plot.
  await page.locator("#f-solver-mode").selectOption("FIXED_STEP");
  await page.locator("#f-solver-duration-value").fill("10");
  await page.locator("#f-solver-maxStep-value").fill("0.1");
  await page.locator("#f-solver-minStep-value").fill("0.1");
  await page.locator("#f-solver-maxAcceptedSteps").fill("5");
  const abstained = await run(201);
  assert.equal(abstained.body.outcome, "ABSTAINED");
  const abstainedView = page.locator("[data-sim-result][data-outcome='ABSTAINED']");
  await abstainedView.waitFor({ timeout: 15_000 });
  await abstainedView.locator("[data-reason-code='STEP_BUDGET_EXHAUSTED']").waitFor({ timeout: 5_000 });
  assert.ok((await abstainedView.locator("[data-abstained]").textContent()).includes("No trace and no observable value is shown"));
  assert.equal(await page.locator("table[data-trace], img[data-verified-plot], [data-observables]").count(), 0, "no value of an abstained pass is shown");
  assert.ok((await abstainedView.locator("[data-diagnostics]").textContent()).includes("5 accepted steps"));
  // abstention by a declared constraint the pass violates (adaptive solver, amplitude 0.1 m against a 0.01 m limit)
  await page.locator("#f-solver-mode").selectOption("ADAPTIVE");
  await page.locator("#f-solver-duration-value").fill("2");
  await page.locator("#f-solver-maxStep-value").fill("0.05");
  await page.locator("#f-solver-minStep-value").fill("0.00001");
  await page.locator("#f-solver-maxAcceptedSteps").fill("5000");
  await page.locator("#f-constrain").check();
  await page.locator("#f-constraints-0-observable").selectOption("POSITION_X");
  await page.locator("#f-constraints-0-aggregate").selectOption("MAX");
  await page.locator("#f-constraints-0-limit-value").fill("0.01");
  const violated = await run(201);
  assert.equal(violated.body.outcome, "ABSTAINED");
  const violation = page.locator("[data-reason-code='CONSTRAINT_VIOLATED']");
  await violation.waitFor({ timeout: 15_000 });
  assert.ok((await violation.textContent()).includes("limit-1"), await violation.textContent());
  assert.equal(await page.locator("table[data-trace]").count(), 0);
  // the same constraint with a limit the pass satisfies is a validated COMPLETED pass that reports it
  await page.locator("#f-constraints-0-limit-value").fill("0.2");
  const satisfied = await run(201);
  assert.equal(satisfied.body.outcome, "COMPLETED");
  await page.locator("table[data-constraints]").waitFor({ timeout: 15_000 });
  await page.locator("#f-constrain").uncheck();

  // 8. Reopen by id (the field is prefilled with the last result's id).
  const reopenPost = page.waitForResponse((response) => new URL(response.url()).pathname === `/dev/v1/simulations/${first.body.simulationId}`, { timeout: 30_000 });
  await page.locator("#sim-reopen-id").fill(first.body.simulationId);
  await page.getByRole("button", { name: "Reopen stored result" }).click();
  const reopened = await (await reopenPost).json();
  assert.equal(reopened.result.trace.rows.length, rows.length);
  await page.locator("[data-sim-result][data-outcome='COMPLETED'] [data-replayed]").waitFor({ timeout: 15_000 });
  // an unknown id is a typed 404
  const missing = page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/simulations/does-not-exist", { timeout: 15_000 });
  await page.locator("#sim-reopen-id").fill("does-not-exist");
  await page.getByRole("button", { name: "Reopen stored result" }).click();
  assert.equal((await missing).status(), 404);
  await page.locator('[data-failure-code="SIMULATION_NOT_FOUND"]').waitFor({ timeout: 15_000 });

  // 9. Projectile with quadratic drag and the MP4: impact time and range against an independent RK4 reference; verified playback.
  await page.locator("#f-model-type").selectOption("PROJECTILE");
  await page.locator("#f-render-video").check();
  const shot = await run(201, 180_000);
  assert.equal(shot.body.outcome, "COMPLETED");
  const shotView = page.locator("[data-sim-result][data-outcome='COMPLETED']");
  await shotView.locator("[data-impact]").waitFor({ timeout: 30_000 });
  const reference = referenceImpact(0.145, 0.0012, 1, 40, 40 * Math.PI / 180);
  assert.ok(Math.abs(shot.body.result.impact.timeSeconds - reference.t) < 1e-6, `impact time ${shot.body.result.impact.timeSeconds} vs reference ${reference.t}`);
  assert.ok(Math.abs(shot.body.result.impact.rangeMeters - reference.x) < 1e-5, `range ${shot.body.result.impact.rangeMeters} vs reference ${reference.x}`);
  assert.ok((await shotView.locator("[data-impact]").textContent()).includes(shot.body.result.impact.timeSeconds.toPrecision(10)));
  assert.equal(await shotView.locator("video").count(), 0, "no video before verification");
  await shotView.getByRole("button", { name: /^Load the animation/u }).click();
  await shotView.getByText(/Bytes verified against the registered version/u).waitFor({ timeout: 30_000 });
  assert.ok((await shotView.locator("[data-playback-status]").textContent()).includes(shot.body.videoArtifact.sha256));
  const video = shotView.locator("video[data-verified-preview='simulation-video']");
  await video.waitFor({ timeout: 10_000 });
  assert.match(await video.getAttribute("src"), /^blob:/u);
  await video.evaluate((element) => new Promise((resolveLoad, rejectLoad) => {
    if (element.readyState >= 1) return resolveLoad();
    element.addEventListener("loadedmetadata", () => resolveLoad(), { once: true });
    element.addEventListener("error", () => rejectLoad(new Error(`video error ${element.error?.code}`)), { once: true });
    setTimeout(() => rejectLoad(new Error("video metadata did not load")), 15_000);
  }));
  const playback = await video.evaluate(async (element) => {
    const meta = { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
    element.muted = true; await element.play(); await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const advanced = element.currentTime; element.pause();
    return { ...meta, advanced };
  });
  assert.equal(playback.width, 800);
  assert.equal(playback.height, 400);
  assert.ok(Math.abs(playback.duration - 2) < 0.05, `48 frames at 24 fps, got ${playback.duration}s`);
  assert.ok(playback.advanced > 0.3, `playback must advance, got ${playback.advanced}`);

  // 10. Accessibility structure.
  const audit = await page.evaluate(() => {
    const unlabelled = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((element) => {
      return !(element.labels?.length > 0 || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby"));
    }).map((element) => element.id || element.name);
    const tables = [...document.querySelectorAll("table")].map((table) => ({ caption: !!table.querySelector("caption")?.textContent?.trim(), scopedHeaders: table.querySelectorAll("thead th[scope=col]").length > 0 }));
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    return { unlabelled, tables, duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      unnamedButtons: [...document.querySelectorAll("button")].filter((button) => !button.textContent?.trim()).length,
      regions: [...document.querySelectorAll("[role=region]")].filter((region) => !region.getAttribute("aria-label")).length,
      groups: [...document.querySelectorAll("fieldset")].filter((group) => !group.querySelector(":scope > legend")).length,
      imagesWithoutAlt: [...document.querySelectorAll("img")].filter((image) => !image.getAttribute("alt")).length, lang: document.documentElement.lang };
  });
  assert.deepEqual(audit.unlabelled, [], "every form control has a label");
  assert.ok(audit.tables.length >= 1 && audit.tables.every((table) => table.caption && table.scopedHeaders), JSON.stringify(audit.tables));
  assert.deepEqual(audit.duplicateIds, []);
  assert.equal(audit.unnamedButtons, 0);
  assert.equal(audit.regions, 0);
  assert.equal(audit.groups, 0, "every fieldset has a legend");
  assert.equal(audit.imagesWithoutAlt, 0);
  assert.equal(audit.lang, "en");
  // keyboard-only: Tab from the token-less page reaches the run button; the focus ring is visible
  const focusRing = await page.evaluate(() => { document.querySelector("#f-model-mass-value").focus(); const style = getComputedStyle(document.activeElement); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  assert.ok(focusRing.style !== "none" && focusRing.width >= 2, `visible focus indicator: ${JSON.stringify(focusRing)}`);
  await page.locator("#f-model-mass-value").focus();
  await page.keyboard.press("Enter");
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/dev/v1/simulations" && response.request().method() === "POST", { timeout: 120_000 });

  // 11. Responsive: a phone viewport has no horizontal page scroll and comfortable touch targets.
  await page.setViewportSize({ width: 375, height: 812 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const wide = overflowX > 1 ? await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 8).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className)} right=${Math.round(e.getBoundingClientRect().right)}`)) : [];
  assert.ok(overflowX <= 1, `no horizontal page scroll at 375px, overflow ${overflowX}: ${JSON.stringify(wide)}`);
  const smallTargets = await page.evaluate(() => [...document.querySelectorAll("button, select, input:not([type=checkbox]), textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.height < 40; }).map((element) => element.id || element.textContent?.trim()));
  assert.deepEqual(smallTargets, [], "touch targets are at least 40px tall");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${JSON.stringify(consoleErrors)}`);
  assert.ok(apiRequests.every((entry) => entry.headers.authorization === `Bearer ${token}`), "bearer is sent as a header only");
  assert.ok(apiRequests.every((entry) => !entry.path.includes(token)), "token never appears in a URL");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  const independent = await fetch(`${baseUrl}/dev/v1/artifacts/${shot.body.videoArtifact.artifactId}/content`, {
    headers: { Authorization: `Bearer ${token}`, "If-Match": shot.body.videoArtifact.artifactVersionId } });
  assert.equal(independent.status, 200);
  assert.equal(sha256Of(Buffer.from(await independent.arrayBuffer())), shot.body.videoArtifact.sha256);
  process.stdout.write(`${JSON.stringify({
    event: "simulated", springSimulationId: first.body.simulationId, springRequestId: first.sent.requestId, springFinalX: finalX, springTruthX: truth,
    curvePixelHits: plotCheck.hits, shotSimulationId: shot.body.simulationId, shotVideoId: shot.body.videoArtifact.artifactId,
    shotVideoSha256: shot.body.videoArtifact.sha256, impactTimeSeconds: shot.body.result.impact.timeSeconds, referenceImpactSeconds: reference.t,
    impactRangeMeters: shot.body.result.impact.rangeMeters, referenceRangeMeters: reference.x, playbackAdvancedSeconds: playback.advanced,
    videoWidth: playback.width, abstainedSimulationId: abstained.body.simulationId,
  })}\n`);
} finally {
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
