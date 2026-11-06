import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const moduleUrl = new URL("../dist/indexeddb-offline-edit-store.js", import.meta.url);
const sources = new Map(await Promise.all([
  ["/indexeddb-offline-edit-store.js", moduleUrl],
  ["/offline-edit-queue.js", new URL("../dist/offline-edit-queue.js", import.meta.url)],
  ["/offline-reconnect.js", new URL("../dist/offline-reconnect.js", import.meta.url)],
].map(async ([pathname, fileUrl]) => [pathname, await readFile(fileUrl, "utf8")])));
const databaseName = `offline-edit-browser-${randomUUID()}`;
const workflowDatabaseName = `offline-reconnect-browser-${randomUUID()}`;
const origin = "https://offline-edit.test";
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (sources.has(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: sources.get(url.pathname) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Offline store integration</title>" });
  });

  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(origin), second.goto(origin)]);
  const init = async (page) => page.evaluate(async ({ modulePath, dbName }) => {
    const { IndexedDbOfflineEditStore } = await import(modulePath);
    window.offlineStore = new IndexedDbOfflineEditStore({ databaseName: dbName });
  }, { modulePath: `${origin}/indexeddb-offline-edit-store.js`, dbName: databaseName });
  await Promise.all([init(first), init(second)]);

  const original = {
    tenantId: "tenant-exact", projectId: "project-exact", editId: "edit-1",
    idempotencyKey: "idem-1", expectedVersion: "v7", nonce: new Uint8Array([1, 2, 3]),
    ciphertext: new Uint8Array([0, 255, 17, 128, 42]), payloadBytes: 37, state: "CONFLICT",
  };
  assert.equal(await first.evaluate(async (record) => window.offlineStore.insert(record, 8), original), true);
  assert.deepEqual(await second.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "project-exact" })), [original]);
  assert.deepEqual(await second.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "another-project" })), []);
  assert.deepEqual(await second.evaluate(async () => window.offlineStore.list({ tenantId: "another-tenant", projectId: "project-exact" })), []);

  const replacements = [
    { ...original, idempotencyKey: "idem-2a", expectedVersion: "v8", nonce: new Uint8Array([9, 8]), ciphertext: new Uint8Array([4, 5, 6]), payloadBytes: 3, state: "PENDING" },
    { ...original, idempotencyKey: "idem-2b", expectedVersion: "v9", nonce: new Uint8Array([7, 6]), ciphertext: new Uint8Array([7, 8, 9]), payloadBytes: 3, state: "OUTCOME_UNKNOWN" },
  ];
  const outcomes = await Promise.all(replacements.map((replacement, index) =>
    (index === 0 ? first : second).evaluate(async ({ expected, next }) =>
      window.offlineStore.compareAndSet(expected, next), { expected: original, next: replacement })));
  assert.equal(outcomes.filter(Boolean).length, 1, `expected exactly one cross-page CAS winner, got ${outcomes}`);
  const winnerIndex = outcomes[0] ? 0 : 1;
  const winner = replacements[winnerIndex];
  const afterRace = await second.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "project-exact" }));
  assert.deepEqual(afterRace, [winner]);

  await first.evaluate(() => window.offlineStore.close());
  await first.evaluate(async ({ modulePath, dbName }) => {
    const { IndexedDbOfflineEditStore } = await import(modulePath);
    window.offlineStore = new IndexedDbOfflineEditStore({ databaseName: dbName });
  }, { modulePath: `${origin}/indexeddb-offline-edit-store.js`, dbName: databaseName });
  assert.deepEqual(await first.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "project-exact" })), [winner]);

  await second.close();
  await first.reload();
  await init(first);
  const afterReload = await first.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "project-exact" }));
  assert.deepEqual(afterReload, [winner]);
  assert.deepEqual([...afterReload[0].nonce], [...winner.nonce]);
  assert.deepEqual([...afterReload[0].ciphertext], [...winner.ciphertext]);
  assert.deepEqual(await first.evaluate(async () => window.offlineStore.list({ tenantId: "tenant-exact", projectId: "another-project" })), []);

  await first.evaluate(() => window.offlineStore.close());
  await context.close();

  const workflowContext = await browser.newContext();
  await workflowContext.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (sources.has(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: sources.get(url.pathname) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Offline reconnect host</title>" });
  });
  const host = await workflowContext.newPage();
  await host.goto(origin);
  await host.evaluate(async () => {
    window.__hostHeldKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
    if (window.__hostHeldKey.extractable) throw new Error("fixture key must be non-extractable");
    const frame = document.createElement("iframe");
    frame.src = "/app";
    document.body.append(frame);
  });
  const app = () => host.frames().find((frame) => frame.url().endsWith("/app"));
  await host.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.location.pathname === "/app");
  const appFrame = app();
  assert.ok(appFrame, "app frame must load on the intercepted secure origin");
  const appModulePath = `${origin}/`;
  const initializeWorkflow = async (frame) => frame.evaluate(async ({ base, dbName }) => {
    const [{ IndexedDbOfflineEditStore }, { OfflineEditQueue }, { OfflineReconnectCoordinator }] = await Promise.all([
      import(`${base}indexeddb-offline-edit-store.js`),
      import(`${base}offline-edit-queue.js`),
      import(`${base}offline-reconnect.js`),
    ]);
    window.__workflowScope = { tenantId: "tenant-j23", projectId: "project-j23" };
    window.__workflowStore = new IndexedDbOfflineEditStore({ databaseName: dbName });
    window.__workflowQueue = new OfflineEditQueue({
      store: window.__workflowStore,
      encryptionKey: window.parent.__hostHeldKey,
    });
    window.__workflowCoordinator = (operations) => new OfflineReconnectCoordinator(
      window.__workflowQueue, window.__workflowScope, operations,
    );
  }, { base: appModulePath, dbName: workflowDatabaseName });
  await initializeWorkflow(appFrame);

  const edit = {
    tenantId: "tenant-j23", projectId: "project-j23", editId: "edit-j23-1",
    idempotencyKey: "idem-j23-original", expectedVersion: "revision-7",
    payload: { action: "move-clip", clipId: "clip-1", position: 31, marker: "private-payload-j23" },
  };
  const offline = await appFrame.evaluate(async (queuedEdit) => {
    await window.__workflowQueue.enqueue(queuedEdit);
    const coordinator = window.__workflowCoordinator({
      reauthorize: async () => { throw new Error("offline reconnect must not authorize"); },
      readProjectVersion: async () => { throw new Error("offline reconnect must not read version"); },
      applyEdit: async () => { throw new Error("offline reconnect must not dispatch"); },
    });
    return coordinator.reconnect(false);
  }, edit);
  assert.deepEqual(offline, { status: "OFFLINE", dirty: true });
  const encryptedRow = await appFrame.evaluate(async () => (await window.__workflowStore.list(window.__workflowScope))[0]);
  assert.equal(encryptedRow.state, "PENDING");
  assert.ok(encryptedRow.ciphertext.length > encryptedRow.payloadBytes, "ciphertext includes AES-GCM authentication overhead");
  assert.equal(new TextDecoder().decode(encryptedRow.ciphertext).includes("private-payload-j23"), false);
  assert.equal(Object.hasOwn(encryptedRow, "key"), false, "the edit store must not contain the host key");
  assert.equal(await appFrame.evaluate(() => window.parent.__hostHeldKey.extractable), false);
  const readEditProjection = async (frame) => frame.evaluate(async () => (await window.__workflowQueue.readEdits(window.__workflowScope))
    .map(({ edit: queued, state }) => ({
      edit: {
        tenantId: queued.tenantId, projectId: queued.projectId, editId: queued.editId,
        idempotencyKey: queued.idempotencyKey, expectedVersion: queued.expectedVersion,
        payload: queued.payload, state: queued.state,
      }, state,
    })));
  await appFrame.evaluate(() => window.__workflowStore.close());

  await appFrame.goto(`${origin}/app`);
  const reloadedApp = app();
  assert.ok(reloadedApp, "reloaded app frame must exist");
  await initializeWorkflow(reloadedApp);
  assert.equal(await reloadedApp.evaluate(() => window.parent.__hostHeldKey.extractable), false);
  assert.deepEqual(await readEditProjection(reloadedApp), [
    { edit: { ...edit, state: "PENDING" }, state: "PENDING" },
  ]);
  const reloadedEncryptedRow = await reloadedApp.evaluate(async () => (await window.__workflowStore.list(window.__workflowScope))[0]);
  assert.deepEqual([...reloadedEncryptedRow.nonce], [...encryptedRow.nonce]);
  assert.deepEqual([...reloadedEncryptedRow.ciphertext], [...encryptedRow.ciphertext]);

  const fixture = { authorizationReads: 0, versionReads: 0, applyCount: 0 };
  const conflict = await reloadedApp.evaluate(async (counts) => {
    window.__workflowFixture = counts;
    const result = await window.__workflowCoordinator({
      reauthorize: async (queued) => {
        counts.authorizationReads++;
        return { tenantId: queued.tenantId, projectId: queued.projectId, disposition: "AUTHORIZED" };
      },
      readProjectVersion: async (scope) => {
        counts.versionReads++;
        return { ...scope, disposition: "CURRENT", version: "revision-8" };
      },
      applyEdit: async () => { counts.applyCount++; throw new Error("stale version must not apply"); },
    }).reconnect(true);
    return { result, counts };
  }, fixture);
  assert.deepEqual(conflict.result, { status: "RECONNECTED", dirty: true, results: [{ editId: edit.editId, state: "CONFLICT" }] });
  assert.deepEqual(conflict.counts, { authorizationReads: 0, versionReads: 1, applyCount: 0 });
  assert.deepEqual(await readEditProjection(reloadedApp), [
    { edit: { ...edit, state: "CONFLICT" }, state: "CONFLICT" },
  ]);

  const rebasedEdit = {
    ...edit, idempotencyKey: "idem-j23-rebased", expectedVersion: "revision-8",
    payload: { ...edit.payload, position: 32 },
  };
  await reloadedApp.evaluate(async (queuedEdit) => window.__workflowQueue.resolveConflict(queuedEdit), rebasedEdit);
  const applied = await reloadedApp.evaluate(async (counts) => {
    const result = await window.__workflowCoordinator({
      reauthorize: async (queued) => {
        counts.authorizationReads++;
        return { tenantId: queued.tenantId, projectId: queued.projectId, disposition: "AUTHORIZED" };
      },
      readProjectVersion: async (scope) => {
        counts.versionReads++;
        return { ...scope, disposition: "CURRENT", version: "revision-8" };
      },
      applyEdit: async (queued) => {
        counts.applyCount++;
        return { ...queued, outcome: "APPLIED", receipt: "fixture-receipt-j23" };
      },
    }).reconnect(true);
    return { result, counts };
  }, conflict.counts);
  assert.deepEqual(applied.result, {
    status: "RECONNECTED", dirty: false,
    results: [{ editId: edit.editId, state: "APPLIED", receipt: "fixture-receipt-j23" }],
  });
  assert.deepEqual(applied.counts, { authorizationReads: 2, versionReads: 2, applyCount: 1 });
  const duplicateReconnect = await reloadedApp.evaluate(async (counts) => {
    const result = await window.__workflowCoordinator({
      reauthorize: async (queued) => {
        counts.authorizationReads++;
        return { tenantId: queued.tenantId, projectId: queued.projectId, disposition: "AUTHORIZED" };
      },
      readProjectVersion: async (scope) => {
        counts.versionReads++;
        return { ...scope, disposition: "CURRENT", version: "revision-8" };
      },
      applyEdit: async () => { counts.applyCount++; throw new Error("terminal edit must not apply twice"); },
    }).reconnect(true);
    return { result, counts };
  }, applied.counts);
  assert.deepEqual(duplicateReconnect.result, { status: "RECONNECTED", dirty: false, results: [] });
  assert.deepEqual(duplicateReconnect.counts, { authorizationReads: 2, versionReads: 2, applyCount: 1 });
  assert.deepEqual(await readEditProjection(reloadedApp), [
    { edit: { ...rebasedEdit, state: "APPLIED" }, state: "APPLIED" },
  ]);
  await reloadedApp.evaluate(() => window.__workflowStore.close());
  await workflowContext.close();
  console.log("PASS: real IndexedDB and AES-GCM queue survive app-frame reload with a host-held non-extractable key; stale version conflicts before authorization and without dispatch; explicit fresh-key rebase performs fresh authorization and reconnects to fixture APPLIED once.");
} finally {
  await browser?.close();
}
