// PDP-0 → PDP-1 → PDP-2 declarative production source verification.
// Definition-only; native execution of this checker does not assert scientific/runtime admission.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import {
  OUTPUT_PATH as PRODUCTION_SPEC_SCHEMA_CONTEXT_PATH,
  renderProductionSpecSchemaContextFromYaml,
} from './generate-media-production-spec-schema-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  authority: '.product-experience/pdp-1-domain-data/authority.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  p3: '.product-experience/pdp-3-product-experience/declarative-production-experience.yaml',
  journeys: '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  recorderP0: '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  recorderP2: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  p1Handoff: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
  p2Handoff: '.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  operations: '.product-experience/pdp-1-domain-data/operations.yaml',
  domain: '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  screens: '.product-experience/pdp-3-product-experience/screen-registry.yaml',
};
const unique = arr => new Set(arr).size === arr.length;
const sameSet = (left, right) => unique(left) && unique(right) &&
  left.length === right.length && left.every(x => right.includes(x));
const knownSourceKinds = ['REAL_CAPTURE', 'DECLARATIVE_ANIMATION', 'MODEL_SIMULATION', 'GENERATIVE_MEDIA', 'PDP_SYNTHETIC_FIXTURE'];
const groupCounts = { ANIMATION: 17, SIMULATION: 22, TUTORPUTOR: 12, UNIFIED: 10 };
const caseIds = Array.from({ length: 61 }, (_, i) => 'MEDIA-DECL-P0-AC-' + String(i + 1).padStart(3, '0'));
const domainIds = [
  'media.domain.project-revision', 'media.domain.media-run', 'media.domain.processing-job',
  'media.domain.job-attempt', 'media.domain.checkpoint', 'media.domain.scene-graph',
  'media.domain.animation-graph', 'media.domain.simulation-world', 'media.domain.timeline',
  'media.domain.artifact-version', 'media.domain.quality-assessment', 'media.domain.provenance-manifest',
];

