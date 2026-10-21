#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP3_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp3-surface-phase-status-matrix.json';
export const PDP3_STATUS_PATH = 'docs/implementation/pdp-3-phase-dev-status.json';
export const PDP2_STATUS_PATH = 'docs/implementation/pdp-2-phase-dev-status.json';
export const PDP1_STATUS_PATH = 'docs/implementation/pdp-1-phase-dev-status.json';
export const PDP0_STATUS_PATH = 'docs/implementation/pdp-0-phase-dev-status.json';
export const PDP2_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp2-surface-phase-status-matrix.json';
export const PDP1_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp1-surface-phase-status-matrix.json';
export const PDP0_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
export const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
export const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
export const PDP3_CHANNEL_BINDINGS_PATH = '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml';
export const PDP3_OWNER_DIRECTIONS_PATH = 'docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json';
export const PDP0_CAMPAIGN_EXTENSIONS_PATH = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml';
export const PDP0_AUDIT_CROSSWALK_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
export const AUTHORITY_MAP_PATH = '.product-experience/authority-map.yaml';
export const PDP3_RULE_MANAGEMENT_PROPOSAL_PATH = '.product-experience/pdp-3-product-experience/proposal-journeys/manage-reusable-rules-proposal.yaml';
export const PDP2_INTERFACE_GRAMMAR_PATH = '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml';

const J31_STEP_IDS = ['author-versioned-candidate', 'inspect-exact-version', 'validate-exact-candidate', 'request-candidate-only-reuse', 'recover-without-replay-or-rebase'];
const AUD_SPEC_020_CHANNEL_PREFIX = `${PDP0_CAMPAIGN_EXTENSIONS_PATH}#records/@id=AUD-SPEC-020/channelApplicability/records/@id=AUD-SPEC-020-CHANNEL-APPLICABILITY/channelApplicability`;

export function isCompleteAudSpec020ChannelExperienceBindings({ bindings, proposedChannels, p2Mappings, journey } = {}) {
  if (!Array.isArray(bindings) || bindings.length !== 8 || !Array.isArray(proposedChannels) || proposedChannels.length !== 8 || !Array.isArray(p2Mappings) || !journey) return false;
  if (journey.status !== 'PROPOSAL_BOUND_PDP3_DEFINITION_COMPLETE; OWNER_APPLICABILITY_REVIEW_PENDING; RUNTIME_NOT_ADMITTED'
    || journey.definitionBoundary?.disposition !== 'CONDITIONAL_ON_AUD_SPEC_020_PROPOSAL; OWNER_APPROVAL_NOT_CLAIMED; RUNTIME_NOT_ADMITTED'
    || journey.definitionBoundary?.applicability?.status !== 'PROPOSED_ONLY; EXACT_SURFACE_RESOLUTION_IS_A_PROPOSAL; OWNER_APPROVAL_NOT_CLAIMED') return false;
  const p0ByChannel = new Map(proposedChannels.map((channel) => [channel.channelRef, channel]));
  const p2ByChannel = new Map(p2Mappings.filter(({ disposition }) => disposition === 'PROPOSED_APPLICABLE').map((mapping) => [mapping.channelRef, mapping]));
  if (p0ByChannel.size !== 8 || p2ByChannel.size !== 8) return false;
  const sourceSteps = journey.steps;
  if (!Array.isArray(sourceSteps) || JSON.stringify(sourceSteps.map(({ stepId }) => stepId)) !== JSON.stringify(J31_STEP_IDS)) return false;
  const bindingChannels = new Set();
  const exactRefs = (actual, expected) => Array.isArray(actual) && JSON.stringify([...actual].sort()) === JSON.stringify([...(expected ?? [])].sort());
  for (const binding of bindings) {
    if (!binding || !nonblank(binding.channelRef) || bindingChannels.has(binding.channelRef)) return false;
    bindingChannels.add(binding.channelRef);
    const p0 = p0ByChannel.get(binding.channelRef);
    const p2 = p2ByChannel.get(binding.channelRef);
    if (!p0 || !p2 || p0.disposition !== 'PROPOSED_APPLICABLE') return false;
    if (binding.applicabilitySourceRef !== `${AUD_SPEC_020_CHANNEL_PREFIX}/@id=${p0.id}`) return false;
    if (binding.p2InterfaceBindingRef !== `${PDP2_INTERFACE_GRAMMAR_PATH}#ruleManagementProposalInterfaceBinding/channelProposalMappings/mappings/@id=${p2.id}`) return false;
    if (!exactRefs(binding.logicalConsumerSurfaceRefs, p0.surfaceResolution?.logicalConsumerSurfaceRefs)
      || !exactRefs(binding.physicalSurfaceRefs, p0.surfaceResolution?.physicalSurfaceRefs)
      || !exactRefs(binding.compositeSurfaceRefs, p0.surfaceResolution?.compositeSurfaceRefs)) return false;
    if (binding.applicabilityDisposition !== 'PROPOSED_APPLICABLE; OWNER_APPROVAL_NOT_CLAIMED'
      || binding.transportBinding !== 'UNBOUND' || binding.invocationBinding !== 'UNBOUND'
      || binding.runtimeAdmission !== 'NOT_ADMITTED' || binding.executionAdmission !== 'NOT_ADMITTED'
      || !binding.applicabilityDisposition.includes('OWNER_APPROVAL_NOT_CLAIMED')) return false;
    if (!nonblank(binding.actor) || !nonblank(binding.entry) || !Array.isArray(binding.interactionSequence)
      || typeof binding.successPresentation !== 'string' || !nonblank(binding.successPresentation)
      || !nonblank(binding.nonSuccessPresentation?.presentation)
      || !Array.isArray(binding.recoveryRefs) || !binding.recoveryRefs.length || binding.recoveryRefs.some((ref) => !nonblank(ref))
      || typeof binding.accessibility !== 'string' || !nonblank(binding.accessibility)) return false;
    const interactionSteps = Array.isArray(binding.interactionSequence) ? binding.interactionSequence.map(({ stepId }) => stepId) : [];
    if (JSON.stringify(interactionSteps) !== JSON.stringify(J31_STEP_IDS)
      || binding.interactionSequence.some(({ interaction }) => !nonblank(interaction))) return false;
    if (binding.channelRef === 'media.channel.api'
      && (!Array.isArray(binding.inheritsChannelRefs)
        || JSON.stringify([...binding.inheritsChannelRefs].sort()) !== JSON.stringify(['media.channel.grpc-api', 'media.channel.http-api'])
        || binding.transportScope !== 'UMBRELLA_ONLY; INHERITS_HTTP_AND_GRPC_PROPOSAL_SCOPES; NO_THIRD_TRANSPORT')) return false;
  }
  return J31_STEP_IDS.every((stepId) => sourceSteps.some(({ stepId: sourceStepId }) => sourceStepId === stepId))
    && [...p0ByChannel.keys()].every((channelRef) => bindingChannels.has(channelRef));
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readBytes = (root, ref) => fs.readFileSync(path.join(root, ref));
const readJson = (root, ref) => JSON.parse(readBytes(root, ref).toString('utf8'));
const readYaml = (root, ref) => parse(readBytes(root, ref).toString('utf8'));
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => new Set(values).size === values.length;
const baseRef = (ref) => ref.split('#', 1)[0].replace(/\/$/u, '');

function exactTopology(topology, registry) {
  const physical = topology?.manifestCandidates;
  const compositions = topology?.compositions;
  const consumers = topology?.consumerCrosswalk;
  const registryRows = registry?.surfaces;
  if (![physical, compositions, consumers, registryRows].every(Array.isArray)) throw new Error('PDP-3 matrix requires physical, composite, logical topology and registry rows.');
  if (topology.activeManifestCandidateCount !== physical.length || registryRows.length !== consumers.length) throw new Error('PDP-3 topology counts do not match physical and logical source populations.');
  const all = [...physical, ...compositions, ...consumers];
  const ids = all.map(({ surfaceId }) => surfaceId);
  if (ids.some((id) => !nonblank(id)) || !unique(ids)) throw new Error('PDP-3 topology must contain unique stable surface identities.');
  const registryById = new Map(registryRows.map((row) => [row.surfaceId, row]));
  if (registryById.size !== registryRows.length || consumers.some(({ surfaceId }) => !registryById.has(surfaceId)) || [...registryById.keys()].some((id) => !consumers.some((row) => row.surfaceId === id))) throw new Error('PDP-3 logical topology and registry identities do not match exactly.');
  return { physical, compositions, consumers, registryById, all };
}

function resolveAuthorityFiles(root, refs, knownFiles) {
  const files = new Set();
  for (const original of refs) {
    if (!nonblank(original)) throw new Error('PDP-3 applicability has a blank authority reference.');
    const ref = baseRef(original);
    const full = path.join(root, ref);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files.add(ref);
    else if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(absolute);
          else if (entry.isFile()) files.add(path.relative(root, absolute).split(path.sep).join('/'));
        }
      };
      visit(full);
    } else if (ref.includes('*')) {
      const pattern = new RegExp(`^${ref.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')).join('.*')}$`, 'u');
      for (const file of knownFiles) if (pattern.test(file)) files.add(file);
    } else throw new Error(`PDP-3 applicability authority does not resolve: ${original}`);
  }
  return [...files].sort();
}

