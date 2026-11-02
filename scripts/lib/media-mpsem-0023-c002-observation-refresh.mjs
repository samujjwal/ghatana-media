import { createHash } from "node:crypto";

export const OWNER_CANDIDATE_PATH = "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json";
export const OPERATION_PARITY_PATH = ".product-experience/interface-parity/operation-parity.yaml";

const CLAIM_ID = "MPSEM-0023-C002";
const TARGET_REF = `${OPERATION_PARITY_PATH}#compatibilityRouteFindings/currentComparison`;
const PENDING = "PENDING_COORDINATOR_MATERIAL_REVIEW";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const targetDigest = (value) => sha256(typeof value === "string" ? value : JSON.stringify(value));

function requireInvariant(condition, message) {
  if (!condition) throw new Error(`MPSEM-0023-C002 observation refresh refused: ${message}`);
}

/**
 * Refreshes only the live whole-file digest for the existing pending C002
 * observation. Historical target pins and the separately recorded live target
 * drift are preserved. This cannot promote semantic parity or acceptance.
 */
export function refreshMpsem0023C002Observation({ candidate, sourceText, operationParity, routeManifest }) {
  requireInvariant(candidate && Array.isArray(candidate.records), "candidate records are missing");
  requireInvariant(typeof sourceText === "string", "owner source text is missing");
  requireInvariant(operationParity?.compatibilityRouteFindings, "compatibility route findings are missing");
  requireInvariant(Array.isArray(routeManifest?.routes), "current route manifest is missing");

  const matches = candidate.records.filter((record) => record.claimId === CLAIM_ID);
  requireInvariant(matches.length === 1, "expected exactly one candidate claim");
  const row = matches[0];
  const observation = row.currentProposalObservation;
  const drift = observation?.currentValueDriftObservation;
  const findings = operationParity.compatibilityRouteFindings.sourceFindings;
  const routes = routeManifest.routes;
  requireInvariant(Array.isArray(findings) && findings.length > 0, "source findings are empty");
  requireInvariant(observation?.status === PENDING, "candidate observation is not pending material review");
  requireInvariant(row.semanticDisposition === "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED",
    "claim disposition changed from not-yet-verified");
  requireInvariant(row.targetSnapshotStatus === "LIVE_OBSERVATION_UNREVIEWED",
    "target snapshot is not marked unreviewed");
  requireInvariant(row.ownerSemanticReview?.acceptanceEffect === "none"
    && row.ownerSemanticReview?.runtimeStatus === "NOT_EVALUATED",
  "owner review already carries an acceptance or runtime effect");
  requireInvariant(drift?.status === PENDING && drift?.ref === TARGET_REF,
    "current target drift is missing or no longer pending");

  const currentValue = operationParity.compatibilityRouteFindings.currentComparison;
  const expectedValue = `${findings.length}-of-${findings.length} observed legacy/candidate SDK paths are absent from the ${routes.length}-route active manifest; this proves non-admission and does not choose a replacement route.`;
  requireInvariant(currentValue === expectedValue, "source summary does not match the live finding and route counts");
  const missing = findings.filter(({ method, path }) =>
    !routes.some((route) => route.method === method && route.path === path));
  requireInvariant(missing.length === findings.length,
    "at least one observed SDK path is present in the current manifest; semantic review is required");

  const liveValueDigest = targetDigest(currentValue);
  requireInvariant(drift.observedTargetValueSha256 === liveValueDigest,
    "the selected target value changed since its pending material observation");
  requireInvariant(drift.observedTargetValuePreview === currentValue,
    "the selected target preview changed since its pending material observation");
  requireInvariant(drift.recordedTargetValueSha256 === observation.currentTargetValueSha256,
    "historical target pin and pending drift record do not align");
  requireInvariant(observation.priorTargetValueSha256 === row.currentTargetValueSha256,
    "historical candidate target pin changed");

  const currentSourceDigest = sha256(sourceText);
  if (observation.currentSourceFileSha256 === currentSourceDigest) {
    return { candidate, changed: false, sourceSha256: currentSourceDigest, targetSha256: liveValueDigest };
  }

  const supersededSourceDigest = observation.currentSourceFileSha256;
  requireInvariant(/^[a-f0-9]{64}$/u.test(supersededSourceDigest ?? ""),
    "current source digest is malformed");
  const history = Array.isArray(observation.sourceFileSha256History)
    ? observation.sourceFileSha256History
    : [];
  requireInvariant(history.length === 0 || history.at(-1) === observation.supersededCurrentSourceFileSha256,
    "source digest history does not end at the recorded predecessor");

  observation.previousCurrentSourceFileSha256 = supersededSourceDigest;
  observation.supersededCurrentSourceFileSha256 = supersededSourceDigest;
  observation.sourceFileSha256History = [...history];
  if (observation.sourceFileSha256History.at(-1) !== supersededSourceDigest) {
    observation.sourceFileSha256History.push(supersededSourceDigest);
  }
  observation.currentSourceFileSha256 = currentSourceDigest;
  observation.reason = `${observation.reason} Current owner-source bytes were re-observed by the narrow C002 refresh; the pending live target value remains unchanged.`;

  requireInvariant(observation.status === PENDING
    && row.semanticDisposition === "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED"
    && row.targetSnapshotStatus === "LIVE_OBSERVATION_UNREVIEWED"
    && row.ownerSemanticReview.acceptanceEffect === "none"
    && row.ownerSemanticReview.runtimeStatus === "NOT_EVALUATED"
    && drift.status === PENDING && drift.acceptanceEffect === "none",
  "refresh would not preserve the pending, non-admitted disposition");

  return { candidate, changed: true, sourceSha256: currentSourceDigest, targetSha256: liveValueDigest };
}

export function digestMpsemObservationValue(value) {
  return targetDigest(value);
}
