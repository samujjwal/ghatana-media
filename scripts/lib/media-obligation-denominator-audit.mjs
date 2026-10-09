import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PHASES = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
const parsedSources = new Map();
function readSourceEntry(absolutePath, parseYaml) {
  const text = fs.readFileSync(absolutePath, 'utf8');
  const previous = parsedSources.get(absolutePath);
  if (previous?.text === text && previous.parseYaml === parseYaml) return previous;
  const entry = { text, parseYaml, digest: `sha256:${crypto.createHash('sha256').update(text).digest('hex')}` };
  try { entry.document = absolutePath.endsWith('.json') ? JSON.parse(text) : parseYaml(text); }
  catch (error) { entry.parseError = error; }
  parsedSources.set(absolutePath, entry);
  return entry;
}

const SOURCE_ENUMERATORS = [
  ['PDP-1', '.product-experience/pdp-1-domain-data/privacy.yaml', 'ownerDefinedErasureInventoryContract', 'domain-object', undefined, 'id', false, true],
  ['PDP-3', '.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'scenarioStartingContextBindings.records', 'action-contract'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/policy-authority-model.yaml', 'productPolicy.inputAndExecutionThreats.browserToLocalWorkerBoundary', 'product-truth', undefined, 'id', false, true],
  ['PDP-0', '.product-experience/pdp-0-product-truth/reuse-decisions.yaml', 'mediaArchitectureRules.enabledCodecBuildEvidenceRule', 'product-truth', undefined, 'id', false, true],
  ['PDP-0', '.product-experience/pdp-0-product-truth/reuse-decisions.yaml', 'mediaArchitectureRules.historicalCandidateInventoryDisposition', 'product-truth', undefined, 'id', false, true],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/motion.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/correlation.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/step-guard-specialized-fact-contracts.yaml', 'records', 'transition'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/quality-policy.yaml', 'personAndIdentityInferenceRule.anonymousTrackIdsByDefault', 'product-truth', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerDefinedWorkflowContracts.records', 'operation-family'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml', 'normativeRuleRecords', 'component-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/localization-content.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/authority.yaml', 'ownerDefinedPdp05TrustAndOwnership.trustProjectionExclusions', 'domain-object'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/requirements.yaml', 'requirements', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/applications-channels.yaml', 'ownerFeatureReviewApplicability.dimensions', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/applications-channels.yaml', 'ownerFeatureReviewApplicability.dimensions.*.applicableRequirementBindings', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/applications-channels.yaml', 'ownerFeatureReviewApplicability.dimensions.*.reviewClauseContracts', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/applications-channels.yaml', 'ownerFeatureReviewApplicability.dimensions.*.notApplicableRequirementDecisions', 'product-truth'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/state-adjudication.yaml', 'ownerDefinedProductDefinitionDomainRules.records', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/privacy.yaml', 'ownerDefinedPdp05InvariantMappings.records', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/authority.yaml', 'ownerDefinedPdp05TrustAndOwnership.trustContexts', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/authority.yaml', 'ownerDefinedPdp05TrustAndOwnership.ownershipRules', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerDefinedJourneyOperationBindings.records', 'operation-family'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml', 'records', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/project-list-observation-contracts.yaml', 'records', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml', 'guardContracts.records', 'transition'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml', 'predicateDefinitions', 'transition'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml', 'stepBindings.records', 'transition'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/typography-layout.yaml', 'normativeRuleRecords', 'layout'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/trust-provenance-grammar.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/events/conventions.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/async-operations.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/cancellation.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/errors.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/idempotency.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml', 'records', 'action-contract'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml', 'ownerCapabilityLeafAdjudication.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml', 'ownerMeasurementDefinitions.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/goals-jtbd.yaml', 'successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.measureApplicabilityRecords.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/goals-jtbd.yaml', 'ownerDefinedMigrationRules.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/domain-model.yaml', 'ownerDefinedMigrationRules.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'ownerMigrationSemanticRules.records', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/handoff-contracts.yaml', 'handoffs', 'product-truth', 'boundedWorkerExceptionRule'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/quality-policy.yaml', 'qualityDimensions', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/quality-policy.yaml', 'metricDefinitions', 'product-truth'],
  ['PDP-0', '.product-experience/pdp-0-product-truth/quality-policy.yaml', 'ownerQualityApplicabilityCrosswalk.records', 'product-truth'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/states.yaml', 'stateMachines', 'state-machine'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'transitionRecords', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'ownerDefinedTransitionRecords', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'ownerRaceResolutionContract', 'transition', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'ownerRaceResolutionContract.invariants', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'ownerRaceResolutionContract.resolutionCases', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'ownerMachineRaceApplicability.records', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml', 'records', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'objects', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'ownerTypedIdentityContracts.records', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'ownerTypedIdentityContracts.relationshipBindings', 'relationship'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'ownerTypedIdentityContracts.tupleRules', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'ownerTypedIdentityContracts.persistenceAndWireSemantics', 'domain-object', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/interoperability.yaml', 'packageCompatibilityBoundary', 'value-object', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'ownerOutputArtifactTypeCrosswalk.records', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'operations', 'operation-family'],
  ['PDP-1', '.product-experience/interface-parity/operation-parity.yaml', 'typedGrpcMethodContracts', 'operation-family', 'mediaOwnerImplementationAssessment'],
  ['PDP-1', '.product-experience/interface-parity/operation-parity.yaml', 'typedGrpcMethodContracts', 'operation-family', 'mediaOwnerSemanticAdapter'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'individualOperationContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerDefinedOperationContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerTypedObservationContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerTypedObservationValidationRules.records', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerLeafWireContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerLeafWireContracts.outputTypes.records', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerLeafWireContracts.mediaTypePolicies.records', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'operations', 'value-object', 'ownerWireSchema'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'individualOperationContracts.records', 'value-object', 'ownerWireSchema'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerDefinedOperationContracts.records', 'value-object', 'ownerWireSchema'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'ownerDefinedOperationProfiles.profiles', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.families', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.bounds', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.inputPayloadSchemas', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.outputPayloadSchemas', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'capabilityOperationContracts.scalarTypeRecords', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/events.yaml', 'ownerEventContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/events.yaml', 'ownerEventContracts.deliveryProtocol', 'operation-family', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/events.yaml', 'ownerEventContracts.deliveryProtocol.externalOwnerReviewRequest', 'operation-family', undefined, 'id', false, true],
  ['PDP-1', '.product-experience/pdp-1-domain-data/events.yaml', 'ownerEventContracts.notificationRecords', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/relationships.yaml', 'relationships', 'relationship'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/value-objects.yaml', 'values', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/value-objects.yaml', 'canonicalConversionDefinitions.records', 'value-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/value-objects.yaml', 'ownerDescriptorDefinitions.records', 'value-object'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'components', 'component-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'components', 'value-object', 'typedDefinition'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/component-value-types.yaml', 'normativeTypeRecords', 'value-object'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml', 'mediaOwnedToolDefinitionContracts.contracts', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml', 'mediaOwnedToolDefinitionContracts.hostInvocationContext', 'value-object', undefined, 'id', false, true],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml', 'mediaOwnedToolDefinitionContracts.invocationSemantics', 'action-contract', undefined, 'id', false, true],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/composition-validation-grammar.yaml', 'normativeRuleRecords', 'component-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/api/conventions.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/cli-language.yaml', 'normativeRuleRecords', 'action-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/layout.yaml', 'layouts', 'layout'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml', 'patterns', 'interaction-pattern'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml', 'templates', 'view-template'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml', 'aliases', 'semantic-token-alias'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/journey-registry.yaml', 'journeys', 'journey-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/migration-semantic-rules.yaml', 'records', 'journey-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/handoff-bindings.yaml', 'handoffs', 'action-contract', 'mediaOwnerDefinition'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/action-registry.yaml', 'actions', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/action-registry.yaml', 'ownerDefinedActions', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml', 'records', 'action-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml', 'factSchemas', 'value-object'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/view-observation-predicates.yaml', 'predicates', 'transition'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml', 'views', 'screen-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml', 'journeys.*.steps', 'journey-contract', 'canonicalBindings', 'semanticDefinitionId', true],
  ['PDP-3', '.product-experience/pdp-3-product-experience/screen-registry.yaml', 'screens', 'screen-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/screen-registry.yaml', 'laneViews', 'screen-contract'],
];

