import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../../../ghatana-tools/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { parse } = require("yaml");
const privacy = parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/privacy.yaml"), "utf8"));
const contract = privacy.ownerDefinedErasureInventoryContract;

const validInstant = (value) => {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
const exact = (left, right) => typeof left === "string" && nonblank(left) && left === right;
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addFormat("date-time", { type: "string", validate: validInstant });
const inventoryObservationIsValid = ajv.compile(contract.copyInventory.observationSchema);
const holdObservationIsValid = ajv.compile(contract.holds.observationSchema);
const restoreReplayIsValid = ajv.compile(contract.tombstones.restoreReplaySchema);
const copyClassCoverageIsValid = ajv.compile(contract.copyInventory.observationSchema.$defs.copyClassCoverage);
const holdAssessmentIsValid = ajv.compile(contract.erasureFinality.outcomeClassifier.holdAssessmentSchema);
const restorePathIsValid = ajv.compile(contract.erasureFinality.outcomeClassifier.restorePathSchema);
const currentReadReceiptIsValid = ajv.compile(contract.erasureFinality.outcomeClassifier.currentReadReceiptSchema);
const tombstoneRecordIsValid = ajv.compile(contract.tombstones.recordSchema);
const restorePathInventoryIsValid = ajv.compile(contract.erasureFinality.outcomeClassifier.restorePathInventorySchema);

function validateCurrentTuple(observation, expected) {
  if (!expected || !validInstant(expected.now)) return false;
  if (!exact(observation.tenantRef, expected.tenantRef)
    || !exact(observation.objectRef, expected.objectRef)
    || !exact(observation.artifactVersionRef, expected.artifactVersionRef)
    || !exact(observation.readAuthorityRef, expected.readAuthorityRef)
    || !exact(observation.readVersionRef, expected.readVersionRef)
    || !validInstant(observation.observedAt)) return false;
  return Date.parse(observation.observedAt) <= Date.parse(expected.now);
}

/** Definition oracle only: validate a host-supplied current inventory tuple; no runtime reader is implied. */
export function validateCurrentErasureInventoryObservation(observation, expected) {
  if (!inventoryObservationIsValid(observation) || !validateCurrentTuple(observation, expected)) return false;
  const copyRefs = new Set();
  for (const copy of observation.copyEntries) {
    if (!exact(copy.tenantRef, expected.tenantRef) || !exact(copy.objectRef, expected.objectRef)
      || !exact(copy.artifactVersionRef, expected.artifactVersionRef) || copyRefs.has(copy.copyRef)) return false;
    copyRefs.add(copy.copyRef);
  }
  return true;
}

/** Definition oracle only: a hold observation must match trusted subject/read scope and current source authority. */
export function validateCurrentErasureHoldObservation(observation, expected) {
  return Boolean(holdObservationIsValid(observation)
    && validateCurrentTuple(observation, expected)
    && exact(observation.issuerAuthorityRef, expected.issuerAuthorityRef)
    && exact(observation.purposeRef, expected.purposeRef)
    && validInstant(observation.issuedAt)
    && validInstant(observation.validUntilExclusive)
    && Date.parse(observation.issuedAt) <= Date.parse(observation.observedAt)
    && Date.parse(observation.observedAt) <= Date.parse(expected.now)
    && Date.parse(expected.now) < Date.parse(observation.validUntilExclusive));
}

/** Definition oracle only: restored-copy replay cannot cross tenant/object/version/tombstone identity. */
export function validateCurrentErasureRestoreReplay(observation, expected) {
  return Boolean(restoreReplayIsValid(observation)
    && exact(observation.tenantRef, expected?.tenantRef)
    && exact(observation.objectRef, expected?.objectRef)
    && exact(observation.artifactVersionRef, expected?.artifactVersionRef)
    && exact(observation.tombstoneRef, expected?.tombstoneRef)
    && exact(observation.restorePathRef, expected?.restorePathRef)
    && exact(observation.copyRef, expected?.copyRef)
    && exact(observation.restoreAuthorityRef, expected?.restoreAuthorityRef)
    && exact(observation.restoreRevisionRef, expected?.restoreRevisionRef)
    && validInstant(expected?.now)
    && Date.parse(observation.observedAt) <= Date.parse(expected.now));
}

const sameSubject = (value, expected) => exact(value?.tenantRef, expected?.tenantRef)
  && exact(value?.objectRef, expected?.objectRef)
  && exact(value?.artifactVersionRef, expected?.artifactVersionRef);
const uniqueBy = (values, key) => values.length === new Set(values.map((value) => value[key])).size;
const sameStringSet = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && new Set(left).size === left.length
  && left.every((value) => right.includes(value));

/** Definition oracle only: classify erasure evidence; true from a shape validator never means erased. */
export function classifyErasureOutcome(input) {
  const unknown = (reason) => ({ disposition: "ERASURE_OUTCOME_UNKNOWN", reason });
  const partial = (reason) => ({ disposition: "PARTIALLY_ERASED", reason });
  if (!input || !input.expected || !input.inventory || !input.holdAssessment) return unknown("required current evidence is missing");
  const { expected, inventory, holdAssessment, restorePathInventory, restorePaths = [], restoreReplays = [], currentReadReceipt, tombstoneRecord } = input;
  if (!validateCurrentErasureInventoryObservation(inventory, expected)) return unknown("inventory tuple is malformed or does not match the expected subject/read");
  if (!holdAssessmentIsValid(holdAssessment) || !sameSubject(holdAssessment, expected)) return unknown("hold assessment is malformed or does not match the expected subject");
  if (!tombstoneRecordIsValid(tombstoneRecord) || !sameSubject(tombstoneRecord, expected)
    || !exact(tombstoneRecord.tombstoneRef, input.tombstoneRef)
    || !sameStringSet(tombstoneRecord.copyRefs, inventory.copyEntries.map(({ copyRef }) => copyRef))) {
    return unknown("exact tombstone record, durable revision, or affected copy set is missing or mismatched");
  }
  if (!restorePathInventoryIsValid(restorePathInventory) || !sameSubject(restorePathInventory, expected)) return unknown("restore-path inventory is missing or does not match the expected subject");
  if (!Array.isArray(restorePaths) || !Array.isArray(restoreReplays) || !restorePaths.every(restorePathIsValid)) return unknown("restore-path evidence is malformed");
  if (!currentReadReceiptIsValid(currentReadReceipt) || !sameSubject(currentReadReceipt, expected)
    || !exact(currentReadReceipt.decisionBoundaryRef, expected.decisionBoundaryRef)
    || !exact(currentReadReceipt.inventoryRead.readAuthorityRef, inventory.readAuthorityRef)
    || !exact(currentReadReceipt.inventoryRead.readVersionRef, inventory.readVersionRef)
    || !exact(currentReadReceipt.holdRead.readAuthorityRef, holdAssessment.readAuthorityRef)
    || !exact(currentReadReceipt.holdRead.readVersionRef, holdAssessment.readVersionRef)
    || !exact(currentReadReceipt.tombstoneRead.tombstoneRef, tombstoneRecord.tombstoneRef)
    || !exact(currentReadReceipt.tombstoneRead.durableStoreRevision, tombstoneRecord.durableStoreRevision)
    || !exact(currentReadReceipt.restorePathInventoryRead.readAuthorityRef, restorePathInventory.readAuthorityRef)
    || !exact(currentReadReceipt.restorePathInventoryRead.readVersionRef, restorePathInventory.readVersionRef)) {
    return unknown("host current-read receipt is absent or not bound to this subject and irreversible decision boundary");
  }
  const declaredPathRefs = restorePaths.map(({ restorePathRef }) => restorePathRef);
  if (restorePathInventory.status === "UNKNOWN") return unknown("restore-path inventory status is unknown");
  if (restorePathInventory.status !== "COMPLETE") return partial("restore-path inventory is incomplete");
  if ((restorePathInventory.disposition === "OWNER_CONFIRMED_NONE" && declaredPathRefs.length !== 0)
    || (restorePathInventory.disposition === "PATHS_ENUMERATED" && declaredPathRefs.length === 0)
    || !sameStringSet(restorePathInventory.pathRefs, declaredPathRefs)) {
    return unknown("restore-path coverage contradicts the declared restore paths");
  }
  if (!uniqueBy(restorePaths, "restorePathRef") || !uniqueBy(currentReadReceipt.restorePathReads, "restorePathRef")) return unknown("restore-path identities are duplicated");
  const expectedRestoreReads = restorePaths.map(({ restorePathRef, restoreAuthorityRef, restoreRevisionRef }) => ({
    restorePathRef, readAuthorityRef: restoreAuthorityRef, readVersionRef: restoreRevisionRef,
  }));
  if (JSON.stringify([...currentReadReceipt.restorePathReads].sort((a, b) => a.restorePathRef.localeCompare(b.restorePathRef)))
    !== JSON.stringify([...expectedRestoreReads].sort((a, b) => a.restorePathRef.localeCompare(b.restorePathRef)))) {
    return unknown("host current-read receipt does not bind exactly the declared restore-path reads");
  }
  if (holdAssessment.disposition === "ACTIVE") {
    return holdAssessment.holdRefs.length > 0
      ? { disposition: "ERASURE_BLOCKED_BY_HOLD", reason: "a current exact-scope legal hold blocks physical erasure" }
      : unknown("active hold assessment has no exact hold identity");
  }
  if (holdAssessment.disposition === "UNKNOWN") return unknown("hold status is unknown");
  if (holdAssessment.disposition === "RELEASED" && holdAssessment.holdRefs.length === 0) return unknown("released hold assessment has no exact hold identities");
  if (holdAssessment.disposition === "NOT_APPLICABLE" && holdAssessment.holdRefs.length !== 0) return unknown("not-applicable hold assessment lists hold identities");
  const requiredClasses = contract.copyInventory.requiredCopyClasses;
  const coverage = inventory.copyClassCoverage;
  if (!Array.isArray(coverage) || !coverage.every(copyClassCoverageIsValid)
    || !uniqueBy(coverage, "copyClass") || !sameStringSet(coverage.map(({ copyClass }) => copyClass), requiredClasses)) {
    return inventory.inventoryStatus === "PARTIAL" ? partial("inventory lacks exact owner evidence for every required copy class")
      : unknown("inventory lacks exact owner evidence for every required copy class");
  }
  if (inventory.inventoryStatus === "UNKNOWN") return unknown("inventory completeness is unknown");
  if (inventory.inventoryStatus !== "COMPLETE") return partial("inventory is not complete");
  const copyRefs = inventory.copyEntries.map(({ copyRef }) => copyRef);
  if (!uniqueBy(inventory.copyEntries, "copyRef")) return unknown("inventory repeats a copy identity");
  for (const row of coverage) {
    const entries = inventory.copyEntries.filter(({ copyClass }) => copyClass === row.copyClass);
    if ((row.disposition === "COPIES_ENUMERATED" && entries.length === 0)
      || (row.disposition === "OWNER_CONFIRMED_EMPTY" && entries.length !== 0)) return unknown(`copy-class coverage contradicts entries for ${row.copyClass}`);
  }
  const nonFinal = inventory.copyEntries.filter(({ copyDisposition }) => !["DELETED", "OWNER_CONFIRMED_ABSENT"].includes(copyDisposition));
  if (nonFinal.some(({ copyDisposition }) => copyDisposition === "DELETION_UNKNOWN")) return unknown("at least one declared copy has unknown deletion outcome");
  if (nonFinal.length > 0) return partial("at least one declared copy is present or deletion remains pending");
  const expectedPairs = restorePaths.flatMap((path) => path.copyRefs.map((copyRef) => ({ path, copyRef })));
  if (expectedPairs.some(({ copyRef }) => !copyRefs.includes(copyRef))) return unknown("restore path references a copy outside the current inventory");
  if (restoreReplays.length !== expectedPairs.length) return unknown("restore replay evidence does not cover every declared restore-path/copy pair");
  const replayKeys = new Set();
  for (const pair of expectedPairs) {
    const replay = restoreReplays.find((row) => row.restorePathRef === pair.path.restorePathRef && row.copyRef === pair.copyRef);
    const key = `${pair.path.restorePathRef}\u0000${pair.copyRef}`;
    if (!replay || replayKeys.has(key)) return unknown("restore replay evidence is missing or duplicated");
    replayKeys.add(key);
    if (!validateCurrentErasureRestoreReplay(replay, {
      tenantRef: expected.tenantRef, objectRef: expected.objectRef, artifactVersionRef: expected.artifactVersionRef,
      tombstoneRef: tombstoneRecord.tombstoneRef, restorePathRef: pair.path.restorePathRef, copyRef: pair.copyRef,
      restoreAuthorityRef: pair.path.restoreAuthorityRef, restoreRevisionRef: pair.path.restoreRevisionRef, now: expected.now,
    }) || !["REPLAYED", "NOT_RESTORED"].includes(replay.replayDisposition)) return unknown("restore replay is stale, mismatched, or unknown");
  }
  return { disposition: "ERASURE_CONFIRMED", reason: "all required exact-scope owner evidence is current at the irreversible decision boundary" };
}
