import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const addFormats = require("ajv-formats");
import { validateCurrentErasureInventoryObservation, validateCurrentErasureHoldObservation, validateCurrentErasureRestoreReplay } from "../scripts/lib/pdp1-erasure-inventory-definition.mjs";
const privacy = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/privacy.yaml"), "utf8"));
const domainObjects = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/domain-objects.yaml"), "utf8"));
const authority = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/authority.yaml"), "utf8"));
const contract = privacy.ownerDefinedErasureInventoryContract;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addFormat("date-time", {
  type: "string",
  validate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value);
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  },
});
ajv.addSchema(privacy, "media-privacy-source");
const valid = (schema) => ajv.compile(schema);
const requiredRef = (path) => assert.ok(path && typeof path === "string" && path.includes("#"), `exact selector: ${path}`);
const resolveExact = (ref) => {
  const hash = ref.indexOf("#");
  assert.ok(hash > 0, `file-scoped selector required: ${ref}`);
  const sourcePath = ref.slice(0, hash);
  const fragment = ref.slice(hash + 1);
  const sources = {
    ".product-experience/pdp-1-domain-data/privacy.yaml": privacy,
    ".product-experience/pdp-1-domain-data/domain-objects.yaml": domainObjects,
    ".product-experience/pdp-1-domain-data/authority.yaml": authority,
  };
  let value = sources[sourcePath];
  assert.ok(value, `source loaded: ${sourcePath}`);
  for (const part of fragment.replace(/^\//u, "").split("/")) {
    const keyed = /^@(id|machineId|capabilityRef)=(.+)$/u.exec(part);
    if (keyed) {
      assert.ok(Array.isArray(value), `identity selector traverses an array: ${ref}`);
      const matches = value.filter((row) => row?.[keyed[1]] === keyed[2]);
      assert.equal(matches.length, 1, `selector has one exact identity match: ${ref}`);
      [value] = matches;
    } else value = Array.isArray(value) && /^\d+$/u.test(part) ? value[Number(part)] : value?.[part];
    assert.notEqual(value, undefined, `selector resolves: ${ref}`);
  }
  return value;
};

test("Media erasure inventory, hold, tombstone, and replay definitions resolve exact owner sources", () => {
  assert.equal(contract.id, "media.privacy.erasure-inventory-and-tombstone.v1");
  assert.equal(contract.scopeStatus, "OWNER_DEFINED_DEFINITION_ONLY");
  assert.equal(privacy.retentionAndErasure.status, "proposal-only; policy-and-storage-owner-approval-pending");
  assert.equal(privacy.retentionAndErasure.notEstablished.includes("complete-inventory-of-primary-replica-backup-cache-export-and-provider-held-copies"), true);
  for (const ref of contract.sourceRefs) { requiredRef(ref); assert.notEqual(resolveExact(ref), undefined); }
  assert.deepEqual(contract.copyInventory.requiredCopyClasses, ["PRIMARY", "REPLICA", "DERIVED_ARTIFACT", "CACHE", "EXPORT", "BACKUP_SNAPSHOT", "EXTERNAL_PROVIDER_COPY"]);
  assert.deepEqual(contract.copyInventory.managedContentClasses.classes, [
    "ORIGINAL_MEDIA", "DERIVED_MEDIA", "THUMBNAIL", "PROXY", "CAPTION", "TRANSCRIPT",
    "MASK_OR_GEOMETRY", "EMBEDDING", "VOICE_MODEL", "SOURCE_REQUEST", "TEMPORARY_FILE",
    "CACHED_INTERMEDIATE", "EXPORT", "EXTERNAL_PROVIDER_COPY", "BACKUP", "AUDIT_OR_PROVENANCE",
  ]);
  assert.deepEqual(contract.erasureFinality.states, ["REQUESTED", "ACCESS_RESTRICTED", "DELETION_PENDING", "PARTIALLY_ERASED", "ERASURE_CONFIRMED", "ERASURE_BLOCKED_BY_HOLD", "ERASURE_OUTCOME_UNKNOWN"]);
  assert.match(contract.tombstones.restoreRule, /Before restored data becomes readable or dispatchable/u);
  assert.match(contract.erasureFinality.externalProviderRule, /never proves remote\/provider-side erasure/u);
  assert.equal(contract.erasureFinality.independentProofBoundary.includes("does not establish that deployment storage inventories are complete"), true);
});

test("copy inventory entries have a closed typed scope and evidence requirement", () => {
  const schema = contract.copyInventory.observationSchema.$defs.copyInventoryEntry;
  const check = valid(schema);
  const copy = {
    copyRef: "copy:tenant-a:artifact-v7:primary",
    tenantRef: "tenant:tenant-a",
    objectRef: "media.domain.artifact",
    artifactVersionRef: "artifact-version:v7",
    storageOwnerRef: "media.storage.primary",
    contentClass: "ORIGINAL_MEDIA",
    copyClass: "PRIMARY",
    retentionRuleRef: "media.retention.policy.pending-review",
    copyDisposition: "PRESENT",
    evidenceRefs: ["evidence:owner-inventory-17"],
  };
  assert.equal(check(copy), true);
  for (const invalid of [
    { ...copy, tenantRef: "  " },
    { ...copy, copyClass: "UNKNOWN_STORE" },
    { ...copy, evidenceRefs: [] },
    { ...copy, callerSaysDeleted: true },
    Object.fromEntries(Object.entries(copy).filter(([key]) => key !== "artifactVersionRef")),
  ]) assert.equal(check(invalid), false);
});

test("inventory observations bind exact subject and current read tuple", () => {
  const check = valid(contract.copyInventory.observationSchema);
  const observation = {
    tenantRef: "tenant:tenant-a",
    objectRef: "media.domain.artifact",
    artifactVersionRef: "artifact-version:v7",
    inventoryStatus: "COMPLETE",
    readAuthorityRef: "media.storage.inventory-reader.v1",
    readVersionRef: "inventory-revision:17",
    observedAt: "2026-10-09T12:00:00Z",
    copyEntries: [{
      copyRef: "copy:tenant-a:artifact-v7:primary",
      tenantRef: "tenant:tenant-a",
      objectRef: "media.domain.artifact",
      artifactVersionRef: "artifact-version:v7",
    storageOwnerRef: "media.storage.primary",
    contentClass: "ORIGINAL_MEDIA",
    copyClass: "PRIMARY",
      retentionRuleRef: "media.retention.policy.pending-review",
      copyDisposition: "PRESENT",
      evidenceRefs: ["evidence:owner-inventory-17"],
    }],
    evidenceRefs: ["evidence:inventory-read-17"],
  };
  assert.equal(check(observation), true);
  const expected = {
    tenantRef: "tenant:tenant-a",
    objectRef: "media.domain.artifact",
    artifactVersionRef: "artifact-version:v7",
    readAuthorityRef: "media.storage.inventory-reader.v1",
    readVersionRef: "inventory-revision:17",
    now: "2026-10-09T12:01:00Z",
  };
  assert.equal(validateCurrentErasureInventoryObservation(observation, expected), true,
    "a well-typed exact current owner tuple is accepted by the definition oracle");
  for (const [label, invalid] of [
    ["undeclared inventory status", { ...observation, inventoryStatus: "COMPLETE_WITH_GUESSED_COPIES" }],
    ["impossible calendar date", { ...observation, observedAt: "2026-02-30T12:00:00Z" }],
    ["missing read version", { ...observation, readVersionRef: "" }],
    ["caller currentness assertion", { ...observation, callerCurrent: true }],
  ]) {
    assert.equal(check(invalid), false, label);
    assert.equal(validateCurrentErasureInventoryObservation(invalid, expected), false, `${label} fails closed in the owner oracle`);
  }
  const foreignTenantCopy = { ...observation, copyEntries: [{ ...observation.copyEntries[0], tenantRef: "tenant:other" }] };
  assert.equal(check(foreignTenantCopy), true, "schema alone permits a structurally valid copy; tenant membership is a cross-record rule");
  assert.equal(validateCurrentErasureInventoryObservation(foreignTenantCopy, expected), false,
    "the definition oracle rejects a copy outside the trusted tenant scope");
  assert.equal(validateCurrentErasureInventoryObservation(observation, { ...expected, now: "2026-02-30T12:00:00Z" }), false,
    "invalid trusted clock values cannot establish currentness");
  assert.equal(validateCurrentErasureInventoryObservation(observation, { ...expected, readVersionRef: "inventory-revision:old" }), false,
    "a stale inventory revision is rejected");
});

test("hold and restore receipts require exact current scoped authority and deny malformed evidence", () => {
  const holdCheck = valid(contract.holds.observationSchema);
  const hold = {
    holdRef: "hold:legal-1",
    issuerAuthorityRef: "media.authority.legal-hold-reader.v1",
    tenantRef: "tenant:tenant-a",
    objectRef: "media.domain.artifact",
    artifactVersionRef: "artifact-version:v7",
    purposeRef: "purpose:erasure-review",
    disposition: "ACTIVE",
    issuedAt: "2026-10-01T00:00:00Z",
    validUntilExclusive: "2027-01-01T00:00:00Z",
    readAuthorityRef: "media.authority.legal-hold-reader.v1",
    readVersionRef: "hold-revision:9",
    observedAt: "2026-10-09T12:00:00Z",
    evidenceRefs: ["evidence:hold-read-9"],
  };
  assert.equal(holdCheck(hold), true);
  const holdExpected = {
    tenantRef: hold.tenantRef, objectRef: hold.objectRef, artifactVersionRef: hold.artifactVersionRef,
    readAuthorityRef: hold.readAuthorityRef, readVersionRef: hold.readVersionRef, issuerAuthorityRef: hold.issuerAuthorityRef,
    purposeRef: hold.purposeRef, now: "2026-10-09T12:01:00Z",
  };
  assert.equal(validateCurrentErasureHoldObservation(hold, holdExpected), true);
  assert.equal(holdCheck({ ...hold, validUntilExclusive: "2026-02-30T00:00:00Z" }), false);
  assert.equal(holdCheck({ ...hold, objectRef: "" }), false);
  assert.equal(validateCurrentErasureHoldObservation(hold, { ...holdExpected, tenantRef: "tenant:other" }), false);
  assert.equal(validateCurrentErasureHoldObservation(hold, { ...holdExpected, now: "2027-01-01T00:00:00Z" }), false,
    "hold validity ends exclusively");

  const replayCheck = valid(contract.tombstones.restoreReplaySchema);
  const replay = {
    tombstoneRef: "tombstone:erase-31",
    tenantRef: "tenant:tenant-a",
    objectRef: "media.domain.artifact",
    artifactVersionRef: "artifact-version:v7",
    copyRef: "copy:tenant-a:artifact-v7:backup-1",
    replayDisposition: "REPLAYED",
    restoreAuthorityRef: "media.storage.restore-reader.v1",
    restoreRevisionRef: "restore-revision:22",
    observedAt: "2026-10-09T12:00:00Z",
    evidenceRefs: ["evidence:tombstone-replay-22"],
  };
  assert.equal(replayCheck(replay), true);
  const replayExpected = {
    tenantRef: replay.tenantRef, objectRef: replay.objectRef, artifactVersionRef: replay.artifactVersionRef,
    tombstoneRef: replay.tombstoneRef, copyRef: replay.copyRef, restoreAuthorityRef: replay.restoreAuthorityRef,
    restoreRevisionRef: replay.restoreRevisionRef, now: "2026-10-09T12:01:00Z",
  };
  assert.equal(validateCurrentErasureRestoreReplay(replay, replayExpected), true);
  assert.equal(replayCheck({ ...replay, tenantRef: "" }), false);
  assert.equal(replayCheck({ ...replay, replayDisposition: "ERASURE_CONFIRMED" }), false);
  assert.equal(replayCheck({ ...replay, evidenceRefs: [] }), false);
  assert.equal(validateCurrentErasureRestoreReplay(replay, { ...replayExpected, copyRef: "copy:foreign" }), false);
});
