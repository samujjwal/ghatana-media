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
const tenant = requiredEnv("MEDIA_DEV_OFFLINE_TENANT");
const principal = requiredEnv("MEDIA_DEV_OFFLINE_PRINCIPAL");
const otherPrincipal = requiredEnv("MEDIA_DEV_OFFLINE_OTHER_PRINCIPAL");
const tokenSecret = requiredEnv("MEDIA_DEV_JWT_HMAC_SECRET");
const repoRoot = resolve(appRoot, "../..");
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

function jsonFrom(locator) {
  return locator.textContent().then((value) => JSON.parse(value ?? "null"));
}

const vitePort = 4178;
const viteEnvironment = { ...process.env, MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT: String(proxyPort) };
delete viteEnvironment.MEDIA_DEV_JWT_HMAC_SECRET;
const viteProcess = spawn(process.execPath, [viteBinary, "--config", "vite.config.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
  cwd: appRoot,
  env: viteEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
viteProcess.stdout.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });
viteProcess.stderr.setEncoding("utf8").on("data", (chunk) => { viteOutput += chunk; });

const PROJECT_PERMISSIONS = ["media:project:dev:create", "media:project:dev:read", "media:project:dev:write"];
/** Mints a real DEV_ONLY JWT the launcher verifies (the same issuer the other journeys use). */
async function mint(subject, permissions = PROJECT_PERMISSIONS, expiresIn = 300) {
  const command = ["scripts/media-dev-identity-token.mjs", "--tenant", tenant, "--subject", subject, "--expires-in", String(expiresIn)];
  for (const permission of permissions) command.push("--permission", permission);
  const { stdout } = await execFile(process.execPath, command, {
    cwd: repoRoot,
    env: { ...process.env, MEDIA_PROFILE: "dev", MEDIA_RUNTIME_ENVIRONMENT: "dev", MEDIA_DEV_IDENTITY_ENABLED: "true", MEDIA_DEV_JWT_HMAC_SECRET: tokenSecret },
  });
  return stdout.trim();
}

