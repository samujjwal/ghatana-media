const DECISION_PREFIX = ".product-experience/pdp-1-domain-data/state-adjudication.yaml#/ownerAcceptedPolicyDecisions/";
const EXPECTED_DECISION_KEYS = new Map([
  ["MEDIA-DOMAIN-RULE-001", "machineScopedStateIdentity"],
  ["MEDIA-DOMAIN-RULE-002", "requestReceiptIsQueuedJob"],
  ["MEDIA-DOMAIN-RULE-003", "unknownOutcomeRule"],
  ["MEDIA-DOMAIN-RULE-004", "completedRule"],
  ["MEDIA-DOMAIN-RULE-005", "cancelledRule"],
  ["MEDIA-DOMAIN-RULE-006", "partialSuccessRule"],
]);

export function resolveAcceptedDomainRuleRecords(records, ownerDecisions) {
  if (!Array.isArray(records) || !ownerDecisions || ownerDecisions.policyStatus !== "ACCEPTED") {
    throw new Error("ProductDefinition domainRules require the accepted PDP-1 owner decision record");
  }

  const mapped = records.filter((record) => record.decisionStatus?.includes("PXD-035-bounded-mapping-accepted"));
  if (mapped.length !== 6 || new Set(mapped.map(({ id }) => id)).size !== mapped.length) {
    throw new Error(`ProductDefinition domainRules require six unique PXD-035 bounded mappings; found ${mapped.length}`);
  }

  const sourceRefs = new Set();
  for (const record of mapped) {
    const ref = record.sourceRef;
    if (typeof ref !== "string" || !ref.startsWith(DECISION_PREFIX)) {
      throw new Error(`ProductDefinition domain rule ${record.id} must cite an exact PDP-1 accepted decision`);
    }
    const decisionKey = ref.slice(DECISION_PREFIX.length);
    if (EXPECTED_DECISION_KEYS.get(record.id) !== decisionKey
      || !Object.hasOwn(ownerDecisions, decisionKey)
      || ownerDecisions[decisionKey] !== record.expectedDecisionValue) {
      throw new Error(`ProductDefinition domain rule ${record.id} has a missing, forged, or value-mismatched PDP-1 decision source`);
    }
    if (sourceRefs.has(ref)) throw new Error(`ProductDefinition domain rule source is duplicated: ${ref}`);
    sourceRefs.add(ref);
  }

  return mapped;
}

/** Mechanical closure of authored business measurement definitions, never a measured result. */
export function validateBusinessMeasureDefinitions(goals, capabilities, profiles) {
  const review = goals.successMeasureContracts;
  if (review?.ownerDecisionRef !== '.product-experience/decision-log.md#PXD-048') throw new Error('Measurement definition lacks the exact bounded owner decision');
  const records = review.records;
  const intents = goals.businessIntents.filter((record) => record.measuredBy);
  if (!Array.isArray(records) || records.length !== 4 || intents.length !== 4) throw new Error('Business measure population changed or incomplete');
  const ids = new Set();
  const populations = { outcomeRefs: new Set(goals.outcomes.map(({ id }) => id)), capabilityRefs: new Set(capabilities.capabilities.map(({ id }) => id)), profileAxisRefs: new Set(profiles.profileAxes.map(({ id }) => id)) };
  for (const record of records) {
    if (ids.has(record.id) || record.id !== `${record.businessIntentRef}.measure` || !intents.some((intent) => intent.id === record.businessIntentRef && intent.measuredBy === record.description)) throw new Error('Duplicate or stale business measure identity');
    ids.add(record.id);
    for (const [field, population] of Object.entries(populations)) {
      if (!Array.isArray(record[field]) || !record[field].length || new Set(record[field]).size !== record[field].length || record[field].some((id) => !population.has(id))) throw new Error(`Invalid exact measurement ${field}`);
    }
    for (const field of ['metric', 'unit', 'numerator', 'denominator', 'calculation', 'profileBinding', 'applicability', 'acceptanceCriterion', 'evidenceMethod', 'baselinePolicy', 'targetPolicy', 'capabilityCrosswalkStatus', 'populationEnumeration']) if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`Missing measurement definition ${field}`);
    if (!record.calculation.includes('100 * numerator / denominator') || !record.calculation.includes('zero denominator is NOT_APPLICABLE') || !record.calculation.includes('NOT_EVALUATED')) throw new Error('Invalid percentage or zero-denominator measurement meaning');
    if (!record.baseline.startsWith('NOT_EVALUATED') || !record.target.startsWith('NOT_SET') || record.qualification !== 'NOT_EVALUATED' || !record.populationEnumeration.startsWith('NOT_EVALUATED') || !record.capabilityCrosswalkStatus.startsWith('exact-source-trace-only')) throw new Error('Definition projection invents measurement, target, population or qualification');
  }
  return records;
}
