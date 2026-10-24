import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = process.cwd();
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const DIRECTION_REF = `${DIR}/media-pdp0-cohort02-root-source-authoring-direction-r1-2026-10-23.json`;
const CANDIDATE_REF = `${DIR}/media-pdp0-cohort02-11-root-directed-source-candidates.v2.json`;
const CURRENT_BASELINE_REF = `${DIR}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`;
const PRIOR_PROJECTION_REF = `${DIR}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`;
const SURFACE_REGISTRY_REF = '.product-experience/surface-registry.yaml';
const PHYSICAL_TOPOLOGY_REF = '.product-experience/surfaces/media-physical-topology.v1.json';
const PDP0_STATUS_REF = 'docs/implementation/pdp-0-phase-dev-status.json';
const CAP_REF = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ_REF = '.product-experience/pdp-0-product-truth/requirements.yaml';
const LEAF_REF = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const CROSSWALK_REF = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const TARGETS = [CAP_REF, REQ_REF, LEAF_REF, CROSSWALK_REF];
const OPS_REF = `${DIR}/cohort-02.r8-root-directed-source-projector-operations.v1.json`;
const MANIFEST_REF = `${DIR}/cohort-02.r8-root-directed-source-postimages.v1.json`;
const OUTPUTS = {
  [CAP_REF]: `${DIR}/cohort-02.r8-root-directed-capabilities.postimage.yaml`,
  [REQ_REF]: `${DIR}/cohort-02.r8-root-directed-requirements.postimage.yaml`,
  [LEAF_REF]: `${DIR}/cohort-02.r8-root-directed-capability-leaf-review.postimage.yaml`,
  [CROSSWALK_REF]: `${DIR}/cohort-02.r8-root-directed-crosswalk.postimage.json`,
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (ref) => fs.readFileSync(path.join(ROOT, ref));
const parseJson = (ref) => JSON.parse(read(ref).toString('utf8'));
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

function parseYaml(bytes, ref) {
  const doc = YAML.parseDocument(bytes.toString('utf8'), {uniqueKeys: true, prettyErrors: true});
  ensure(doc.errors.length === 0, `${ref} is invalid YAML: ${doc.errors.map((error) => error.message).join('; ')}`);
  return doc;
}

function sequence(doc, key, label) {
  const seq = doc.get(key, true);
  ensure(seq && Array.isArray(seq.items), `${label}.${key} must be a sequence`);
  return seq;
}

function recordWithSourceScope(feature) {
  const capability = structuredClone(feature.proposedCapability);
  const slots = capability.ownerDefinition?.typedInputSlots ?? [];
  const outputs = capability.ownerDefinition?.successOutputs ?? [];
  ensure(capability.id && capability.operation && slots.length && outputs.length, `${feature.auditId} lacks typed operation/input/output semantics`);
  ensure(capability.acceptanceCases?.length === 2, `${feature.auditId} must contain a positive and negative leaf case`);
  const leafCases = capability.acceptanceCases.map((item) => {
    ensure(['POSITIVE', 'NEGATIVE'].includes(item.polarity), `${feature.auditId} leaf case ${item.id} has invalid polarity`);
    ensure([item.id, item.given, item.when, item.then].every((value) => typeof value === 'string' && value.length > 0), `${feature.auditId} leaf case is incomplete`);
    return {id: item.id, polarity: item.polarity, record: {given: item.given, when: item.when, then: item.then}};
  });
  capability.scopeStatus = 'TARGET';
  capability.outcome = capability.ownerDefinition.semanticOutcomeContract.intent;
  capability.sourceScope = {
    sourceFeature: feature.sourceFeature.text,
    sourceAcceptanceCriterion: feature.sourceAcceptanceCriterion,
    sourceRef: feature.sourceFeature.sourceRef,
    rootDirectionRef: DIRECTION_REF,
  };
  capability.inputArtifactTypes = [...new Set(slots.map((slot) => slot.sourceType))];
  capability.outputArtifactTypes = [...new Set(outputs.map((output) => output.artifactType))];
  capability.acceptanceCases = [];
  return {capability, leafCases};
}

function validateOverlapPackets(packets) {
  ensure(packets.length === 2, `expected two full overlap packets; found ${packets.length}`);
  for (const packet of packets) {
    ensure(packet.alternatives?.length === 2, `${packet.auditId} must retain shared and split alternatives`);
    const options = packet.alternatives.map((item) => item.optionId);
    ensure(options.includes('A_ONE_SHARED_SEMANTIC_CONTRACT') && options.includes('B_SPLIT_BY_OPERATION_SCOPE'), `${packet.auditId} alternatives are incomplete`);
    ensure(packet.alternatives.every((item) => item.selectionStatus !== 'SELECTED' && item.selected !== true), `${packet.auditId} has a selected shared/split alternative; this R8 cut cannot choose it`);
    for (const alternative of packet.alternatives) {
      ensure(alternative.capabilityPackages?.length > 0, `${packet.auditId}/${alternative.optionId} has no typed capability packages`);
      for (const packageRow of alternative.capabilityPackages) {
        const capability = packageRow.capability;
        ensure(capability?.id && capability?.operation && capability.ownerDefinition?.typedInputSlots?.length > 0
          && capability.ownerDefinition?.successOutputs?.length > 0 && capability.ownerDefinition?.nonSuccessOutputs
          && capability.acceptanceCases?.length === 2, `${packet.auditId}/${alternative.optionId} has an incomplete typed capability`);
        ensure(capability.acceptanceCases.some((item) => item.polarity === 'POSITIVE')
          && capability.acceptanceCases.some((item) => item.polarity === 'NEGATIVE'), `${capability.id} must include positive and adverse cases`);
        for (const item of capability.acceptanceCases) {
          ensure([item.id, item.given, item.when, item.then].every((value) => typeof value === 'string' && value.length > 0), `${capability.id} has an incomplete case`);
        }
        ensure(Array.isArray(packageRow.requirementIds) && packageRow.requirementIds.length > 0
          && Array.isArray(packageRow.requirementCases)
          && packageRow.requirementCases.length === packageRow.requirementIds.length,
        `${capability.id} overlap packet requirement case groups do not match its requirement bindings`);
        for (const group of packageRow.requirementCases) {
          ensure(packageRow.requirementIds.includes(group.requirementId), `${capability.id} has an unbound overlap parent case group`);
          for (const polarity of ['positive', 'negative']) {
            const item = group[polarity];
            ensure(item?.id && item?.given && item?.when && item?.then, `${capability.id} overlap parent ${polarity} case is incomplete`);
          }
        }
      }
    }
  }
}

function main() {
  const directionBytes = read(DIRECTION_REF);
  const direction = JSON.parse(directionBytes.toString('utf8'));
  const candidateBytes = read(CANDIDATE_REF);
  const candidate = JSON.parse(candidateBytes.toString('utf8'));
  const baselineBytes = read(CURRENT_BASELINE_REF);
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  const registryBytes = read(SURFACE_REGISTRY_REF);
  const registry = parseYaml(registryBytes, SURFACE_REGISTRY_REF).toJSON();
  const topologyBytes = read(PHYSICAL_TOPOLOGY_REF);
  const topology = JSON.parse(topologyBytes.toString('utf8'));
  const phaseStatusBytes = read(PDP0_STATUS_REF);
  const phaseStatus = JSON.parse(phaseStatusBytes.toString('utf8'));
  const priorProjectionBytes = read(PRIOR_PROJECTION_REF);
  const priorProjection = JSON.parse(priorProjectionBytes.toString('utf8'));
  ensure(direction.schemaVersion === 'media.pdp0.root-source-authoring-direction.v1' && direction.decisions.length === 11, 'root direction does not match the selected 11-decision source-authoring cut');
  ensure(candidate.schemaVersion === 'media.pdp0.cohort02.root-directed-source-candidate-packages.v2', 'unsupported root-directed candidate schema');
  ensure(candidate.rootAuthoringDirection.sha256 === sha(directionBytes), 'root-directed candidate does not bind the exact root direction');
  ensure(candidate.selectedFeatureCandidates?.length === 9 && candidate.sourcePacketRepairs?.length === 2, 'expected nine selected feature definitions and two overlap packet repairs');
  ensure(candidate.denominators?.registeredSubjectIdentityDenominator === 54
    && candidate.denominators?.phaseCells === 216
    && candidate.denominators?.historicalBaseRecords === 462
    && candidate.denominators?.featureCandidatesAuthored === 9
    && candidate.denominators?.packetRepairsAuthored === 2
    && candidate.denominators?.sourceFeaturesExcluded === 0
    && candidate.denominators?.ownerAdoptionDecisionsCreated === 0
    && candidate.denominators?.canonicalApply === 'NOT_PERFORMED', 'root candidate denominator or authority boundary changed');
  ensure(topology.manifestCandidates?.length === 26 && topology.compositions?.length === 7 && topology.consumerCrosswalk?.length === 21,
    'live physical topology does not preserve 26 physical + 7 composite/root + 21 logical surfaces');
  ensure(registry.surfaces?.length === 21, 'live surface registry does not preserve its 21 logical surface denominator');
  ensure(phaseStatus.phase === 'PDP-0' && phaseStatus.status === 'IN_PROGRESS'
    && phaseStatus.campaignDenominator?.denominator === 54
    && phaseStatus.campaignDenominator?.physicalManifestCandidates === 26
    && phaseStatus.campaignDenominator?.compositions === 7
    && phaseStatus.campaignDenominator?.logicalConsumers === 21,
  'source-bound PDP-0 status or 54-surface campaign denominator changed');
  validateOverlapPackets(candidate.sourcePacketRepairs);

  const selected = new Map(direction.decisions.map((row) => [row.auditId, row]));
  for (const feature of candidate.selectedFeatureCandidates) {
    const decision = selected.get(feature.auditId);
    ensure(decision?.selectedOption === 'A_DEFINE_FEATURE_AS_A_DISTINCT_PDP0_LEAF', `${feature.auditId} is not root-selected for distinct leaf source authoring`);
    ensure(feature.rootAuthoringDecision?.directionSha256 === sha(directionBytes), `${feature.auditId} decision pin is stale`);
    ensure(feature.ownerAdoptionStatus === 'UNKNOWN' && feature.canonicalApply === 'NOT_PERFORMED', `${feature.auditId} improperly claims adoption or apply`);
  }

  const currentTargets = baseline.sourceBaseline ?? baseline.currentSourceBaseline?.targets ?? baseline.currentTargets ?? [];
  const pins = new Map(currentTargets.map((row) => [row.targetRef ?? row.path, row.sha256 ?? row.expectedSha256]));
  for (const feature of candidate.selectedFeatureCandidates) {
    for (const pin of feature.sourcePreimageHashes) ensure(pins.get(pin.targetRef) === pin.sha256, `${feature.auditId} source pin differs from current baseline for ${pin.targetRef}`);
  }
  ensure(sha(baselineBytes) === candidate.sourceCurrentBaseline.sha256, 'root candidate current-source baseline pin differs from exact baseline bytes');
  ensure(priorProjection.sourceCurrentBaselineSha256 === sha(baselineBytes), 'prior 248-case projection is based on a different current-source baseline');
  ensure(priorProjection.counts?.caseOperations === 248 && priorProjection.operations?.length === 248, 'prior projector operation count is not 248');

  const currentExpected = new Map((baseline.currentTargets ?? baseline.sourceBaseline ?? []).map((row) => [row.targetRef ?? row.path, row.sha256 ?? row.expectedSha256]));
  ensure(currentExpected.size === 7, `expected seven pinned live source targets; found ${currentExpected.size}`);
  for (const ref of TARGETS) {
    if (currentExpected.has(ref)) ensure(sha(read(ref)) === currentExpected.get(ref), `live input ${ref} is not at the exact current baseline`);
  }
  const priorTargets = new Map(priorProjection.projectedTargetSet.map((row) => [row.targetRef, row]));
  const baseSources = {};
  for (const ref of TARGETS) {
    const target = priorTargets.get(ref);
    ensure(target, `prior 248-case projection omits ${ref}`);
    const bytes = read(target.postimageRef);
    ensure(sha(bytes) === target.postimageSha256, `prior 248-case postimage pin mismatch for ${ref}`);
    baseSources[ref] = bytes;
  }

  const capDoc = parseYaml(baseSources[CAP_REF], CAP_REF);
  const reqDoc = parseYaml(baseSources[REQ_REF], REQ_REF);
  const leafDoc = parseYaml(baseSources[LEAF_REF], LEAF_REF);
  const caps = sequence(capDoc, 'capabilities', 'capabilities');
  const requirements = sequence(reqDoc, 'requirements', 'requirements');
  const capById = new Map(caps.items.map((item) => [item.get('id', true)?.toJSON(), item]));
  const reqById = new Map(requirements.items.map((item) => [item.get('id', true)?.toJSON(), item]));
  const opRows = [];
  const caseMappings = [];
  const traceUpdates = [];
  const allCaseIds = new Set();
  const allNewCapabilityIds = new Set();
  let operationSequence = 0;
  const op = (row) => ({operationId: `COH02-R8-${String(++operationSequence).padStart(3, '0')}`, ...row});

  for (const feature of candidate.selectedFeatureCandidates) {
    const {capability, leafCases} = recordWithSourceScope(feature);
    ensure(!capById.has(capability.id) && !allNewCapabilityIds.has(capability.id), `duplicate selected capability ${capability.id}`);
    allNewCapabilityIds.add(capability.id);
    const sourceCaseRef = `${CANDIDATE_REF}#/selectedFeatureCandidates/@auditId=${feature.auditId}/proposedCapability/acceptanceCases`;
    opRows.push(op({kind: 'ADD_CAPABILITY_DEFINITION', auditId: feature.auditId, targetRef: `${CAP_REF}#capabilities/@id=${capability.id}`, record: capability}));
    const requirementIds = capability.requirementIds ?? [];
    ensure(requirementIds.length > 0, `${capability.id} must bind to an existing parent requirement`);
    for (const requirementId of requirementIds) {
      const req = reqById.get(requirementId);
      ensure(req, `${capability.id} parent requirement ${requirementId} does not exist`);
      const capabilityIds = req.get('capabilityIds', true);
      ensure(capabilityIds && Array.isArray(capabilityIds.items), `${requirementId}.capabilityIds must be a sequence`);
      ensure(!capabilityIds.items.some((item) => item.toJSON() === capability.id), `${requirementId} already binds ${capability.id}`);
      capabilityIds.add(reqDoc.createNode(capability.id));
      opRows.push(op({kind: 'APPEND_REQUIREMENT_CAPABILITY_BINDING', auditId: feature.auditId, targetRef: `${REQ_REF}#requirements/@id=${requirementId}/capabilityIds`, capabilityId: capability.id}));
    }
    const capCases = caps.items.length;
    caps.add(capDoc.createNode(capability));
    capById.set(capability.id, caps.items.at(-1));
    for (const item of leafCases) {
      ensure(!allCaseIds.has(item.id), `duplicate new case identity ${item.id}`);
      allCaseIds.add(item.id);
      const target = capById.get(capability.id);
      const acceptanceCases = target.get('acceptanceCases', true);
      ensure(acceptanceCases && Array.isArray(acceptanceCases.items), `${capability.id}.acceptanceCases must be a sequence`);
      acceptanceCases.add(capDoc.createNode(item.record));
      const traceRef = `${sourceCaseRef}/@id=${item.id}`;
      opRows.push(op({kind: 'APPEND_CAPABILITY_CASE', auditId: feature.auditId, caseId: item.id, casePolarity: item.polarity, targetRef: `${CAP_REF}#capabilities/@id=${capability.id}/acceptanceCases`, sourceCaseRef: traceRef, record: item.record}));
      caseMappings.push({caseId: item.id, polarity: item.polarity, auditId: feature.auditId, targetRef: `${CAP_REF}#capabilities/@id=${capability.id}/acceptanceCases`, sourceCaseRef: traceRef, canonicalRecordSha256: sha(Buffer.from(canonical(item.record)))});
    }
    ensure(caps.items.length === capCases + 1, `capability append failed for ${capability.id}`);

    const parentCaseRefs = [];
    for (const group of feature.proposedParentRequirementCases ?? []) {
      const req = reqById.get(group.requirementId);
      ensure(req, `${feature.auditId} parent requirement ${group.requirementId} does not exist`);
      const acceptanceCases = req.get('acceptanceCases', true);
      ensure(acceptanceCases && Array.isArray(acceptanceCases.items), `${group.requirementId}.acceptanceCases must be a sequence`);
      for (const polarity of ['positive', 'negative']) {
        const item = group[polarity];
        ensure(item && item.id && item.given && item.when && item.then, `${feature.auditId} ${group.requirementId} ${polarity} case incomplete`);
        ensure(!allCaseIds.has(item.id), `duplicate new case identity ${item.id}`);
        allCaseIds.add(item.id);
        const record = {id: item.id, given: item.given, when: item.when, then: item.then};
        ensure(!acceptanceCases.items.some((existing) => existing.get('id', true)?.toJSON() === record.id), `parent case ${record.id} already exists`);
        acceptanceCases.add(reqDoc.createNode(record));
        const traceRef = `${CANDIDATE_REF}#/selectedFeatureCandidates/@auditId=${feature.auditId}/proposedParentRequirementCases/@requirementId=${group.requirementId}/${polarity}`;
        opRows.push(op({kind: 'APPEND_REQUIREMENT_CASE', auditId: feature.auditId, caseId: item.id, casePolarity: item.polarity, targetRef: `${REQ_REF}#requirements/@id=${group.requirementId}/acceptanceCases/@id=${item.id}`, sourceCaseRef: traceRef, record}));
        caseMappings.push({caseId: item.id, polarity: item.polarity, auditId: feature.auditId, targetRef: `${REQ_REF}#requirements/@id=${group.requirementId}/acceptanceCases/@id=${item.id}`, sourceCaseRef: traceRef, canonicalRecordSha256: sha(Buffer.from(canonical(record)))});
        parentCaseRefs.push(`${REQ_REF}#requirements/@id=${group.requirementId}/acceptanceCases/@id=${item.id}`);
      }
    }

    const crosswalk = JSON.parse(baseSources[CROSSWALK_REF].toString('utf8'));
    const crosswalkMatches = crosswalk.rows.filter((row) => row.auditId === feature.auditId);
    ensure(crosswalkMatches.length === 1, `${feature.auditId} must resolve to exactly one crosswalk row`);
    const row = crosswalkMatches[0];
    const refs = [
      `${CANDIDATE_REF}#/selectedFeatureCandidates/@auditId=${feature.auditId}/proposedCapability`,
      `${CAP_REF}#capabilities/@id=${capability.id}`,
      ...leafCases.map((item) => `${sourceCaseRef}/@id=${item.id}`),
      ...parentCaseRefs,
    ];
    row.pdp0ContextRefs ??= [];
    ensure(Array.isArray(row.pdp0ContextRefs), `${feature.auditId}.pdp0ContextRefs must be a sequence`);
    const toAppend = refs.filter((ref) => !row.pdp0ContextRefs.includes(ref));
    row.pdp0ContextRefs.push(...toAppend);
    traceUpdates.push({auditId: feature.auditId, crosswalkRef: `${CROSSWALK_REF}#rows/@auditId=${feature.auditId}/pdp0ContextRefs`, addedRefs: toAppend});
    opRows.push(op({kind: 'APPEND_CROSSWALK_CONTEXT_REFS', auditId: feature.auditId, targetRef: `${CROSSWALK_REF}#rows/@auditId=${feature.auditId}/pdp0ContextRefs`, refs: toAppend}));
    baseSources[CROSSWALK_REF] = Buffer.from(`${JSON.stringify(crosswalk, null, 2)}\n`);
  }

  const postimages = {
    [CAP_REF]: Buffer.from(capDoc.toString()),
    [REQ_REF]: Buffer.from(reqDoc.toString()),
    [LEAF_REF]: baseSources[LEAF_REF],
    [CROSSWALK_REF]: baseSources[CROSSWALK_REF],
  };
  const featureCaseCount = caseMappings.filter((row) => row.targetRef.startsWith(`${CAP_REF}#`)).length;
  const parentCaseCount = caseMappings.length - featureCaseCount;
  ensure(allNewCapabilityIds.size === 9 && featureCaseCount === 18 && parentCaseCount === 20 && allCaseIds.size === 38, 'projected feature/case operation totals do not match 9/18/20');

  const checkCapDoc = parseYaml(postimages[CAP_REF], CAP_REF);
  const checkReqDoc = parseYaml(postimages[REQ_REF], REQ_REF);
  const checkCaps = sequence(checkCapDoc, 'capabilities', 'postimage capabilities').items.map((item) => item.toJSON());
  const checkReqs = sequence(checkReqDoc, 'requirements', 'postimage requirements').items.map((item) => item.toJSON());
  for (const feature of candidate.selectedFeatureCandidates) {
    const expected = feature.proposedCapability;
    const matches = checkCaps.filter((row) => row.id === expected.id);
    ensure(matches.length === 1, `${expected.id} must appear exactly once in the owning capability postimage`);
    const actual = matches[0];
    ensure(actual.operation === expected.operation
      && actual.familyId === expected.familyId
      && canonical(actual.requirementIds) === canonical(expected.requirementIds)
      && canonical(actual.requiredAuthority) === canonical(expected.requiredAuthority)
      && canonical(actual.explicitUnsupportedCases) === canonical(expected.explicitUnsupportedCases)
      && canonical(actual.ownerDefinition) === canonical(expected.ownerDefinition), `${expected.id} semantic definition drifted during canonical-shape projection`);
    const expectedLeaf = expected.acceptanceCases.map(({given, when, then}) => ({given, when, then}));
    ensure(canonical(actual.acceptanceCases) === canonical(expectedLeaf), `${expected.id} positive/adverse leaf cases differ from the root-directed source packet`);
    for (const group of feature.proposedParentRequirementCases) {
      const req = checkReqs.find((row) => row.id === group.requirementId);
      ensure(req, `${feature.auditId} owning parent requirement ${group.requirementId} is absent`);
      ensure(req.capabilityIds.includes(expected.id), `${group.requirementId} does not trace the new capability ${expected.id}`);
      for (const polarity of ['positive', 'negative']) {
        const item = group[polarity];
        const projected = req.acceptanceCases.find((row) => row.id === item.id);
        ensure(projected && canonical(projected) === canonical({id: item.id, given: item.given, when: item.when, then: item.then}), `parent case ${item.id} is absent or structurally changed`);
      }
    }
  }
  const checkCrosswalk = JSON.parse(postimages[CROSSWALK_REF].toString('utf8'));
  ensure(checkCrosswalk.rows.length === 501, 'crosswalk row denominator changed');
  for (const feature of candidate.selectedFeatureCandidates) {
    const crosswalkRow = checkCrosswalk.rows.find((row) => row.auditId === feature.auditId);
    const refs = crosswalkRow?.pdp0ContextRefs ?? [];
    ensure(refs.some((ref) => ref.includes(`capabilities/@id=${feature.proposedCapability.id}`)), `${feature.auditId} capability trace path is absent`);
    const featureCaseIds = feature.proposedCapability.acceptanceCases.map((row) => row.id);
    const parentCaseIds = feature.proposedParentRequirementCases.flatMap((group) => [group.positive.id, group.negative.id]);
    ensure([...featureCaseIds, ...parentCaseIds].every((id) => refs.some((ref) => ref.includes(id))), `${feature.auditId} has missing new case trace paths`);
  }

  const featureIds = [...allNewCapabilityIds];
  const packetRepairs = structuredClone(candidate.sourcePacketRepairs);
  const operationBody = {
    schemaVersion: 'media.pdp0.cohort02.root-directed-source-projector-operations.v1',
    artifactId: 'MEDIA-PDP0-COHORT02-R8-ROOT-DIRECTED-SOURCE-PROJECTOR-OPERATIONS-2026-10-23',
    status: 'NON_CANONICAL_SOURCE_POSTIMAGE_PROJECTION; OWNER_ADOPTION_AND_CANONICAL_APPLY_NOT_PERFORMED',
    macroStage: 'DISCOVERY',
    phase: 'PDP-0 Product Truth',
    rootDirectionRef: DIRECTION_REF,
    rootDirectionSha256: sha(directionBytes),
    rootDirectedCandidateRef: CANDIDATE_REF,
    rootDirectedCandidateSha256: sha(candidateBytes),
    priorProjectionRef: PRIOR_PROJECTION_REF,
    priorProjectionSha256: sha(priorProjectionBytes),
    currentSourceBaselineRef: CURRENT_BASELINE_REF,
    currentSourceBaselineSha256: sha(baselineBytes),
    denominatorAuthorityPins: [
      {ref: SURFACE_REGISTRY_REF, sha256: sha(registryBytes), logicalSurfaceCount: 21},
      {ref: PHYSICAL_TOPOLOGY_REF, sha256: sha(topologyBytes), physicalSurfaceCount: 26, compositeIncludingRootCount: 7, logicalConsumerCount: 21},
      {ref: PDP0_STATUS_REF, sha256: sha(phaseStatusBytes), phaseStatus: phaseStatus.status, denominator: phaseStatus.campaignDenominator.denominator},
    ],
    projector: {kind: 'DETERMINISTIC_SOURCE_AUTHORING_POSTIMAGE_BUILDER', scriptRef: `${DIR}/build-cohort-02-root-directed-source-postimages-r8.mjs`, canonicalProjectorApply: 'NOT_PERFORMED'},
    operations: opRows,
    caseMappings,
    traceUpdates,
    overlapPacketRepairs: packetRepairs,
    counts: {sourceOperations: opRows.length, featureDefinitionsAdded: 9, leafCaseOperations: featureCaseCount, parentRequirementCaseOperations: parentCaseCount, totalNewCaseOperations: featureCaseCount + parentCaseCount, priorCaseOperationsPreserved: 248, cumulativeCaseOperations: 248 + featureCaseCount + parentCaseCount, sourceFeatureExclusions: 0, overlapPacketsRetained: packetRepairs.length, overlapOptionsRetained: packetRepairs.reduce((sum, packet) => sum + packet.alternatives.length, 0), overlapAlternativesSelected: 0},
    newCapabilityIds: featureIds,
    newCaseIds: caseMappings.map((row) => row.caseId),
    nonClaims: ['No canonical source write or apply was performed.', 'The new feature candidates remain proposed pending authentic canonical-owner adoption.', 'No shared or split overlap option was selected or projected.', 'No owner leaf-adjudication or trust-reconstruction record was fabricated; the 462 historical owner rows remain unchanged.'],
  };
  const operationBytes = Buffer.from(`${JSON.stringify(operationBody, null, 2)}\n`);
  const hashes = Object.fromEntries(TARGETS.map((ref) => [ref, sha(postimages[ref])]));
  const preimageHashes = Object.fromEntries(TARGETS.map((ref) => [ref, sha(read(priorTargets.get(ref).postimageRef))]));
  const baseLeaf = parseYaml(read(priorTargets.get(LEAF_REF).postimageRef), LEAF_REF).toJSON();
  const postLeaf = parseYaml(postimages[LEAF_REF], LEAF_REF).toJSON();
  const baseOwnerRecords = baseLeaf.ownerCapabilityLeafAdjudication.records;
  const postOwnerRecords = postLeaf.ownerCapabilityLeafAdjudication.records;
  ensure(baseOwnerRecords.length === 462 && postOwnerRecords.length === 462 && canonical(baseOwnerRecords) === canonical(postOwnerRecords), '462 historical owner leaf records were not preserved byte-semantically');
  const baseCrosswalk = JSON.parse(read(priorTargets.get(CROSSWALK_REF).postimageRef).toString('utf8'));
  const postCrosswalk = JSON.parse(postimages[CROSSWALK_REF].toString('utf8'));
  ensure(baseCrosswalk.rows.length === 501 && postCrosswalk.rows.length === 501, 'crosswalk historical row count changed');
  const manifest = {
    schemaVersion: 'media.pdp0.cohort02.root-directed-source-postimages.v1',
    artifactId: 'MEDIA-PDP0-COHORT02-R8-ROOT-DIRECTED-SOURCE-POSTIMAGES-2026-10-23',
    status: 'SOURCE_POSTIMAGES_REBUILT_EXACTLY; CANONICAL_APPLY_NOT_PERFORMED; OWNER_ADOPTION_PENDING',
    campaign: {repository: 'ghatana-media', macroStage: 'DISCOVERY', phase: 'PDP-0 Product Truth', physicalSurfaceDenominator: 26, compositeIncludingRootDenominator: 7, logicalSurfaceDenominator: 21, totalSurfaceDenominator: 54, phaseCellDenominator: 216, historicalBaseRecordDenominator: 462},
    rootDirectionRef: DIRECTION_REF,
    rootDirectionSha256: sha(directionBytes),
    rootDirectedCandidateRef: CANDIDATE_REF,
    rootDirectedCandidateSha256: sha(candidateBytes),
    currentSourceBaselineRef: CURRENT_BASELINE_REF,
    currentSourceBaselineSha256: sha(baselineBytes),
    denominatorAuthorityPins: [
      {ref: SURFACE_REGISTRY_REF, sha256: sha(registryBytes), logicalSurfaceCount: 21},
      {ref: PHYSICAL_TOPOLOGY_REF, sha256: sha(topologyBytes), physicalSurfaceCount: 26, compositeIncludingRootCount: 7, logicalConsumerCount: 21},
      {ref: PDP0_STATUS_REF, sha256: sha(phaseStatusBytes), phaseStatus: phaseStatus.status, denominator: phaseStatus.campaignDenominator.denominator},
    ],
    priorProjectionRef: PRIOR_PROJECTION_REF,
    priorProjectionSha256: sha(priorProjectionBytes),
    operationsRef: OPS_REF,
    operationsSha256: sha(operationBytes),
    postimages: TARGETS.map((ref) => ({targetRef: ref, preimageRef: priorTargets.get(ref).postimageRef, preimageSha256: preimageHashes[ref], postimageRef: OUTPUTS[ref], postimageSha256: hashes[ref], semanticMutationCount: ref === CAP_REF ? 27 : ref === REQ_REF ? 30 : ref === CROSSWALK_REF ? 9 : 0})),
    denominatorsAndPreservation: {physicalSurfaces: 26, compositesIncludingRoot: 7, logicalSurfaces: 21, totalSurfaces: 54, phaseCells: 216, historicalOwnerLeafRecordsBefore: 462, historicalOwnerLeafRecordsAfter: 462, crosswalkRowsBefore: 501, crosswalkRowsAfter: 501, priorProjectorCaseOperations: 248, newFeatureLeafCases: 18, newParentRequirementCasePairs: 10, newParentRequirementAcceptanceCases: 20, cumulativeProjectorCaseOperations: 286, sourceFeaturesExcluded: 0},
    overlapPacketDisposition: {packetCount: packetRepairs.length, alternativesPerPacket: packetRepairs.map((packet) => ({auditId: packet.auditId, options: packet.alternatives.map((item) => item.optionId)})), selectedAlternativeCount: 0, postimageMutation: 'NONE_PENDING_ROOT_SELECTION'},
    leafReviewDisposition: 'UNCHANGED_EXACT_PRIOR_SOURCE_POSTIMAGE; 462 HISTORICAL OWNER ADJUDICATION RECORDS PRESERVED; NO NEW OWNER DECISION AUTHORED',
    sourceCurrentness: 'Candidate postimages only. The live source baseline and source-bound PDP-0 status are unchanged; this artifact does not assert current PDP-0 DEV_COMPLETE.',
    canonicalApply: 'NOT_PERFORMED',
    validations: {rootDirectionPinMatches: true, candidateDirectionPinMatches: true, sevenTargetCurrentBaselinePinsMatch: true, fourPriorPostimagePinsMatch: true, nineSelectedDefinitionsProjected: true, eighteenLeafCasesProjected: true, tenParentCasePairsProjected: true, allNewFeatureAndCaseIdsHaveTracePaths: true, overlapPacketsTypedAndUnselected: true, historicalDenominatorsPreserved: true, exactRebuild: 'CHECK_WITH_BUILDER --check'},
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const outputs = {
    ...Object.fromEntries(TARGETS.map((ref) => [OUTPUTS[ref], postimages[ref]])),
    [OPS_REF]: operationBytes,
    [MANIFEST_REF]: manifestBytes,
  };
  const checkOnly = process.argv.includes('--check');
  const refreshOwned = process.argv.includes('--refresh-owned-r8');
  let previousOwnedPins = null;
  if (refreshOwned) {
    ensure(fs.existsSync(path.join(ROOT, MANIFEST_REF)), '--refresh-owned-r8 requires this builder’s existing R8 manifest');
    const previousManifest = parseJson(MANIFEST_REF);
    ensure(previousManifest.artifactId === 'MEDIA-PDP0-COHORT02-R8-ROOT-DIRECTED-SOURCE-POSTIMAGES-2026-10-23', 'existing manifest is not this builder’s owned R8 artifact');
    previousOwnedPins = new Map(previousManifest.postimages.map((row) => [row.postimageRef, row.postimageSha256]));
    previousOwnedPins.set(previousManifest.operationsRef, previousManifest.operationsSha256);
    previousOwnedPins.set(MANIFEST_REF, sha(read(MANIFEST_REF)));
  }
  for (const [ref, bytes] of Object.entries(outputs)) {
    const absolute = path.join(ROOT, ref);
    if (checkOnly) {
      ensure(fs.existsSync(absolute), `--check expected existing artifact ${ref}`);
      ensure(read(ref).equals(bytes), `exact rebuild differs for ${ref}`);
    } else {
      if (fs.existsSync(absolute)) {
        ensure(refreshOwned && previousOwnedPins?.get(ref) === sha(read(ref)), `refusing to overwrite frozen artifact ${ref}`);
      }
      fs.writeFileSync(absolute, bytes);
    }
  }
  console.log(JSON.stringify({mode: checkOnly ? 'CHECK' : 'WRITE', status: manifest.status, outputs: Object.fromEntries(Object.entries(outputs).map(([ref, bytes]) => [ref, sha(bytes)])), counts: operationBody.counts}, null, 2));
}

main();