function applicability(node, surfaceId) {
  const cell = node?.phaseApplicability?.['PDP-3'];
  if (!cell || !nonblank(cell.disposition) || !nonblank(cell.rationale)) throw new Error(`${surfaceId}: PDP-3 topology applicability needs an explicit disposition and rationale.`);
  const refs = [...new Set([...(cell.authorityRefs ?? []), cell.authorityRef].filter(nonblank))];
  if (!refs.length) throw new Error(`${surfaceId}: PDP-3 topology applicability needs an authority reference.`);
  const excluded = /^NOT_APPLICABLE(?:_|$)/u.test(cell.disposition) || cell.disposition === 'NOT_ACTIVE_ARCHIVED';
  return { disposition: cell.disposition, rationale: cell.rationale, refs, excluded };
}

function statusCurrentness(root, status) {
  const pins = status?.sourceShaSet;
  if (!pins || typeof pins !== 'object' || !Object.keys(pins).length) return { status: 'UNKNOWN', sourcePinCount: 0, staleSourcePinCount: 0, staleSourcePins: [], note: 'Native PDP-3 sourceShaSet is absent.' };
  const staleSourcePins = [];
  for (const [sourceRef, expectedSha256] of Object.entries(pins)) {
    const currentSha256 = sourceRef.includes('#') ? null : fs.existsSync(path.join(root, sourceRef)) && fs.statSync(path.join(root, sourceRef)).isFile() ? sha256(readBytes(root, sourceRef)) : null;
    if (!currentSha256 || currentSha256 !== expectedSha256) staleSourcePins.push({ sourceRef, expectedSha256, currentSha256 });
  }
  return { status: staleSourcePins.length ? 'STALE' : 'CURRENT', sourcePinCount: Object.keys(pins).length, staleSourcePinCount: staleSourcePins.length, staleSourcePins, note: 'Every native PDP-3 sourceShaSet pin is compared with current repository bytes; selector pins without native projection support are stale.' };
}

function predecessorStatus(statuses, matrices) {
  const rows = ['PDP-0', 'PDP-1', 'PDP-2'].map((phase, index) => {
    const status = statuses[index]; const matrix = matrices[index];
    const ready = status?.phase === phase && status.status === 'DEV_COMPLETE' && matrix?.campaign?.phase === phase && matrix.campaign.status === 'DEV_COMPLETE' && matrix.phaseSourceCurrentness?.status === 'CURRENT';
    return { phase, status: status?.status ?? 'UNKNOWN', matrixStatus: matrix?.campaign?.status ?? 'UNKNOWN', sourceCurrentness: matrix?.phaseSourceCurrentness?.status ?? 'UNKNOWN', ready };
  });
  return { status: rows.every(({ ready }) => ready) ? 'READY' : 'BLOCKED_OR_UNKNOWN', phases: rows };
}

