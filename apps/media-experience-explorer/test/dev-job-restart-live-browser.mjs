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
import { createInterface } from "node:readline";

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
const hostPort = Number(required("MEDIA_DEV_JOB_RESTART_BROWSER_HOST_PORT"));
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
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
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
  const mutations = [];
  const diagnostics = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (diagnostics.length < 20) diagnostics.push(`console.${message.type()}: ${message.text().slice(0, 200)}`); });
  page.on("requestfailed", (request) => { if (diagnostics.length < 20) diagnostics.push(`requestfailed: ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`); });
  page.on("response", (response) => { const path = new URL(response.url()).pathname; if (path.startsWith("/dev/v1") && diagnostics.length < 20) diagnostics.push(`response: ${path} ${response.status()}`); });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/jobs") && request.method() !== "GET") mutations.push(request.method());
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/dev-job-recovery.html`);
  reply({ ok: true, event: "ready" });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    try {
      if (command.cmd === "connect") {
        await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(command.token);
        await page.getByLabel("Short-lived DEV_ONLY bearer token").press("Enter");
        await waitForConnection(page, "DEV_ONLY host");
        assert.equal(await page.locator("#dev-token").inputValue(), "");
        reply({ ok: true, event: "connected" });
      } else if (command.cmd === "watch") {
        await page.getByLabel("Job ID").fill(command.jobId);
        await page.getByLabel("Job ID").press("Enter");
        await page.getByRole("button", { name: "Start watching" }).click();
        reply({ ok: true, event: "watching" });
      } else if (command.cmd === "expectObservation") {
        await page.locator("#observations li", { hasText: command.text }).first().waitFor({ timeout: command.timeoutMs ?? 30000 });
        reply({ ok: true, event: "observed", text: command.text });
      } else if (command.cmd === "expectWatchState") {
        await page.waitForFunction((state) => document.querySelector("#watch-status")?.dataset.state === state, command.state, { timeout: command.timeoutMs ?? 30000 });
        reply({ ok: true, event: "watch-state", state: command.state, text: await page.locator("#watch-status").innerText() });
      } else if (command.cmd === "snapshot") {
        const observed = await page.locator("#observations li").allInnerTexts();
        const detailHidden = await page.locator("#watch-detail").isHidden();
        const detail = detailHidden ? "" : await page.locator("#watch-detail").innerText();
        const status = await page.locator("#watch-status").innerText();
        const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        reply({ ok: true, event: "snapshot", observed, detail, status, storage, overflow, mutations: mutations.length, errors: [...errors] });
      } else if (command.cmd === "disconnect") {
        await page.getByRole("button", { name: "Forget token" }).click();
        reply({ ok: true, event: "disconnected" });
      } else if (command.cmd === "close") {
        reply({ ok: true, event: "closing" });
        break;
      } else {
        throw new Error(`unknown command ${command.cmd}`);
      }
    } catch (error) {
      let statusText = "";
      try { statusText = await page.locator("#connection-status").innerText({ timeout: 1000 }); } catch { /* page gone */ }
      reply({ ok: false, event: "error", command: command.cmd, message: error instanceof Error ? error.message : String(error), statusText, diagnostics });
    }
  }
} finally {
  if (browser) await browser.close();
  if (vite.exitCode === null) {
    vite.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => vite.once("exit", resolveExit)), delay(5000)]);
    if (vite.exitCode === null) vite.kill("SIGKILL");
  }
}

process.exit(0);

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
