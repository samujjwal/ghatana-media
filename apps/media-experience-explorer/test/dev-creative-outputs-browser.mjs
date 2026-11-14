import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Static browser journey for the DEV_ONLY "Creative outputs" page against a fixture host behind the loopback
// Vite proxy. It exercises the real page, the real adapter and the real guard; the host is a fixture, so this
// proves UI wiring and request identity only, not engine behaviour.
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const token = "bounded-dev-only-browser-fixture-token";
const SHA = "c".repeat(64);
const SRC = `sha256:${"a".repeat(64)}`;
const fixture = { requests: [], audioBodies: [], audioPosts: 0, simBodies: [], spatialBodies: [] };
const artifact = (id, contentType) => ({ artifactId: id, artifactVersionId: `sha256:${SHA}`, contentType, sizeBytes: 512, sha256: SHA });
const audioView = (replayed) => ({
  schema: "x", outputId: "out-audio-1", replayed, scope: "DEV_ONLY", artifact: artifact("out-audio-1", "audio/wav"),
  lineage: { kind: "AUDIO_REPAIR_CANDIDATE", engine: "declipper-1", comparisonEngine: "compare-1", requestId: "fixture",
    source: { artifactId: "src-1", artifactVersionId: SRC, sha256: "a".repeat(64) }, profile: { threshold: 0.94, maxRunFrames: 64 },
    metrics: { changedSampleCount: 17, hasIndependentReference: false, snrDbVsReference: null } },
});
const simView = () => ({
  schema: "x", outputId: "out-sim-1", replayed: false, scope: "DEV_ONLY", artifact: artifact("out-sim-1", "application/json"),
  lineage: { kind: "SIMULATED_OUTPUT_NOT_MEASUREMENT", engine: "sim-1", requestId: "fixture", evidenceClass: "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE",
    validation: { disposition: "VALID", findings: [] }, inputReferences: [{ role: "PHYSICAL_MODEL", identity: "request.scenario.model" }], solverStats: { acceptedSteps: 8 } },
});
const spatialView = () => ({
  schema: "x", outputId: "out-glb-1", replayed: false, scope: "DEV_ONLY", artifact: artifact("out-glb-1", "model/gltf-binary"),
  lineage: { kind: "SPATIAL_GLB_EXPORT", engine: "spatial-1", requestId: "fixture", rigId: "rig-1",
    sources: [{ artifactId: "src-1", artifactVersionId: SRC }], coordinateFrame: { frameRef: "urn:media:frame:glb", handedness: "RIGHT_HANDED", axisDirections: ["POS_X", "POS_Y", "POS_Z"] },
    timeEncoding: "FLOAT32_SECONDS", lossDisposition: "FLOAT32_APPROXIMATION", float32LossFields: ["animation.inputTimeSeconds"],
    rightsDecision: { authority: "DEV_ONLY_OWNER_SCOPE_VISIBILITY", outcome: "ELIGIBLE", productionGrant: false } },
});

const respond = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
const readBody = (request) => new Promise((resolve) => { let data = ""; request.on("data", (chunk) => { data += chunk; }); request.on("end", () => resolve(data)); });

