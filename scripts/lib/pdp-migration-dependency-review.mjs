import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const materialText = (value) => typeof value === "string" ? value : JSON.stringify(value);

/**
 * Validate an authored dependency-claim review row against the exact owner
 * value and the coordinator's fixed cohort expectation. This checks source
 * identity and claim text, semantic predicates, target pin, and acceptance
 * boundaries; it does not accept the claim or a product phase.
 */
export function validateMigrationClaimReview({ claim, expectedTargetRef, targetValue, requiredPredicates }) {
  const errors = [];
  if (!claim || typeof claim.claimId !== "string") errors.push("missing-claim-identity");
  if (claim && sha256(claim.exactSourceText ?? "") !== claim.sourceTextSha256) errors.push("source-text-digest-mismatch");
  if (claim?.targetRef !== expectedTargetRef) errors.push("wrong-owner-target");
  const text = materialText(targetValue);
  if (claim && sha256(text) !== claim.targetTextSha256) errors.push("owner-target-digest-mismatch");
  for (const predicate of requiredPredicates ?? []) {
    if (!text.includes(predicate)) errors.push(`missing-material-predicate:${predicate}`);
  }
  if (claim?.acceptanceEffect !== "none") errors.push("acceptance-effect-must-remain-none");
  if (/PHASE_ACCEPTED|INDEPENDENT_ACCEPTED|RECEIPT_ISSUED/u.test(claim?.semanticReviewStatus ?? "")) {
    errors.push("forged-independent-or-phase-acceptance");
  }
  return { valid: errors.length === 0, errors };
}

export function validateMigrationClaimCohort({ claims, expectedTargets, resolveRef, predicatesByClaim }) {
  const byId = new Map();
  const errors = [];
  for (const claim of claims) {
    if (byId.has(claim.claimId)) errors.push(`duplicate-claim:${claim.claimId}`);
    byId.set(claim.claimId, claim);
  }
  if (byId.size !== expectedTargets.size) errors.push("claim-population-does-not-match-fixed-cohort");
  const results = new Map();
  for (const [claimId, expectedTargetRef] of expectedTargets) {
    const claim = byId.get(claimId);
    if (!claim) {
      errors.push(`missing-claim:${claimId}`);
      continue;
    }
    const result = validateMigrationClaimReview({
      claim,
      expectedTargetRef,
      targetValue: resolveRef(expectedTargetRef),
      requiredPredicates: predicatesByClaim.get(claimId) ?? [],
    });
    results.set(claimId, result);
    for (const error of result.errors) errors.push(`${claimId}:${error}`);
  }
  return { valid: errors.length === 0, errors, results };
}
