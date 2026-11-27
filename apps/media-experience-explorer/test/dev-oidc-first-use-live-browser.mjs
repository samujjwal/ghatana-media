import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execFile = promisify(execFileCallback);
const proxyPort = positivePort(requiredEnv("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT"));
const oidcIssuer = requiredEnv("VITE_MEDIA_OIDC_ISSUER");
const oidcClientId = requiredEnv("VITE_MEDIA_OIDC_CLIENT_ID");
const testPassword = requiredEnv("MEDIA_J01_TEST_PASSWORD");
const ownerUser = requiredEnv("MEDIA_J01_OWNER_USER");
const ownerTenant = requiredEnv("MEDIA_J01_OWNER_TENANT");
const otherTenantUser = requiredEnv("MEDIA_J01_OTHER_TENANT_USER");
const otherTenant = requiredEnv("MEDIA_J01_OTHER_TENANT");
const removedUser = requiredEnv("MEDIA_J01_REMOVED_USER");
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
  if (!value) throw new Error(`${name} is required for the real Keycloak browser journey.`);
  return value;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT must be a valid TCP port.");
  }
  return port;
}

const jsonFrom = (locator) => locator.textContent().then((value) => JSON.parse(value ?? "null"));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
async function awaitLine(expected) {
  const { value, done } = await lines.next();
  assert.equal(done, false, `stdin closed while waiting for ${expected}`);
  assert.equal(value, expected);
}

/**
 * Real authorization-code + PKCE sign-in: the Explorer redirects to Keycloak, the test user types the TEST password
 * into Keycloak's own login form, and Keycloak redirects back with a code the Explorer exchanges for a token.
 */