function phaseTasks({ root, status, topologyRows, parents, channelExperienceBindingsOverride }) {
  const phaseOwner = readYaml(root, AUTHORITY_MAP_PATH).phaseAuthorities?.find(({ phase }) => phase === 'PDP-3')?.owner ?? null;
  const channelRegistry = readYaml(root, PDP3_CHANNEL_BINDINGS_PATH);
  const edges = Array.isArray(channelRegistry?.edges) ? channelRegistry.edges : [];
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const ownerDirections = readJson(root, PDP3_OWNER_DIRECTIONS_PATH);
  const ownerTaskById = new Map((ownerDirections.journeyChannelTasks ?? []).map((task) => [task.taskId, task]));
  const physicalById = new Map(topologyRows.physical.map((row) => [row.surfaceId, row]));
  const topologyById = new Map(topologyRows.all.map((row) => [row.surfaceId, row]));
  const tasks = [];
  const statusDisagreements = [];
  const externalDecisionHandoffs = [];

  const edgeSurfaceSet = (edge) => {
    const node = topologyRows.consumers.find(({ surfaceId }) => surfaceId === edge.consumerSurfaceId);
    const registry = topologyRows.registryById.get(edge.consumerSurfaceId);
    if (!node || !registry) return null;
    const explicitPhysicalRefs = [...new Set(node.physicalRefs ?? [])];
    if (explicitPhysicalRefs.some((ref) => !physicalById.has(ref))) return null;
    const visited = new Set();
    const pending = [edge.consumerSurfaceId, ...explicitPhysicalRefs];
    while (pending.length) {
      const id = pending.pop();
      if (!topologyById.has(id) || visited.has(id)) continue;
      visited.add(id);
      for (const parent of parents.get(id) ?? []) if (!visited.has(parent)) pending.push(parent);
    }
    return { node, registry, explicitPhysicalRefs, surfaceIds: [...visited].sort() };
  };

  const ownerPacketFor = (edge) => ownerTaskById.get(edge.taskId) ?? null;
  const edgeTask = (edge, expectedTaskId) => {
    const mapping = edgeSurfaceSet(edge);
    const ownerPacket = ownerPacketFor(edge);
    if (!mapping || !Array.isArray(mapping.registry.owners) || !mapping.registry.owners.length) return {
      taskId: expectedTaskId, criterionId: 'P3-03', edgeId: edge.id, consumerSurfaceId: edge.consumerSurfaceId ?? null,
      owner: null, surfaceIds: [], surfacePaths: [], assignment: 'UNKNOWN_EDGE_CONSUMER_OR_OWNER',
      sourceRefs: [PDP3_CHANNEL_BINDINGS_PATH],
      where: { sourceRef: PDP3_CHANNEL_BINDINGS_PATH, selector: `#/edges/@id=${edge.id}` },
      blockerText: edge.logicalDefinitionBlockers ?? [], how: ownerPacket?.how ?? null, predecessorEvidence: edge.p1OperationBindings ?? [],
      acceptanceCriterion: ownerPacket?.accept ?? null,
    };
    const repositoryPathsFor = (surfaceId, visited = new Set()) => {
      if (visited.has(surfaceId)) return [];
      visited.add(surfaceId);
      const node = topologyById.get(surfaceId);
      if (!node) return [];
      if (node.sourcePath) return [node.sourcePath];
      const refs = node.physicalRefs ?? node.children ?? [];
      return [...new Set(refs.flatMap((ref) => repositoryPathsFor(ref, visited)))].sort();
    };
    const mappedSurfacePaths = mapping.surfaceIds.map((surfaceId) => ({
      surfaceId,
      repositoryPaths: repositoryPathsFor(surfaceId),
    }));
    const blockerText = Array.isArray(edge.logicalDefinitionBlockers) ? edge.logicalDefinitionBlockers : [];
    return {
      taskId: expectedTaskId, criterionId: 'P3-03', edgeId: edge.id, ownerPacketTaskId: edge.taskId,
      consumerSurfaceId: edge.consumerSurfaceId, owner: mapping.registry.owners,
      surfaceIds: mapping.surfaceIds, surfacePaths: mappedSurfacePaths,
      assignment: 'EXACT_EDGE_CONSUMER_AND_DECLARED_PHYSICAL_COMPOSITE_ANCESTORS',
      sourceRefs: [...new Set([PDP3_CHANNEL_BINDINGS_PATH, edge.journeyContractRef, edge.ownerPacketRef, ...(edge.p1OperationBindings ?? []).map(({ sourceRef }) => sourceRef), ...(edge.p1StateRefs ?? []), ...(edge.p1ObservationRefs ?? [])].filter(nonblank).map(baseRef))].sort(),
      where: { sourceRef: PDP3_CHANNEL_BINDINGS_PATH, selector: `#/edges/@id=${edge.id}`, consumerSurfaceId: edge.consumerSurfaceId },
      blockerText, how: ownerPacket?.how ?? null,
      predecessorEvidence: {
        journeyContractRef: edge.journeyContractRef ?? null,
        p1OperationBindings: (edge.p1OperationBindings ?? []).filter(({ disposition }) => disposition !== 'BOUND').map(({ operationRef, sourceRef, disposition, transportRef, reason }) => ({ operationRef, sourceRef, disposition, transportRef, reason })),
        p1StateRefs: edge.p1StateRefs ?? [], p1ObservationRefs: edge.p1ObservationRefs ?? [],
        p2GrammarRef: edge.p2GrammarRef ?? null, channelTransportEquivalence: edge.channelTransportEquivalence ?? null,
      },
      acceptanceCriterion: ownerPacket?.accept ?? null,
      nextLegalAction: ownerPacket?.how ?? 'Resolve this exact edge at its canonical PDP-3 binding record and preserve source-backed PDP-1/PDP-2 semantics.',
    };
  };

  const outstandingIds = [...new Set(status?.outstandingMeaningIds ?? [])].sort();
  const outstandingEdgeIds = outstandingIds.filter((taskId) => taskId.startsWith('P3-03:channel-logical-edge-incomplete:')).map((taskId) => taskId.slice('P3-03:channel-logical-edge-incomplete:'.length));
  const liveIncomplete = edges.filter((edge) => (edge.logicalDefinitionBlockers?.length ?? 0) > 0 || String(edge.logicalDefinitionDisposition ?? '').startsWith('INCOMPLETE'));
  const liveIncompleteIds = new Set(liveIncomplete.map(({ id }) => id));
  for (const edgeId of outstandingEdgeIds) {
    if (!liveIncompleteIds.has(edgeId)) statusDisagreements.push({ taskId: `P3-03:channel-logical-edge-incomplete:${edgeId}`, edgeId, status: 'STATUS_TASK_NOT_IN_LIVE_INCOMPLETE_EDGE_SET', owner: phaseOwner, surfaceIds: [] });
  }
  for (const edge of liveIncomplete) tasks.push(edgeTask(edge, `P3-03:channel-logical-edge-incomplete:${edge.id}`));

  for (const [criterionId, criterion] of Object.entries(status?.directDevelopmentCriteria ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (criterion?.testStatus === 'PASS' && Number.isFinite(criterion?.testCount) && criterion.passedTestCount === criterion.testCount) continue;
    tasks.push({
      taskId: `${criterionId}:failed-development-criteria`, criterionId,
      testStatus: criterion?.testStatus ?? 'UNKNOWN', testCount: Number.isFinite(criterion?.testCount) ? criterion.testCount : null,
      passedTestCount: Number.isFinite(criterion?.passedTestCount) ? criterion.passedTestCount : null,
      owner: phaseOwner, surfaceIds: [], surfacePaths: [], assignment: 'PHASE_WIDE_CRITERION',
      sourceRefs: [PDP3_STATUS_PATH, AUTHORITY_MAP_PATH],
      where: { sourceRef: PDP3_STATUS_PATH, selector: `/directDevelopmentCriteria/${criterionId}` },
      blockerText: `PDP-3 criterion ${criterionId} is ${criterion?.testStatus ?? 'UNKNOWN'} (${criterion?.passedTestCount ?? 'unknown'}/${criterion?.testCount ?? 'unknown'} direct-development tests passed).`,
      acceptanceCriterion: `The source-current PDP-3 status records ${criterionId} as PASS with every direct-development test passing (passedTestCount equals testCount).`,
    });
  }
  for (const taskId of outstandingIds) {
    if (taskId.startsWith('P3-03:channel-logical-edge-incomplete:')) continue;
    const phaseCriterion = taskId.match(/^(P3-\d{2}):/u)?.[1] ?? null;
    const owner = phaseCriterion ? phaseOwner : null;
    const acceptanceCriterion = taskId.includes('strict-current-public-projection-not-green')
      ? 'PDP-3 strict public projections are schema-valid, pass public validators, and are current for the pinned source cut.'
      : taskId.includes('channel-logical-edge-denominator-invalid')
        ? 'The live channel-edge identity denominator is unique and complete, and the recorded status agrees with all live incomplete edges.'
        : phaseCriterion
          ? `Resolve ${taskId} within ${phaseCriterion}; retain current source evidence and pass its direct-development acceptance criterion.`
          : null;
    tasks.push({ taskId, criterionId: phaseCriterion, owner, surfaceIds: [], surfacePaths: [], assignment: owner ? 'PHASE_WIDE_TASK' : 'UNKNOWN_SOURCE_ASSIGNMENT', sourceRefs: [PDP3_STATUS_PATH, AUTHORITY_MAP_PATH], where: { sourceRef: PDP3_STATUS_PATH, selector: '/outstandingMeaningIds' }, blockerText: taskId, acceptanceCriterion });
  }

  const extensions = readYaml(root, PDP0_CAMPAIGN_EXTENSIONS_PATH);
  const extension = extensions.records?.find(({ id }) => id === 'AUD-SPEC-020');
  const applicabilityRecord = extension?.channelApplicability?.records?.find(({ capabilityRef }) => capabilityRef === 'media.rules.manage');
  const proposedChannels = (applicabilityRecord?.channelApplicability ?? []).filter(({ disposition }) => disposition === 'PROPOSED_APPLICABLE');
  if (!extension || !applicabilityRecord || proposedChannels.length !== 8) throw new Error('AUD-SPEC-020 PDP-3 channel-scope handoff must retain its eight explicit proposed-applicable channel records.');
  const allSurfaceIds = new Set(topologyRows.all.map(({ surfaceId }) => surfaceId));
  const proposedScopeSurfaceIds = [...new Set(proposedChannels.flatMap(({ surfaceResolution }) => [
    ...(surfaceResolution?.logicalConsumerSurfaceRefs ?? []), ...(surfaceResolution?.physicalSurfaceRefs ?? []), ...(surfaceResolution?.compositeSurfaceRefs ?? []),
  ]))].sort();
  if (proposedScopeSurfaceIds.some((id) => !allSurfaceIds.has(id))) throw new Error('AUD-SPEC-020 PDP-3 channel scope references a surface outside the current 54-identity topology.');
  const p0CrosswalkRow = readJson(root, PDP0_AUDIT_CROSSWALK_PATH).rows?.find(({ auditId }) => auditId === 'AUD-SPEC-020');
  const p3Handoff = p0CrosswalkRow?.laterPhaseHandoffs?.find(({ phase }) => phase === 'PDP-3');
  if (!p3Handoff) throw new Error('AUD-SPEC-020 PDP-3 handoff is missing from the authoritative PDP-0 crosswalk.');
  const ruleManagementJourney = readYaml(root, PDP3_RULE_MANAGEMENT_PROPOSAL_PATH);
  const p2RuleManagementBinding = readYaml(root, PDP2_INTERFACE_GRAMMAR_PATH).ruleManagementProposalInterfaceBinding;
  const audSpec020ExperienceComplete = isCompleteAudSpec020ChannelExperienceBindings({
    bindings: channelExperienceBindingsOverride ?? ruleManagementJourney.channelExperienceBindings,
    proposedChannels,
    p2Mappings: p2RuleManagementBinding?.channelProposalMappings?.mappings,
    journey: ruleManagementJourney,
  });
  const surfacePathsFor = (surfaceIds) => surfaceIds.map((surfaceId) => {
    const node = topologyById.get(surfaceId);
    const physicalRefs = node?.physicalRefs ?? [];
    const repositoryPaths = surfaceTypeForNode(node) === 'PHYSICAL' ? [node.sourcePath] : physicalRefs.map((ref) => physicalById.get(ref)?.sourcePath).filter(nonblank);
    return { surfaceId, repositoryPaths };
  });
  if (!audSpec020ExperienceComplete) tasks.push({
    taskId: 'PDP3-DEFINITION:AUD-SPEC-020:proposal-bound-channel-experiences', criterionId: 'P3-03', auditId: 'AUD-SPEC-020', taskKind: 'PDP3_EXPERIENCE_DEFINITION',
    owner: phaseOwner, surfaceIds: proposedScopeSurfaceIds, surfacePaths: surfacePathsFor(proposedScopeSurfaceIds), assignment: 'EXPLICIT_CROSS_SURFACE_DEFINITION_SCOPE',
    sourceRefs: [PDP0_CAMPAIGN_EXTENSIONS_PATH, PDP0_AUDIT_CROSSWALK_PATH, AUTHORITY_MAP_PATH, baseRef(extension.sourceRef)].filter(nonblank),
    where: { sourceRef: PDP0_CAMPAIGN_EXTENSIONS_PATH, selector: '#records/@id=AUD-SPEC-020/channelApplicability/records/@capabilityRef=media.rules.manage' },
    blockerText: 'Define complete PDP-3 experiences for the eight proposal-bound applicable channel scopes on their 37 explicitly mapped identities; this does not adopt applicability or claim implementation, admission, or runtime support.',
    how: p3Handoff.scope,
    predecessorEvidence: { sourceRef: PDP0_AUDIT_CROSSWALK_PATH, selector: '#rows/@auditId=AUD-SPEC-020/laterPhaseHandoffs/@phase=PDP-3', handoffStatus: p3Handoff.status },
    proposedChannels: proposedChannels.map(({ id, channelRef, disposition, rationale, surfaceResolution }) => ({ id, channelRef, disposition, rationale, surfaceResolution })),
    proposedNotApplicableChannels: (applicabilityRecord.channelApplicability ?? []).filter(({ disposition }) => disposition.startsWith('NOT_APPLICABLE')).map(({ id, channelRef, disposition, rationale }) => ({ id, channelRef, disposition, rationale, authorityState: 'PROPOSAL_ONLY_NOT_PDP3_EXCLUSION' })),
    applicabilityProposalTargets: proposedScopeSurfaceIds.length, denominatorIdentityCount: topologyRows.all.length,
    unmappedDenominatorSurfaceIds: topologyRows.all.map(({ surfaceId }) => surfaceId).filter((id) => !proposedScopeSurfaceIds.includes(id)).sort(),
    acceptanceCriterion: p3Handoff.scope,
    nextLegalAction: 'Complete the PDP-3 experience definitions for the eight proposal-bound channel scopes on their exact mapped identities; keep the three proposed N/A channel dispositions proposal-only.',
  });
  externalDecisionHandoffs.push({
    handoffId: 'PDP0-DECISION:AUD-SPEC-020:channel-applicability-disposition',
    sourcePhase: 'PDP-0', targetPhase: 'PDP-3', auditId: 'AUD-SPEC-020', status: 'PENDING_OWNER_DISPOSITION',
    ownerApproval: applicabilityRecord.ownerApproval ?? 'UNKNOWN',
    independentAcceptance: applicabilityRecord.independentAcceptance ?? 'UNKNOWN',
    applicabilityState: applicabilityRecord.applicabilityState ?? 'UNKNOWN',
    sourceRef: PDP0_CAMPAIGN_EXTENSIONS_PATH,
    selector: '#records/@id=AUD-SPEC-020/channelApplicability/records/@capabilityRef=media.rules.manage',
    proposedNotApplicableChannels: (applicabilityRecord.channelApplicability ?? []).filter(({ disposition }) => disposition.startsWith('NOT_APPLICABLE')).map(({ id, channelRef, disposition, rationale }) => ({ id, channelRef, disposition, rationale, authorityState: 'PROPOSAL_ONLY_NOT_PDP3_EXCLUSION' })),
    note: 'The PDP-0 owner adoption/rejection decision is separate from PDP-3 experience-definition work and is not claimed or counted as a PDP-3 remaining definition task.',
  });
  return { tasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)), statusDisagreements, externalDecisionHandoffs };
}

