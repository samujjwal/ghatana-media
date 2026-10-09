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
    && exact(observation.copyRef, expected?.copyRef)
    && exact(observation.restoreAuthorityRef, expected?.restoreAuthorityRef)
    && exact(observation.restoreRevisionRef, expected?.restoreRevisionRef)
    && validInstant(expected?.now)
    && Date.parse(observation.observedAt) <= Date.parse(expected.now));
}