// Read-only descriptors let isolated tests build complete synthetic source
// fixtures without copying the production collection inventory.
export function getMediaSourceEnumerationDescriptors() {
  return Object.freeze(SOURCE_ENUMERATORS.map((descriptor) => Object.freeze([...descriptor])));
}

export function enumerateExpectedMediaObligations({ root, parseYaml }) {
  const records = [];
  const issues = [];
  const sourceDocuments = new Map();
  const sourceDigests = {};
  for (const [phase, sourcePath, collection, dimension, childField, identityField = 'id', requiredChild = false, singleton = false] of SOURCE_ENUMERATORS) {
    const absolutePath = path.resolve(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      issues.push({ code: 'SOURCE_ENUMERATION_MISSING', detail: `Cannot enumerate ${sourcePath}` });
      continue;
    }
    let document;
    try {
      if (!sourceDocuments.has(sourcePath)) {
        const entry = readSourceEntry(absolutePath, parseYaml);
        if (entry.parseError) throw entry.parseError;
        sourceDigests[sourcePath] = entry.digest;
        sourceDocuments.set(sourcePath, entry.document);
      }
      document = sourceDocuments.get(sourcePath);
    } catch (error) {
      issues.push({ code: 'SOURCE_ENUMERATION_PARSE', detail: `${sourcePath}: ${error.message}` });
      continue;
    }
    const collectionPath = collection.split('.');
    const nested = collectionPath.includes('*');
    const entries = [];
    let validCollection = true;
    const visit = (value, remaining, pointer = []) => {
      if (remaining.length === 0) {
        if (!Array.isArray(value)) { validCollection = false; return; }
        value.forEach((record, index) => entries.push({ record, pointer: [...pointer, index] }));
      } else if (remaining[0] === '*') {
        if (!Array.isArray(value)) { validCollection = false; return; }
        value.forEach((record, index) => visit(record, remaining.slice(1), [...pointer, index]));
      } else visit(value?.[remaining[0]], remaining.slice(1), [...pointer, remaining[0]]);
    };
    if (nested) visit(document, collectionPath);
    const collectionValue = nested ? (validCollection ? entries.map(({ record }) => record) : undefined)
      : collectionPath.reduce((value, segment) => value?.[segment], document);
    const candidates = singleton && collectionValue && typeof collectionValue === 'object' && !Array.isArray(collectionValue)
      ? [collectionValue] : singleton ? undefined : collectionValue;
    if (!Array.isArray(candidates)) {
      issues.push({ code: 'SOURCE_ENUMERATION_COLLECTION', detail: `${sourcePath} has no ${collection} ${singleton ? 'record' : 'array'}` });
      continue;
    }
    for (const [index, sourceRecord] of candidates.entries()) {
      const record = childField ? sourceRecord?.[childField] : sourceRecord;
      if (childField && record === undefined && !requiredChild) continue;
      const recordId = record?.[identityField] ?? record?.machineId;
      if (typeof recordId !== 'string' || !recordId.trim()) {
        issues.push({ code: 'SOURCE_ENUMERATION_ID', detail: `${sourcePath}#/${collection} has a record without a stable ID` });
        continue;
      }
      const sourceRecordId = sourceRecord?.id ?? sourceRecord?.machineId ?? sourceRecord?.identity;
      if (childField && !nested && (typeof sourceRecordId !== 'string' || !sourceRecordId.trim())) {
        issues.push({ code: 'SOURCE_ENUMERATION_ID', detail: `${sourcePath}#/${collection} has an anonymous parent for ${recordId}` });
        continue;
      }
      records.push({
        phase,
        dimension,
        sourcePath,
        sourceRef: nested
          ? `${sourcePath}#/${[...entries[index].pointer, ...(childField ? [childField] : [])].join('/')}`
          : singleton ? `${sourcePath}#/${collectionPath.join('/')}`
          : `${sourcePath}#/${collectionPath.join('/')}/${childField ? `${sourceRecordId}/${childField}` : recordId}`,
        recordId,
        obligationId: `media.${phase.toLowerCase()}.requirement.${recordId.toLowerCase()}`,
        sourceSummary: record.statement ?? record.purpose ?? record.useFor ?? record.domainIntent
          ?? record.meaning ?? record.statusDimension ?? record.name ?? record.id,
      });
    }
  }
  return { records, issues, sourceDigests };
}

