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

/** Validate source applicability membership without treating leaves as measured cohorts. */
export function validateOwnerMeasureApplicabilityCrosswalk(crosswalk, capabilityIds, measureIds) {
  const capabilities = new Set(capabilityIds), measures = new Set(measureIds);
  if (capabilities.size !== capabilityIds.length || measures.size !== measureIds.length || !capabilities.size || measures.size !== 4) throw new Error('Invalid applicability source populations');
  const allowed = new Map([
    ['media.business.reuse-media-capabilities.measure', ['TRACE_ONLY_NOT_A_MEASURE_UNIT']],
    ['media.business.trustworthy-versioned-outputs.measure', ['APPLICABLE_OUTPUT_PRODUCER_CANDIDATE', 'NOT_APPLICABLE_READ_ONLY_OR_NO_OUTPUT_OPERATION']],
    ['media.business.bounded-provider-execution.measure', ['APPLICABLE_PROVIDER_PROFILE_CANDIDATE', 'NOT_APPLICABLE_NOT_EXECUTION_PROFILE_OPERATION']],
    ['media.business.safe-recoverable-operations.measure', ['APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE', 'NOT_APPLICABLE_SYNCHRONOUS_OPERATION']],
  ]);
  if ([...measures].some(id => !allowed.has(id))) throw new Error('Unknown applicability measure');
  const unmeasured = record => record?.baseline === 'NOT_EVALUATED' && record.target === 'NOT_SET' && record.qualification === 'NOT_EVALUATED';
  if (!crosswalk || !unmeasured(crosswalk) || crosswalk.executionAdmission !== 'NOT_ADMITTED') throw new Error('Applicability cannot assert observations or admission');
  const normative = crosswalk.measureApplicabilityRecords;
  const rows = normative?.records;
  if (!Array.isArray(rows) || rows.length !== capabilities.size * measures.size || normative.recordCount !== rows.length || normative.uniqueRecordIds !== rows.length) throw new Error('Incomplete exact leaf by measure applicability population');
  const seen = new Set(), byPair = new Map();
  for (const row of rows) {
    const key = `${row.capabilityRef}\u0000${row.measureRef}`;
    const expectedId = `media.measure-applicability.${row.measureRef?.replaceAll('.', '-')}.${row.capabilityRef?.replaceAll('.', '-')}`;
    if (!capabilities.has(row.capabilityRef) || !measures.has(row.measureRef) || seen.has(key) || row.id !== expectedId) throw new Error('Duplicate, forged or foreign applicability identity');
    if (!allowed.get(row.measureRef).includes(row.disposition) || typeof row.reason !== 'string' || !row.reason.trim() || !Array.isArray(row.sourceRefs) || !row.sourceRefs.length || row.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('Missing exact applicability definition and source');
    if (!unmeasured(row) || row.admission !== 'NOT_ADMITTED' || row.sourceDisposition !== 'OWNER_DEFINED_DEFINITION_ONLY') throw new Error('Source applicability cannot assert measurement or admission');
    seen.add(key); byPair.set(key, row);
  }
  if (!Array.isArray(crosswalk.records) || crosswalk.records.length !== capabilities.size || new Set(crosswalk.records.map(row => row.capabilityRef)).size !== capabilities.size) throw new Error('Incomplete applicability binding index');
  for (const binding of crosswalk.records) {
    if (!capabilities.has(binding.capabilityRef) || binding.bindingProjectionOnly !== true || !unmeasured(binding) || binding.admission !== 'NOT_ADMITTED' || binding.sourceDisposition !== 'OWNER_DEFINITION_ONLY') throw new Error('Invalid nonnormative applicability binding');
    if (Object.keys(binding.measureApplicability ?? {}).length !== measures.size) throw new Error('Incomplete binding measure population');
    for (const measure of measures) {
      const projected = binding.measureApplicability[measure], row = byPair.get(`${binding.capabilityRef}\u0000${measure}`);
      if (!projected || projected.id !== row.id || projected.disposition !== row.disposition || projected.reason !== row.reason || JSON.stringify(projected.sourceRefs) !== JSON.stringify(row.sourceRefs)) throw new Error('Binding index differs from normative applicability definition');
    }
  }
  if (crosswalk.capabilityCount !== capabilities.size || crosswalk.uniqueCapabilityCount !== capabilities.size || crosswalk.completeCrosswalkCount !== capabilities.size || JSON.stringify([...crosswalk.measureRefs ?? []].sort()) !== JSON.stringify([...measures].sort())) throw new Error('Applicability census differs from source populations');
  for (const measure of measures) {
    const count = rows.filter(row => row.measureRef === measure && (row.disposition.startsWith('APPLICABLE_') || row.disposition === 'TRACE_ONLY_NOT_A_MEASURE_UNIT')).length;
    if (crosswalk.applicableCandidateCounts?.[measure] !== count) throw new Error('Applicability candidate count differs from normative dispositions');
  }
  return rows;
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
  const crosswalkDecision = '.product-experience/decision-log.md#PXD-081';
  const currentCrosswalk = review.ownerApplicabilityDecisionRef === crosswalkDecision;
  let applicabilityRows;
  if (review.ownerApplicabilityDecisionRef !== undefined && !currentCrosswalk) throw new Error('Unknown applicability owner decision');
  if (currentCrosswalk) {
    if (review.ownerCapabilityApplicabilityCrosswalk?.ownerDecisionRef !== crosswalkDecision) throw new Error('Applicability crosswalk differs from its owner decision');
    applicabilityRows = validateOwnerMeasureApplicabilityCrosswalk(review.ownerCapabilityApplicabilityCrosswalk, [...populations.capabilityRefs], records.map(record => record.id));
  }
  for (const record of records) {
    if (ids.has(record.id) || record.id !== `${record.businessIntentRef}.measure` || !intents.some((intent) => intent.id === record.businessIntentRef && intent.measuredBy === record.description)) throw new Error('Duplicate or stale business measure identity');
    ids.add(record.id);
    for (const [field, population] of Object.entries(populations)) {
      if (!Array.isArray(record[field]) || !record[field].length || new Set(record[field]).size !== record[field].length || record[field].some((id) => !population.has(id))) throw new Error(`Invalid exact measurement ${field}`);
    }
    for (const field of ['metric', 'unit', 'numerator', 'denominator', 'calculation', 'profileBinding', 'applicability', 'acceptanceCriterion', 'evidenceMethod', 'baselinePolicy', 'targetPolicy', 'capabilityCrosswalkStatus', 'populationEnumeration']) if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`Missing measurement definition ${field}`);
    if (!record.calculation.includes('100 * numerator / denominator') || !record.calculation.includes('zero denominator is NOT_APPLICABLE') || !record.calculation.includes('NOT_EVALUATED')) throw new Error('Invalid percentage or zero-denominator measurement meaning');
    let pendingPopulation;
    if (currentCrosswalk) {
      const applicable = applicabilityRows.filter(row => row.measureRef === record.id && (row.disposition.startsWith('APPLICABLE_') || row.disposition === 'TRACE_ONLY_NOT_A_MEASURE_UNIT')).map(row => row.capabilityRef).sort();
      const definition = record.ownerApplicabilityDefinition;
      pendingPopulation = definition?.sourceApplicabilityStatus === 'COMPLETE_DEFINITION_ONLY'
        && definition.admittedPopulationStatus === 'NOT_EVALUATED'
        && definition.sourceCandidateCount === applicable.length
        && definition.normativeCrosswalkRef === '.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/successMeasureContracts/ownerCapabilityApplicabilityCrosswalk/measureApplicabilityRecords/records'
        && JSON.stringify([...record.capabilityRefs].sort()) === JSON.stringify(applicable)
        && record.populationEnumeration.includes('NOT_EVALUATED') && record.capabilityCrosswalkStatus.includes('NOT_EVALUATED');
    } else pendingPopulation = record.populationEnumeration.startsWith('NOT_EVALUATED') && record.capabilityCrosswalkStatus.startsWith('exact-source-trace-only');
    if (!record.baseline.startsWith('NOT_EVALUATED') || !record.target.startsWith('NOT_SET') || record.qualification !== 'NOT_EVALUATED' || !pendingPopulation) throw new Error('Definition projection invents measurement, target, population or qualification');
  }
  return records;
}
