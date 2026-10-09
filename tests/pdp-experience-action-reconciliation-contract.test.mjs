import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const contract = parse(await readFile(".product-experience/pdp-3-product-experience/action-reconciliation-contracts.yaml", "utf8"));
const ports = await readFile("libs/audio-video-ui/src/ports/index.ts", "utf8");
const guard = await readFile("libs/audio-video-ui/src/screens/MediaActionDispatchGuard.ts", "utf8");
const localAllowlistSource = await readFile("libs/audio-video-ui/src/screens/MediaLocalActionContracts.ts", "utf8");
const source = contract.records.find((row) => row.id === "media.pdp3.action-reconciliation.host-projection.v1");

test("action reconciliation contract is definition-only and covers exact host port identities", () => {
  assert.ok(source);
  assert.equal(contract.authorityStatus, "MEDIA_OWNER_LOGICAL_HOST_ADAPTER_DEFINITION_ONLY");
  assert.equal(source.runtimeAdmission, "NOT_ADMITTED");
  for (const name of ["MediaActionPort", "MediaActionDispatchContext", "MediaActionDispatchResult", "MediaActionReconciliation", "canonicalMediaActionRequest"]) {
    assert.match(ports, new RegExp(`(?:type|interface|function) ${name}\\b`, "u"), `${name} exists in the exact public port source`);
    assert.ok(source.sourcePortRefs.some((ref) => ref.endsWith(`#${name}`)), `${name} has a source pointer`);
  }
  for (const disposition of ["pending", "unknown", "effect-resolved", "retry-authorized"]) {
    assert.ok(Object.hasOwn(source.reconciliation.dispositions, disposition));
  }
  assert.match(guard, /baselineRevisions/u);
  assert.match(guard, /sameReconciliationIdentity/u);
  assert.match(guard, /record\.reconciliationRevision/u);
  assert.match(guard, /MEDIA_LOCAL_ACTION_IDS\.has\(actionId\)/u);
});

test("local immediate finality allowlist is explicit and consequential/unknown outcomes remain reconciled", () => {
  const ids = [...localAllowlistSource.matchAll(/^\s+"(media\.action\.[^"]+)"[,]?$/gmu)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(source.dispatchResultSemantics["local-applied"].includes("exact action id is in the source local-action allowlist"), true);
  assert.match(source.dispatchResultSemantics.failed, /outcome-unknown/u);
  assert.match(source.reconciliation.expiry, /elapsed local time never authorizes retry/u);
  assert.equal(source.notEstablished.includes("canonical backend persistence or effect finality"), true);
});