function surfaceTypeForNode(node) {
  if (!node) return 'UNKNOWN';
  if (node.sourcePath) return 'PHYSICAL';
  if (Array.isArray(node.physicalRefs)) return 'LOGICAL_CONSUMER';
  return 'COMPOSITION';
}

export function buildPdp3SurfaceMatrix({ root = ROOT, status, generatedAt = '1970-01-01T00:00:00.000Z', channelExperienceBindingsOverride } = {}) {
  if (status?.phase !== 'PDP-3' || !['DEV_COMPLETE', 'IN_PROGRESS'].includes(status.status)) throw new Error('PDP-3 native phase status is missing or has an invalid phase/status.');
  const topologyRows = exactTopology(readJson(root, TOPOLOGY_PATH), readYaml(root, REGISTRY_PATH));
  const predecessorStatuses = [PDP0_STATUS_PATH, PDP1_STATUS_PATH, PDP2_STATUS_PATH].map((ref) => readJson(root, ref));
  const predecessorMatrices = [PDP0_MATRIX_PATH, PDP1_MATRIX_PATH, PDP2_MATRIX_PATH].map((ref) => readJson(root, ref));
  const predecessors = predecessorStatus(predecessorStatuses, predecessorMatrices);
  const phaseSourceCurrentness = statusCurrentness(root, status);
  const topologyAuthorities = topologyRows.physical.concat(topologyRows.compositions).map((node) => applicability(node, node.surfaceId));
  const logicalAuthorities = topologyRows.consumers.map((node) => {
    const registry = topologyRows.registryById.get(node.surfaceId);
    if (!Array.isArray(registry?.applicablePdpArtifacts) || !nonblank(registry?.applicabilityDisposition) || !nonblank(registry?.applicabilityRationale)) throw new Error(`${node.surfaceId}: registry PDP applicability decision and rationale are required.`);
    const included = registry.applicablePdpArtifacts.includes('PDP-3');
    const archived = registry.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    if (!included && !archived && registry.applicablePdpArtifacts.length > 0 && !nonblank(registry.applicabilityRationale)) throw new Error(`${node.surfaceId}: PDP-3 exclusion has no rationale.`);
    const refs = [...new Set([registry.interactionModel, registry.contractAuthority, registry.securityAuthorityModel].filter(nonblank))];
    if (included && !refs.length) throw new Error(`${node.surfaceId}: applicable logical consumer has no PDP-3 experience authority reference.`);
    return { node, registry, disposition: archived ? 'NOT_ACTIVE_ARCHIVED' : included ? 'APPLICABLE' : 'NOT_APPLICABLE', rationale: registry.applicabilityRationale, refs: refs.length ? refs : [REGISTRY_PATH], excluded: !included || archived };
  });
  const predecessorRefs = [PDP0_STATUS_PATH, PDP1_STATUS_PATH, PDP2_STATUS_PATH];
  const predecessorMatrixRefs = [PDP0_MATRIX_PATH, PDP1_MATRIX_PATH, PDP2_MATRIX_PATH];
  const parents = new Map(topologyRows.all.map(({ surfaceId }) => [surfaceId, new Set()]));
  for (const composition of topologyRows.compositions) for (const child of composition.children ?? []) {
    if (!parents.has(child)) throw new Error(`${composition.surfaceId}: unknown direct child ${child}.`);
    parents.get(child).add(composition.surfaceId);
  }
  for (const { node, registry } of logicalAuthorities) if (registry.parentSurfaceId) {
    if (!parents.has(registry.parentSurfaceId) || registry.parentSurfaceId === node.surfaceId) throw new Error(`${node.surfaceId}: unknown or self-referential parent ${registry.parentSurfaceId}.`);
    parents.get(node.surfaceId).add(registry.parentSurfaceId);
  }
  const taskResult = phaseTasks({ root, status, topologyRows, parents, channelExperienceBindingsOverride });
  const tasks = taskResult.tasks;
  const assignedTasks = tasks.filter(({ surfaceIds }) => surfaceIds.length > 0);
  const phaseWideTasks = tasks.filter(({ assignment }) => assignment === 'PHASE_WIDE_CRITERION' || assignment === 'PHASE_WIDE_TASK' || assignment === 'UNKNOWN_SOURCE_ASSIGNMENT' || assignment === 'UNKNOWN_EDGE_CONSUMER_OR_OWNER');
  const surfaceTasksFor = (surfaceId) => assignedTasks.filter(({ surfaceIds }) => surfaceIds.includes(surfaceId));
  const statusIncompleteIds = [...new Set(status.channelDefinitionCoverage?.incompleteEdgeIds ?? [])].sort();
  const liveIncompleteIds = [...new Set(tasks.filter(({ edgeId }) => edgeId).map(({ edgeId }) => edgeId))].sort();
  const statusProjectionConsistency = {
    status: JSON.stringify(statusIncompleteIds) === JSON.stringify(liveIncompleteIds) ? 'CURRENT' : 'STALE',
    statusRecordedIncompleteEdgeCount: statusIncompleteIds.length,
    liveIncompleteEdgeCount: liveIncompleteIds.length,
    statusOnlyEdgeIds: statusIncompleteIds.filter((id) => !liveIncompleteIds.includes(id)),
    liveOnlyEdgeIds: liveIncompleteIds.filter((id) => !statusIncompleteIds.includes(id)),
    staleOutstandingEdgeTaskIds: taskResult.statusDisagreements,
    channelRegistryRef: PDP3_CHANNEL_BINDINGS_PATH,
  };
  const refs = new Set([...Object.keys(status.sourceShaSet ?? {}), REGISTRY_PATH, TOPOLOGY_PATH, PDP3_STATUS_PATH,
    PDP0_STATUS_PATH, PDP1_STATUS_PATH, PDP2_STATUS_PATH, PDP0_MATRIX_PATH, PDP1_MATRIX_PATH, PDP2_MATRIX_PATH,
    PDP3_CHANNEL_BINDINGS_PATH, PDP3_OWNER_DIRECTIONS_PATH, PDP0_CAMPAIGN_EXTENSIONS_PATH, PDP0_AUDIT_CROSSWALK_PATH, AUTHORITY_MAP_PATH]);
  for (const ref of tasks.flatMap(({ sourceRefs = [] }) => sourceRefs)) for (const file of resolveAuthorityFiles(root, [ref], Object.keys(status.sourceShaSet ?? {}))) refs.add(file);
  for (const authority of [...topologyAuthorities, ...logicalAuthorities]) for (const ref of resolveAuthorityFiles(root, authority.refs, Object.keys(status.sourceShaSet ?? {}))) refs.add(ref);
  const sourceFingerprints = Object.fromEntries([...refs].sort().map((ref) => [ref, fs.existsSync(path.join(root, ref)) && fs.statSync(path.join(root, ref)).isFile() ? sha256(readBytes(root, ref)) : null]));
  const sourceFingerprintSetSha256 = sha256(JSON.stringify(Object.entries(sourceFingerprints).sort(([a], [b]) => a.localeCompare(b))));
  const makeRow = ({ node, surfaceType, owner, repositoryPath = null, manifestPath = null, authority, topologyFields = {} }) => {
    const excluded = authority.excluded;
    const localTasks = surfaceTasksFor(node.surfaceId);
    const authorityFiles = resolveAuthorityFiles(root, authority.refs, Object.keys(sourceFingerprints));
    const commonRowRefs = [REGISTRY_PATH, TOPOLOGY_PATH, PDP3_STATUS_PATH, ...predecessorRefs, ...predecessorMatrixRefs];
    const taskRefs = localTasks.flatMap(({ sourceRefs = [] }) => sourceRefs);
    const rowRefs = [...new Set([...commonRowRefs, ...authority.refs, ...taskRefs])].sort();
    const taskFileRefs = taskRefs.flatMap((ref) => resolveAuthorityFiles(root, [ref], Object.keys(sourceFingerprints)));
    const rowCurrent = phaseSourceCurrentness.status === 'CURRENT' && [...commonRowRefs, ...authorityFiles, ...taskFileRefs].every((ref) => Boolean(sourceFingerprints[ref]));
    const blockers = excluded ? [] : localTasks.map(({ taskId }) => taskId);
    const ready = !excluded && rowCurrent && !localTasks.length && status.status === 'DEV_COMPLETE' && !phaseWideTasks.length && !tasks.length && predecessors.status === 'READY' && statusProjectionConsistency.status === 'CURRENT';
    const archived = authority.disposition === 'NOT_ACTIVE_ARCHIVED';
    const taskMapping = excluded ? 'NOT_APPLICABLE_SOURCE_DECISION' : localTasks.length ? 'EXPLICIT_SURFACE_AND_DECLARED_ANCESTOR_ASSIGNMENTS' : 'KNOWN_ZERO_SURFACE_LOCAL_TASKS';
    const taskOwners = [...new Set(localTasks.flatMap(({ owner: taskOwner }) => Array.isArray(taskOwner) ? taskOwner : taskOwner ? [taskOwner] : []))].sort();
    return {
      surfaceId: node.surfaceId, surfaceType, owner: owner ?? 'media', repositoryPath, manifestPath,
      pathRefs: surfaceType === 'LOGICAL_CONSUMER' ? [...(node.physicalRefs ?? [])] : [],
      parentSurfaceIds: [...parents.get(node.surfaceId)].sort(), phase: 'PDP-3',
      applicability: { disposition: authority.disposition, rationale: authority.rationale, authorityRefs: authority.refs },
      sourceRefs: rowRefs,
      sourceCurrent: rowCurrent,
      sourceCurrentBasis: rowCurrent ? 'Native PDP-3 source pins and this row’s topology, registry, authority, status, and predecessor inputs match current bytes.' : `PDP-3 source currentness is ${phaseSourceCurrentness.status}, or a row source fingerprint is unavailable.`,
      developmentStatus: archived ? 'NOT_ACTIVE_ARCHIVED' : excluded ? 'NOT_APPLICABLE' : ready ? 'DEV_COMPLETE' : 'PENDING',
      remainingPhaseLocalTaskIds: excluded ? [] : localTasks.map(({ taskId }) => taskId).sort(), remainingPhaseLocalTaskMapping: taskMapping,
      assignedPhaseLocalTasks: excluded ? [] : localTasks.map(({ taskId, owner: taskOwner, blockerText, where, acceptanceCriterion, nextLegalAction, how }) => ({ taskId, owner: taskOwner, blockerText, where, acceptanceCriterion, nextLegalAction: nextLegalAction ?? how ?? null })),
      blockerIds: blockers, blockerOwner: excluded || !taskOwners.length ? null : taskOwners.join(', '),
      acceptanceCriterion: excluded ? 'A current authoritative PDP-3 applicability decision explicitly excludes this identity with a source-bound rationale.' : localTasks.length ? localTasks.map(({ acceptanceCriterion }) => acceptanceCriterion).filter(nonblank).join(' | ') : 'This surface has zero directly assigned PDP-3 tasks in the current source records; no remaining phase-local task is asserted for this row. Source currentness and phase-wide status remain reported separately.',
      nextLegalAction: excluded ? 'Retain the explicit PDP-3 applicability decision; this row does not imply phase closure or runtime admission.' : localTasks.length ? localTasks.map(({ nextLegalAction, how }) => nextLegalAction ?? how).filter(nonblank).join(' | ') : ready ? 'Retain the source-current PDP-3 development definition; native closure, implementation qualification, and Delivery remain separate gates.' : 'No surface-local PDP-3 task is assigned here; retain this row while separately reported phase-wide work, source-currentness, or predecessor blockers are resolved.',
      campaignReadinessBasis: ready ? 'All PDP-3 campaign gates are source-current and complete.' : 'PDP-3 campaign remains pending; phase-wide blockers are listed once in unassignedPhaseLevelWork and mapped tasks appear only on their declared surfaces/ancestors.',
      ...topologyFields,
    };
  };
  const physicalRows = topologyRows.physical.map((node, i) => makeRow({ node, surfaceType: 'PHYSICAL', owner: node.owner, repositoryPath: node.sourcePath, manifestPath: node.manifestPath, authority: topologyAuthorities[i], topologyFields: { topologyDisposition: node.disposition, topologyDispositionRationale: node.dispositionRationale, consumerSurfaceRefs: node.consumerSurfaceRefs ?? [], consumerMappingState: node.consumerMappingState ?? null } }));
  const compositionRows = topologyRows.compositions.map((node, i) => makeRow({ node, surfaceType: node.kind ?? 'COMPOSITION', owner: node.canonicalOwner, authority: topologyAuthorities[topologyRows.physical.length + i], topologyFields: { directMeaning: node.directMeaning, children: node.children ?? [], membershipSemantics: node.membershipSemantics ?? null } }));
  const logicalRows = logicalAuthorities.map(({ node, registry, ...authority }) => makeRow({ node, surfaceType: 'LOGICAL_CONSUMER', owner: (registry.owners ?? []).join(', '), authority, topologyFields: { consumers: registry.consumers ?? [], interactionModel: registry.interactionModel ?? null, contractAuthority: registry.contractAuthority ?? null, physicalOwnerSurfaceRefs: node.physicalRefs ?? [], bindingState: node.bindingState, registryApplicabilityDisposition: registry.applicabilityDisposition, registryApplicabilityRationale: registry.applicabilityRationale } }));
  const surfaces = [...physicalRows, ...compositionRows, ...logicalRows];
  const summary = surfaces.reduce((result, row) => { result[row.surfaceType] = (result[row.surfaceType] ?? 0) + 1; result.statuses[row.developmentStatus] = (result.statuses[row.developmentStatus] ?? 0) + 1; return result; }, { statuses: {} });
  const applicableCount = surfaces.filter((row) => !['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(row.developmentStatus)).length;
  const phaseReady = status.status === 'DEV_COMPLETE' && phaseSourceCurrentness.status === 'CURRENT' && !tasks.length && predecessors.status === 'READY' && statusProjectionConsistency.status === 'CURRENT';
  const matrix = {
    schemaVersion: 'media.pdp3-surface-phase-status-matrix.v1',
    recordKind: 'SOURCE_BOUND_PDP3_DISCOVERY_DEVELOPMENT_STATUS_PROJECTION_NOT_CLOSURE_OR_ACCEPTANCE',
    campaign: { macroStage: 'DISCOVERY', phase: 'PDP-3', sourceBaselineCommit: status.mainSha ?? null, status: phaseReady ? 'DEV_COMPLETE' : 'IN_PROGRESS' },
    generatedAt, statusRecordRef: PDP3_STATUS_PATH, statusRecordSha256: sourceFingerprints[PDP3_STATUS_PATH],
    predecessorStatusRefs: predecessorRefs, predecessorStatusSha256: Object.fromEntries(predecessorRefs.map((ref) => [ref, sourceFingerprints[ref]])),
    predecessorMatrixRefs, predecessorMatrixSha256: Object.fromEntries(predecessorMatrixRefs.map((ref) => [ref, sourceFingerprints[ref]])),
    sourceFingerprintSetSha256, sourceFingerprintSetAlgorithm: 'SHA-256 of compact JSON.stringify over sorted [repository-relative path, file SHA-256] tuples', sourceFingerprints,
    phaseSourceCurrentness, prerequisiteState: predecessors,
    nativePdp3Readiness: { status: phaseReady ? 'READY' : 'BLOCKED_OR_UNKNOWN', recordedStatus: status.status, directCriteriaStatus: Object.values(status.directDevelopmentCriteria ?? {}).every((criterion) => criterion?.testStatus === 'PASS' && Number.isFinite(criterion?.testCount) && criterion.passedTestCount === criterion.testCount) ? 'PASS' : 'FAIL_OR_UNKNOWN', outstandingTaskCount: tasks.length, sourceCurrentness: phaseSourceCurrentness.status },
    channelBindingCoverage: { sourceRef: PDP3_CHANNEL_BINDINGS_PATH, liveEdgeDenominator: readYaml(root, PDP3_CHANNEL_BINDINGS_PATH).edges.length, liveIncompleteEdgeCount: liveIncompleteIds.length, distinctConsumerSurfaceCount: new Set(tasks.filter(({ edgeId }) => edgeId).map(({ consumerSurfaceId }) => consumerSurfaceId)).size, statusProjectionConsistency: statusProjectionConsistency.status, note: 'The live channel-binding edge denominator is separate from the 54 physical/composite/logical surface denominator; AUD-SPEC-020 channel applicability is separately mapped to its explicit surfaceResolution identities.' },
    denominatorValidation: { status: surfaces.length === 54 && unique(surfaces.map(({ surfaceId }) => surfaceId)) && surfaces.every((row) => nonblank(row.applicability.disposition) && nonblank(row.applicability.rationale) && row.applicability.authorityRefs.length) ? 'PASS' : 'FAIL', stats: { physical: topologyRows.physical.length, compositions: topologyRows.compositions.length, logicalConsumers: topologyRows.consumers.length, denominator: surfaces.length, applicablePdp3: applicableCount, explicitNotApplicablePdp3: surfaces.length - applicableCount } },
    summary: { totalSurfaceIdentities: surfaces.length, physical: topologyRows.physical.length, compositions: topologyRows.compositions.length, logicalConsumers: topologyRows.consumers.length, applicableCells: applicableCount, explicitNotApplicableCells: surfaces.length - applicableCount, remainingPhaseLocalTaskCount: tasks.length, remainingPhaseLocalTaskCountKnown: taskMappingKnown(tasks), mappedSurfaceTaskCount: assignedTasks.length, phaseWideTaskCount: phaseWideTasks.length, remainingPhaseLocalSurfaceCount: surfaces.filter((row) => row.developmentStatus === 'PENDING').length, sourceCurrentDevCompleteCells: surfaces.filter((row) => row.developmentStatus === 'DEV_COMPLETE' && row.sourceCurrent).length },
    nativeDevelopmentCriteria: Object.entries(status.directDevelopmentCriteria ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([criterionId, criterion]) => ({ criterionId, testStatus: criterion?.testStatus ?? 'UNKNOWN', testCount: Number.isFinite(criterion?.testCount) ? criterion.testCount : null, passedTestCount: Number.isFinite(criterion?.passedTestCount) ? criterion.passedTestCount : null, skippedTestCount: Number.isFinite(criterion?.skippedTestCount) ? criterion.skippedTestCount : 0 })),
    unassignedPhaseLevelWork: { sourceRecordRef: PDP3_STATUS_PATH, tasks: phaseWideTasks, surfaceAssignmentState: taskMappingKnown(tasks) ? phaseWideTasks.length ? 'KNOWN_PHASE_WIDE_TASKS_WITH_EXPLICIT_OWNER' : 'KNOWN_ZERO_PHASE_WIDE_TASKS' : 'UNKNOWN_TASK_ASSIGNMENT_REMAINS', note: 'Only explicitly phase-wide PDP-3 criteria and tasks appear here. Edge tasks and the AUD-SPEC-020 handoff appear on their source-bound consumer surfaces and declared topology ancestors.' },
    surfaceAssignedWork: { tasks: assignedTasks, note: 'Edge failures are assigned to their exact consumerSurfaceId and propagated only through consumer physicalRefs, registry parentSurfaceId, and topology composition children. AUD-SPEC-020 PDP-3 experience-definition work is assigned only to its eight proposal-bound applicable channel surfaceResolution identities.' },
    externalDecisionHandoffs: taskResult.externalDecisionHandoffs,
    statusProjectionConsistency,
    claimsBoundary: { ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_PERFORMED', implementationQualification: 'NOT_EVALUATED', delivery: 'NOT_ENTERED', runtimeAdmission: 'NOT_ADMITTED' },
    surfaceAuthority: 'PDP-3 applicability: topology.phaseApplicability.PDP-3 for physical and composite identities; surface-registry.yaml applicablePdpArtifacts and explicit applicability disposition/rationale for logical consumers. Identity denominator: topology physical candidates + compositions + consumer crosswalk joined exactly to surface-registry.yaml.',
    surfaces,
  };
  if (matrix.denominatorValidation.status !== 'PASS') throw new Error('PDP-3 matrix denominator or explicit applicability validation failed.');
  return matrix;
}

function taskMappingKnown(tasks) { return !tasks.some(({ assignment }) => String(assignment).startsWith('UNKNOWN')); }

export function generatePdp3SurfaceMatrix({ root = ROOT, mode = 'write' } = {}) {
  if (!['write', 'check'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const status = readJson(root, PDP3_STATUS_PATH);
  const target = path.join(root, PDP3_MATRIX_PATH);
  const previous = fs.existsSync(target) ? readJson(root, PDP3_MATRIX_PATH) : null;
  let matrix = buildPdp3SurfaceMatrix({ root, status, generatedAt: previous?.generatedAt ?? new Date().toISOString() });
  if (mode === 'write' && previous && (matrix.sourceFingerprintSetSha256 !== previous.sourceFingerprintSetSha256 || matrix.statusRecordSha256 !== previous.statusRecordSha256)) {
    matrix = buildPdp3SurfaceMatrix({ root, status, generatedAt: new Date().toISOString() });
  }
  const output = `${JSON.stringify(matrix, null, 2)}\n`;
  if (mode === 'write') fs.writeFileSync(target, output);
  else if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) throw new Error(`${PDP3_MATRIX_PATH} is stale; regenerate after PDP-3 source status settles.`);
  return { matrix, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const { matrix } = generatePdp3SurfaceMatrix({ mode });
  console.log(JSON.stringify({ matrixPath: PDP3_MATRIX_PATH, phaseStatus: matrix.campaign.status, rows: matrix.surfaces.length, sourceCurrentness: matrix.phaseSourceCurrentness.status }, null, 2));
}
