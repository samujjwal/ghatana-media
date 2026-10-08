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