export function verifyDeclarativeProductionDefinitions({ repoRoot = root, overrides = {} } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const raw = Object.fromEntries(Object.entries(paths).map(([key, value]) => [
    key, Object.hasOwn(overrides, key) ? overrides[key] : fs.readFileSync(path.join(repoRoot, value), 'utf8'),
  ]));
  const docs = {};
  for (const name of ['p0', 'p1', 'p2', 'p3', 'recorderP0', 'recorderP2', 'p1Handoff', 'p2Handoff', 'authority']) {
    const doc = parseDocument(raw[name], { strict: true, uniqueKeys: true });
    if (doc.errors.length) {
      for (const issue of doc.errors) fail(name + ': native YAML parse or duplicate-key error: ' + issue.message);
      continue;
    }
    try { docs[name] = doc.toJS(); } catch (error) { fail(name + ': unsupported document shape: ' + error.message); }
  }
  try {
    const expected = renderProductionSpecSchemaContextFromYaml(raw.p1);
    const actual = Object.hasOwn(overrides, 'productionSpecSchemaContext')
      ? overrides.productionSpecSchemaContext
      : fs.readFileSync(path.join(repoRoot, PRODUCTION_SPEC_SCHEMA_CONTEXT_PATH), 'utf8');
    if (actual !== expected) fail('PDP-1 H-02: generated production-spec schema context differs from canonical descriptor and shared $defs');
  } catch (error) {
    fail('PDP-1 H-02: cannot derive or verify generated production-spec schema context: ' + error.message);
  }
  const [p0, p1, p2, p3, recorderP0, recorderP2, p1Handoff, p2Handoff] =
    ['p0', 'p1', 'p2', 'p3', 'recorderP0', 'recorderP2', 'p1Handoff', 'p2Handoff'].map(name => docs[name] || {});
  const authorityIdentityScope = docs.authority?.ownerDefinedPdp10AuthorityScopes?.identityScope || {};
  const c0 = p0.declarativeProductionProfile || {};
  const c1 = p1.caseOperationBindings || [];
  const c2 = p2.declarativeProductionInterface?.caseInterfaceBindings || [];
  const c3 = p3.caseExperiences || [];
  const scope2 = p2.declarativeProductionInterface || {};
  const c0Rows = c0.acceptanceClauses || [];
  const c0Ids = c0Rows.map(r => r.id);
  const c1Ids = c1.map(r => r.caseId);
  const c2Ids = c2.map(r => r.caseId);
  const c3Ids = c3.map(r => r.pdp0CaseId);
  for (const [name, ids] of [['PDP-0', c0Ids], ['PDP-1', c1Ids], ['PDP-2', c2Ids], ['PDP-3', c3Ids]]) {
    if (!sameSet(ids, caseIds)) fail(name + ': exact 61 canonical case identifiers missing, duplicated or displaced');
  }
  if (c0.additionalAcceptanceCaseCount !== 61 || c0.existingRecorderCaseCount !== 84)
    fail('PDP-0: existing 84 Recorder plus 61 nonduplicated declarative case denominator changed');
  if (p1.denominator?.operationBindings !== 61 || scope2.caseCount !== 61)
    fail('PDP-1/PDP-2: source-authored case binding denominator is not exactly 61');
  if (!sameSet(p1.originClasses || [], knownSourceKinds) ||
      !sameSet(c0.producerModes || [], knownSourceKinds))
    fail('PDP-0/PDP-1: REAL_CAPTURE, ANIMATION, MODEL_SIMULATION, GENERATIVE_MEDIA and PDP fixture source classes diverged');
  for (const [group, count] of Object.entries(groupCounts)) {
    if (c0Rows.filter(row => row.group === group).length !== count ||
        c1.filter(row => row.group === group).length !== count ||
        c2.filter(row => row.group === group).length !== count)
      fail(group + ': 17/22/12/10 phase-specific source counts differ');
  }
  const capIds = new Set([...raw.capabilities.matchAll(/^\s+- id:\s*(media\.[A-Za-z0-9_.-]+)\s*$/gm)].map(m => m[1]));
  const opIds = new Set([...raw.operations.matchAll(/^\s+- id:\s*(media\.(?:operation|operation-slice)\.[A-Za-z0-9_.-]+)\s*$/gm)].map(m => m[1]));
  const objectIds = new Set([...raw.domain.matchAll(/^\s+- id:\s*(media\.domain\.[A-Za-z0-9_.-]+)\s*$/gm)].map(m => m[1]));
  const screenIds = new Set([...raw.screens.matchAll(/^\s+- (?:id|screenId):\s*(media\.view\.[A-Za-z0-9_.-]+)\s*$/gm)].map(m => m[1]));
  const familyIds = new Set((p0.requirements || []).map(r => r.id));
  const byP1 = new Map(c1.map(r => [r.caseId, r]));
  const byP2 = new Map(c2.map(r => [r.caseId, r]));
  const byP3 = new Map(c3.map(r => [r.pdp0CaseId, r]));
  const journeyIds = new Set([...raw.journeys.matchAll(/^\s+- (?:id|journeyId):\s*(J-\d\d)\s*$/gm)].map(m => m[1]));
  for (const row of c0Rows) {
    if (!row.id) continue;
    const r1 = byP1.get(row.id), r2 = byP2.get(row.id);
    if (!capIds.has(row.capabilityLeafId)) fail(row.id + ': missing existing canonical capability leaf');
    if (!familyIds.has(row.parentRequirementId)) fail(row.id + ': missing existing canonical family requirement');
    if (!row.given || !row.when || !row.then || !row.rejection || !row.surfaceId)
      fail(row.id + ': incomplete positive, negative or surface semantics');
    if (!r1 || !r2) continue;
    const r3 = byP3.get(row.id);
    if (!r3 || r3.pdp1OperationRef !== r1.canonicalOperationRef ||
        r3.pdp2ScreenReuseRef !== r2.canonicalScreenReuseRef ||
        r3.surfaceId !== row.surfaceId || !journeyIds.has(r3.existingJourneyRef))
      fail(row.id + ': PDP-3 successor lacks exact P0/1/2 source and existing journey/screen binding');
    if (r1.capabilityRef !== row.capabilityLeafId || r2.capabilityRef !== row.capabilityLeafId ||
        r1.surfaceId !== row.surfaceId || r2.surfaceId !== row.surfaceId ||
        r1.parentRequirementId !== row.parentRequirementId)
      fail(row.id + ': capability/requirement/surface source authority drift between PDP-0/1/2');
    if (!opIds.has(r1.canonicalOperationRef) || r2.operationRef !== r1.canonicalOperationRef)
      fail(row.id + ': missing or mismatched canonical PDP-1 operation');
    if (!r2.sourceP1Binding?.includes('#caseOperationBindings/@caseId=' + row.id))
      fail(row.id + ': PDP-2 missing exact PDP-1 case binding');
    if (!r1.p0CaseSource?.endsWith('/@id=' + row.id))
      fail(row.id + ': PDP-1 missing exact PDP-0 canonical case source');
    if (!screenIds.has(r2.canonicalScreenReuseRef))
      fail(row.id + ': PDP-2 references a nonexistent existing experience screen');
    if (!r1.resultEvidenceRequired?.includes('effect-finality') ||
        !r2.statesRequired?.includes('OUTCOME_UNKNOWN'))
      fail(row.id + ': unknown-result and negative finality are not exposed');
    if (!r2.negative?.includes('no-fake-execution'))
      fail(row.id + ': falsely presenting scene rendering or source recording as an executed owner effect');
  }
  if (p3.denominators?.declarativeCases !== 61 || p3.denominators?.scopedTotal !== 145 ||
      p3.sourceBoundScenarios?.length !== 8)
    fail('PDP-3: scoped case, journey and 8 negative/positive scenario denominator drift');
  if (!sameSet(p1.existingCanonicalDomainRefs || [], domainIds) ||
      !domainIds.every(id => objectIds.has(id))) fail('PDP-1: canonical domain objects are missing, replaced or duplicated');
  const vals = p1.typedProductionValueDescriptors || [];
  if (vals.length !== 11 || !unique(vals.map(x => x.id)) ||
      vals.some(x => !x.requiredFields?.length || !x.invariant || !objectIds.has(x.ownerDomainRef)))
    fail('PDP-1: all 11 typed declarative value descriptions require existing owner objects and explicit fields');
  if (recorderP2.manualOperationParity?.canonicalOperationCount !== 52 ||
      recorderP2.manualOperationParity.operations?.length !== 52)
    fail('PDP-2: 52 Recorder manual operation discriminants/parity are not preserved');
  if (recorderP0.requirementCoverage?.scopedProfileCaseCount !== 84)
    fail('PDP-0: Recorder acceptance case denominator changed unexpectedly');
  if (!p1Handoff.handoffs?.pdp1ToPdp2CanonicalDomain?.declarativeProductionSpecialization?.source?.includes('declarative-production-contracts.yaml'))
    fail('PDP-1: downstream semantic handoff omits the new source-owned contract');
  if (!p2Handoff.handoffs?.pdp2ToPdp3DesignInterface?.sourceRefs?.includes(paths.p2))
    fail('PDP-2: downstream interface handoff omits the animation/simulation grammar');
  if (!recorderP2.authoritativeReuse?.declarativeProductionProjection?.includes('#declarativeProductionInterface'))
    fail('PDP-2: production Studio does not reference the unified presentation grammar');
  const oracle = p1.scientificReferenceOracles?.find(o => o.id === 'media.declarative.oracle.force-motion.v1');
  const m = oracle?.testInputs?.massKg, F = oracle?.testInputs?.forceN, t = oracle?.testInputs?.durationS;
  if (!(m > 0 && t > 0 && Number.isFinite(F)) ||
      Math.abs(F / m - oracle?.expected?.accelerationMPerS2) > 1e-12 ||
      Math.abs((F / m) * t - oracle?.expected?.finalVelocityMPerS) > 1e-12 ||
      Math.abs(0.5 * (F / m) * t * t - oracle?.expected?.displacementM) > 1e-12)
    fail('PDP-1: analytical force-and-motion oracle inconsistent, underdefined or unphysical');
  if (!scope2.simulationGrammar?.stateRule?.includes('tStory') ||
      !scope2.simulationGrammar?.stateRule?.includes('tSim') ||
      !scope2.simulationGrammar?.visualOutputs?.includes('never the reverse'))
    fail('PDP-2: simulation time and model/visual authority are conflated');
  if (scope2.tutorPutorIntegration?.evidenceOwner?.includes('TutorPutor') !== true ||
      scope2.headlessAndEmbeddedParity?.apiOnly?.includes('do not invent a real browser screen') !== true)
    fail('PDP-2: science/learner authority or headless no-fake-GUI rule missing');
  for (const [phase, status] of [['PDP-0', c0.status], ['PDP-1', p1.status], ['PDP-2', scope2.status]]) {
    if (status === 'DEV_COMPLETE') fail(phase + ': cannot self-declare current-source DEV_COMPLETE from source authoring alone');
  }
  const admission = p1.executionAdmissionBinding || {};
  const admissionSchema = admission.schema || {};
  const admissionProps = admissionSchema.properties || {};
  const sourceBindings = admissionProps.sourceBindingsByScene || {};
  const sceneAuthority = sourceBindings.additionalProperties || {};
  const sceneAuthorityProps = sceneAuthority.properties || {};
  const admissionRelation = admission.operationSchemaRelation || {};
  const admissionPlanRules = admissionRelation.planBindingRules || {};
  const admissionCurrentAuthority = admissionRelation.admissionContextBindingRules?.currentAuthority || {};
  const admissionAuthenticatedIdentity = admissionRelation.admissionContextBindingRules?.authenticatedIdentity || {};
  const admissionEffectFence = admissionRelation.effectBoundary?.beforeProviderDispatchRetryOrRestart || {};
  const inputCoverage = admissionRelation.operationInputCoverage || {};
  const authoritySchema = admissionProps.authority || {};
  const authorityRequired = authoritySchema.required || [];
  const authorityProperties = authoritySchema.properties || {};
  const engineSchema = admissionProps.enginesByStep || {};
  const engineEntry = engineSchema.additionalProperties || {};
  const reservationSchema = admissionProps.reservation || {};
  const projectSchema = admissionProps.project || {};
  const editLockSchema = admissionProps.editLocksByStep || {};
  const editLockEntry = editLockSchema.additionalProperties || {};
  const clocksSchema = admissionProps.clocks || {};
  const clockConversion = clocksSchema.properties?.conversions?.items || {};
  const authenticatedIdentityTuple = admissionAuthenticatedIdentity.tuple || {};
  const requiredSceneAuthorityFields = [
    'sourceVersionRef', 'sourceSha256', 'rightsRef', 'ownerDecisionRef', 'decisionExpiresAt', 'revocationEpoch',
  ];
  const sceneAuthoritySchemaIsTyped = sceneAuthorityProps.sourceVersionRef?.$ref === '#/$defs/versionRef' &&
    sceneAuthorityProps.sourceSha256?.$ref === '#/$defs/immutableSha256' &&
    sceneAuthorityProps.rightsRef?.$ref === '#/$defs/versionRef' &&
    sceneAuthorityProps.ownerDecisionRef?.$ref === '#/$defs/versionRef' &&
    sceneAuthorityProps.decisionExpiresAt?.format === 'date-time' &&
    sceneAuthorityProps.revocationEpoch?.$ref === '#/$defs/nonnegativeInt64';
  if (admission.id !== 'media.production.execution-admission.v3' ||
      admissionSchema.properties?.schemaVersion?.const !== 'media.production.execution-admission.v3')
    fail('PDP-1 H-02: execution admission must use the separately versioned v3 envelope');
  if (admission.runtimeAdmission !== 'NOT_ADMITTED')
    fail('PDP-1 H-02: source envelope cannot admit runtime effects');
  const engineRequired = ['identityKind', 'identity', 'immutableBuildSha256'];
  const reservationRequired = ['quoteRef', 'quoteVersion', 'reservationId', 'worstCaseCost', 'reservedCost', 'worstCaseCompute', 'reservedCompute', 'worstCaseTime', 'reservedTime'];
  const lockRequired = ['scopeKind', 'targetRef', 'ownerPrincipalId', 'leaseId', 'epoch', 'expiresAt'];
  if (!engineSchema.minProperties || !sameSet(engineEntry.required || [], engineRequired) ||
      engineEntry.additionalProperties !== false ||
      engineEntry.properties?.immutableBuildSha256?.$ref !== '#/$defs/digestOrNoEngine' ||
      !String(admissionRelation.planBindingRules?.planFingerprint || '').includes('PER_STEP_ENGINE_DIGESTS') ||
      !String(admissionRelation.planBindingRules?.changedEngineDigest || '').includes('ONLY_THAT_STEP_AND_DESCENDANTS'))
    fail('PDP-1 H-02: each step requires a closed engine/model/solver identity and immutable build digest or explicit NO_ENGINE with scoped fingerprint invalidation');
  if (!sameSet(reservationSchema.required || [], reservationRequired) ||
      reservationRequired.some(field => !reservationSchema.properties?.[field]) ||
      reservationSchema.properties?.quoteRef?.$ref !== '#/$defs/versionRef' ||
      reservationSchema.properties?.quoteVersion?.$ref !== '#/$defs/versionRef' ||
      reservationSchema.properties?.reservationId?.$ref !== '#/$defs/opaqueId' ||
      !['worstCaseCost', 'reservedCost', 'worstCaseCompute', 'reservedCompute', 'worstCaseTime', 'reservedTime']
        .every(field => reservationSchema.properties?.[field]?.$ref === '#/$defs/boundedQuantity') ||
      !String(admissionRelation.admissionContextBindingRules?.reservation?.reservedCostComputeAndTime || '').includes('SAME_UNIT') ||
      !String(admission.executionRule || '').includes('cover their corresponding worst-case bound in the same declared unit'))
    fail('PDP-1 H-02: quote/reservation must bound worst-case cost, compute and time in matching units');
  if (!authorityRequired.includes('decisionExpiresAt') || !authorityRequired.includes('revocationEpoch') ||
      authorityProperties.decisionExpiresAt?.format !== 'date-time' ||
      authorityProperties.revocationEpoch?.$ref !== '#/$defs/nonnegativeInt64' ||
      projectSchema.properties?.compareAndSet?.const !== 'REQUIRED' ||
      !projectSchema.required?.includes('expectedRevision'))
    fail('PDP-1 H-02: current rights decision expiry/revocation and expected-revision compare-and-set must be typed and required');
  if (!sameSet(editLockEntry.required || [], lockRequired) || editLockEntry.additionalProperties !== false ||
      !['SCENE', 'OUTPUT'].every(scope => editLockEntry.properties?.scopeKind?.enum?.includes(scope)) ||
      editLockEntry.properties?.targetRef?.$ref !== '#/$defs/versionRef' ||
      editLockEntry.properties?.ownerPrincipalId?.$ref !== '#/$defs/opaqueId' ||
      editLockEntry.properties?.leaseId?.$ref !== '#/$defs/opaqueId' ||
      editLockEntry.properties?.epoch?.$ref !== '#/$defs/positiveInt64' ||
      editLockEntry.properties?.expiresAt?.format !== 'date-time' ||
      !String(admissionRelation.admissionContextBindingRules?.editLock?.beforeEffectReadback || '').includes('LEASE_ID_EPOCH_AND_EXPIRY'))
    fail('PDP-1 H-02: effect locks must bind one exact target, scope, owner, lease, epoch and expiry');
  if (!sameSet(clocksSchema.required || [], ['storyClockRef', 'mediaClockRef', 'simulationClockRef', 'wallClockRef', 'conversions']) ||
      !sameSet(clockConversion.required || [], ['fromClockRef', 'toClockRef', 'numerator', 'denominator']) ||
      clockConversion.properties?.numerator?.$ref !== '#/$defs/positiveInt64' ||
      clockConversion.properties?.denominator?.$ref !== '#/$defs/positiveInt64')
    fail('PDP-1 H-02: all four clocks and directional positive rational conversions must be typed');
  if (!/before each dispatch, retry and restart/u.test(admission.executionRule || '') ||
      !String(admissionRelation.effectBoundary?.beforeProviderDispatchRetryOrRestart?.required || '').includes('RECHECK_CURRENT_AUTHORITY'))
    fail('PDP-1 H-02: current authorization, rights, quote and lock state must be rechecked at dispatch, retry and restart');
  const expectedIdentitySource = '.product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope';
  const identitySourceResolves = admissionAuthenticatedIdentity.source === expectedIdentitySource &&
    Boolean(docs.authority?.ownerDefinedPdp10AuthorityScopes?.identityScope);
  const authorityIdentityTupleIsComplete =
    String(authorityIdentityScope.tenantRef || '').includes('host-attested') &&
    String(authorityIdentityScope.tenantRef || '').includes('never caller body') &&
    String(authorityIdentityScope.principalRef || '').includes('host-attested') &&
    String(authorityIdentityScope.principalRef || '').includes('never caller body') &&
    String(authorityIdentityScope.delegationRef || '').includes('host-attested, current delegation') &&
    String(authorityIdentityScope.workspaceRef || '').includes('host-authorized workspace context') &&
    String(authorityIdentityScope.requiredObservation || '').includes('identity epoch') &&
    String(authorityIdentityScope.requiredObservation || '').includes('tenant, principal, delegation and workspace tuple') &&
    ['tenantId', 'principalId', 'delegation', 'workspaceAuthority'].every(field =>
      (authorityIdentityScope.callerClaimsNeverAuthority || []).includes(field)) &&
    String(authorityIdentityScope.unknownOrMismatched || '').includes('DENY before lookup or effect');
  if (!['identityContextRef', 'identityContextSha256', 'identityEpoch', 'tenantId', 'principalId',
    'delegationRef', 'workspaceRef', 'purposeRef']
        .every(field => authorityRequired.includes(field)) ||
      authorityProperties.identityContextRef?.$ref !== '#/$defs/versionRef' ||
      authorityProperties.identityContextSha256?.$ref !== '#/$defs/immutableSha256' ||
      authorityProperties.identityEpoch?.$ref !== '#/$defs/nonnegativeInt64' ||
      authorityProperties.delegationRef?.$ref !== '#/$defs/versionRef' ||
      authorityProperties.workspaceRef?.$ref !== '#/$defs/versionRef' ||
      !identitySourceResolves || !authorityIdentityTupleIsComplete ||
      !['tenantId', 'principalId', 'delegationRef', 'workspaceRef', 'identityEpoch'].every(field =>
        Object.hasOwn(authenticatedIdentityTuple, field)) ||
      !String(authenticatedIdentityTuple.tenantId || '').includes('CALLER_BODY_COMPARE_ONLY') ||
      !String(authenticatedIdentityTuple.principalId || '').includes('CALLER_BODY_COMPARE_ONLY') ||
      !String(authenticatedIdentityTuple.delegationRef || '').includes('CALLER_BODY_COMPARE_ONLY') ||
      !String(authenticatedIdentityTuple.workspaceRef || '').includes('CALLER_SELECTOR_CANNOT_WIDEN') ||
      authenticatedIdentityTuple.identityEpoch !== 'MUST_MATCH_CURRENT_TRUSTED_IDENTITY_EPOCH' ||
      admissionAuthenticatedIdentity.missingStaleOrMismatched !== 'NOT_ADMITTED_BEFORE_LOOKUP_OR_EFFECT' ||
      !String(admission.executionRule || '').includes('host-authenticated tenant, principal, delegation, workspace, and identity epoch tuple'))
    fail('PDP-1 H-02: complete host-attested identity tuple and current identity epoch must be source-bound, typed and fail closed');
  if (!/RESOLVER_OVERLOAD_REQUIRES_INPUT2_STRICTLY_PARSED_JSON_TO_BE_STRUCTURALLY_EQUAL_TO_THE_CANONICAL_PRODUCTION_SPEC_SCHEMA_WITH_THE_EXACT_SHARED_PDP1_\$DEFS_MATERIALIZED/.test(
      inputCoverage.input2ProductionSpecSchema || '') ||
      inputCoverage.notImplementedInputs?.includes('input2-shared-definitions-context-materialization')) {
    fail('PDP-1 H-02: input-2 schema context must bind the generated canonical schema with shared root $defs');
  }
  if (!admission.requiredFields?.includes('perSceneImmutableSourceVersionDigestRightsOwnerDecisionExpiryAndRevocation'))
    fail('PDP-1 H-02: v3 requiredFields omits per-scene immutable source authority');
  if (!admissionSchema.required?.includes('sourceBindingsByScene') || sourceBindings.type !== 'object' ||
      sourceBindings.minProperties !== 1 || sourceBindings.additionalProperties?.additionalProperties !== false ||
      !sameSet(sceneAuthority.required || [], requiredSceneAuthorityFields) ||
      !sceneAuthoritySchemaIsTyped)
    fail('PDP-1 H-02: v3 sourceBindingsByScene must be a required closed map of complete per-scene authority');
  if (!String(admission.executionRule || '').includes('sourceBindingsByScene keys must exactly equal ProductionSpec.sceneRefs') ||
      !String(admissionCurrentAuthority.sourceBindingsByScene?.keys || '').includes('EXACT_EQUAL_TO_PRODUCTION_SPEC_SCENE_REFS'))
    fail('PDP-1 H-02: source map keys must exactly cover ProductionSpec.sceneRefs');
  if (!String(admissionCurrentAuthority.sourceBindingsByScene?.captureStepIndex || '')
        .includes('capture-source-{i}_MUST_MATCH_PRODUCTION_SPEC_SCENE_REFS[i]') ||
      !String(admissionPlanRules.captureGuard || '').includes('EXACT_COMPILED_CAPTURE_NODE_ID_AND_SINGLETON_SCENE_REF') ||
      !String(admissionCurrentAuthority.sourceBindingsByScene?.guardIdentity || '').includes('EXACT_COMPILED_PLAN_CAPTURE_NODE_AND_SCENE_EDIT_LOCK_TARGET'))
    fail('PDP-1 H-02: capture guard must bind the exact indexed plan scene and matching scene-lock target');
  if (admissionEffectFence.implementationStatus !== 'NOT_WIRED_TO_H02_EXECUTION_PATH' ||
      admissionRelation.effectBoundary?.runtimeAdmission !== 'NOT_ADMITTED_PENDING_INDEPENDENT_SOURCE_REVIEW_AND_AUTHORITY_BACKED_ADAPTER')
    fail('PDP-1 H-02: runtime effect integration must remain unwired and NOT_ADMITTED');
  if (!/compiler-produced plan candidate/.test(admissionRelation.sourceOwnerDisposition || '') ||
      !/provenance is not attested/.test(admissionRelation.sourceOwnerDisposition || '') ||
      !/does not authorize runtime effects/.test(admissionRelation.sourceOwnerDisposition || ''))
    fail('PDP-1 H-02: compiler-produced plan candidate trust limitation is not explicit');
  return { errors, stats: { recorderCases: 84, declarativeCases: c0Rows.length, p1Bindings: c1.length, p2Bindings: c2.length, p3Bindings: c3.length, capabilityLeafCount: capIds.size, canonicalOperationIdentities: opIds.size, valueTypes: vals.length, recorderManualEdits: 52, originClasses: knownSourceKinds.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDeclarativeProductionDefinitions();
  process.stdout.write(JSON.stringify({ status: result.errors.length ? 'FAIL' : 'PASS', ...result }, null, 2) + '\n');
  if (result.errors.length) process.exitCode = 1;
}