/** A second session talking to the real launcher directly (no browser): same principal, its own token. */
async function host(method, path, token, body) {
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": tenant, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const step = (name) => process.stderr.write(`[offline-journey] ${name}\n`);
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleMessages = [];
  const apiRequests = [];
  const apiResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleMessages.push(message.text()); });
  page.on("request", (request) => {
    if (request.url().includes("/dev/v1/")) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() });
  });
  page.on("response", (response) => {
    if (response.url().includes("/dev/v1/")) apiResponses.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname });
  });
  const editPath = (projectId) => new RegExp(`/dev/v1/projects/${projectId}/timelines/[^/]+/edits$`, "u");
  const editPosts = (projectId) => apiRequests.filter((r) => r.method === "POST" && editPath(projectId).test(r.path));

  const drafts = () => page.getByRole("region", { name: "Offline drafts", exact: true });
  const linkState = () => page.getByTestId("offline-link-state");
  const draftItem = (scene) => drafts().locator("li[data-draft-state]", { hasText: `Add scene ${scene}` });
  const statusText = async () => (await page.getByTestId("offline-draft-status").textContent()) ?? "";

  /** Waits for the panel status; on timeout the failure message carries what the page actually said. */
  async function status(pattern) {
    try { await page.getByTestId("offline-draft-status").filter({ hasText: pattern }).waitFor({ timeout: 20_000 }); }
    catch (error) {
      throw new Error(`status ${pattern} not shown; status="${await statusText()}"; panel="${(await drafts().innerText()).slice(0, 1500)}"; cause=${error.message}`);
    }
  }
  async function connect(token) {
    // The module script sets the host chip when it has run; Vite may still be (re)loading dependencies before that.
    await page.waitForFunction(() => Boolean(document.getElementById("host-origin")?.textContent), undefined, { timeout: 30_000 });
    await page.getByLabel("Short-lived DEV_ONLY bearer token").fill(token);
    await page.getByRole("button", { name: "Read host context" }).click();
    try { await page.getByText(/Connected to the local host/u).waitFor({ timeout: 15_000 }); }
    catch (error) { throw new Error(`connect failed; page status="${await page.locator("#status").textContent()}"; responses=${JSON.stringify(apiResponses.slice(-4))}; cause=${error.message}`); }
  }
  async function forget() {
    await page.getByRole("button", { name: "Forget token and disconnect" }).click();
    await page.getByText(/Disconnected/u).waitFor();
  }
  async function saveDraft(scene, order) {
    await drafts().getByLabel("Scene id").fill(scene);
    await drafts().getByLabel("Order").fill(String(order)); // scene orders are unique per timeline at the host
    await drafts().getByRole("button", { name: "Save as offline draft" }).click();
    await status(/Saved offline draft .*Nothing was sent\./u);
  }
  async function reviewDraft(scene) {
    await draftItem(scene).getByRole("button", { name: "Review and replay" }).click();
    await draftItem(scene).getByLabel("Draft review").waitFor();
  }
  const requestIdOf = async (scene) => (await draftItem(scene).locator("code").last().textContent());
  async function headOf(projectId, token) {
    const read = await host("GET", `/dev/v1/projects/${projectId}`, token);
    assert.equal(read.status, 200, JSON.stringify(read));
    return { head: read.json.project.headRevisionId, graph: read.json.currentRevision.timelines[0]?.graph, revision: read.json.currentRevision };
  }
  const sceneIds = (graph) => (graph?.scenes ?? []).map((scene) => scene.sceneId).sort();
  async function chainLength(projectId, token, fromHead, toRevisionId) {
    let length = 0; let id = fromHead;
    while (id !== toRevisionId) {
      const read = await host("GET", `/dev/v1/projects/${projectId}/revisions/${id}`, token);
      assert.equal(read.status, 200);
      id = read.json.revision.parentRevisionId; length += 1;
      assert.ok(id && length < 50, "the revision chain must reach the base");
    }
    return length;
  }

  // ---------------------------------------------------------------- setup: an online session builds the project
  const ownerToken = await mint(principal);
  await page.goto(`${baseUrl}/dev-project-timeline.html`);
  await connect(ownerToken);
  await page.getByLabel("Project title").fill("Offline reconnect journey");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByText(/Created DEV_ONLY project .* exact initial revision .* reopened\./u).waitFor();
  const created = JSON.parse(await page.locator("#project-json").textContent());
  const projectId = created.project.projectId;
  const timelineId = `offline-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("Timeline ID").fill(timelineId);
  await page.getByRole("button", { name: "Create timeline", exact: true }).click();
  await page.getByText(new RegExp(`Created empty timeline ${timelineId}; exact revision .* reopened\\.`)).waitFor();
  await page.getByLabel("New scene ID").fill("base-scene");
  await page.getByLabel("Scene order").fill("0");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByText(/Committed and reopened addScene in revision .*\./u).waitFor();
  const editRoute = editPath(projectId); // one RegExp instance: Playwright unroute compares by identity
  const baseRevisionId = (await host("GET", `/dev/v1/projects/${projectId}`, ownerToken)).json.project.headRevisionId;
  const pointerRaw = await page.evaluate(() => localStorage.getItem("ghatana-media-dev-offline-workspace-v1"));
  assert.ok(pointerRaw, "opening a project must leave the non-secret offline pointer");
  assert.ok(!pointerRaw.includes(ownerToken) && !/eyJ/u.test(pointerRaw), "the pointer must never contain a token");
  assert.equal(JSON.parse(pointerRaw).project.headRevisionId, baseRevisionId, "online edits advance the pointer's last observed head");

  // The app-shell worker must control the page before an offline reload can work.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.getByRole("heading", { name: "Offline drafts on this device" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true, "the worker must control the reloaded page");
  assert.ok(await page.evaluate(async () => (await (await caches.open("media-dev-offline-shell-v1")).keys()).length) > 5, "the app shell must be cached");

  step("setup done->ep1");
  // ---------------------------------------------------------------- episode 1: offline edits, offline reload, fresh-rights replay
  await connect(ownerToken);
  await page.getByLabel("Project ID").fill(projectId);
  await page.getByRole("button", { name: "Open existing project" }).click();
  await page.getByText(/Opened existing DEV_ONLY project/u).waitFor();
  const postsBefore = editPosts(projectId).length;
  await context.setOffline(true);
  await linkState().filter({ hasText: "Offline" }).waitFor();
  await saveDraft("offline-a", 1);
  assert.equal(editPosts(projectId).length, postsBefore, "an offline draft must never reach the host");

  // Encrypted at rest: the stored bytes are AES-GCM ciphertext, the key is non-extractable.
  const stored = await page.evaluate(async () => {
    const open = (name) => new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const rows = (db, store) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); });
    const keys = await rows(await open("ghatana-media-offline-draft-keys-v1"), "keys");
    const result = { keys: keys.map((k) => ({ extractable: k.key.extractable, algorithm: k.key.algorithm.name, type: k.key.type, length: k.key.algorithm.length, scope: [k.tenantId, k.principalId, k.projectId] })), rows: [] };
    for (const name of (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("ghatana-media-offline-drafts-v1:"))) {
      const db = await open(name);
      for (const store of db.objectStoreNames) for (const row of await rows(db, store)) {
        const bytes = new Uint8Array(row.ciphertext);
        const latin = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
        let parsesAsJson = true; try { JSON.parse(new TextDecoder().decode(bytes)); } catch { parsesAsJson = false; }
        result.rows.push({ state: row.state, payloadBytes: row.payloadBytes, ciphertextBytes: bytes.length, nonceBytes: new Uint8Array(row.nonce).length,
          leaks: ["offline-a", "addScene", "sceneId", "timelineId", "requestId", "capturedAt", "edits", "{\""].filter((needle) => latin.includes(needle)), parsesAsJson,
          fields: Object.keys(row).sort() });
      }
    }
    return result;
  });
  assert.equal(stored.keys.length, 1);
  assert.deepEqual(stored.keys[0], { extractable: false, algorithm: "AES-GCM", type: "secret", length: 256, scope: [tenant, principal, projectId] });
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].ciphertextBytes, stored.rows[0].payloadBytes + 16, "AES-GCM: plaintext plus a 128-bit tag");
  assert.equal(stored.rows[0].nonceBytes, 12);
  assert.deepEqual(stored.rows[0].leaks, [], "no edit JSON fragment may appear in the stored bytes");
  assert.equal(stored.rows[0].parsesAsJson, false, "the stored bytes are not the edit JSON");
  assert.ok(!stored.rows[0].fields.includes("payload"), "no plaintext payload field is stored");

  // Reload the page while offline: the page opens from the app-shell cache and the drafts survive.
  const requestsBeforeReload = apiRequests.length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Offline drafts on this device" }).waitFor({ timeout: 15_000 });
  await linkState().filter({ hasText: "Offline" }).waitFor();
  await draftItem("offline-a").waitFor();
  assert.equal(await draftItem("offline-a").getAttribute("data-draft-state"), "PENDING");
  const requestIdBefore = await requestIdOf("offline-a");
  assert.equal(apiRequests.length, requestsBeforeReload, "the offline reload must make no host call");
  assert.equal(await drafts().getByRole("button", { name: "Review and replay" }).isDisabled(), true, "replay is unavailable while offline");

  // Reconnecting never replays by itself.
  await context.setOffline(false);
  await linkState().filter({ hasText: "Online" }).waitFor();
  await delay(500);
  assert.equal(editPosts(projectId).length, postsBefore, "reconnecting must not auto-replay");
  assert.equal(apiRequests.length, requestsBeforeReload, "reconnecting alone makes no host call");

  // 1a. expired token: refused typed, draft kept, nothing sent.
  const shortToken = await mint(principal, PROJECT_PERMISSIONS, 30);
  await connect(shortToken);
  await reviewDraft("offline-a");
  assert.ok(await draftItem("offline-a").getByLabel("Draft review").getByText(/unchanged/u).count() > 0, "no server change yet");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await host("GET", "/dev/v1/context", shortToken)).status === 401) break;
    await delay(1_000);
  }
  assert.equal((await host("GET", "/dev/v1/context", shortToken)).status, 401, "the short-lived token must really expire at the host");
  await draftItem("offline-a").getByRole("button", { name: "Confirm replay" }).click();
  await draftItem("offline-a").getByText(/REFUSED \(401 AUTH_EXPIRED\)/u).first().waitFor();
  assert.equal(editPosts(projectId).length, postsBefore, "an expired token must not send the edit");
  assert.equal(await draftItem("offline-a").getAttribute("data-draft-state"), "PENDING", "the refused draft is kept");
  await forget();

  // 1b. the project write right was revoked (a token without it): the edit is refused at the host, the draft is kept.
  const readOnlyToken = await mint(principal, ["media:project:dev:read"]);
  await connect(readOnlyToken);
  await reviewDraft("offline-a");
  await draftItem("offline-a").getByRole("button", { name: "Confirm replay" }).click();
  await draftItem("offline-a").getByText(/REFUSED \(403 ACCESS_DENIED\)/u).first().waitFor();
  assert.equal(editPosts(projectId).length, postsBefore + 1, "the host, not the browser, refused the edit");
  assert.equal(apiResponses.filter((r) => r.status === 403 && r.method === "POST" && editPath(projectId).test(r.path)).length, 1);
  assert.equal(await draftItem("offline-a").getAttribute("data-draft-state"), "PENDING");
  assert.equal(await requestIdOf("offline-a"), requestIdBefore, "the refused draft keeps its requestId");
  await forget();

  // 1c. project access removed (another principal's token): refused at the fresh read, draft kept, nothing sent.
  const strangerToken = await mint(otherPrincipal);
  await connect(strangerToken);
  const postsAfterRevocation = editPosts(projectId).length;
  await draftItem("offline-a").getByRole("button", { name: "Review and replay" }).click();
  await status(/REFUSED \(403 ACCESS_DENIED\)/u);
  assert.equal(editPosts(projectId).length, postsAfterRevocation);
  assert.equal(await draftItem("offline-a").getAttribute("data-draft-state"), "PENDING");
  await forget();

  // 1d. fresh full rights, lost REQUEST (never reached the host): outcome unknown, reconciled as not applied, retried once.
  const freshOwner = await mint(principal);
  await connect(freshOwner);
  const dropRequest = async (route) => { await route.abort("failed"); };
  await page.route(editRoute, dropRequest);
  await reviewDraft("offline-a");
  await draftItem("offline-a").getByRole("button", { name: "Confirm replay" }).click();
  await draftItem("offline-a").getByText(/OUTCOME_UNKNOWN: The host did not confirm/u).first().waitFor();
  await draftItem("offline-a").getByText(/The head still equals the base, so the earlier request did not commit\./u).waitFor();
  await page.unroute(editRoute, dropRequest);
  assert.equal((await headOf(projectId, freshOwner)).head, baseRevisionId, "a lost request leaves the head unchanged");
  await draftItem("offline-a").getByRole("button", { name: "Retry same requestId" }).click();
  await status(/re-armed with the same requestId/u);
  assert.equal(await requestIdOf("offline-a"), requestIdBefore, "retry reuses the draft's requestId");
  await reviewDraft("offline-a");
  await draftItem("offline-a").getByRole("button", { name: "Confirm replay" }).click();
  await status(/REPLAYED: the same requestId .* was accepted again; revision /);
  const afterEpisode1 = await headOf(projectId, freshOwner);
  assert.deepEqual(sceneIds(afterEpisode1.graph), ["base-scene", "offline-a"]);
  assert.equal(await chainLength(projectId, freshOwner, afterEpisode1.head, baseRevisionId), 1, "exactly one revision for the replayed draft");
  const episode1Head = afterEpisode1.head;
  await drafts().getByText("No offline drafts.").waitFor();

  step("ep1 done->ep2");
  // ---------------------------------------------------------------- episode 2: second session changes the head while offline
  await context.setOffline(true);
  await linkState().filter({ hasText: "Offline" }).waitFor();
  await saveDraft("ep2-a", 2);
  await saveDraft("ep2-b", 3);
  const secondSessionToken = await mint(principal);
  assert.notEqual(secondSessionToken, freshOwner);
  const second = await host("POST", `/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`, secondSessionToken,
    { expectedHeadRevisionId: episode1Head, edits: [{ type: "addScene", sceneId: "second-session-scene", order: 5 }] });
  assert.equal(second.status, 201, JSON.stringify(second));
  const secondHead = second.json.revision.revisionId;
  await page.reload({ waitUntil: "domcontentloaded" });
  await draftItem("ep2-a").waitFor({ timeout: 15_000 });
  await draftItem("ep2-b").waitFor();
  const episode2PostsBefore = editPosts(projectId).length;
  await context.setOffline(false);
  await linkState().filter({ hasText: "Online" }).waitFor();
  await connect(await mint(principal));
  await reviewDraft("ep2-a");
  const conflictA = draftItem("ep2-a").getByTestId("offline-conflict");
  await conflictA.waitFor();
  assert.match(await conflictA.getByTestId("conflict-mine").textContent(), /Add scene ep2-a/u);
  const theirsText = await conflictA.getByTestId("conflict-theirs").textContent();
  assert.ok(theirsText.includes("Added scene second-session-scene") && theirsText.includes(secondHead), `theirs must show the server change: ${theirsText}`);
  assert.equal(await draftItem("ep2-a").getByRole("button", { name: "Confirm replay" }).count(), 0, "a stale draft is never blindly replayed");
  assert.equal(editPosts(projectId).length, episode2PostsBefore, "showing the conflict sends nothing");

  // keep mine: rebase onto the new head, new requestId, new CAS; the response is lost in transit (the host commits).
  await draftItem("ep2-a").getByRole("button", { name: "Keep mine (rebase onto current head)" }).click();
  await status(/Kept mine: the edit was rebased onto the current head with a new requestId/u);
  assert.equal(editPosts(projectId).length, episode2PostsBefore, "rebasing sends nothing");
  await reviewDraft("ep2-a");
  assert.ok(await draftItem("ep2-a").getByLabel("Draft review").getByText(/unchanged/u).count() > 0);
  const loseResponse = async (route) => { await route.fetch(); await route.abort("failed"); };
  await page.route(editRoute, loseResponse);
  await draftItem("ep2-a").getByRole("button", { name: "Confirm replay" }).click();
  await draftItem("ep2-a").getByText(/OUTCOME_UNKNOWN: The host did not confirm/u).first().waitFor();
  await page.unroute(editRoute, loseResponse);
  const committed = await headOf(projectId, freshOwner);
  assert.notEqual(committed.head, secondHead, "the host committed although the browser saw no response");
  await draftItem("ep2-a").getByText(/already holds this draft's edits\. It will not be sent again\./u).waitFor();
  assert.equal(await draftItem("ep2-a").getByRole("button", { name: "Retry same requestId" }).count(), 0, "a committed draft cannot be re-sent");
  const sentForEp2A = editPosts(projectId).filter((r) => r.body?.includes("ep2-a")).length;
  assert.equal(sentForEp2A, 1, "the rebased draft was sent exactly once");
  await draftItem("ep2-a").getByRole("button", { name: "Confirm already applied and remove local draft" }).click();
  await status(/Confirmed already applied in revision .*; the local draft was removed and nothing was sent again\./u);
  assert.equal(await draftItem("ep2-a").count(), 0);
  assert.equal(editPosts(projectId).filter((r) => r.body?.includes("ep2-a")).length, 1, "no second send after reconciliation");
  assert.deepEqual(sceneIds(committed.graph), ["base-scene", "ep2-a", "offline-a", "second-session-scene"], "nothing overwritten: both sessions' scenes survive");
  assert.equal(await chainLength(projectId, freshOwner, committed.head, secondHead), 1, "exactly one revision for ep2-a");
  // A duplicate of the very same CAS is refused by the host: the effect cannot be applied twice.
  const duplicate = await host("POST", `/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`, freshOwner,
    { expectedHeadRevisionId: secondHead, edits: [{ type: "addScene", sceneId: "ep2-a", order: 0 }] });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, "REVISION_CONFLICT");
  assert.equal((await headOf(projectId, freshOwner)).head, committed.head, "the duplicate changed nothing");

  // take theirs: the other draft is discarded and never sent.
  await reviewDraft("ep2-b");
  await draftItem("ep2-b").getByTestId("offline-conflict").waitFor();
  await draftItem("ep2-b").getByRole("button", { name: "Take theirs (discard my draft)" }).click();
  await status(/Took theirs: my draft was discarded; the server version .* stands\./u);
  assert.equal(await draftItem("ep2-b").count(), 0);
  assert.equal(editPosts(projectId).filter((r) => r.body?.includes("ep2-b")).length, 0, "a discarded draft is never sent");
  assert.ok(!sceneIds((await headOf(projectId, freshOwner)).graph).includes("ep2-b"));
  await drafts().getByText("No offline drafts.").waitFor();

  step("ep2 done->ep3");
  // ---------------------------------------------------------------- episode 3: the head moves between the fresh read and the send (real host 409)
  const episode3Base = (await headOf(projectId, freshOwner)).head;
  await saveDraft("race-mine", 4);
  await reviewDraft("race-mine");
  assert.ok(await draftItem("race-mine").getByLabel("Draft review").getByText(/unchanged/u).count() > 0);
  const racer = async (route) => {
    const theirs = await host("POST", `/dev/v1/projects/${projectId}/timelines/${timelineId}/edits`, secondSessionToken,
      { expectedHeadRevisionId: episode3Base, edits: [{ type: "addScene", sceneId: "race-theirs", order: 9 }] });
    assert.equal(theirs.status, 201, JSON.stringify(theirs));
    await route.continue();
  };
  await page.route(editRoute, racer);
  await draftItem("race-mine").getByRole("button", { name: "Confirm replay" }).click();
  await draftItem("race-mine").getByText(/REVISION_CONFLICT: this draft was authored on .* but the project head is /u).first().waitFor();
  await page.unroute(editRoute, racer);
  assert.ok(apiResponses.some((r) => r.status === 409 && r.method === "POST" && editPath(projectId).test(r.path)), "the real host answered the CAS with 409");
  const raced = await headOf(projectId, freshOwner);
  assert.ok(!sceneIds(raced.graph).includes("race-mine"), "the conflicting edit was not applied");
  assert.ok(sceneIds(raced.graph).includes("race-theirs"));
  const conflictRace = draftItem("race-mine").getByTestId("offline-conflict");
  await conflictRace.waitFor();
  assert.ok((await conflictRace.getByTestId("conflict-theirs").textContent()).includes("Added scene race-theirs"));
  await draftItem("race-mine").getByRole("button", { name: "Keep mine (rebase onto current head)" }).click();
  await status(/Kept mine/u);
  await reviewDraft("race-mine");
  await draftItem("race-mine").getByRole("button", { name: "Confirm replay" }).click();
  await status(/APPLIED \(201\)/u);
  const finalState = await headOf(projectId, freshOwner);
  assert.deepEqual(sceneIds(finalState.graph), ["base-scene", "ep2-a", "offline-a", "race-mine", "race-theirs", "second-session-scene"]);
  assert.equal(await chainLength(projectId, freshOwner, finalState.head, baseRevisionId), 5);

  step("ep3 done->ep4");
  // ---------------------------------------------------------------- episode 4: a corrupted local draft fails closed
  await saveDraft("corrupt-me", 6);
  await page.evaluate(async () => {
    const open = (name) => new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    for (const name of (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("ghatana-media-offline-drafts-v1:"))) {
      const db = await open(name);
      for (const store of db.objectStoreNames) {
        await new Promise((resolve) => {
          const tx = db.transaction(store, "readwrite"); const os = tx.objectStore(store); const all = os.getAll();
          all.onsuccess = () => { for (const row of all.result) { const bytes = new Uint8Array(row.ciphertext); bytes[1] ^= 0x5a; os.put({ ...row, ciphertext: bytes }); } };
          tx.oncomplete = resolve;
        });
      }
      db.close();
    }
  });
  const corruptMark = apiRequests.length;
  await page.reload();
  const unreadable = page.getByTestId("offline-drafts-unreadable");
  await unreadable.waitFor({ timeout: 15_000 });
  assert.match(await unreadable.textContent(), /DRAFTS_UNREADABLE: .*could not be decrypted or authenticated.*Nothing was sent to the host/u);
  await connect(await mint(principal));
  assert.equal(await drafts().getByRole("button", { name: "Save as offline draft" }).isDisabled(), true);
  assert.equal(apiRequests.slice(corruptMark).filter((r) => r.path.includes("/projects/")).length, 0, "an unreadable draft store makes no project or edit call");
  assert.equal(await drafts().getByRole("button", { name: "Review and replay" }).count(), 0);
  await unreadable.getByRole("button", { name: "Discard unreadable local drafts" }).click();
  await status(/Discarded 1 unreadable local draft row\(s\) at your request\. Nothing was sent\./u);
  await drafts().getByText("No offline drafts.").waitFor();
  assert.equal((await headOf(projectId, freshOwner)).head, finalState.head, "the corrupt draft never reached the host");

  assert.deepEqual(pageErrors, [], `browser page errors: ${JSON.stringify(pageErrors)}`);
  process.stdout.write(`${JSON.stringify({
    event: "offline-reconnect",
    projectId, timelineId, baseRevisionId, finalHeadRevisionId: finalState.head,
    expectedScenes: sceneIds(finalState.graph),
    absentScenes: ["ep2-b", "corrupt-me"],
    revisionsAfterBase: 5,
    consoleErrors: consoleMessages.length,
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