const apiServer = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  fixture.requests.push(`${request.method} ${path}`);
  if (request.headers.authorization !== `Bearer ${token}`) return respond(response, 401, { error: { code: "TOKEN_INVALID", message: "Fixture token required." } });
  const body = await readBody(request);
  if (request.method === "GET" && path === "/dev/v1/context") return respond(response, 200, { scope: "DEV_ONLY", tenantId: "t", principalId: "p" });
  if (request.method === "POST" && path === "/dev/v1/creative-outputs/audio-repairs") {
    fixture.audioBodies.push(JSON.parse(body));
    fixture.audioPosts += 1;
    if (fixture.audioPosts === 1) return respond(response, 502, { error: { code: "CREATIVE_OUTPUT_REGISTRATION_FAILED", message: "Output was not registered" } });
    return respond(response, fixture.audioPosts === 2 ? 201 : 200, audioView(fixture.audioPosts !== 2));
  }
  if (request.method === "POST" && path === "/dev/v1/creative-outputs/simulations") {
    fixture.simBodies.push(JSON.parse(body));
    if (fixture.simBodies.length === 1) {
      return respond(response, 422, { error: { code: "SIMULATION_VALIDATION_REJECTED", message: "rejected",
        details: { disposition: "REJECTED", findings: [{ reason: "SEMANTIC_INVARIANT_FAILED", subject: "terminal-position", detail: "fixture finding" }] } } });
    }
    return respond(response, 201, simView());
  }
  if (request.method === "POST" && path === "/dev/v1/creative-outputs/spatial-glb") {
    fixture.spatialBodies.push(JSON.parse(body));
    return respond(response, 201, spatialView());
  }
  if (request.method === "GET" && path === "/dev/v1/creative-outputs/out-audio-1") return respond(response, 200, audioView(true));
  if (request.method === "GET" && path.startsWith("/dev/v1/creative-outputs/")) return respond(response, 404, { error: { code: "CREATIVE_OUTPUT_NOT_FOUND", message: "none" } });
  return respond(response, 404, { error: { code: "NOT_FOUND", message: "fixture" } });
});

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const apiPort = await listen(apiServer);
const probe = createServer();
const vitePort = await listen(probe);
await new Promise((resolve) => probe.close(resolve));
const viteBinary = process.env.MEDIA_DEV_VITE_BINARY;
const viteProcess = spawn(viteBinary ? process.execPath : "vite",
  [...(viteBinary ? [viteBinary] : []), "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)],
  { cwd: appRoot, env: { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(apiPort) }, stdio: ["ignore", "pipe", "pipe"] });
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try { ready = (await fetch(`${baseUrl}/dev-creative-outputs.html`)).ok; } catch { /* starting */ }
    if (!ready) await delay(250);
  }
  assert.ok(ready, `Vite did not serve the page:\n${viteOutput}`);
  // The guard admits only the four creative routes: other verbs and sibling paths never reach the host.
  fixture.requests.length = 0;
  const blocked = await fetch(`${baseUrl}/dev/v1/creative-outputs/audio-repairs/extra`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(blocked.status, 404);
  const blockedDelete = await fetch(`${baseUrl}/dev/v1/creative-outputs/out-audio-1`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(blockedDelete.status, 404);
  assert.deepEqual(fixture.requests, [], "non-allowlisted creative routes must not be forwarded");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = []; const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${baseUrl}/dev-creative-outputs.html`);
  assert.equal(await page.getByRole("main").count(), 1);
  assert.equal(await page.getByRole("heading", { name: /Creative outputs · DEV_ONLY/u }).count(), 0, "panel stays unmounted until connected");

  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: /Creative outputs · DEV_ONLY/u }).waitFor();
  assert.equal(await page.locator("#dev-token").inputValue(), "", "token input must be cleared after connect");

  // Audio: explicit profile, 502 then retry with the SAME request identity, then a duplicate shown as replayed.
  await page.getByLabel("Source artifact ID").fill("src-1");
  await page.getByLabel("Exact source artifact version").fill(SRC);
  await page.getByLabel(/Clipping threshold/u).fill("0.94");
  await page.getByLabel(/Maximum clipped run/u).fill("64");
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "CREATIVE_OUTPUT_REGISTRATION_FAILED" }).waitFor();
  await page.getByRole("button", { name: "Retry with the same request identity" }).click();
  await page.locator("#audio-status", { hasText: "Created (HTTP 201)" }).waitFor();
  assert.equal(fixture.audioBodies.length, 2);
  assert.equal(fixture.audioBodies[1].requestId, fixture.audioBodies[0].requestId, "retry must reuse the request identity");
  assert.deepEqual(fixture.audioBodies[0].profile, { threshold: 0.94, maxRunFrames: 64 });
  const result = page.locator("#creative-result");
  await result.getByText("out-audio-1").first().waitFor();
  assert.match(await result.textContent(), /changedSampleCount/u);
  assert.match(await result.textContent(), /not a quality assessment/u);
  await page.getByRole("button", { name: "Repair exact source version" }).click();
  await page.locator("#audio-status", { hasText: "Replayed (HTTP 200)" }).waitFor();
  assert.equal(fixture.audioBodies[2].requestId, fixture.audioBodies[0].requestId);

  // Simulation: label is present before any run; REJECTED shows findings and no output; the corrected run registers.
  assert.match(await page.getByLabel("Simulated output label").textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  await page.getByRole("button", { name: /Load worked example/u }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "SIMULATION_VALIDATION_REJECTED" }).waitFor();
  assert.match(await page.getByLabel("Validator findings").textContent(), /fixture finding/u);
  await page.getByRole("button", { name: "Run simulation" }).click();
  await page.locator("#simulation-status", { hasText: "Created (HTTP 201)" }).waitFor();
  assert.match(await page.locator("#creative-result").textContent(), /SIMULATED_OUTPUT_NOT_MEASUREMENT/u);
  assert.match(await page.locator("#creative-result").textContent(), /no DEV_ONLY content route/u);
  assert.equal(fixture.simBodies[0].scenario.model.force.value.unit, "NEWTON");

  // Spatial: shape validation is local; a valid rig is exported and shows the DEV_ONLY rights decision.
  await page.getByLabel("Rig JSON").fill("{ not json");
  await page.getByRole("button", { name: "Export GLB" }).click();
  await page.getByText("Rig JSON could not be parsed.").waitFor();
  assert.equal(fixture.spatialBodies.length, 0);
  await page.getByRole("button", { name: /Insert rig template/u }).click();
  const template = JSON.parse(await page.getByLabel("Rig JSON").inputValue());
  template.sourceVersions = [{ artifactId: "src-1", artifactVersionId: SRC }];
  await page.getByLabel("Rig JSON").fill(JSON.stringify(template));
  await page.getByRole("button", { name: "Export GLB" }).click();
  await page.locator("#spatial-status", { hasText: "Created (HTTP 201)" }).waitFor();
  assert.match(await page.locator("#creative-result").textContent(), /productionGrant=false/u);
  assert.match(await page.locator("#creative-result").textContent(), /float32LossFields/u);

  // Reopen: success and a typed 404.
  await page.getByLabel("Output ID").fill("out-audio-1");
  await page.getByRole("button", { name: "Reopen output from the host" }).click();
  await page.locator("#reopen-status", { hasText: "Reopened output out-audio-1" }).waitFor();
  await page.getByLabel("Output ID").fill("missing-1");
  await page.getByRole("button", { name: "Reopen output from the host" }).click();
  await page.locator("#reopen-status", { hasText: "CREATIVE_OUTPUT_NOT_FOUND" }).waitFor();

  // Keyboard reachability and memory-only token.
  await page.getByLabel("Output ID").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON");
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
  assert.ok(!stored.includes(token), "token must never be persisted");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors.filter((message) => !/status of 4\d\d|status of 502|Failed to load resource/u.test(message)), []);
  console.log("dev-creative-outputs browser journey passed");
} finally {
  await browser?.close();
  viteProcess.kill("SIGTERM");
  apiServer.close();
}