function addIssue(issues, code, detail) {
  issues.push({ code, detail });
}

function resolveAnchor(document, anchor) {
  const tokens = anchor.replace(/^\//u, '').split('/').filter(Boolean)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let value = document;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (Array.isArray(value)) {
      const numericIndex = Number(token);
      if (Number.isInteger(numericIndex)) value = value[numericIndex];
      else {
        let match;
        // Stable record IDs can contain multiple slashes (machine/dimension/edge).
        // Match the complete identity before traversing any remaining fields.
        for (let end = tokens.length; end > index && !match; end -= 1) {
          const identity = tokens.slice(index, end).join('/');
          const candidate = value.find(item => item?.id === identity || item?.key === identity
            || item?.recordId === identity || item?.machineId === identity || item?.sourceMachineId === identity || item?.identity === identity);
          if (candidate) { match = candidate; index = end - 1; }
        }
        value = match;
      }
    } else if (value && typeof value === 'object' && value.id === `${tokens[index - 1]}/${token}`) {
      // Anchors sometimes spell a composite record ID as two path segments.
    } else value = value?.[token];
    if (value === undefined || value === null) return undefined;
  }
  return value;
}

function compareMembership(label, expectedIds, selectedIds, issues) {
  const counts = new Map();
  for (const id of selectedIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) addIssue(issues, 'DUPLICATE_SELECTION', `${label} selects ${id} ${count} times`);
  const expected = new Set(expectedIds);
  const selected = new Set(counts.keys());
  for (const id of expected) if (!selected.has(id)) addIssue(issues, 'MISSING_SELECTION', `${label} omits ${id}`);
  for (const id of selected) if (!expected.has(id)) addIssue(issues, 'CONTRADICTORY_SELECTION', `${label} selects unknown or contradictory obligation ${id}`);
}

