// Checks the Recorder/Studio DISCOVERY successor source identities and negative cases.
// This is a source-definition verifier, not a phase exit, runtime admission or certification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  registry: '.product-experience/surface-registry.yaml',
  topology: '.product-experience/surfaces/media-physical-topology.v1.json',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  actorCatalog: '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  p0: '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  domain: '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  p1: '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  journeyCatalog: '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
  domainVersioning: '.product-experience/pdp-1-domain-data/versioning.yaml',
  interfaceGrammar: '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
  editingGrammar: '.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml',
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
  const parsedDocs = {};
  // Syntax and duplicate mapping keys are source-level errors, even when
  // count-based selectors coincidentally find every expected line.
  for (const id of ['registry', 'requirements', 'actorCatalog', 'p0', 'journeyCatalog', 'domain', 'domainVersioning', 'p1', 'interfaceGrammar', 'editingGrammar', 'p2']) {
    const document = parseDocument(original[id], {uniqueKeys:true, strict:true});
    parsedDocs[id] = document;
    for (const issue of document.errors) fail(id+': invalid or duplicate YAML mapping: '+issue.message);
  }
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

  // The new surfaces are logical child contracts of canonical consumer surfaces.
  // The owning PDP-0 Product Truth states the intent; registry and physical
  // crosswalk must project its exact parent, rather than creating orphaned or
  // mutually contradictory surface trees.
  let productSurfaceSpecs = [], registrySurfaceSpecs = [];
  try {
    productSurfaceSpecs = parseDocument(original.p0, {uniqueKeys:true, strict:true}).toJS()?.surfaces ?? [];
    registrySurfaceSpecs = parseDocument(original.registry, {uniqueKeys:true, strict:true}).toJS()?.surfaces ?? [];
  } catch (error) {
    fail('Recorder Studio parent hierarchy cannot be read from valid YAML: '+error.message);
  }
  const actorDocument = parseDocument(original.actorCatalog, {uniqueKeys:true, strict:true}).toJS();
  const canonicalActorIds = new Set((actorDocument?.actors ?? []).map(x => x.id));
  const p0Document = parseDocument(original.p0, {uniqueKeys:true, strict:true}).toJS();
  const declaredActorIds = p0Document?.actors ?? [];
  if (canonicalActorIds.size < 8 || declaredActorIds.length < 1)
    fail('Recorder Studio requires a source-grounded set of canonical participant actors');
  for (const ref of declaredActorIds)
    if (!canonicalActorIds.has(ref)) fail('Recorder Studio declares an unknown canonical actor '+ref);
  const specs = new Map(productSurfaceSpecs.map(x => [x.id, x]));
  const registered = new Map(registrySurfaceSpecs.map(x => [x.surfaceId, x]));
  if (specs.size !== newSurfaceIds.length || productSurfaceSpecs.length !== newSurfaceIds.length)
    fail('PDP-0 must have exactly four distinct new logical surface definitions');
  for (const id of newSurfaceIds) {
    const sourceSurface = specs.get(id);
    const registeredSurface = registered.get(id);
    const consumer = consumers.find(x => x.surfaceId === id);
    const parentId = sourceSurface?.parent;
    if (!parentId || parentId === id || !old.includes(parentId)
      || !consumers.some(x => x.surfaceId === parentId))
      fail(id+': PDP-0 parent is not a retained canonical consumer surface');
    if (registeredSurface?.parentSurfaceId !== parentId)
      fail(id+': surface registry parent differs from PDP-0 parent');
    if (consumer?.parentSurfaceId !== parentId)
      fail(id+': physical consumer crosswalk parent differs from PDP-0 parent');
    if (registeredSurface?.surfaceType !== consumer?.consumerType)
      fail(id+': registry surface type differs from consumer crosswalk type');
    if (registeredSurface?.semanticStatus !== 'PROPOSED'
      || registeredSurface?.implementationStatus !== 'SOURCE_ONLY'
      || registeredSurface?.qualificationStatus !== 'PENDING')
      fail(id+': successor consumer must remain explicitly source-only and unqualified');
    if (sourceSurface?.interfaceRequired !== true)
      fail(id+': PDP-0 must declare applicable interface design even for headless surfaces');
  }

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
  const requirementLeaves = new Map((parsedDocs.requirements.toJS()?.requirements ?? [])
    .map(r => [r.id, new Set(r.capabilityIds ?? [])]));
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
    if (!requirementLeaves.get(parent)?.has(cap))
      fail(id+': canonical parent requirement does not own capability leaf '+cap);
    if (!newSurfaceIds.includes(surface)) fail(id+': missing intended owner surface');
    if (!/^      given: ".+"/m.test(body) || !/^      when: ".+"/m.test(body)
       || !/^      then: ".+"/m.test(body) || !/^      rejection: ".+"/m.test(body))
      fail(id+': complete given/when/then/negative scenario is required');
    positiveAndDenied.push(id);
    caseDetails.set(id, {cap, surface, group: body.match(/^      group: (\S+)/m)?.[1]});
  }
  if (caseIds.length !== 84 || new Set(caseIds).size !== 84 || caseIds.some(id => !stableCaseId.test(id)))
    fail('exactly 84 stable unique canonical Recorder Studio acceptance cases required');
  const requiredCaseCount = Number(caseSection.match(/^  requiredClauseCount: (\d+)$/m)?.[1]);
  const p0CaseCount = Number(p0.match(/^  scopedProfileCaseCount: (\d+)$/m)?.[1]);
  if (requiredCaseCount !== 84 || p0CaseCount !== 84 || requiredCaseCount !== caseIds.length)
    fail('Recorder Studio requirement and PDP-0 scoped case counts must agree at exactly 84');
  if (!sameSet(caseIds, Array.from({length:84}, (_, i) => 'MEDIA-REC-P0-AC-'+String(i+1).padStart(3,'0'))))
    fail('Recorder Studio canonical acceptance case IDs must be contiguous and lossless');
  const historicalReqCount = Number(req.match(/^  historicalFamilyRequirementsPreserved: (\d+)$/m)?.[1]);
  const historicalCapCount = Number(req.match(/^  historicalCapabilityLeavesPreserved: (\d+)$/m)?.[1]);
  if (historicalReqCount !== canonReqIds.size || historicalCapCount !== canonCaps.size)
    fail('Recorder Studio profile may not redefine historical family or capability denominators');

  const capGroupRecords = [...p0.matchAll(/^  (REC-C\d{2}): \[([^\]]+)\]$/gm)];
  const capGroupCapabilities = new Map(capGroupRecords.map(m => [m[1], new Set(yamlList(m[2]))]));
  const p0BindingChunks = extract(p0, /^  REC-C\d{2}: \[([^\]]+)\]/gm);
  if (p0BindingChunks.length !== 8) fail('all eight previous Recorder Studio P0 capability groups must be present');
  for (const refs of p0BindingChunks) for (const cap of yamlList(refs))
    if (!canonCaps.has(cap)) fail('P0 Recorder Studio proposal has unbound capability '+cap);
  const p0SourceCases = extract(p0, /^    acceptanceCaseRefs: \[([^\]]+)\]/gm).flatMap(yamlList);
  if (!sameSet(p0SourceCases, caseIds)) fail('P0 feature profiles must exactly cover 84 canonical acceptance cases once');
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
  const locallyBoundActorRefs = [];
  for (let i = 1; i + 1 < featureChunks.length; i += 2) {
    const featureId = featureChunks[i], body = featureChunks[i + 1];
    const group = body.match(/^    ownerCapabilityGroup: (\S+)/m)?.[1];
    const surface = body.match(/^    ownerSurface: (\S+)/m)?.[1];
    const caseRefs = yamlList(body.match(/^    acceptanceCaseRefs: \[([^\]]+)\]/m)?.[1] ?? '');
    const participantActors = yamlList(body.match(/^    participantActorRefs: \[([^\]]+)\]/m)?.[1] ?? '');
    if (participantActors.length === 0 || new Set(participantActors).size !== participantActors.length)
      fail(featureId+': unique canonical participant actor references are required');
    for (const ref of participantActors) {
      locallyBoundActorRefs.push(ref);
      if (!canonicalActorIds.has(ref) || !declaredActorIds.includes(ref))
        fail(featureId+': unknown or unscoped canonical participant actor '+ref);
    }
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
  if (!sameSet([...new Set(locallyBoundActorRefs)], declaredActorIds))
    fail('PDP-0 participant actor aggregate differs from feature-level actor references');
  if (!p0.includes('actorBindingRule:') || !p0.includes('interactiveAudienceRule:'))
    fail('actor participants may not imply grants, domain effects, publication or viewer authority');
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
  const declaredManualParityCount = Number(p2.match(/^  canonicalOperationCount: (\d+)$/m)?.[1]);
  if (declaredManualParityCount !== manualKinds.length)
    fail('PDP-2 manual operation parity denominator differs from owning PDP-1 discriminants');
  if (manualKinds.length !== 52 || !sameSet(manualKinds, parityKinds))
    fail('all 52 versioned PDP1 edit discriminants need exactly one PDP2 GUI/keyboard/CLI parity record');
  const p1ProposedOperations = extract(p1, /^    - id: (media\.recorder\.operation\.\S+)$/gm);
  if (p1ProposedOperations.length !== 15 || new Set(p1ProposedOperations).size !== 15)
    fail('PDP1 15 typed proposal operation contracts missing/duplicate');
  // Check semantic ownership rather than accepting a green count for 84
  // source cases and 52 edit kinds that might be incorrectly cross-bound.
  const p1Doc = parsedDocs.p1.toJS(), p2Doc = parsedDocs.p2.toJS();
  const ownedOperations = p1Doc.canonicalOperationProposals?.records ?? [];
  const p1Crosswalk = p1Doc.pdp0CaseOperationCrosswalk?.groups ?? [];
  const p2Crosswalk = p2Doc.pdp0AcceptanceCaseProjection?.groups ?? [];
  const p1Groups = new Map(p1Crosswalk.map(row => [row.groupId, row]));
  const p2Groups = new Map(p2Crosswalk.map(row => [
    String(row.id ?? '').split('.group.')[1]?.replace('.v1', '').toUpperCase(), row
  ]));
  const groups = new Set([...caseDetails.values()].map(row => row.group));
  if (p1Groups.size !== 16 || p2Groups.size !== 16 || groups.size !== 16)
    fail('PDP0-PDP1-PDP2 16 unique feature group identities are required');
  const opIds = new Set(p1ProposedOperations);
  for (const group of groups) {
    const actualCases = caseIds.filter(id => caseDetails.get(id)?.group === group);
    const p1Group=p1Groups.get(group), p2Group=p2Groups.get(group);
    if (!p1Group || !p2Group) { fail(group+': missing source feature group'); continue; }
    if (!sameSet(actualCases,p1Group.acceptanceCaseIds ?? []))
      fail(group+': wrong canonical PDP1 case-to-operation binding');
    if (!sameSet(actualCases,p2Group.cases ?? []))
      fail(group+': wrong canonical PDP2 case-to-interface binding');
    if (!sameSet(p1Group.proposedPdp1OperationRefs ?? [],p2Group.pdp1OperationRefs ?? []))
      fail(group+': PDP1/PDP2 operation selection mismatch');
    for (const op of [...(p1Group.proposedPdp1OperationRefs ?? []),...(p2Group.pdp1OperationRefs ?? [])])
      if (!opIds.has(op)) fail(group+': missing PDP1 proposed operation '+op);
    const owner=caseDetails.get(actualCases[0])?.surface;
    if (owner !== p2Group.surfaceId || !actualCases.every(id => caseDetails.get(id)?.surface === owner))
      fail(group+': wrong PDP2 owner surface');
    if (!p2Group.presentation || !p2Group.denialRecovery)
      fail(group+': PDP2 requires visible presentation and safe denial/recovery');
  }
  for (const op of ownedOperations) {
    if (!['OBSERVATION_ONLY','LOCAL_CANDIDATE_OR_DRAFT','CANONICAL_PRODUCT_STATE_CHANGE','GOVERNED_EXTERNAL_REQUEST'].includes(op.effectBoundary)
        || !Array.isArray(op.requestFields) || !op.requestFields.length
        || !Array.isArray(op.resultVariants) || !op.resultVariants.length
        || !Array.isArray(op.negativeCases) || !op.negativeCases.includes('wrong-tenant')
        || !op.invariant || op.runtimeStatus !== 'NOT_ADMITTED')
      fail('PDP1 proposed operation missing typed effect/request/result/tenant denial/currentness: '+op.id);
  }
  const manualParity=p2Doc.manualOperationParity?.operations ?? [];
  if (manualParity.length !== 52 || p2Doc.manualOperationParity?.canonicalOperationCount !== 52)
    fail('PDP2 manual parity count must match 52 canonical edit operations');
  for (const op of manualParity) {
    if (op.owningProjectMutation !== 'media.recorder.operation.edit.commit.v1'
        || op.cliSdkApiIntent !== 'media.recorder.edit-operation.'+op.kind
        || op.expectedRevisionRequired !== true || !op.gui || !op.keyboardAndTextEquivalent
        || !op.denial || !op.manualLockAndUndoPolicy)
      fail('PDP2 manual operation missing exact GUI/keyboard/CLI/API/version/denial parity: '+op.kind);
  }
  const valueDefs = parsedDocs.p1.toJS()?.derivedValueObjects ?? [];
  const designBindings = parsedDocs.p2.toJS()?.sourceBoundEditorValueContracts?.definitions ?? [];
  const requiredBoundedValues = ['transform','effect','render-profile','run-receipt'];
  for (const name of requiredBoundedValues) {
    const valueId = 'media.recorder.value.'+name+'.v1';
    const source = valueDefs.find(v => v.id === valueId);
    const binding = designBindings.find(v => v.valueRef === valueId);
    if (!source || !source.fields?.length || !source.acceptanceCaseRefs?.length
        || source.classification !== 'SCOPED_PROJECTION_OF_EXISTING_MEDIA_DOMAIN_NOT_NEW_INDEPENDENT_STORE')
      fail('PDP1 source-bound Studio value projection missing or duplicating authority: '+valueId);
    if (!binding || !binding.editor || !binding.keyboardTextParity || !binding.denial)
      fail('PDP2 Studio value needs editor/keyboard/API and denial parity: '+valueId);
  }
  if (!p1.includes('OUTCOME_UNKNOWN') || !p1.includes('no-product-proof-manufactured'))
    fail('PDP1 explicit business truth/unknown finality missing');
  if (!p1.includes('SCOPED_PROJECTION_OF_EXISTING_MEDIA_DOMAIN_NOT_NEW_INDEPENDENT_STORE'))
    fail('PDP1 canonical nonduplicate identity rule missing');

  const p2Cases = extract(p2, /^      cases: \[([^\]]+)\]/gm).flatMap(yamlList);
  if (!sameSet(p2Cases, caseIds)) fail('PDP2 surface interface profiles must cover all 84 acceptance cases exactly once');
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