async function signIn(page, baseUrl, username, password) {
  const diagnostics = pageDiagnostics(page);
  // The host's network can flap (Docker bridges coming and going aborts in-flight module loads with
  // ERR_NETWORK_CHANGED); that is infrastructure noise, not product behaviour, so reload the page a few times.
  const signInButton = page.getByRole("button", { name: "Sign in with identity provider (OIDC)" });
  let loaded = false;
  for (let attempt = 0; attempt < 4 && !loaded; attempt += 1) {
    await page.goto(`${baseUrl}/dev-project-timeline.html`);
    try { await signInButton.waitFor({ state: "visible", timeout: 10_000 }); loaded = true; } catch { /* reload */ }
  }
  if (!loaded) {
    throw new Error(`OIDC sign-in button unavailable; status=${await page.locator("#status").textContent()}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
  await signInButton.click();
  await page.waitForURL((url) => url.href.startsWith(oidcIssuer), { timeout: 30_000 });
  const authorize = new URL(page.url());
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok((authorize.searchParams.get("code_challenge") ?? "").length >= 43, "PKCE challenge must be present");
  assert.equal(authorize.searchParams.get("client_id"), oidcClientId);
  await page.locator("input#username").fill(username);
  await page.locator("input#password").fill(password);
  await page.locator("#kc-login").click();
}

const diagnosticsByPage = new WeakMap();
function pageDiagnostics(page) {
  if (!diagnosticsByPage.has(page)) {
    const entries = [];
    page.on("console", (message) => entries.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => entries.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => entries.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
    diagnosticsByPage.set(page, entries);
  }
  return diagnosticsByPage.get(page);
}
/** Waits for visible text and, on failure, reports what the page and browser saw. */
async function expectText(page, text, options) {
  try { await page.getByText(text, options).first().waitFor({ timeout: 30_000 }); }
  catch (error) {
    throw new Error(`Timed out waiting for ${text}; url=${page.url().split("?")[0]}; status=${await page.locator("#status").textContent()}; `
      + `diagnostics=${JSON.stringify(pageDiagnostics(page))}`);
  }
}

const vitePort = positivePort(requiredEnv("MEDIA_J01_EXPLORER_PORT"));
const viteEnvironment = {
  ...process.env,
  MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort),
  VITE_MEDIA_OIDC_ISSUER: oidcIssuer,
  VITE_MEDIA_OIDC_CLIENT_ID: oidcClientId,
};
delete viteEnvironment.MEDIA_J01_TEST_PASSWORD;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

function observe(page) {
  const seen = { pageErrors: [], apiRequests: [], apiResponses: [], authorizationHeaders: [] };
  page.on("pageerror", (error) => seen.pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/")) {
      seen.apiRequests.push({ method: request.method(), url: request.url(), body: request.postData(),
        authorizationPresent: Boolean(request.headers().authorization), observedAt: Date.now() });
      seen.authorizationHeaders.push(request.headers().authorization ?? null);
    }
  });
  page.on("response", async (response) => {
    if (response.url().includes("/dev/v1/")) {
      let text = "";
      try { text = await response.text(); } catch { /* body unavailable */ }
      seen.apiResponses.push({ status: response.status(), url: response.url(), text });
    }
  });
  return seen;
}

let browser;
try {
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (viteProcess.exitCode !== null) throw new Error(`Vite exited before ready:\n${viteOutput}`);
    try {
      const response = await fetch(`${baseUrl}/dev-project-timeline.html`);
      if (response.ok) { ready = true; break; }
    } catch { /* Vite is still starting. */ }
    await delay(250);
  }
  assert.equal(ready, true, `Vite did not serve the actual Explorer page:\n${viteOutput}`);

  browser = await chromium.launch({ headless: true });

  // ---- A first-time user of tenant A signs in through Keycloak ----
  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  const seen = observe(page);
  await signIn(page, baseUrl, ownerUser, testPassword);
  await expectText(page, ownerTenant, { exact: true });
  await page.getByText(/^oidc:/u).waitFor();
  const principal = (await page.locator("#context-fields").getByText(/^oidc:/u).textContent()).trim();
  const workspaceId = (await page.locator("#context-fields div").filter({ hasText: "Workspace ID" }).locator("dd").textContent()).trim();
  assert.ok(workspaceId.length > 0);
  assert.equal(new URL(page.url()).search, "", "the authorization response must be removed from the address bar");
  const storedBlob = await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }) + JSON.stringify({ ...window.localStorage }) + document.cookie);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/u.test(storedBlob), "no access token may be written to browser storage");
  assert.ok(seen.authorizationHeaders.length > 0 && seen.authorizationHeaders.every((value) => /^Bearer eyJ/u.test(value ?? "")),
    "every host call must carry the Keycloak-issued bearer token");

  const title = "First-use project from Keycloak sign-in";
  await page.getByLabel("Project title").fill(title);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByText(/Created DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  const created = await jsonFrom(page.locator("#project-json"));
  const projectId = created.project.projectId;
  const initialRevisionId = created.initialRevision.revisionId;
  assert.equal(created.project.tenantId, ownerTenant);
  const createRequest = seen.apiRequests.find(({ method, url }) => method === "POST" && url.endsWith("/dev/v1/projects"));
  const createBody = JSON.parse(createRequest.body);

  const timelineId = `first-use-${crypto.randomUUID()}`;
  await page.getByLabel("Timeline ID").fill(timelineId);
  await page.getByRole("button", { name: "Create timeline", exact: true }).click();
  await page.getByText(new RegExp(`Created empty timeline ${timelineId}; exact revision .* reopened\\.`)).waitFor();
  const timelineRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  const sceneId = `scene-${crypto.randomUUID()}`;
  await page.getByLabel("New scene ID").fill(sceneId);
  await page.getByLabel("Scene order").fill("0");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByText(/Committed and reopened addScene in revision .*\./u).waitFor();
  const headRevision = (await jsonFrom(page.locator("#timeline-json"))).revision;
  assert.equal(headRevision.parentRevisionId, timelineRevision.revisionId);
  assert.deepEqual(headRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);

  emit({ event: "created", principal, workspaceId, projectId, initialRevisionId, title, createBody,
    timelineRevisionId: timelineRevision.revisionId, headRevisionId: headRevision.revisionId, timelineId, sceneId });
  await awaitLine("host-restarted");

  // The same in-memory token still verifies against the restarted launcher; the exact head reopens from storage.
  const callsBeforeReopen = seen.apiRequests.length;
  await page.getByRole("button", { name: "Reopen current project" }).click();
  await page.getByText(new RegExp(`Reopened project ${projectId} at head ${headRevision.revisionId}\\.`)).waitFor();
  const reopened = await jsonFrom(page.locator("#readback-json"));
  assert.equal(reopened.currentRevision.revisionId, headRevision.revisionId);
  assert.deepEqual(reopened.currentRevision.timelines[0].graph.scenes, [{ sceneId, order: 0 }]);
  await page.getByLabel("Exact revision ID").fill(initialRevisionId);
  await page.getByRole("button", { name: "Read exact revision" }).click();
  await page.locator("#workspace-status").filter({ hasText: new RegExp(`Read exact revision ${initialRevisionId} from project ${projectId}\\.`) }).waitFor();
  assert.deepEqual((await jsonFrom(page.locator("#readback-json"))).revision.timelines, []);
  assert.ok(!seen.apiRequests.slice(callsBeforeReopen).some(({ method }) => method === "POST"),
    "reopening after the restart must only read");

  // Duplicate create from the UI: the exact saved request replays, it does not make a second project.
  await page.getByRole("button", { name: "Replay same create request" }).click();
  await page.getByText(/Replayed DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  assert.equal((await jsonFrom(page.locator("#project-json"))).createdNow, false);
  assert.equal((await jsonFrom(page.locator("#project-json"))).project.projectId, projectId);

  // Sign out: the in-memory token is dropped and no further call carries it.
  const callsBeforeSignOut = seen.apiRequests.length;
  const signOutClickAt = Date.now();
  await page.getByRole("button", { name: "Forget token and disconnect" }).click();
  await page.getByText(/Disconnected\. The in-memory token and current project context were cleared\./u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create project", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Open existing project" }).isDisabled(), true);
  assert.equal(await page.locator("#timeline-workspace-panel").isHidden(), true);
  assert.equal(await page.locator("#context-fields").isHidden(), true);
  await page.waitForTimeout(500);
  const callsAfterSignOut = seen.apiRequests.slice(callsBeforeSignOut)
    .map(({ method, url, authorizationPresent, observedAt }) => ({ method, url, authorizationPresent, observedAt,
      afterSignOutClick: observedAt > signOutClickAt }));
  assert.equal(seen.apiRequests.length, callsBeforeSignOut,
    `no host call may follow sign-out; observed=${JSON.stringify(callsAfterSignOut)}`);
  const afterBlob = await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }) + JSON.stringify({ ...window.localStorage }));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/u.test(afterBlob));
  await page.reload();
  assert.equal(await page.getByRole("button", { name: "Create project", exact: true }).isDisabled(), true,
    "a reload must not restore the session from storage");
  assert.deepEqual(seen.pageErrors, [], `page errors: ${JSON.stringify(seen.pageErrors)}`);
  await ownerContext.close();

  // ---- A tenant B user (fresh browser context: no Keycloak SSO cookie) cannot see tenant A's project ----
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const otherSeen = observe(otherPage);
  await signIn(otherPage, baseUrl, otherTenantUser, testPassword);
  await expectText(otherPage, otherTenant, { exact: true });
  await otherPage.locator("#open-project-id").fill(projectId);
  await otherPage.getByRole("button", { name: "Open existing project" }).click();
  await otherPage.getByText(/PROJECT_NOT_FOUND/u).waitFor();
  const probe = otherSeen.apiResponses.find(({ url }) => url.endsWith(`/dev/v1/projects/${projectId}`));
  assert.equal(probe?.status, 404, "the other tenant must get 404, not 403");
  for (const needle of [title, ownerTenant, initialRevisionId, headRevision.revisionId, timelineId, sceneId]) {
    assert.ok(!probe.text.includes(needle), `404 body must not leak ${needle}`);
    assert.ok(!(await otherPage.locator("body").innerText()).includes(needle), `page must not show ${needle}`);
  }
  assert.equal(await otherPage.locator("#timeline-workspace-panel").isHidden(), true);
  await otherContext.close();
  emit({ event: "tenant-b-done", status: probe.status });
  await awaitLine("user-removed");

  // ---- A user removed from the tenant group signs in at Keycloak but the host refuses the new token ----
  const removedContext = await browser.newContext();
  const removedPage = await removedContext.newPage();
  const removedSeen = observe(removedPage);
  await signIn(removedPage, baseUrl, removedUser, testPassword);
  await removedPage.getByText(/UNAUTHENTICATED|401|Invalid OIDC bearer token/u).first().waitFor({ timeout: 30_000 });
  assert.ok(removedSeen.apiResponses.every(({ status }) => status === 401), "every host answer for the removed user is 401");
  assert.equal(await removedPage.getByRole("button", { name: "Create project", exact: true }).isDisabled(), true);
  await removedContext.close();

  // ---- A wrong password stays at Keycloak: no token reaches the Explorer ----
  const wrongContext = await browser.newContext();
  const wrongPage = await wrongContext.newPage();
  await signIn(wrongPage, baseUrl, ownerUser, `${testPassword}-wrong`);
  await wrongPage.getByText(/Invalid username or password/u).waitFor({ timeout: 30_000 });
  assert.ok(wrongPage.url().startsWith(oidcIssuer), "a wrong password must not leave the identity provider");
  await wrongContext.close();

  emit({ event: "done" });
} finally {
  process.stdin.destroy();
  if (browser) await browser.close();
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => viteProcess.once("exit", resolve)), delay(5_000)]);
    if (viteProcess.exitCode === null) viteProcess.kill("SIGKILL");
  }
}
