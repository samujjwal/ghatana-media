import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const moduleUrl = new URL("../dist/indexeddb-offline-edit-store.js", import.meta.url);
const moduleSource = await readFile(moduleUrl, "utf8");
const databaseName = `offline-edit-browser-${randomUUID()}`;
const origin = "https://offline-edit.test";
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/indexeddb-offline-edit-store.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", body: moduleSource });
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
  console.log("PASS: two browser pages share IndexedDB; cross-page CAS has one winner; close/reopen/reload preserves exact scoped record and ciphertext bytes.");
} finally {
  await browser?.close();
}