export function auditMediaObligationDenominator({ root, obligations, program, binding, surface, traceability, parseYaml }) {
  const issues = [];
  const sourceEnumeration = enumerateExpectedMediaObligations({ root, parseYaml });
  issues.push(...sourceEnumeration.issues);
  const expectedById = new Map(sourceEnumeration.records.map((record) => [record.obligationId, record]));
  const obligationBySource = new Map(obligations.map((record) => {
    const source = record?.extensions?.['media-source'];
    return [`${source?.sourceRef ?? ''}|${source?.recordId ?? ''}`, record];
  }));
  for (const expected of sourceEnumeration.records) {
    const record = obligationBySource.get(`${expected.sourceRef}|${expected.recordId}`);
    if (!record) addIssue(issues, 'MISSING_SOURCE_OBLIGATION', `${expected.obligationId} is missing for ${expected.sourceRef}`);
    else if (record.id !== expected.obligationId || record.dimension !== expected.dimension) {
      addIssue(issues, 'SOURCE_OBLIGATION_MISMATCH', `${expected.sourceRef} expects ${expected.obligationId} (${expected.dimension}), found ${record.id} (${record.dimension})`);
    }
  }
  for (const record of obligations) {
    const source = record?.extensions?.['media-source'];
    const sourcePath = source?.sourceRef?.split('#')[0];
    if (SOURCE_ENUMERATORS.some(([, candidatePath]) => candidatePath === sourcePath)
      && !expectedById.has(record.id)) {
      addIssue(issues, 'CONTRADICTORY_SOURCE_OBLIGATION', `${record.id} does not resolve to an enumerated source record`);
    }
  }

  const ids = obligations.map((record) => record?.id).filter(Boolean);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) addIssue(issues, 'DUPLICATE_ID', `${id} occurs ${count} times`);
  for (let i = 0; i < obligations.length; i += 1) {
    const record = obligations[i];
    if (!record?.id) addIssue(issues, 'MISSING_ID', `obligation index ${i} has no ID`);
    if (record?.disposition !== 'REQUIRED') addIssue(issues, 'DISPOSITION', `${record?.id ?? `index ${i}`} has disposition ${String(record?.disposition)}; exactly one REQUIRED disposition is expected in this source set`);
    if (record?.disposition === undefined) addIssue(issues, 'MISSING_DISPOSITION', `${record?.id ?? `index ${i}`} has no disposition`);
    const applicable = record?.phaseSemantics?.applicableIn ?? [];
    const phase = record?.id?.match(/^media\.(pdp-[0-3])\./u)?.[1]?.toUpperCase();
    if (applicable.length !== 1 || applicable[0] !== phase) {
      addIssue(issues, 'CONTRADICTORY_PHASE', `${record?.id ?? `index ${i}`} phase ID=${phase ?? 'unknown'} applicableIn=${JSON.stringify(applicable)}`);
    }
    for (const field of ['blockingIn', 'affects']) {
      const values = record?.phaseSemantics?.[field] ?? [];
      if (!Array.isArray(values) || values.some((value) => !PHASES.includes(value))) {
        addIssue(issues, 'CONTRADICTORY_PHASE', `${record?.id ?? `index ${i}`} has invalid ${field}=${JSON.stringify(values)}`);
      }
    }
  }

  const expectedIdsByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    sourceEnumeration.records.filter((record) => record.phase === phase).map((record) => record.obligationId)]));
  const expectedPhaseCounts = Object.fromEntries(PHASES.map((phase) => [phase, expectedIdsByPhase[phase].length]));
  const phaseCounts = Object.fromEntries(PHASES.map((phase) => [phase,
    obligations.filter((record) => record?.phaseSemantics?.applicableIn?.length === 1 && record.phaseSemantics.applicableIn[0] === phase).length]));
  for (const [phase, expected] of Object.entries(expectedPhaseCounts)) {
    if (phaseCounts[phase] !== expected) addIssue(issues, 'PHASE_COUNT', `${phase} count ${phaseCounts[phase]} != source-enumerated ${expected}`);
  }
  if (obligations.length !== sourceEnumeration.records.length) {
    addIssue(issues, 'TOTAL_COUNT', `total ${obligations.length} != source-enumerated ${sourceEnumeration.records.length}`);
  }

  const selectedByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    expectedIdsByPhase[phase]]));
  for (const phase of PHASES) {
    compareMembership(`phase-program ${phase}`, selectedByPhase[phase], program?.phases?.find((item) => item.id === phase)?.obligationIds, issues);
    compareMembership(`phase-binding ${phase}`, selectedByPhase[phase], binding?.phases?.[phase]?.obligationIds, issues);
  }
  compareMembership('closure-surface', sourceEnumeration.records.map((record) => record.obligationId), surface?.obligationIds, issues);

  const sourceHashes = {};
  const sourceDocuments = new Map();
  let resolvedSourceRefs = 0;
  let unresolvedSourceRefs = 0;
  const fingerprintComparisons = { present: 0, matching: 0, stale: 0, absent: 0 };
  for (const record of obligations) {
    const source = record?.extensions?.['media-source'];
    if (!source?.sourceRef || !source?.recordId) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'MISSING_SOURCE_REF', `${record?.id ?? 'unknown'} lacks sourceRef or recordId`);
      continue;
    }
    const hashAt = source.sourceRef.indexOf('#');
    const relativePath = hashAt < 0 ? source.sourceRef : source.sourceRef.slice(0, hashAt);
    const anchor = hashAt < 0 ? '' : decodeURIComponent(source.sourceRef.slice(hashAt + 1));
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'UNRESOLVED_SOURCE', `${record.id} source file missing: ${relativePath}`);
      continue;
    }
    let sourceEntry = sourceDocuments.get(relativePath);
    if (!sourceEntry) {
      sourceEntry = readSourceEntry(absolutePath, parseYaml);
      sourceDocuments.set(relativePath, sourceEntry);
      sourceHashes[relativePath] = sourceEntry.digest;
    }
    const { digest } = sourceEntry;
    if (sourceEntry.parseError) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'SOURCE_PARSE', `${record.id} cannot parse ${relativePath}: ${sourceEntry.parseError.message}`);
      continue;
    }
    const resolved = anchor ? resolveAnchor(sourceEntry.document, anchor) : sourceEntry.document;
    const resolvedId = resolved?.id ?? resolved?.semanticDefinitionId ?? resolved?.requirementId ?? resolved?.key ?? resolved?.recordId
      ?? resolved?.machineId ?? resolved?.sourceMachineId;
    if (!resolved || (resolvedId !== undefined && resolvedId !== source.recordId)) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'SOURCE_REFERENCE_MISMATCH', `${record.id} ${source.sourceRef} did not resolve recordId ${source.recordId}${resolvedId ? ` (found ${resolvedId})` : ''}`);
      continue;
    }
    resolvedSourceRefs += 1;
    const expectedFingerprint = source.sourceDigest;
    if (expectedFingerprint) {
      fingerprintComparisons.present += 1;
      if (expectedFingerprint === digest) fingerprintComparisons.matching += 1;
      else {
        fingerprintComparisons.stale += 1;
        addIssue(issues, 'STALE_SOURCE_FINGERPRINT', `${record.id} expected ${expectedFingerprint}, observed ${digest}`);
      }
    } else {
      fingerprintComparisons.absent += 1;
      addIssue(issues, 'MISSING_SOURCE_FINGERPRINT', `${record.id} has no persisted sourceDigest`);
    }
  }
  if (!traceability || traceability.status !== 'partial-authored-links; independent-P0-010-semantic-closure-pending') {
    addIssue(issues, 'TRACEABILITY_STATE', 'traceability source is missing or no longer declares partial authored links / pending independent review');
  }
  return {
    status: issues.length === 0 ? 'DENOMINATOR_AND_MEMBERSHIP_CHECKED_SOURCE_SEMANTIC_ACCEPTANCE_PENDING' : 'AUDIT_FINDINGS',
    total: obligations.length,
    uniqueIds: counts.size,
    phaseCounts,
    expectedPhaseCounts,
    sourceEnumeration: { total: sourceEnumeration.records.length, phaseCounts: expectedPhaseCounts },
    dispositionRecords: obligations.filter((record) => record?.disposition === 'REQUIRED').length,
    sourceReferences: { total: obligations.length, resolved: resolvedSourceRefs, unresolved: unresolvedSourceRefs },
    sourceFingerprints: { algorithm: 'sha256', files: sourceHashes, comparison: fingerprintComparisons,
      note: 'Persisted sourceDigest values are compared with the current source file hashes.' },
    traceability: { status: traceability?.status ?? 'MISSING', completeness: traceability?.coverageSemantics?.completeness ?? 'UNKNOWN', independentReviewRequired: traceability?.coverageSemantics?.independentReviewRequired ?? null },
    authoritativeObserverAssignments: obligations.filter((record) => record?.observerIds?.length).length,
    authoritativeOracleAssignments: obligations.filter((record) => record?.oracleIds?.length).length,
    issues,
  };
}
