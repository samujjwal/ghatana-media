// Checks the Recorder/Studio DISCOVERY successor source identities and negative cases.
// This is a source-definition verifier, not a phase exit, runtime admission or certification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  registry: '.product-experience/surface-registry.yaml',
  topology: '.product-experience/surfaces/media-physical-topology.v1.json',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  p0: '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  domain: '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  p1: '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
};
const newSurfaceIds = [
  'media.surface.recorder-orchestrator',
  'media.surface.capture-adapters',
  'media.surface.production-studio',
  'media.surface.interactive-demo-player',
];
const stableCaseId = /^MEDIA-REC-P0-AC-\d{3}$/u;
const extract = (source, regex, group = 1) => [...source.matchAll(regex)].map(x => x[group]);
const sameSet = (left, right) =>
  left.length === right.length && new Set(left).size === left.length &&
  new Set(right).size === right.length && left.every(x => right.includes(x));
const yamlList = text => text.split(',').map(s => s.trim()).filter(Boolean);
const refPath = ref => String(ref).split('#', 1)[0];

export function verifyRecorderStudioDefinitions({root = defaultRoot, overrides = {}} = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const read = id => {
    const filename = paths[id];
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    return fs.readFileSync(path.join(root, filename), 'utf8');
  };
  const original = Object.fromEntries(Object.keys(paths).map(k => [k, read(k)]));
  const topology = JSON.parse(original.topology);
  const registry = original.registry;
  const registryIds = extract(registry, /^  - surfaceId: (\S+)/gm);
  const old = topology.recorderStudioConsumerSuccessor?.historicalConsumerIds ?? [];
  const added = topology.recorderStudioConsumerSuccessor?.addedLogicalConsumerSurfaceIds ?? [];
  const consumers = topology.consumerCrosswalk ?? [];
  const consumerIds = consumers.map(c => c.surfaceId);
  const physicals = topology.manifestCandidates ?? [];
  const physicalIds = physicals.map(c => c.surfaceId);
  const domains = extract(original.domain, /^\s+- id: (media\.domain\.\S+)/gm);
  if (physicals.length !== 26 || topology.activeManifestCandidateCount !== 26)
    fail('historical physical candidate denominator changed');
  if (topology.compositions?.length !== 7) fail('historical composition denominator changed');
  if (old.length !== 17 || added.length !== 4 || topology.recorderStudioConsumerSuccessor?.historicalPhaseCells !== 200)
    fail('historical 50×4 PDP population not preserved');
  if (!sameSet(added, newSurfaceIds)) fail('four proposed recorder/studio logical surface identities drifted');
  if (consumers.length !== 21 || topology.recorderStudioConsumerSuccessor?.currentConsumerCount !== 21)
    fail('successor consumer denominator is not 21');
  if (topology.recorderStudioConsumerSuccessor?.successorProposedPhaseCells !== 216)
    fail('successor proposed PDP denominator is not 54×4=216');
  if (!sameSet(registryIds, consumerIds)) fail('surface-registry and consumer crosswalk identities mismatch');
  if (old.some(id => !consumerIds.includes(id)) || old.some(id => added.includes(id)))
    fail('historical consumer identities were dropped or reused');
  if (new Set(physicalIds).size !== 26) fail('physical candidate identity duplicated');

  // Every new consumer is a declared logical contract/host-dependent boundary,
  // never a disguised deployed recorder or invented physical package.
  for (const id of newSurfaceIds) {
    const c = consumers.find(x => x.surfaceId === id);
    if (!c || !['HOST_DEPENDENT', 'CONTRACT_ONLY'].includes(c.bindingState)
        || c.physicalRefs?.length === 0 || !c.statusReason?.length
        || !c.sourceContracts?.length) {
      fail(id + ': missing explicit proposed host-only admission/contract record');
    }
    for (const ref of c?.physicalRefs ?? []) {
      if (!physicalIds.includes(ref)) fail(id + ': ungrounded physical host '+ref);
    }
    for (const ref of c?.sourceContracts ?? []) {
      if (!fs.existsSync(path.join(root, refPath(ref)))) fail(id + ': missing source '+ref);
    }
  }
  for (const p of physicals) {
    const inverse = consumers.filter(c => c.physicalRefs?.includes(p.surfaceId)).map(c => c.surfaceId).sort();
    if (!sameSet(inverse, p.consumerSurfaceRefs ?? []))
      fail(p.surfaceId + ': physical-to-consumer reverse refs not reconciled');
  }

  const req = original.requirements;
  const p0 = original.p0, p1 = original.p1, p2 = original.p2;
  const allCapIds = extract(original.capabilities.slice(original.capabilities.indexOf('\ncapabilities:\n')), /^  - id: (media\.[^\s]+)$/gm);
  const canonCaps = new Set(allCapIds);
  const canonReqIds = new Set(extract(req, /^- id: (MEDIA-REQ-CAP-[A-Z-]+)$/gm));
  if (allCapIds.length !== 462 || canonCaps.size !== 462) fail('historical 462 capability leaf identities changed');
  if (canonReqIds.size !== 38) fail('historical 38 requirement family identities changed');
  const caseSection = req.split('\nrecorderStudioProfile:\n')[1];
  if (!caseSection) return { errors: [...errors, 'canonical Recorder Studio requirements profile is missing'], stats: {} };
  const clauseChunks = caseSection.split(/^    - id: (MEDIA-REC-P0-AC-\d{3})\s*$/gm);
  const caseIds = [], positiveAndDenied = [];
  const caseDetails = new Map();
  for (let i = 1; i + 1 < clauseChunks.length; i += 2) {
    const id = clauseChunks[i], body = clauseChunks[i + 1];
    caseIds.push(id);
    const parent = body.match(/^      parentRequirementId: (\S+)/m)?.[1];
    const cap = body.match(/^      capabilityLeafId: (\S+)/m)?.[1];
    const surface = body.match(/^      surfaceId: (\S+)/m)?.[1];
    if (!canonReqIds.has(parent)) fail(id+': missing canonical parent requirement '+parent);
    if (!canonCaps.has(cap)) fail(id+': missing canonical capability leaf '+cap);
    if (!newSurfaceIds.includes(surface)) fail(id+': missing intended owner surface');
    if (!/^      given: ".+"/m.test(body) || !/^      when: ".+"/m.test(body)
       || !/^      then: ".+"/m.test(body) || !/^      rejection: ".+"/m.test(body))
      fail(id+': complete given/when/then/negative scenario is required');
    positiveAndDenied.push(id);
    caseDetails.set(id, {cap, surface});
  }
  if (caseIds.length !== 78 || new Set(caseIds).size !== 78 || caseIds.some(id => !stableCaseId.test(id)))
    fail('exactly 78 stable unique canonical Recorder Studio acceptance cases required');
  if (!req.includes('requiredClauseCount: 78') && !req.includes('requiredClauseCount: 78\n'))
    fail('profile denominator is not source-bound to 78');

  const capGroupRecords = [...p0.matchAll(/^  (REC-C\d{2}): \[([^\]]+)\]$/gm)];
  const capGroupCapabilities = new Map(capGroupRecords.map(m => [m[1], new Set(yamlList(m[2]))]));
  const p0BindingChunks = extract(p0, /^  REC-C\d{2}: \[([^\]]+)\]/gm);
  if (p0BindingChunks.length !== 8) fail('all eight previous Recorder Studio P0 capability groups must be present');
  for (const refs of p0BindingChunks) for (const cap of yamlList(refs))
    if (!canonCaps.has(cap)) fail('P0 Recorder Studio proposal has unbound capability '+cap);
  const p0SourceCases = extract(p0, /^    acceptanceCaseRefs: \[([^\]]+)\]/gm).flatMap(yamlList);
  if (!sameSet(p0SourceCases, caseIds)) fail('P0 feature profiles must exactly cover 78 canonical acceptance cases once');
  const p0FeatureIds = extract(p0, /^  - id: (media\.recorder\.profile\.[^\s]+)/gm);
  if (p0FeatureIds.length !== 16 || new Set(p0FeatureIds).size !== 16)
    fail('P0 sixteen profile areas must each have unique source identity');

  // A valid global acceptance-case set is insufficient: every case must belong
  // to the exact capability group AND owning consumer surface of its feature.
  // Otherwise a case may silently move between features without changing any
  // structural denominator or breaking the previous coverage check.
  const featureSection = p0.split('\nfeatureProfiles:\n')[1]?.split('\ncrossCuttingPolicies:\n')[0] ?? '';
  const featureChunks = featureSection.split(/^  - id: (media\.recorder\.profile\.[^\s]+)\s*$/gm);
  const locallyBoundCaseIds = [];
  for (let i = 1; i + 1 < featureChunks.length; i += 2) {
    const featureId = featureChunks[i], body = featureChunks[i + 1];
    const group = body.match(/^    ownerCapabilityGroup: (\S+)/m)?.[1];
    const surface = body.match(/^    ownerSurface: (\S+)/m)?.[1];
    const caseRefs = yamlList(body.match(/^    acceptanceCaseRefs: \[([^\]]+)\]/m)?.[1] ?? '');
    if (!capGroupCapabilities.has(group)) fail(featureId+': unrecognized owner capability group '+group);
    if (!newSurfaceIds.includes(surface)) fail(featureId+': unrecognized owner surface '+surface);
    if (!caseRefs.length) fail(featureId+': missing local acceptance cases');
    for (const caseId of caseRefs) {
      locallyBoundCaseIds.push(caseId);
      const detail = caseDetails.get(caseId);
      if (!detail) {
        fail(featureId+': unknown acceptance case '+caseId);
        continue;
      }
      if (detail.surface !== surface)
        fail(featureId+': '+caseId+' case surface differs from feature owner surface');
      if (!capGroupCapabilities.get(group)?.has(detail.cap))
        fail(featureId+': '+caseId+' capability leaf not bound by feature capability group '+group);
    }
  }
  if (!sameSet(locallyBoundCaseIds, caseIds))
    fail('P0 feature-local acceptance cases must exactly cover canonical cases once');
  if (featureChunks.length !== 1 + 2 * p0FeatureIds.length)
    fail('P0 feature section parser did not account for every feature identity');
  if (!p0.includes('negativeApplicability:') || !p0.includes('noFakeUserInterfaceForApiCli'))
    fail('P0 unsupported/non-GUI and fail-closed applicability missing');

  // Reuse exact Media domain identities; no second job store or conflated run/attempt.
  for (const name of ['media.domain.project-revision','media.domain.processing-job',
      'media.domain.job-attempt','media.domain.media-run','media.domain.artifact-version',
      'media.domain.timeline','media.domain.render-outcome']) {
    if (!domains.includes(name) || !p1.includes(name)) fail('PDP1 Recorder Studio misses existing canonical domain '+name);
  }
  if (p1.includes('extends: media.domain.media-job') || p1.includes('identity: [tenantId, jobId, attemptId]'))
    fail('PDP1 incorrectly merges Media job and attempt identity');
  const manualKinds = yamlList(p1.match(/^    operationKinds: \[([^\]]+)\]/m)?.[1] ?? '');
  const parityKinds = extract(p2, /^  - kind: ([a-z][a-z0-9-]+)$/gm);
  if (manualKinds.length !== 42 || !sameSet(manualKinds, parityKinds))
    fail('all 42 versioned PDP1 edit discriminants need exactly one PDP2 GUI/keyboard/CLI parity record');
  const p1ProposedOperations = extract(p1, /^    - id: (media\.recorder\.operation\.\S+)$/gm);
  if (p1ProposedOperations.length !== 15 || new Set(p1ProposedOperations).size !== 15)
    fail('PDP1 15 typed proposal operation contracts missing/duplicate');
  if (!p1.includes('OUTCOME_UNKNOWN') || !p1.includes('no-product-proof-manufactured'))
    fail('PDP1 explicit business truth/unknown finality missing');
  if (!p1.includes('SCOPED_PROJECTION_OF_EXISTING_MEDIA_DOMAIN_NOT_NEW_INDEPENDENT_STORE'))
    fail('PDP1 canonical nonduplicate identity rule missing');

  const p2Cases = extract(p2, /^      cases: \[([^\]]+)\]/gm).flatMap(yamlList);
  if (!sameSet(p2Cases, caseIds)) fail('PDP2 surface interface profiles must cover all 78 acceptance cases exactly once');
  if (extract(p2, /^    - id: media\.recorder\.p2\.group\./gm, 0).length !== 16)
    fail('PDP2 sixteen surface feature groups missing');
  if (!p2.includes('no-fictitious-product-screenshot') || !p2.includes('CONTENT_SECURITY_POLICY') && !p2.includes('content-security-policy'))
    fail('PDP2 headless no-GUI and interactive player security required');
  if (!p2.includes('status: SOURCE_AUTHORED_SUCCESSOR_PENDING_REVALIDATION')
    || !p0.includes('status: SOURCE_AUTHORED_SUCCESSOR_PENDING_REVALIDATION')
    || !p1.includes('status: SOURCE_AUTHORED_SUCCESSOR_PENDING_REVALIDATION'))
    fail('new PDP source status must not imply DEV_COMPLETE or Build admission');
  return {
    errors,
    stats: {
      historicalPhysical:26,historicalCompositions:7,historicalConsumers:17,
      successorConsumers:consumers.length,historicalPdpCells:200,proposedPdpCells:216,
      capabilityLeaves:canonCaps.size,parentRequirements:canonReqIds.size,
      recorderCases:caseIds.length,p0Groups:p0FeatureIds.length,
      p1OperationProposals:p1ProposedOperations.length,manualEditKinds:manualKinds.length,
      surfaceCount:newSurfaceIds.length,
    }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyRecorderStudioDefinitions();
  if (result.errors.length) {
    for (const error of result.errors) console.error('FAIL:', error);
    process.exitCode = 1;
  } else {
    console.log('Media Recorder Studio Discovery source contracts structurally reconciled');
    console.log(JSON.stringify(result.stats, null, 2));
    console.log('Definition validation only: phase DEV_COMPLETE, acceptance, runtime, and release are NOT asserted.');
  }
}
