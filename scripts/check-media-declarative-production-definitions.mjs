// PDP-0 → PDP-1 → PDP-2 declarative production source verification.
// Definition-only; native execution of this checker does not assert scientific/runtime admission.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
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
  for (const name of ['p0', 'p1', 'p2', 'p3', 'recorderP0', 'recorderP2', 'p1Handoff', 'p2Handoff']) {
    const doc = parseDocument(raw[name], { strict: true, uniqueKeys: true });
    if (doc.errors.length) {
      for (const issue of doc.errors) fail(name + ': native YAML parse or duplicate-key error: ' + issue.message);
      continue;
    }
    try { docs[name] = doc.toJS(); } catch (error) { fail(name + ': unsupported document shape: ' + error.message); }
  }
  const [p0, p1, p2, p3, recorderP0, recorderP2, p1Handoff, p2Handoff] =
    ['p0', 'p1', 'p2', 'p3', 'recorderP0', 'recorderP2', 'p1Handoff', 'p2Handoff'].map(name => docs[name] || {});
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
  if (vals.length !== 10 || !unique(vals.map(x => x.id)) ||
      vals.some(x => !x.requiredFields?.length || !x.invariant || !objectIds.has(x.ownerDomainRef)))
    fail('PDP-1: all 10 typed declarative value descriptions require existing owner objects and explicit fields');
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
  return { errors, stats: { recorderCases: 84, declarativeCases: c0Rows.length, p1Bindings: c1.length, p2Bindings: c2.length, p3Bindings: c3.length, capabilityLeafCount: capIds.size, canonicalOperationIdentities: opIds.size, valueTypes: vals.length, recorderManualEdits: 52, originClasses: knownSourceKinds.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDeclarativeProductionDefinitions();
  process.stdout.write(JSON.stringify({ status: result.errors.length ? 'FAIL' : 'PASS', ...result }, null, 2) + '\n');
  if (result.errors.length) process.exitCode = 1;
}
