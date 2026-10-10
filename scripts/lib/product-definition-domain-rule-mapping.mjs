const DECISION_PREFIX = ".product-experience/pdp-1-domain-data/state-adjudication.yaml#/ownerAcceptedPolicyDecisions/";
const EXPECTED_DECISION_KEYS = new Map([
  ["MEDIA-DOMAIN-RULE-001", "machineScopedStateIdentity"],
  ["MEDIA-DOMAIN-RULE-002", "requestReceiptIsQueuedJob"],
  ["MEDIA-DOMAIN-RULE-003", "unknownOutcomeRule"],
  ["MEDIA-DOMAIN-RULE-004", "completedRule"],
  ["MEDIA-DOMAIN-RULE-005", "cancelledRule"],
  ["MEDIA-DOMAIN-RULE-006", "partialSuccessRule"],
]);

function resolveExactSourceRef(ref, sourceDocuments) {
  if (typeof ref !== "string") return undefined;
  const hash = ref.indexOf("#");
  if (hash <= 0) return undefined;
  let value = sourceDocuments[ref.slice(0, hash)];
  if (value === undefined) return undefined;
  for (const part of ref.slice(hash + 1).replace(/^\//u, "").split("/")) {
    if (!part) continue;
    const byId = /^@id=(.+)$/u.exec(part);
    if (byId) value = Array.isArray(value) ? value.find((row) => row.id === byId[1]) : undefined;
    else if (Array.isArray(value) && /^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    if (value === undefined) return undefined;
  }
  return value;
}

const P0_INVARIANT_TARGETS = new Set([
  "MEDIA-INV-001", "MEDIA-INV-002", "MEDIA-INV-003", "MEDIA-INV-004",
  "MEDIA-INV-005", "MEDIA-INV-006", "MEDIA-INV-007",
]);
const EXPECTED_PDP05_INVARIANT_SOURCES = new Map([
  ["media.invariant.private-local-authorized-are-independent", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/classificationAndDisclosure/locality", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"]],
  ["media.invariant.attestation-is-not-authority", [".product-experience/pdp-1-domain-data/privacy.yaml#consentModel", ".product-experience/pdp-1-domain-data/authority.yaml#consentAndIdentity"]],
  ["media.invariant.classification-floor", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/classificationAndDisclosure"]],
  ["media.invariant.untrusted-content-cannot-authorize", [".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/invariants/4", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"]],
  ["media.invariant.audit-intent-precedes-effect", [".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/platformMechanics/audit", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/genericAuditMechanics"]],
  ["media.invariant.revocation-stops-future-effects", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/consentRevocation", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"]],
  ["media.invariant.tenant-isolation", [".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/tenantIsolation", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"]],
]);
const EXPECTED_TRUST_TARGETS = new Map([
  ["media.trust.host-identity", "media.trust.authenticated"],
  ["media.trust.current-policy-decision", "media.trust.privileged"],
  ["media.trust.canonical-state-observation", "media.trust.authenticated"],
  ["media.trust.effect-finality-evidence", "media.trust.privileged"],
]);
const EXPECTED_TRUST_SOURCES = new Map([
  ["media.trust.host-identity", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"],
  ["media.trust.current-policy-decision", ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/consentRevocation"],
  ["media.trust.canonical-state-observation", ".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions"],
  ["media.trust.effect-finality-evidence", ".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions/unknownOutcomeRule"],
]);
const EXPECTED_TRUST_EXCLUSIONS = new Map([
  ["media.trust.projection-exclusion.public", ["media.trust.public", ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml#trustContexts/contexts/@id=media.trust.public"]],
  ["media.trust.projection-exclusion.admin", ["media.trust.admin", ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml#trustContexts/contexts/@id=media.trust.admin"]],
]);
const EXPECTED_PDP05_OWNER_TARGETS = new Map([
  ["media.owner.product-semantics", "media.ownership.product-semantics"],
  ["media.owner.identity-and-delegation", "media.ownership.identity"],
  ["media.owner.privileged-effects", "media.ownership.privileged-effects"],
  ["media.owner.audit-mechanics", "media.ownership.audit"],
  ["media.owner.domain-state-semantics", "media.ownership.domain-state"],
]);
const EXPECTED_OWNER_SOURCES = new Map([
  ["media.owner.product-semantics", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/mediaProductSemantics"],
  ["media.owner.identity-and-delegation", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/identityAuthenticationAndDelegation"],
  ["media.owner.privileged-effects", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/privilegedEffects"],
  ["media.owner.model-execution", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/genericModelExecution"],
  ["media.owner.audit-mechanics", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/genericAuditMechanics"],
  ["media.owner.event-transport", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/eventTransport"],
  ["media.owner.storage-and-erasure", ".product-experience/pdp-1-domain-data/authority.yaml#ownership/storageMechanics"],
  ["media.owner.domain-state-semantics", ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority"],
]);
const EXPECTED_OWNER_FACTS = new Map([
  ["media.owner.product-semantics", { owner: "media", owns: ["job-artifact-consent-quality-fidelity-and-lifecycle-meaning", "operation-preconditions-and-outcomes"], mustNotDelegateMeaningTo: ["provider-success", "transport-acceptance", "generic-workflow-mechanics"] }],
  ["media.owner.identity-and-delegation", { owner: "ghatana-shared-and-identity-service", owns: ["authentication", "tenant-principal-identity", "current-delegation"], MediaBoundary: "Media-consumes-host-attested-identity-but-does-not-claim-to-authenticate-it" }],
  ["media.owner.privileged-effects", { owner: "ghatana-action-plane", owns: ["generic-privileged-effect-mechanics"], MediaBoundary: "privileged-mechanism-acceptance-does-not-accept-Media-policy-or-outcome" }],
  ["media.owner.model-execution", { owner: "ghatana-ai-inference", owns: ["generic-model-execution-mechanics"], MediaBoundary: "Media-owns-intent-rights-quality-fidelity-and-output-meaning" }],
  ["media.owner.audit-mechanics", { owner: "ghatana-shared", owns: ["generic-audit-mechanics"], MediaBoundary: "required-Media-audit-intent-is-a-precondition-and-is-not-replaced-by-telemetry" }],
  ["media.owner.event-transport", { owner: "platform-event-plane", owns: ["event-transport-durability-and-delivery-mechanics"], MediaBoundary: "Media-owns-event-meaning-and-does-not-infer-transport-durability" }],
  ["media.owner.storage-and-erasure", { owner: "platform-storage-owner", owns: ["storage-and-replica-deletion-mechanics"], MediaBoundary: "Media-owns-artifact-lifecycle-retention-and-erasure-policy-meaning" }],
  ["media.owner.domain-state-semantics", { owner: "media", owns: ["canonical-media-state-identities", "lifecycle-finality-and-precondition-meaning"], mustNotDelegateMeaningTo: ["provider-status-spelling", "transport-acceptance", "generic-workflow-state"] }],
]);

/**
 * Validate that the source-authored PDP-1 invariant, trust, and ownership
 * definitions preserve the already-authored PDP-0 projection targets. This is
 * a definition/projection join only; it does not accept the policy or claim
 * runtime enforcement.
 */
export function resolvePdp05InvariantTrustOwnershipProjection({ constitution, p0Actors, privacy, authority, sourceDocuments }) {
  const fail = (message) => { throw new Error(`Invalid PDP-1 invariant/trust/ownership projection: ${message}`); };
  const invariantSource = privacy?.ownerDefinedPdp05InvariantMappings;
  const trustOwnershipSource = authority?.ownerDefinedPdp05TrustAndOwnership;
  const invariants = invariantSource?.records;
  const p0Invariants = constitution?.invariants?.records;
  const p0Trust = p0Actors?.trustContexts?.contexts;
  const p0Ownership = p0Actors?.ownershipRules?.rules;
  const trustContexts = trustOwnershipSource?.trustContexts;
  const ownershipRules = trustOwnershipSource?.ownershipRules;
  if (invariantSource?.status !== "OWNER_DEFINED_DEFINITION_ONLY; security-rights-specialist-and-independent-P0-010-review-pending"
    || !Array.isArray(invariants) || invariants.length !== 7 || !Array.isArray(p0Invariants) || p0Invariants.length !== 7) fail("must resolve all seven definition-only PDP-1 invariants to seven existing PDP-0 targets");
  const invariantIds = new Set(invariants.map(({ id }) => id));
  if (invariantIds.size !== 7 || invariants.some((row) => row.accountableOwner !== "media" || !P0_INVARIANT_TARGETS.has(row.projectionTargetRef?.split("@id=")[1]))) fail("invariant identity, Media accountability, or exact P0 target is invalid");
  const p0InvariantById = new Map(p0Invariants.map((row) => [row.id, row]));
  for (const row of invariants) {
    const targetId = row.projectionTargetRef.split("@id=")[1];
    const target = p0InvariantById.get(targetId);
    if (row.projectionTargetRef !== `.product-experience/pdp-0-product-truth/constitution.yaml#invariants/records/@id=${targetId}`
      || !target || target.statement !== row.statement || target.violation !== row.violation
      || !row.ownerElaboration || !row.trustScope || !row.failClosedResponse
      || JSON.stringify(row.sourceRefs) !== JSON.stringify(EXPECTED_PDP05_INVARIANT_SOURCES.get(row.id))
      || row.sourceRefs.some((ref) => !resolveExactSourceRef(ref, sourceDocuments))) {
      fail(`${row.id} does not preserve its exact P0 statement/violation, explicit PDP-1 elaboration, and resolvable PDP-1 evidence`);
    }
  }
  const invariantTargets = invariants.map((row) => row.projectionTargetRef);
  if (new Set(invariantTargets).size !== p0Invariants.length
    || p0Invariants.some((row) => !invariantTargets.includes(`.product-experience/pdp-0-product-truth/constitution.yaml#invariants/records/@id=${row.id}`))) fail("every P0 invariant must have exactly one P1 source mapping");
  if (!Array.isArray(trustContexts) || trustContexts.length !== 4 || !Array.isArray(p0Trust) || p0Trust.length !== 4
    || !Array.isArray(ownershipRules) || ownershipRules.length !== 8 || !Array.isArray(p0Ownership)) fail("trust or ownership population is incomplete");
  const p0TrustById = new Map(p0Trust.map((row) => [row.id, row]));
  const trustIds = new Set();
  for (const row of trustContexts) {
    if (!row?.id || trustIds.has(row.id)) fail("duplicate or missing PDP-1 trust context identity");
    trustIds.add(row.id);
    const targetId = row.projectionTargetRef?.split("@id=")[1];
    const target = p0TrustById.get(targetId);
    if (!target || EXPECTED_TRUST_TARGETS.get(row.id) !== targetId
      || row.projectionTargetRef !== `.product-experience/pdp-0-product-truth/actors-responsibilities.yaml#trustContexts/contexts/@id=${targetId}`
      || row.expectedTrustLevel !== target.trustLevel || row.expectedDataSensitivity !== target.dataSensitivity
      || row.expectedEffectScope !== target.effectScope || row.expectedAuditRequired !== target.auditRequired
      || row.sourceRef !== EXPECTED_TRUST_SOURCES.get(row.id) || !resolveExactSourceRef(row.sourceRef, sourceDocuments)
      || !Array.isArray(row.forbiddenCoercions) || row.forbiddenCoercions.length === 0
      || !row.missingOrMismatch) fail(`${row.id} does not preserve its exact P0 trust class, sensitivity, effect, audit requirement, or resolvable PDP-1 trust source`);
  }
  if (trustContexts.some((row) => EXPECTED_TRUST_TARGETS.get(row.id) !== row.projectionTargetRef?.split("@id=")[1])) fail("PDP-1 trust mapping differs from its exact P0 trust target");
  const mappedTrustTargetIds = new Set(trustContexts.map((row) => row.projectionTargetRef.split("@id=")[1]));
  const trustExclusions = trustOwnershipSource.trustProjectionExclusions;
  if (!Array.isArray(trustExclusions) || trustExclusions.length !== EXPECTED_TRUST_EXCLUSIONS.size) fail("PDP-0 public/admin trust targets need explicit PDP-1 non-applicability");
  for (const row of trustExclusions) {
    const [targetId, exactRef] = EXPECTED_TRUST_EXCLUSIONS.get(row.id) ?? [];
    if (targetId !== row.p0TargetRef?.split("@id=")[1] || row.p0TargetRef !== exactRef || row.disposition !== "NOT_APPLICABLE_TO_PDP1_TRUST_CONTEXTS"
      || !row.reason || !resolveExactSourceRef(row.p0TargetRef, sourceDocuments)) fail(`${row.id} is not an exact explicit trust non-projection`);
    if (mappedTrustTargetIds.has(targetId)) fail(`${row.id} overlaps a mapped P1 trust context`);
    mappedTrustTargetIds.add(targetId);
  }
  if (mappedTrustTargetIds.size !== p0Trust.length || p0Trust.some((row) => !mappedTrustTargetIds.has(row.id))) fail("every P0 trust context must have a P1 mapping or exact non-applicability disposition");
  const p0OwnershipById = new Map(p0Ownership.map((row) => [row.id, row]));
  const ownerIds = new Set();
  const projectedOwnerIds = new Set();
  for (const row of ownershipRules) {
    const ownerFacts = EXPECTED_OWNER_FACTS.get(row.id);
    if (!row.id || ownerIds.has(row.id) || !ownerFacts || row.sourceRef !== EXPECTED_OWNER_SOURCES.get(row.id)
      || !resolveExactSourceRef(row.sourceRef, sourceDocuments) || row.accountableOwner !== ownerFacts.owner
      || JSON.stringify(row.owns) !== JSON.stringify(ownerFacts.owns)
      || JSON.stringify(row.mustNotDelegateMeaningTo) !== JSON.stringify(ownerFacts.mustNotDelegateMeaningTo)
      || row.MediaBoundary !== ownerFacts.MediaBoundary) fail(`${row.id} lacks exact row-specific PDP-1 owner source, owner, and boundary meaning`);
    if (row.projectionTargetRef) {
      const targetId = row.projectionTargetRef.split("@id=")[1];
      const target = p0OwnershipById.get(targetId);
      if (EXPECTED_PDP05_OWNER_TARGETS.get(row.id) !== targetId || !target
        || row.projectionTargetRef !== `.product-experience/pdp-0-product-truth/actors-responsibilities.yaml#ownershipRules/rules/@id=${targetId}`
        || row.expectedAccountableRoleRef !== target.accountableRoleRef || row.expectedConcern !== target.concern
        || !Array.isArray(row.owns) || row.owns.length === 0) fail(`${row.id} does not preserve exact P0 ownership/accountability or owner boundary`);
      if (row.accountableOwner === "media" && (!Array.isArray(row.mustNotDelegateMeaningTo) || row.mustNotDelegateMeaningTo.length === 0)) fail(`${row.id} lacks Media meaning boundaries`);
      if (row.accountableOwner !== "media" && !row.MediaBoundary) fail(`${row.id} loses the distinction between external mechanics ownership and Media meaning`);
      projectedOwnerIds.add(targetId);
    } else if (row.projectionDisposition !== "NOT_PROJECTED_EXTERNAL_MECHANICS_OWNER" || !row.nonProjectionReason
      || !row.accountableOwner || !Array.isArray(row.owns) || row.owns.length === 0 || !row.MediaBoundary) {
      fail(`${row.id} lacks an exact non-projection disposition for its external owner`);
    }
    ownerIds.add(row.id);
  }
  if ([...ownerIds].filter((id) => ownershipRules.find((row) => row.id === id).projectionTargetRef).length !== EXPECTED_PDP05_OWNER_TARGETS.size
    || projectedOwnerIds.size !== p0Ownership.length || p0Ownership.some((row) => !projectedOwnerIds.has(row.id))) fail("every P0 owner row must have exactly one matching PDP-1 source mapping");
  return { invariants: p0Invariants, trustContexts: p0Trust, ownershipRules: p0Ownership };
}

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

/** Join the current P1-owned rule semantics to the bounded P0 projections. */
export function resolvePdp05DomainRuleProjection({ p0Records, p1Projection, ownerDecisions, sourceDocuments }) {
  const fail = (message) => { throw new Error(`Invalid PDP-1 domain rule projection: ${message}`); };
  const mappedP0 = resolveAcceptedDomainRuleRecords(p0Records, ownerDecisions);
  const rows = p1Projection?.records;
  if (p1Projection?.id !== "media.pdp1.product-definition-domain-rules.v1"
    || p1Projection.authorityRef !== ".product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions"
    || p1Projection.decisionRef !== ".product-experience/decision-log.md#PXD-035"
    || p1Projection.status !== "SIX_BOUNDED_ACCEPTED_RULES; projection-only; runtime-and-independent-P0-010-review-pending"
    || !Array.isArray(rows) || rows.length !== 6 || new Set(rows.map(({ id }) => id)).size !== 6) {
    fail("the exact six-record PXD-035 projection source is absent or its pending gates changed");
  }
  const p0ById = new Map(mappedP0.map((row) => [row.id, row]));
  const p1ById = new Map(rows.map((row) => [row.id, row]));
  for (const [id, p0] of p0ById) {
    const p1 = p1ById.get(id);
    const decisionRef = `.product-experience/pdp-1-domain-data/state-adjudication.yaml#ownerAcceptedPolicyDecisions/${EXPECTED_DECISION_KEYS.get(id)}`;
    if (!p1 || p1.sourceDecisionRef !== decisionRef || p1.expectedDecisionValue !== ownerDecisions[EXPECTED_DECISION_KEYS.get(id)]
      || resolveExactSourceRef(decisionRef, sourceDocuments) !== p1.expectedDecisionValue
      || p1.projectionTargetRef !== `.product-experience/pdp-0-product-truth/constitution.yaml#domainRules/records/@id=${id}`
      || p1.statement !== p0.rule || p1.violation !== p0.violation || p1.trustScope !== p0.trustScope
      || p1.failClosedResponse !== p0.failClosed || p1.accountableOwner !== "media"
      || p1.ownerRef !== ".product-experience/pdp-1-domain-data/authority.yaml#ownership/mediaProductSemantics"
      || p1.trustContextRef !== (id === "MEDIA-DOMAIN-RULE-001" || id === "MEDIA-DOMAIN-RULE-002"
        ? ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope"
        : ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority")
      || !resolveExactSourceRef(p1.ownerRef, sourceDocuments) || resolveExactSourceRef(p1.ownerRef, sourceDocuments) !== "media"
      || !resolveExactSourceRef(p1.trustContextRef, sourceDocuments)
      || !p0.decisionStatus?.includes("PXD-035-bounded-mapping-accepted")) {
      fail(`${id} does not preserve exact P1 owner semantics, source decision, accountability, trust scope and P0 projection fields`);
    }
  }
  return mappedP0;
}

/** Validate source applicability membership without treating leaves as measured cohorts. */
export function validateOwnerMeasureApplicabilityCrosswalk(crosswalk, capabilityIds, measureIds, sourceDocuments = undefined) {
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
    if (!capabilities.has(row.capabilityRef) || row.capabilityIntentId !== row.capabilityRef || !measures.has(row.measureRef) || seen.has(key) || row.id !== expectedId) throw new Error('Duplicate, forged or foreign capability-intent applicability identity');
    if (!allowed.get(row.measureRef).includes(row.disposition) || typeof row.reason !== 'string' || !row.reason.trim() || !Array.isArray(row.sourceRefs) || !row.sourceRefs.length || row.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('Missing exact applicability definition and source');
    if (JSON.stringify(row.sourceRefs).includes('pdp-1-domain-data') || /operation(?:Contract)?Ref|SchemaRef|operationId/iu.test(JSON.stringify(row))) throw new Error('P0 applicability cannot depend on PDP-1 operation identity or schemas');
    if (!unmeasured(row) || row.admission !== 'NOT_ADMITTED' || row.sourceDisposition !== 'OWNER_DEFINED_DEFINITION_ONLY') throw new Error('Source applicability cannot assert measurement or admission');
    if (sourceDocuments) {
      const resolved = row.sourceRefs.map(ref => resolveExactSourceRef(ref, sourceDocuments));
      if (resolved.some(value => value === undefined)) throw new Error(`Applicability source selector does not resolve for ${row.capabilityRef}/${row.measureRef}`);
      const capabilityRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${row.capabilityIntentId}`;
      const measureRef = `.product-experience/pdp-0-product-truth/goals-jtbd.yaml#successMeasureContracts/records/@id=${row.measureRef}`;
      const capability = resolveExactSourceRef(capabilityRef, sourceDocuments);
      const measure = resolveExactSourceRef(measureRef, sourceDocuments);
      if (!capability || !measure || row.sourceRefs.length !== 2 || !row.sourceRefs.includes(capabilityRef) || !row.sourceRefs.includes(measureRef)) throw new Error(`Applicability does not resolve exact P0 capability intent and measure semantics ${row.capabilityRef}/${row.measureRef}`);
      const listed = measure.capabilityRefs?.includes(row.capabilityIntentId) ?? false;
      const expectedDisposition = row.measureRef === 'media.business.reuse-media-capabilities.measure'
        ? 'TRACE_ONLY_NOT_A_MEASURE_UNIT'
        : row.measureRef === 'media.business.trustworthy-versioned-outputs.measure'
          ? (listed ? 'APPLICABLE_OUTPUT_PRODUCER_CANDIDATE' : 'NOT_APPLICABLE_READ_ONLY_OR_NO_OUTPUT_OPERATION')
          : row.measureRef === 'media.business.bounded-provider-execution.measure'
            ? (listed ? 'APPLICABLE_PROVIDER_PROFILE_CANDIDATE' : 'NOT_APPLICABLE_NOT_EXECUTION_PROFILE_OPERATION')
            : (listed ? 'APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE' : 'NOT_APPLICABLE_SYNCHRONOUS_OPERATION');
      if (row.disposition !== expectedDisposition) throw new Error(`Applicability disposition disagrees with exact P0 measure capability population for ${row.capabilityRef}/${row.measureRef}`);
    }
    seen.add(key); byPair.set(key, row);
  }
  if (!Array.isArray(crosswalk.records) || crosswalk.records.length !== capabilities.size || new Set(crosswalk.records.map(row => row.capabilityRef)).size !== capabilities.size) throw new Error('Incomplete applicability binding index');
  for (const binding of crosswalk.records) {
    if (!capabilities.has(binding.capabilityRef) || binding.capabilityIntentId !== binding.capabilityRef || binding.capabilityIntentRef !== `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${binding.capabilityIntentId}` || binding.outputSemanticShapeRef !== `${binding.capabilityIntentRef}/outputArtifactTypes` || !Array.isArray(binding.outputSemanticShape) || binding.bindingProjectionOnly !== true || !unmeasured(binding) || binding.admission !== 'NOT_ADMITTED' || binding.sourceDisposition !== 'OWNER_DEFINITION_ONLY' || /operation(?:Contract)?Ref|SchemaRef|operationId/iu.test(JSON.stringify(binding))) throw new Error('Invalid P0 capability-intent applicability binding');
    if (sourceDocuments) {
      const capability = resolveExactSourceRef(binding.capabilityIntentRef, sourceDocuments);
      if (!capability || JSON.stringify(binding.outputSemanticShape) !== JSON.stringify(capability.outputArtifactTypes ?? [])) throw new Error(`P0 output semantic shape does not match capability intent ${binding.capabilityIntentId}`);
    }
    if (Object.keys(binding.measureApplicability ?? {}).length !== measures.size) throw new Error('Incomplete binding measure population');
    for (const measure of measures) {
      const projected = binding.measureApplicability[measure], row = byPair.get(`${binding.capabilityRef}\u0000${measure}`);
      if (!projected || projected.id !== row.id || projected.disposition !== row.disposition || projected.reason !== row.reason || JSON.stringify(projected.sourceRefs) !== JSON.stringify(row.sourceRefs)) throw new Error('Binding index differs from normative applicability definition');
    }
  }
  if (crosswalk.downstreamPdp1OperationContext?.gatingForPdp0 !== false || crosswalk.downstreamPdp1OperationContext?.status !== 'DOWNSTREAM_CONTEXT_ONLY_NOT_A_PDP0_PREREQUISITE' || crosswalk.downstreamPdp1OperationContext.records?.length !== capabilities.size) throw new Error('PDP-1 operation context must be explicitly downstream and non-gating');
  if (crosswalk.capabilityCount !== capabilities.size || crosswalk.uniqueCapabilityCount !== capabilities.size || crosswalk.completeCrosswalkCount !== capabilities.size || JSON.stringify([...crosswalk.measureRefs ?? []].sort()) !== JSON.stringify([...measures].sort())) throw new Error('Applicability census differs from source populations');
  for (const measure of measures) {
    const count = rows.filter(row => row.measureRef === measure && (row.disposition.startsWith('APPLICABLE_') || row.disposition === 'TRACE_ONLY_NOT_A_MEASURE_UNIT')).length;
    if (crosswalk.applicableCandidateCounts?.[measure] !== count) throw new Error('Applicability candidate count differs from normative dispositions');
  }
  return rows;
}

/** Mechanical closure of authored business measurement definitions, never a measured result. */
export function validateBusinessMeasureDefinitions(goals, capabilities, profiles, sourceDocuments = undefined) {
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
    applicabilityRows = validateOwnerMeasureApplicabilityCrosswalk(review.ownerCapabilityApplicabilityCrosswalk, [...populations.capabilityRefs], records.map(record => record.id), sourceDocuments);
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
