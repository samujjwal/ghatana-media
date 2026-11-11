import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const appRequire = createRequire(resolve(appRoot, "package.json"));
const { chromium } = appRequire("playwright");
const playwrightEntry = appRequire.resolve("playwright");
const playwrightPackageRoot = dirname(playwrightEntry);
const playwrightPackage = JSON.parse(await readFile(resolve(playwrightPackageRoot, "package.json"), "utf8"));
assert.equal(playwrightPackage.version, "1.63.0", "browser must use the pinned UI test runtime");
const playwrightCoreRoot = resolve(playwrightPackageRoot, "../playwright-core");
const playwrightCore = JSON.parse(await readFile(resolve(playwrightCoreRoot, "package.json"), "utf8"));
const browserManifest = JSON.parse(await readFile(resolve(playwrightCoreRoot, "browsers.json"), "utf8"));
const pinnedChromium = browserManifest.browsers.find(({ name }) => name === "chromium");
assert.equal(playwrightCore.version, "1.63.0");
assert.equal(pinnedChromium?.revision, "1243");
assert.equal(pinnedChromium?.browserVersion, "153.0.8010.12");
const chromiumBinary = chromium.executablePath();
assert.ok(chromiumBinary.includes("chromium-1243/"), `unexpected pinned Chromium path: ${chromiumBinary}`);
const chromiumVersion = await promisify(execFileCallback)(chromiumBinary, ["--version"]);
assert.ok(chromiumVersion.stdout.includes("153.0.8010.12"), chromiumVersion.stdout);
const token = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_TOKEN");
const tenant = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_TENANT");
const principal = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_PRINCIPAL");
const jobId = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_JOB_ID");
const statusExpected = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_STATUS");
const versionExpected = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_VERSION");
const deniedToken = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_DENIED_TOKEN");
const otherOwnerToken = required("MEDIA_DEV_JOB_RECOVERY_BROWSER_OTHER_OWNER_TOKEN");
const hostPort = Number(required("MEDIA_DEV_JOB_RECOVERY_BROWSER_HOST_PORT"));
assert.ok(Number.isSafeInteger(hostPort) && hostPort > 0 && hostPort < 65536);
const vitePort = await freePort();
const viteEntry = resolve(appRoot, "node_modules/vite/bin/vite.js");
const vite = spawn(process.execPath, [viteEntry, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment(hostPort),
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.setEncoding("utf8").on("data", (chunk) => { viteLog += chunk; });
vite.stderr.setEncoding("utf8").on("data", (chunk) => { viteLog += chunk; });
let browser;
try {
  const origin = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(`${origin}/dev-job-recovery.html`); if (response.ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve job recovery page: ${viteLog}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const jobs = [];
  const authorizationObservations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 403 \(Forbidden\)|status of 404 \(Not Found\)/u.test(message.text())) errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/jobs")) jobs.push({ method: request.method(), url: request.url() });
    void request.allHeaders().then((headers) => authorizationObservations.push({
      origin: new URL(request.url()).origin,
      path: new URL(request.url()).pathname,
      hasAuthorization: Boolean(headers.authorization),
    }));
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/dev-job-recovery.html`);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
  await page.getByLabel("Short-lived DEV_ONLY bearer token").press("Enter");
  await waitForConnection(page, "DEV_ONLY host");
  assert.equal(await page.locator("#dev-token").inputValue(), "");
  await page.getByLabel("Job ID").fill(jobId);
  await page.getByLabel("Job ID").press("Enter");
  assert.equal(jobs.length, 0, "screen mount must not issue a job read before explicit refresh");
  await page.getByRole("button", { name: "Refresh canonical status" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText(new RegExp(`Terminal status observed: ${statusExpected} \\(version ${versionExpected}\\)\\.`)).waitFor();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].method, "GET");
  assert.equal(new URL(jobs[0].url).origin, origin);
  assert.equal(new URL(jobs[0].url).pathname, `/api/v1/jobs/${jobId}`);
  assert.equal(new URL(jobs[0].url).search, "");
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0,
    "the in-memory DEV_ONLY credential must not enter browser storage");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "the page must not overflow a 375px mobile viewport");

  await page.getByRole("button", { name: "Forget token" }).click();
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(deniedToken);
  await page.getByRole("button", { name: "Connect" }).click();
  await waitForConnection(page, "DEV_ONLY host");
  await page.getByLabel("Job ID").fill(jobId);
  await page.getByRole("button", { name: "Show job recovery screen" }).click();
  await page.getByRole("button", { name: "Refresh canonical status" }).click();
  await page.getByText(/Canonical job status read was denied/u).waitFor();
  assert.equal(jobs.at(-1).method, "GET");
  assert.equal(new URL(jobs.at(-1).url).origin, origin);

  await page.getByRole("button", { name: "Forget token" }).click();
  await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(otherOwnerToken);
  await page.getByRole("button", { name: "Connect" }).click();
  await waitForConnection(page, "DEV_ONLY host");
  await page.getByLabel("Job ID").fill(jobId);
  await page.getByRole("button", { name: "Show job recovery screen" }).click();
  const nonOwnerResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "GET" && new URL(response.url()).pathname === `/api/v1/jobs/${jobId}`;
  });
  await page.getByRole("button", { name: "Refresh canonical status" }).click();
  const nonOwnerResponse = await nonOwnerResponsePromise;
  assert.equal(nonOwnerResponse.status(), 404, "the real Media host must hide another owner's job as not found");
  const nonOwnerBodyText = await nonOwnerResponse.text();
  const nonOwnerBody = JSON.parse(nonOwnerBodyText);
  assert.equal(nonOwnerBody.error?.code, "JOB_NOT_FOUND");
  assert.equal(nonOwnerBody.error?.message, "Media job not found");
  const disclosedJobFields = [];
  collectDisclosedJobFields(nonOwnerBody, disclosedJobFields);
  assert.deepEqual(disclosedJobFields, [], "404 body must not contain jobId/status/version/result fields");
  assert.ok(!nonOwnerBodyText.includes(jobId), "404 body must not contain the requested job ID");
  assert.ok(!nonOwnerBodyText.includes(statusExpected), "404 body must not contain the owner's observed status");
  await page.getByText(/Canonical job status is unknown/u).waitFor();
  assert.equal(jobs.at(-1).method, "GET");
  assert.equal(new URL(jobs.at(-1).url).origin, origin);
  assert.equal(jobs.at(-1).url.includes("version="), false);
  const unknownText = await page.locator("body").innerText();
  assert.match(unknownText, /Canonical job status is unknown/u);
  const unknownScreenText = await page.locator("#screen").innerText();
  assert.doesNotMatch(unknownScreenText, new RegExp(`${statusExpected}|version\\s+${versionExpected}`, "u"),
    "a non-owner must not see the job status or version");
  assert.ok(jobs.every(({ method }) => method === "GET"), "page must never call job mutation routes");
  await delay(0);
  assert.ok(authorizationObservations.some(({ origin: requestOrigin, path, hasAuthorization }) =>
    requestOrigin === origin && path === "/dev/v1/context" && hasAuthorization));
  assert.ok(authorizationObservations.some(({ origin: requestOrigin, path, hasAuthorization }) =>
    requestOrigin === origin && path === `/api/v1/jobs/${jobId}` && hasAuthorization));
  assert.ok(authorizationObservations.every(({ origin: requestOrigin, hasAuthorization }) =>
    requestOrigin === origin || !hasAuthorization), "credentials must never be sent to another origin");
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({
    result: "PASS",
    sameOriginGetCount: jobs.length,
    owner: `${tenant}/${principal}`,
    observed: `${statusExpected}@${versionExpected}`,
    denied: true,
    unknown: true,
    mutationRequests: jobs.filter(({ method }) => method !== "GET").length,
  }) + "\n");
} finally {
  if (browser) await browser.close();
  if (vite.exitCode === null) {
    vite.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => vite.once("exit", resolveExit)), delay(5000)]);
    if (vite.exitCode === null) vite.kill("SIGKILL");
  }
}

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
async function waitForConnection(page, label) {
  await page.waitForFunction(() => {
    const value = document.querySelector("#connection-status")?.textContent ?? "";
    return !value.includes("Validating") && value !== "Not connected.";
  });
  const current = await page.locator("#connection-status").innerText();
  assert.ok(current.includes(label), `connection failed: ${current}`);
}
function collectDisclosedJobFields(value, matches) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["jobid", "status", "version", "result"].includes(key.toLowerCase())) matches.push(key);
    collectDisclosedJobFields(child, matches);
  }
}
function viteEnvironment(port) {
  const environment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI"]
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  environment.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT = String(port);
  return environment;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
