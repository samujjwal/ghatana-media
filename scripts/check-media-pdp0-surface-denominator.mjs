#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATHS = {
  registry: '.product-experience/surface-registry.yaml',
  topology: '.product-experience/surfaces/media-physical-topology.v1.json',
  applications: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  capabilityLeafReview: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  recorderStudio: '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  campaignExtensions: '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
};

const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => new Set(values).size === values.length;
const error = (findings, code, owner, message) => findings.push({ code, owner, message });

export function validatePdp0SurfaceDenominator(registry, topology, authority = readPdp0AuthoritySources(), { root = ROOT } = {}) {
  const findings = [];
  const physical = Array.isArray(topology?.manifestCandidates) ? topology.manifestCandidates : [];
  const compositions = Array.isArray(topology?.compositions) ? topology.compositions : [];
  const consumers = Array.isArray(topology?.consumerCrosswalk) ? topology.consumerCrosswalk : [];
  const registrySurfaces = Array.isArray(registry?.surfaces) ? registry.surfaces : [];
  const scopeDocument = authority?.applications?.logicalConsumerPdp0Scope;
  if (!scopeDocument?.authority?.includes('source-definition-coordinator')
      || !scopeDocument?.status?.includes('owner-acceptance-and-runtime-admission-pending')) {
    error(findings, 'PDP0_SCOPE_AUTHORITY_BOUNDARY', 'PDP-0', 'Logical-consumer scope must record delegated source-definition coordination and keep owner acceptance and runtime admission pending.');
  }
  const leafRecords = authority?.capabilityLeafReview?.ownerCapabilityLeafAdjudication?.records ?? [];
  const leafById = new Map(leafRecords.map((record) => [record.capabilityRef, record]));
  const recorder = authority?.recorderStudio;
  const capabilityFamilies = authority?.capabilities?.families ?? [];
  const familyIds = new Set(capabilityFamilies.map((family) => family.id));
  const capabilityCatalog = authority?.capabilities?.capabilities ?? [];
  const capabilityById = new Map(capabilityCatalog.map((capability) => [capability.id, capability]));
  const definitionExtensions = authority?.campaignExtensions?.currentDefinitionPopulation?.records ?? [];
  const extensionById = new Map(definitionExtensions.map((record) => [record.capabilityId, record]));
  const requirementIds = new Set((authority?.requirements?.requirements ?? []).map((requirement) => requirement.id));
  const byRegistryId = new Map();
  for (const surface of registrySurfaces) {
    if (!nonblank(surface?.surfaceId)) {
      error(findings, 'REGISTRY_ID_MISSING', '(registry)', 'Every registry surface needs a stable surfaceId.');
      continue;
    }
    if (byRegistryId.has(surface.surfaceId)) error(findings, 'REGISTRY_ID_DUPLICATE', surface.surfaceId, 'Registry surfaceId is duplicated.');
    else byRegistryId.set(surface.surfaceId, surface);
  }
  const physicalIds = physical.map((item) => item.surfaceId);
  const compositionIds = compositions.map((item) => item.surfaceId);
  const consumerIds = consumers.map((item) => item.surfaceId);
  const physicalSet = new Set(physicalIds);
  const compositionSet = new Set(compositionIds);
  const consumerSet = new Set(consumerIds);
  const allNodeIds = new Set([...physicalSet, ...compositionSet]);

  const scopeRecords = Array.isArray(scopeDocument?.records) ? scopeDocument.records : [];
  const scopeBySurface = new Map();
  const resolvedScopeIds = new Set();
  const resolvedConsumerScopes = [];
  for (const ref of scopeDocument?.sourceRefs ?? []) {
    const sourcePath = ref.split('#', 1)[0];
    if (sourcePath.startsWith('.') && !fs.existsSync(path.resolve(root, sourcePath))) error(findings, 'CONSUMER_PDP0_SOURCE_REF_MISSING', 'PDP-0 scope', `Scope source ref does not exist: ${sourcePath}`);
  }
  for (const record of scopeRecords) {
    const surfaceId = record?.surfaceRef;
    if (!nonblank(surfaceId)) {
      error(findings, 'CONSUMER_PDP0_SCOPE_ID', '(scope record)', 'Every logical consumer scope record needs surfaceRef.');
      continue;
    }
    if (scopeBySurface.has(surfaceId)) error(findings, 'CONSUMER_PDP0_SCOPE_DUPLICATE', surfaceId, 'Logical consumer has multiple PDP-0 scope records.');
    else scopeBySurface.set(surfaceId, record);
  }
  const mappings = registry?.channelSurfaceProposals?.mappings ?? [];
  const mappingByChannel = new Map();
  for (const mapping of mappings) {
    const channelRef = mapping?.channelRef;
    if (!nonblank(channelRef)) continue;
    if (mappingByChannel.has(channelRef)) error(findings, 'CHANNEL_MAPPING_DUPLICATE', channelRef, 'A channel must have exactly one candidate-surface mapping.');
    else mappingByChannel.set(channelRef, mapping);
    const refs = mapping?.candidateSurfaceRefs ?? [];
    if (!unique(refs)) error(findings, 'CHANNEL_CANDIDATE_DUPLICATE', channelRef, 'Candidate surface refs must be unique within a channel mapping.');
    for (const ref of refs) if (!byRegistryId.has(ref)) error(findings, 'CHANNEL_CANDIDATE_UNKNOWN', channelRef, `Unknown candidate surface: ${ref}`);
  }
  const knownChannels = new Set([
    ...(authority?.applications?.channels ?? []).map((channel) => channel.id),
    ...(authority?.applications?.ownerDefinedChannels?.records ?? []).map((channel) => channel.id),
  ]);
  const applicableLeafDispositions = new Set(authority?.applications?.ownerLeafApplicabilityRules?.profileApplicabilityContract?.applicableChannelDispositions ?? []);
  const channelDisposition = (record, channelRef) => record?.channelApplicability?.find((row) => row.channelRef === channelRef)?.disposition;
  const webFamilies = authority?.applications?.channels?.find((channel) => channel.id === 'media.channel.web')?.ownerDefinitionApplicability?.familyConsumers ?? [];
  const webApplicableIds = new Set(webFamilies.flatMap((family) => family.webApplicableCapabilityRefs ?? []));
  const webNotApplicableIds = new Set(webFamilies.flatMap((family) => family.webNonApplicableCapabilityRefs ?? []));
  const webOwnerApplicability = authority?.applications?.channels?.find((channel) => channel.id === 'media.channel.web')?.ownerDefinitionApplicability;
  const webConsumerRecords = webOwnerApplicability?.consumerSpecificApplicability?.records ?? [];
  const studioConsumerApplicability = webConsumerRecords.find((record) => record.surfaceRef === 'media.surface.production-studio');
  const declarativeAcceptanceClauses = authority?.requirements?.declarativeProductionProfile?.acceptanceClauses ?? [];
  const declarativeAcceptanceClauseById = new Map();
  for (const clause of declarativeAcceptanceClauses) {
    if (!nonblank(clause?.id)) {
      error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_ID', 'PDP-0', 'Every declarative acceptance clause needs a stable ID.');
      continue;
    }
    if (declarativeAcceptanceClauseById.has(clause.id)) error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_ID_DUPLICATE', clause.id, 'Declarative acceptance case IDs must be unique.');
    else declarativeAcceptanceClauseById.set(clause.id, clause);
  }
  const assignedDeclarativeAcceptanceCaseIds = new Map();
  const leafApplicableToChannel = (id, channelRef) => channelRef === 'media.channel.web' ? webApplicableIds.has(id) : applicableLeafDispositions.has(channelDisposition(leafById.get(id), channelRef));
  const leafIds = leafRecords.map((leaf) => leaf.capabilityRef);
  const capabilityIds = capabilityCatalog.map((capability) => capability.id);
  const canonicalCapabilityIds = capabilityIds.filter((id) => leafById.has(id));
  const proposalApplicability = projectPdp0DefinitionExtensionApplicability(registry, topology, authority);
  let globalScopeIntegrity = true;
  if (leafRecords.length !== 462) {
    error(findings, 'PDP0_LEAF_DENOMINATOR', 'PDP-0', `Expected the exact 462-leaf authority denominator; found ${leafRecords.length}.`);
    globalScopeIntegrity = false;
  }
  if (webApplicableIds.size !== 77 || webNotApplicableIds.size !== 385
      || [...webApplicableIds].some((id) => webNotApplicableIds.has(id))
      || new Set([...webApplicableIds, ...webNotApplicableIds]).size !== 462
      || [...leafIds].some((id) => !webApplicableIds.has(id) && !webNotApplicableIds.has(id))) {
    error(findings, 'PDP0_WEB_PARTITION', 'media.channel.web', 'The exact generic Web applicability partition must remain 77 applicable and 385 non-applicable leaves, disjoint and complete over all 462 leaves.');
    globalScopeIntegrity = false;
  }
  if (webConsumerRecords.length !== 1 || !studioConsumerApplicability
      || studioConsumerApplicability.channelRef !== 'media.channel.web'
      || studioConsumerApplicability.status !== 'DELEGATED_SOURCE_DEFINITION_SELECTION; DEFINITION_ONLY'
      || studioConsumerApplicability.capabilityIntentRefs?.length !== 32
      || !unique(studioConsumerApplicability.capabilityIntentRefs ?? [])
      || !nonblank(studioConsumerApplicability.sourceRef)
      || studioConsumerApplicability.acceptanceCaseSourceRef !== `${SOURCE_PATHS.requirements}#/declarativeProductionProfile/acceptanceClauses`
      || !nonblank(studioConsumerApplicability.rationale)
      || (studioConsumerApplicability.capabilityIntentRefs ?? []).some((id) => !webNotApplicableIds.has(id))) {
    error(findings, 'PDP0_WEB_CONSUMER_APPLICABILITY', 'media.surface.production-studio', 'Studio consumer-specific Web applicability must be exact, source-backed, definition-only, and drawn from the generic Web non-applicable set.');
    globalScopeIntegrity = false;
  }
  const expectedExtensionIds = definitionExtensions.map((record) => record.capabilityId);
  const exactCatalogIds = [...leafIds, ...expectedExtensionIds].sort();
  if (!unique(leafIds) || !unique(capabilityIds) || !unique(expectedExtensionIds)
      || JSON.stringify([...leafIds].sort()) !== JSON.stringify([...canonicalCapabilityIds].sort())
      || JSON.stringify([...capabilityIds].sort()) !== JSON.stringify(exactCatalogIds)) {
    error(findings, 'PDP0_LEAF_IDENTITY_SET', 'PDP-0', 'The capability catalog must equal the 462 historical owner-adjudicated leaf set plus the separately recorded seven PDP-0 definition extensions.');
    globalScopeIntegrity = false;
  }
  if (definitionExtensions.length !== 7 || [...extensionById.keys()].some((id) => leafById.has(id))) {
    error(findings, 'PDP0_EXTENSION_DEFINITION_DENOMINATOR', 'PDP-0', 'The seven definition extensions must remain separate from the exact 462-leaf owner-adjudication denominator.');
    globalScopeIntegrity = false;
  }
  const versionDisposition = authority?.campaignExtensions?.currentDefinitionPopulation?.versionDisposition;
  const expectedFutureVersionIds = [
    'media.recipe.specification.compile',
    'media.project.scene.patch-merge',
    'media.quality.audio.content-similarity.assess',
    'media.generate.video.preset.manage',
    'media.generate.video.shot-condition',
    'media.job.schedule.manage',
    'media.master.audio.creative-effect.apply',
  ];
  const expectedDecisionRefs = [
    '.product-experience/decision-log.md#PXD-220',
    '.product-experience/decision-log.md#PXD-221',
  ];
  const actualDecisionRefs = versionDisposition?.decisionRefs ?? [];
  const expectedCurrentExtensionIds = [];
  const actualFutureVersionRows = versionDisposition?.futureVersionProposals ?? [];
  const actualFutureVersionIds = actualFutureVersionRows.map((row) => row.capabilityId);
  const actualCurrentExtensionIds = versionDisposition?.currentVersionExtensionCapabilityIds ?? [];
  const versionPartitionValid = JSON.stringify(actualDecisionRefs) === JSON.stringify(expectedDecisionRefs)
    && authority?.campaignExtensions?.currentDefinitionPopulation?.extensionDisposition
      === 'SIX_COORDINATOR_AUTHORED_MEANING_PROPOSALS_AND_ONE_USER_DELEGATED_CREATIVE_EFFECT_DEFINITION; ALL_SEVEN_FUTURE_VERSION; INDEPENDENT_ACCEPTANCE_NOT_CLAIMED'
    && versionDisposition?.historicalCanonicalCapabilityLeaves === 462
    && versionDisposition?.currentVersionCapabilityLeaves === 462
    && versionDisposition?.futureVersionProposalCapabilityLeaves === 7
    && versionDisposition?.totalSourceCapabilityDefinitions === 469
    && JSON.stringify(actualFutureVersionIds) === JSON.stringify(expectedFutureVersionIds)
    && JSON.stringify(actualCurrentExtensionIds) === JSON.stringify(expectedCurrentExtensionIds)
    && actualFutureVersionRows.every((row) => row.scopeStatus === 'DEFERRED' && row.version === 'later-governed-version'
      && expectedDecisionRefs.includes(row.decisionRef))
    && expectedFutureVersionIds.every((id) => capabilityById.get(id)?.scopeStatus === 'DEFERRED')
    && expectedCurrentExtensionIds.length === 0;
  if (!versionPartitionValid) {
    error(findings, 'PDP0_VERSION_SCOPE_PARTITION', 'PDP-0', 'PXD-220/PXD-221 must partition exactly seven DEFERRED proposal leaves from the 462-leaf current-version baseline while preserving the 469-record source catalog.');
    globalScopeIntegrity = false;
  }
  for (const extension of definitionExtensions) {
    const capability = capabilityById.get(extension.capabilityId);
    const requirementId = extension.requirementRef?.match(/@id=([^/]+)/u)?.[1];
    const familyId = extension.familyRef?.match(/@id=([^/]+)/u)?.[1];
    const family = capabilityFamilies.find((row) => row.id === familyId);
    const requirement = authority?.requirements?.requirements?.find((row) => row.id === requirementId);
    if (!capability || !requirement || !family
        || capability.familyId !== familyId
        || !(family.capabilityIds ?? []).includes(extension.capabilityId)
        || !(capability.requirementIds ?? []).includes(requirementId)
        || family.requirementId !== requirementId
        || !(extension.acceptanceCaseRefs ?? []).length
        || !extension.channelApplicabilityProposalRef) {
      error(findings, 'PDP0_EXTENSION_DEFINITION_BINDING', extension.capabilityId ?? '(extension missing id)', 'Every proposal extension must bind to its exact requirement, matching family, acceptance case, and separate proposal applicability record.');
      globalScopeIntegrity = false;
    }
  }
  if (!proposalApplicability.ok) {
    for (const finding of proposalApplicability.findings) error(findings, finding.code, finding.owner, finding.message);
    globalScopeIntegrity = false;
  }
  for (const leaf of leafRecords) {
    const cap = capabilityById.get(leaf.capabilityRef);
    if (!cap) continue;
    const a = [...new Set(leaf.requirementRefs ?? [])].sort();
    const b = [...new Set(cap.requirementIds ?? [])].sort();
    if (JSON.stringify(a) !== JSON.stringify(b) || a.some((id) => !requirementIds.has(id)) || !familyIds.has(cap.familyId)) {
      error(findings, 'PDP0_LEAF_REQUIREMENT_SOURCE_BINDING', leaf.capabilityRef, 'Exact leaf requirement/family refs must resolve to canonical PDP-0 source identities.');
      globalScopeIntegrity = false;
    }
    const rows = leaf.channelApplicability ?? [];
    const rowChannels = rows.map((row) => row.channelRef);
    if (rows.length !== knownChannels.size || !unique(rowChannels) || knownChannels.size !== new Set([...knownChannels, ...rowChannels]).size || [...knownChannels].some((id) => !rowChannels.includes(id))) {
      error(findings, 'PDP0_LEAF_CHANNEL_MATRIX', leaf.capabilityRef, 'Every exact capability leaf must have one decision for each of the 11 current channel identities.');
      globalScopeIntegrity = false;
    }
  }
  const assertLeafRefs = (owner, ids) => {
    for (const id of ids) {
      const leaf = leafById.get(id);
      const capability = capabilityById.get(id);
      if (!leaf || !capability) {
        error(findings, 'CONSUMER_PDP0_LEAF_UNKNOWN', owner, `Capability leaf is not in the exact P0 source denominator: ${id}`);
        continue;
      }
      const leafRequirements = [...new Set(leaf.requirementRefs ?? [])].sort();
      const capabilityRequirements = [...new Set(capability.requirementIds ?? [])].sort();
      if (JSON.stringify(leafRequirements) !== JSON.stringify(capabilityRequirements)) error(findings, 'CONSUMER_PDP0_REQUIREMENT_BINDING', owner, `${id} requirementRefs disagree with its canonical capability requirementIds.`);
      for (const requirementId of leafRequirements) if (!requirementIds.has(requirementId)) error(findings, 'CONSUMER_PDP0_REQUIREMENT_UNKNOWN', owner, `${id} references unknown PDP-0 requirement ${requirementId}.`);
      if (!(leafRequirements.length)) error(findings, 'CONSUMER_PDP0_REQUIREMENT_MISSING', owner, `${id} has no canonical requirement binding.`);
      if (!familyIds.has(capability.familyId)) error(findings, 'CONSUMER_PDP0_FAMILY_UNKNOWN', owner, `${id} references unknown capability family ${capability.familyId}.`);
    }
  };
  const linkedPhysical = (consumer) => (consumer?.physicalRefs ?? []).map((ref) => physical.find((candidate) => candidate.surfaceId === ref)).filter(Boolean);
  const physicalLeafIds = (consumer, owner) => {
    const linked = linkedPhysical(consumer);
    const ids = [];
    for (const item of linked) {
      const phase = item.phaseApplicability?.['PDP-0'];
      if (phase?.disposition !== 'APPLICABLE') continue;
      ids.push(...(phase.capabilityIntentIds ?? []));
    }
    const exact = [...new Set(ids)].sort();
    assertLeafRefs(owner, exact);
    return exact;
  };
  const assertMappedChannel = (surfaceId, channelRef) => {
    const refs = mappingByChannel.get(channelRef)?.candidateSurfaceRefs ?? [];
    if (!refs.includes(surfaceId)) error(findings, 'CONSUMER_PDP0_CHANNEL_UNMAPPED', surfaceId, `No candidate mapping binds ${channelRef} to this consumer.`);
  };
  const activeConsumers = consumers.filter((consumer) => consumer.bindingState !== 'ARCHIVED' && byRegistryId.get(consumer.surfaceId)?.applicabilityDisposition !== 'NOT_ACTIVE_ARCHIVED');
  const expectedScopeLeafCounts = new Map([
    ['media.surface.agent-tools', 13],
    ['media.surface.grpc.stt', 16],
    ['media.surface.grpc.tts', 17],
    ['media.surface.grpc.vision', 22],
    ['media.surface.grpc.multimodal', 43],
    ['media.surface.recorder-orchestrator', 25],
    ['media.surface.capture-adapters', 9],
    ['media.surface.production-studio', 37],
    ['media.surface.interactive-demo-player', 8],
  ]);
  for (const consumer of consumers) {
    const surfaceId = consumer.surfaceId;
    const surface = byRegistryId.get(surfaceId);
    const archived = consumer.bindingState === 'ARCHIVED' || surface?.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    if (archived) {
      const scope = scopeBySurface.get(surfaceId);
      if (scope) error(findings, 'ARCHIVED_SCOPE_PRESENT', surfaceId, 'Archived consumer must not have active logical PDP-0 scope.');
      continue;
    }
    const record = scopeBySurface.get(surfaceId);
    if (!record) {
      error(findings, 'CONSUMER_PDP0_SCOPE_MISSING', surfaceId, 'Active logical consumer needs an explicit PDP-0 scope record.');
      continue;
    }
    const initialFindingCount = findings.length;
    if (!nonblank(scopeDocument?.authority) || !scopeDocument?.sourceRefs?.length || scopeDocument.status !== 'SOURCE_CURRENT_DEFINITION_SCOPE; owner-acceptance-and-runtime-admission-pending') {
      error(findings, 'CONSUMER_PDP0_SCOPE_AUTHORITY', surfaceId, 'Scope document needs current source authority, source refs, and a definition-only pending-admission status.');
    }
    const mode = record.scopeMode;
    const channels = record.channelRefs ?? [];
    const inheritedChannels = record.inheritedChannelRefs ?? [];
    if (!nonblank(record.rationale)) error(findings, 'CONSUMER_PDP0_SCOPE_RATIONALE', surfaceId, 'PDP-0 consumer scope needs a rationale.');
    if (!nonblank(record.scopeSourceRef)) error(findings, 'CONSUMER_PDP0_SCOPE_SOURCE_REF', surfaceId, 'PDP-0 consumer scope needs an exact source reference.');
    for (const channelRef of [...channels, ...inheritedChannels]) {
      if (!knownChannels.has(channelRef)) error(findings, 'CONSUMER_PDP0_CHANNEL_UNKNOWN', surfaceId, `Unknown PDP-0 channel identity: ${channelRef}`);
    }
    let selectedLeafIds = [];
    let profileLeafIds = [];
    if (mode === 'CHANNEL_LEAF_APPLICABILITY') {
      if (channels.length !== 1) error(findings, 'CONSUMER_PDP0_CHANNEL_CARDINALITY', surfaceId, 'Direct channel scope must select exactly one channel.');
      const channelRef = channels[0];
      assertMappedChannel(surfaceId, channelRef);
      if (channelRef === 'media.channel.web') {
        const channel = authority.applications.channels.find((item) => item.id === channelRef);
        const families = channel?.ownerDefinitionApplicability?.familyConsumers ?? [];
        selectedLeafIds = [...new Set(families.flatMap((family) => family.webApplicableCapabilityRefs ?? []))].sort();
        const excluded = [...new Set(families.flatMap((family) => family.webNonApplicableCapabilityRefs ?? []))];
        assertLeafRefs(surfaceId, [...selectedLeafIds, ...excluded]);
        if (selectedLeafIds.length !== channel.ownerDefinitionApplicability?.webApplicableLeafCount) error(findings, 'CONSUMER_PDP0_WEB_DENOMINATOR', surfaceId, 'Exact owner-defined Web leaf overlay count does not match its source count.');
      } else {
        selectedLeafIds = [];
        for (const leaf of leafRecords) {
          const rows = (leaf.channelApplicability ?? []).filter((row) => row.channelRef === channelRef);
          if (rows.length !== 1) {
            error(findings, 'CONSUMER_PDP0_CHANNEL_ROW_COUNT', surfaceId, `${leaf.capabilityRef} must have exactly one ${channelRef} P0 decision.`);
            continue;
          }
          if (applicableLeafDispositions.has(rows[0].disposition)) selectedLeafIds.push(leaf.capabilityRef);
        }
        selectedLeafIds.sort();
      }
      if (selectedLeafIds.length === 0) error(findings, 'CONSUMER_PDP0_EMPTY_SCOPE', surfaceId, 'Direct channel scope resolves to no applicable capability leaves.');
      assertLeafRefs(surfaceId, selectedLeafIds);
      if (surfaceId === 'media.surface.agent-tools' && selectedLeafIds.length !== expectedScopeLeafCounts.get(surfaceId)) error(findings, 'CONSUMER_PDP0_LEAF_COUNT', surfaceId, `Expected exactly ${expectedScopeLeafCounts.get(surfaceId)} agent-applicable leaves; found ${selectedLeafIds.length}.`);
    } else if (mode === 'TOPOLOGY_PHYSICAL_PDP0_SCOPE') {
      if (channels.length !== 1) error(findings, 'CONSUMER_PDP0_CHANNEL_CARDINALITY', surfaceId, 'Physical service scope must name its channel.');
      const channelRef = channels[0];
      assertMappedChannel(surfaceId, channelRef);
      selectedLeafIds = physicalLeafIds(consumer, surfaceId);
      if (!selectedLeafIds.length) error(findings, 'CONSUMER_PDP0_EMPTY_SCOPE', surfaceId, 'Linked physical PDP-0 sources resolve to no capability leaves.');
      for (const id of selectedLeafIds) {
        const disposition = channelDisposition(leafById.get(id), channelRef);
        if (!leafApplicableToChannel(id, channelRef)) error(findings, 'CONSUMER_PDP0_CHANNEL_LEAF_MISMATCH', surfaceId, `${id} is selected by the linked physical source but ${channelRef} is ${disposition ?? 'missing'} for that leaf.`);
      }
      if (surfaceId.startsWith('media.surface.grpc.') && selectedLeafIds.length === 0) error(findings, 'GRPC_SPECIALIZATION_SCOPE_EMPTY', surfaceId, 'gRPC specialization must bind a non-empty exact service leaf set.');
    } else if (mode === 'RECORDER_PROFILE_CAPABILITY_BINDING') {
      const ownerSurface = record.recorderOwnerSurfaceRef;
      const extensionSurface = recorder?.surfaces?.find((item) => item.id === ownerSurface);
      if (!extensionSurface || ownerSurface !== surfaceId) error(findings, 'RECORDER_SCOPE_OWNER', surfaceId, 'Recorder scope must resolve to the matching source-declared owner surface.');
      const channelRef = channels[0];
      if (channels.length !== 1) error(findings, 'RECORDER_SCOPE_CHANNEL', surfaceId, 'Recorder profile scope must select exactly one current channel.');
      assertMappedChannel(surfaceId, channelRef);
      const profiles = recorder?.featureProfiles?.filter((profile) => profile.ownerSurface === ownerSurface) ?? [];
      const groups = [...new Set(profiles.map((profile) => profile.ownerCapabilityGroup))];
      const capabilityBindings = recorder?.capabilityBindings ?? {};
      profileLeafIds = [...new Set(groups.flatMap((group) => capabilityBindings[group] ?? []))].sort();
      selectedLeafIds = profileLeafIds;
      if (!profiles.length || !profileLeafIds.length) error(findings, 'RECORDER_SCOPE_EMPTY', surfaceId, 'Recorder owner surface must resolve feature profiles and exact capability bindings.');
      if (groups.some((group) => !/^REC-C\d\d$/.test(group))) error(findings, 'RECORDER_SCOPE_GROUP', surfaceId, 'Recorder profile group identity is malformed.');
      if (groups.some((group) => !Array.isArray(capabilityBindings[group]))) error(findings, 'RECORDER_SCOPE_BINDING_MISSING', surfaceId, 'Recorder capability group has no exact leaf binding.');
      assertLeafRefs(surfaceId, profileLeafIds);
      if (extensionSurface?.channel !== channelRef) {
        const expectedOverrideRef = `${SOURCE_PATHS.recorderStudio}#/surfaces/@id=${surfaceId}/channel`;
        if (record.sourceChannelOverrideRef !== expectedOverrideRef || !nonblank(record.sourceChannelOverrideRationale)) error(findings, 'RECORDER_CHANNEL_OVERRIDE', surfaceId, `Changed Recorder channel needs an explicit source-bound override of ${expectedOverrideRef}.`);
      } else if (record.sourceChannelOverrideRef || record.sourceChannelOverrideRationale) {
        error(findings, 'RECORDER_CHANNEL_OVERRIDE_UNNEEDED', surfaceId, 'Do not retain a superseded-channel override when the source channel agrees.');
      }
      const declarativeAcceptanceCaseRefs = record.declarativeAcceptanceCaseRefs ?? [];
      if (!Array.isArray(declarativeAcceptanceCaseRefs) || !unique(declarativeAcceptanceCaseRefs)) {
        error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_REFS', surfaceId, 'Declarative acceptance case refs must be a unique exact list.');
      }
      const caseBoundLeafIds = [];
      for (const caseId of Array.isArray(declarativeAcceptanceCaseRefs) ? declarativeAcceptanceCaseRefs : []) {
        const clause = declarativeAcceptanceClauseById.get(caseId);
        if (!clause) {
          error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_REF_UNKNOWN', surfaceId, `Unknown declarative acceptance case: ${caseId}`);
          continue;
        }
        const assignedTo = assignedDeclarativeAcceptanceCaseIds.get(caseId) ?? [];
        assignedTo.push(surfaceId);
        assignedDeclarativeAcceptanceCaseIds.set(caseId, assignedTo);
        if (clause.surfaceId !== surfaceId) error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_SURFACE', surfaceId, `${caseId} declares ${clause.surfaceId ?? '(missing surface)'} but is scoped to ${surfaceId}.`);
        if (clause.scope !== 'DEFINITION_REQUIREMENT_NOT_RUNTIME_PROOF') error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_SCOPE', surfaceId, `${caseId} must remain an explicit definition requirement, not runtime proof.`);
        const leafId = clause.capabilityLeafId;
        if (!leafById.has(leafId) || !capabilityById.has(leafId)) {
          error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_LEAF', surfaceId, `${caseId} references a capability leaf outside the exact PDP-0 denominator: ${leafId ?? '(missing leaf)'}`);
          continue;
        }
        const channelRef = channels[0];
        const studioOverride = surfaceId === 'media.surface.production-studio'
          && channelRef === 'media.channel.web'
          && record.consumerApplicabilityRef === 'channels/@id=media.channel.web/ownerDefinitionApplicability/consumerSpecificApplicability/@surfaceRef=media.surface.production-studio'
          && (studioConsumerApplicability?.capabilityIntentRefs ?? []).includes(leafId)
          && webNotApplicableIds.has(leafId);
        if (!leafApplicableToChannel(leafId, channelRef) && !studioOverride) {
          error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_CHANNEL', surfaceId, `${caseId} leaf ${leafId} is not definition-applicable to ${channelRef ?? '(missing channel)'}.`);
        }
        caseBoundLeafIds.push(leafId);
      }
      const exactCaseSourceRef = `${SOURCE_PATHS.requirements}#/declarativeProductionProfile/acceptanceClauses`;
      if (declarativeAcceptanceCaseRefs.length && !scopeDocument?.sourceRefs?.includes(exactCaseSourceRef)) error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_SOURCE', surfaceId, `PDP-0 scope source refs must include ${exactCaseSourceRef}.`);
      selectedLeafIds = [...new Set([...profileLeafIds, ...caseBoundLeafIds])].sort();
      assertLeafRefs(surfaceId, caseBoundLeafIds);
      for (const id of selectedLeafIds) {
        const disposition = channelDisposition(leafById.get(id), channelRef);
        const consumerRefs = studioConsumerApplicability?.capabilityIntentRefs ?? [];
        const overridden = surfaceId === 'media.surface.production-studio'
          && channelRef === 'media.channel.web'
          && record.consumerApplicabilityRef === 'channels/@id=media.channel.web/ownerDefinitionApplicability/consumerSpecificApplicability/@surfaceRef=media.surface.production-studio'
          && consumerRefs.includes(id)
          && webNotApplicableIds.has(id);
        if (!leafApplicableToChannel(id, channelRef) && !overridden) error(findings, 'CONSUMER_PDP0_CHANNEL_LEAF_MISMATCH', surfaceId, `${id} is selected by its Recorder profile but ${channelRef} is ${disposition ?? 'missing'} for that leaf without an exact sub-surface applicability decision.`);
      }
      if (surfaceId === 'media.surface.production-studio') {
        if (!studioConsumerApplicability || record.consumerApplicabilityRef !== 'channels/@id=media.channel.web/ownerDefinitionApplicability/consumerSpecificApplicability/@surfaceRef=media.surface.production-studio') error(findings, 'RECORDER_CONSUMER_APPLICABILITY_REF', surfaceId, 'Production Studio must point to the authoritative Web owner consumer-specific applicability record.');
        const consumerRefs = studioConsumerApplicability?.capabilityIntentRefs ?? [];
        const expectedConsumerRefs = [...new Set([
          ...profileLeafIds.filter((id) => webNotApplicableIds.has(id)),
          ...caseBoundLeafIds.filter((id) => webNotApplicableIds.has(id)),
        ])].sort();
        if (JSON.stringify([...consumerRefs].sort()) !== JSON.stringify(expectedConsumerRefs)
            || consumerRefs.some((id) => !selectedLeafIds.includes(id))
            || consumerRefs.some((id) => !webNotApplicableIds.has(id))) {
          error(findings, 'RECORDER_CONSUMER_APPLICABILITY_SCOPE', surfaceId, 'Studio owner record must exactly resolve Web-non-applicable feature-profile and declarative case leaves for this consumer.');
        }
      }
      for (const profile of profiles) if (!(profile.acceptanceCaseRefs ?? []).length) error(findings, 'RECORDER_PROFILE_CASES_MISSING', surfaceId, `Recorder profile ${profile.id} has no acceptance case refs.`);
    } else if (mode === 'INHERITED_PHYSICAL_DEFINITION') {
      if (channels.length) error(findings, 'INHERITED_SCOPE_DIRECT_CHANNEL', surfaceId, 'Inherited library scope must use inheritedChannelRefs, not claim a direct invocation channel.');
      if (!inheritedChannels.length) error(findings, 'INHERITED_SCOPE_CHANNELS_MISSING', surfaceId, 'Inherited library scope needs exact source consumer channels.');
      const currentPhysicalRefs = new Set(consumer.physicalRefs ?? []);
      for (const channelRef of inheritedChannels) {
        const candidateRefs = mappingByChannel.get(channelRef)?.candidateSurfaceRefs ?? [];
        if (!candidateRefs.length) error(findings, 'INHERITED_SCOPE_CHANNEL_UNBOUND', surfaceId, `Inherited channel has no source proposal: ${channelRef}`);
        const tracedCandidate = consumers.find((candidate) => candidateRefs.includes(candidate.surfaceId)
          && (candidate.physicalRefs ?? []).some((physicalRef) => currentPhysicalRefs.has(physicalRef)));
        if (!tracedCandidate) error(findings, 'INHERITED_SCOPE_CHANNEL_TRACE', surfaceId, `${channelRef} has no candidate consumer sharing a linked physical source with this library.`);
      }
      selectedLeafIds = physicalLeafIds(consumer, surfaceId);
      if (!selectedLeafIds.length) error(findings, 'INHERITED_SCOPE_PHYSICAL_REFS_MISSING', surfaceId, 'Inherited scope needs exact P0-applicable physical source refs.');
      for (const id of selectedLeafIds) {
        if (!inheritedChannels.some((channelRef) => leafApplicableToChannel(id, channelRef))) error(findings, 'INHERITED_SCOPE_CHANNEL_LEAF_MISMATCH', surfaceId, `${id} is not applicable to any declared inherited channel.`);
      }
    } else if (mode === 'NON_INVOCATION_CHANNEL') {
      if (channels.length !== 1 || channels[0] !== 'media.channel.event') error(findings, 'EVENT_SCOPE_CHANNEL', surfaceId, 'Event consumer must bind only the owner-defined event channel.');
      assertMappedChannel(surfaceId, channels[0]);
      for (const leaf of leafRecords) if (channelDisposition(leaf, channels[0]) !== 'NOT_A_CAPABILITY_INVOCATION_CHANNEL') error(findings, 'EVENT_SCOPE_LEAF_DISPOSITION', surfaceId, `${leaf.capabilityRef} must remain explicitly outside capability invocation on the event channel.`);
      if (!nonblank(record.scopeSourceRef)) error(findings, 'EVENT_SCOPE_RULE_REF', surfaceId, 'Event non-invocation scope needs its explicit owner rule ref.');
    } else if (mode === 'TOOLING_NON_INVOCATION') {
      if (channels.length || inheritedChannels.length) error(findings, 'TOOLING_SCOPE_CHANNEL', surfaceId, 'Read-only Explorer scope must not claim a product invocation channel.');
      if (consumer.consumerType !== 'EXPLORER_TOOLING') error(findings, 'TOOLING_SCOPE_TYPE', surfaceId, 'Non-invocation tooling scope is reserved for the Explorer consumer type.');
      const linked = linkedPhysical(consumer);
      if (!linked.some((item) => item.phaseApplicability?.['PDP-0']?.disposition === 'NO_IMPLEMENTATION_ADMITTED')) error(findings, 'TOOLING_SCOPE_TOPOLOGY', surfaceId, 'Explorer must remain non-admitted in physical PDP-0 topology.');
    } else {
      error(findings, 'CONSUMER_PDP0_SCOPE_MODE', surfaceId, `Unknown PDP-0 scope mode: ${mode ?? '(missing)'}`);
    }
    if (expectedScopeLeafCounts.has(surfaceId) && selectedLeafIds.length !== expectedScopeLeafCounts.get(surfaceId)) error(findings, 'CONSUMER_PDP0_LEAF_COUNT', surfaceId, `Expected exactly ${expectedScopeLeafCounts.get(surfaceId)} capability leaves; found ${selectedLeafIds.length}.`);
    const proposalsForSurface = mappings.filter((mapping) => (mapping.candidateSurfaceRefs ?? []).includes(surfaceId));
    for (const channelRef of channels) if (!proposalsForSurface.some((mapping) => mapping.channelRef === channelRef)) error(findings, 'CONSUMER_PDP0_PROPOSAL_MISSING', surfaceId, `No candidate proposal exists for its declared channel ${channelRef}.`);
    if (globalScopeIntegrity && findings.length === initialFindingCount) {
      resolvedScopeIds.add(surfaceId);
      resolvedConsumerScopes.push({
        surfaceId,
        scopeMode: mode,
        channelRefs: [...channels],
        inheritedChannelRefs: [...inheritedChannels],
        capabilityIntentRefs: [...selectedLeafIds].sort(),
        profileCapabilityIntentRefs: mode === 'RECORDER_PROFILE_CAPABILITY_BINDING' ? [...profileLeafIds].sort() : [...selectedLeafIds].sort(),
        declarativeAcceptanceCaseRefs: [...(record.declarativeAcceptanceCaseRefs ?? [])].sort(),
        requirementRefs: [...new Set(selectedLeafIds.flatMap((id) => leafById.get(id)?.requirementRefs ?? []))].sort(),
      });
    }
  }
  for (const record of scopeRecords) {
    if (!consumerSet.has(record.surfaceRef)) error(findings, 'CONSUMER_PDP0_SCOPE_UNKNOWN', record.surfaceRef, 'PDP-0 scope record does not identify a topology consumer.');
  }
  const expectedDeclarativeCaseSourceRef = `${SOURCE_PATHS.requirements}#/declarativeProductionProfile/acceptanceClauses`;
  if (declarativeAcceptanceClauses.length && !scopeDocument?.sourceRefs?.includes(expectedDeclarativeCaseSourceRef)) {
    error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_SOURCE', 'PDP-0 scope', `PDP-0 scope source refs must include ${expectedDeclarativeCaseSourceRef}.`);
  }
  for (const clause of declarativeAcceptanceClauses) {
    const assigned = assignedDeclarativeAcceptanceCaseIds.get(clause.id) ?? [];
    if (assigned.length === 0) error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_UNBOUND', clause.surfaceId ?? clause.id, `${clause.id} must be bound by exactly one logical-consumer PDP-0 scope.`);
    else if (assigned.length !== 1) error(findings, 'CONSUMER_PDP0_ACCEPTANCE_CASE_DUPLICATE', clause.surfaceId ?? clause.id, `${clause.id} is bound by ${assigned.length} logical-consumer PDP-0 scopes.`);
  }

  for (const [kind, ids] of [['PHYSICAL_ID', physicalIds], ['COMPOSITION_ID', compositionIds], ['CONSUMER_ID', consumerIds]]) {
    if (!unique(ids)) {
      const seen = new Set();
      for (const id of ids) {
        if (seen.has(id)) error(findings, `${kind}_DUPLICATE`, id ?? '(missing)', `${kind.toLowerCase()} is duplicated.`);
        seen.add(id);
      }
    }
  }
  for (const item of physical) {
    const id = item?.surfaceId ?? '(physical missing id)';
    if (!nonblank(item?.surfaceId)) error(findings, 'PHYSICAL_ID_MISSING', id, 'Manifest candidate has no surfaceId.');
    if (!nonblank(item?.manifestPath) || !nonblank(item?.sourcePath)) error(findings, 'PHYSICAL_IDENTITY_INCOMPLETE', id, 'Physical identity must name sourcePath and manifestPath.');
    const phase = item?.phaseApplicability?.['PDP-0'];
    const allowed = ['APPLICABLE', 'NOT_APPLICABLE_SUPPORT', 'NO_IMPLEMENTATION_ADMITTED'];
    if (!phase || !allowed.includes(phase.disposition)) {
      error(findings, 'PHYSICAL_PDP0_DISPOSITION', id, `PDP-0 disposition must be one of ${allowed.join(', ')}.`);
      continue;
    }
    if (!nonblank(phase.authorityRef)) error(findings, 'PHYSICAL_PDP0_AUTHORITY', id, 'PDP-0 applicability needs an authorityRef.');
    if (!nonblank(phase.rationale)) error(findings, 'PHYSICAL_PDP0_RATIONALE', id, 'Every PDP-0 disposition needs a rationale.');
    if (phase.disposition === 'APPLICABLE') {
      const refs = [...(phase.capabilityFamilyIds ?? []), ...(phase.capabilityIntentIds ?? []), ...(phase.requirementIds ?? []), ...(phase.intentIds ?? [])];
      if (refs.length === 0) error(findings, 'PHYSICAL_PDP0_REFS', id, 'Applicable physical surface must name at least one capability, requirement, or intent.');
    } else if (phase.disposition === 'NOT_APPLICABLE_SUPPORT' && ((phase.capabilityFamilyIds ?? []).length || (phase.capabilityIntentIds ?? []).length || (phase.requirementIds ?? []).length || (phase.intentIds ?? []).length)) {
      error(findings, 'PHYSICAL_PDP0_NA_REFS', id, 'Non-applicable physical surface must not claim PDP-0 capability, requirement, or intent refs.');
    }
    if (nonblank(phase.authorityRef) && !fs.existsSync(path.resolve(root, phase.authorityRef))) error(findings, 'SOURCE_REF_MISSING', id, `PDP-0 authorityRef does not exist: ${phase.authorityRef}`);
    for (const consumerId of item.consumerSurfaceRefs ?? []) {
      if (!consumerSet.has(consumerId)) error(findings, 'PHYSICAL_CONSUMER_LINK', id, `consumerSurfaceRef is absent from the consumer crosswalk: ${consumerId}`);
    }
  }

  for (const composition of compositions) {
    const id = composition?.surfaceId ?? '(composition missing id)';
    if (!nonblank(composition?.surfaceId)) error(findings, 'COMPOSITION_ID_MISSING', id, 'Composition has no surfaceId.');
    for (const child of composition.children ?? []) if (!allNodeIds.has(child)) error(findings, 'COMPOSITION_CHILD_MISSING', id, `Unknown physical/composite child: ${child}`);
    const phase = composition?.phaseApplicability?.['PDP-0'];
    if (!phase || !['ROOT_AUTHORITY_REFERENCE', 'DIRECT_CROSS_CHILD_MEANING'].includes(phase.disposition)) {
      error(findings, 'COMPOSITION_PDP0_DISPOSITION', id, 'Composition needs a recognized PDP-0 authority/direct-meaning disposition.');
      continue;
    }
    if (!nonblank(phase.authorityRef)) error(findings, 'COMPOSITION_PDP0_AUTHORITY', id, 'PDP-0 composition needs an authorityRef.');
    if (!nonblank(phase.rationale)) error(findings, 'COMPOSITION_PDP0_RATIONALE', id, 'PDP-0 composition needs a rationale.');
    if (phase.disposition === 'DIRECT_CROSS_CHILD_MEANING') {
      if (!nonblank(composition.directMeaning)) error(findings, 'COMPOSITION_DIRECT_MEANING', id, 'Applicable composite must define directMeaning.');
      const refs = [...(phase.capabilityFamilyIds ?? []), ...(phase.capabilityIntentIds ?? []), ...(phase.requirementIds ?? []), ...(phase.intentIds ?? [])];
      if (refs.length === 0) error(findings, 'COMPOSITION_PDP0_REFS', id, 'Applicable composite must include direct PDP-0 meaning refs.');
    }
    if (nonblank(phase.authorityRef) && !fs.existsSync(path.resolve(root, phase.authorityRef))) error(findings, 'SOURCE_REF_MISSING', id, `PDP-0 authorityRef does not exist: ${phase.authorityRef}`);
  }

  for (const consumer of consumers) {
    const id = consumer?.surfaceId ?? '(consumer missing id)';
    if (!nonblank(consumer?.surfaceId)) error(findings, 'CONSUMER_ID_MISSING', id, 'Consumer crosswalk row has no surfaceId.');
    const registrySurface = byRegistryId.get(id);
    if (!registrySurface) {
      error(findings, 'CONSUMER_REGISTRY_MISSING', id, 'Consumer crosswalk surface is missing from the logical surface registry.');
      continue;
    }
    if (registrySurface.parentSurfaceId !== consumer.parentSurfaceId) error(findings, 'CONSUMER_PARENT_MISMATCH', id, 'Registry parentSurfaceId must equal the topology consumer crosswalk parentSurfaceId.');
    for (const parentId of [registrySurface.parentSurfaceId, consumer.parentSurfaceId].filter(Boolean)) {
      if (!byRegistryId.has(parentId)) error(findings, 'CONSUMER_PARENT_UNKNOWN', id, `Unknown logical parent surface: ${parentId}`);
    }
    for (const ref of consumer.physicalRefs ?? []) if (!physicalSet.has(ref)) error(findings, 'CONSUMER_PHYSICAL_LINK', id, `physicalRef is absent from manifestCandidates: ${ref}`);
    const archived = consumer.bindingState === 'ARCHIVED' || registrySurface.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    if (!Array.isArray(registrySurface.applicablePdpArtifacts) || !registrySurface.applicablePdpArtifacts.includes('PDP-0')) {
      if (!archived) error(findings, 'CONSUMER_PDP0_UNDECLARED', id, 'Active logical consumer must explicitly include PDP-0 applicability in the registry.');
    }
    if (archived && registrySurface.applicabilityDisposition !== 'NOT_ACTIVE_ARCHIVED') error(findings, 'ARCHIVED_DISPOSITION_MISSING', id, 'Archived consumer needs explicit NOT_ACTIVE_ARCHIVED disposition.');
    if (archived && !nonblank(registrySurface.applicabilityRationale)) error(findings, 'ARCHIVED_RATIONALE_MISSING', id, 'Archived consumer needs an explicit applicability rationale.');
    if (registrySurface.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED' && !archived) error(findings, 'UNDECLARED_ARCHIVE', id, 'Registry archive disposition is not reflected by topology.');
    for (const ref of consumer.physicalRefs ?? []) {
      const item = physical.find((candidate) => candidate.surfaceId === ref);
      if (item && !(item.consumerSurfaceRefs ?? []).includes(id)) error(findings, 'PHYSICAL_LINK_INVERSE', id, `Physical candidate ${ref} does not point back to this consumer.`);
    }
  }

  for (const surface of registrySurfaces) {
    if (surface.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED') continue;
    if (!consumerSet.has(surface.surfaceId)) error(findings, 'REGISTRY_CONSUMER_UNMAPPED', surface.surfaceId, 'Non-archived logical registry surface is absent from topology consumer crosswalk.');
  }

  const stats = {
    physicalManifestCandidates: physical.length,
    compositions: compositions.length,
    logicalConsumers: consumers.length,
    registrySurfaces: registrySurfaces.length,
    archivedConsumers: consumers.filter((consumer) => byRegistryId.get(consumer.surfaceId)?.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED').length,
    activeLogicalConsumers: activeConsumers.length,
    activeLogicalScopesResolved: resolvedScopeIds.size,
    applicablePhysicalPdp0: physical.filter((item) => item.phaseApplicability?.['PDP-0']?.disposition === 'APPLICABLE').length,
    notApplicableSupportPhysicalPdp0: physical.filter((item) => item.phaseApplicability?.['PDP-0']?.disposition === 'NOT_APPLICABLE_SUPPORT').length,
    noImplementationAdmittedPhysicalPdp0: physical.filter((item) => item.phaseApplicability?.['PDP-0']?.disposition === 'NO_IMPLEMENTATION_ADMITTED').length,
    denominator: physical.length + compositions.length + consumers.length,
  };
  return { ok: findings.length === 0, stats, findings, consumerScopes: resolvedConsumerScopes, proposalApplicability };
}

export function projectPdp0DefinitionExtensionApplicability(registry, topology, authority) {
  const findings = [];
  const source = authority?.applications?.coordinatorDefinitionExtensionApplicability;
  const records = source?.records ?? [];
  const campaigns = authority?.campaignExtensions?.currentDefinitionPopulation?.records ?? [];
  const versionDisposition = authority?.campaignExtensions?.currentDefinitionPopulation?.versionDisposition;
  const futureVersionById = new Map((versionDisposition?.futureVersionProposals ?? []).map((row) => [row.capabilityId, row]));
  const currentVersionExtensionIds = new Set(versionDisposition?.currentVersionExtensionCapabilityIds ?? []);
  const channels = [
    ...(authority?.applications?.channels ?? []).map((row) => row.id),
    ...(authority?.applications?.ownerDefinedChannels?.records ?? []).map((row) => row.id),
  ].sort();
  const mappings = new Map((registry?.channelSurfaceProposals?.mappings ?? []).map((row) => [row.channelRef, row]));
  const consumers = new Map((topology?.consumerCrosswalk ?? []).map((row) => [row.surfaceId, row]));
  const physical = topology?.manifestCandidates ?? [];
  const compositions = topology?.compositions ?? [];
  const surfaces = [
    ...physical.map((row) => ({ surfaceId: row.surfaceId, surfaceType: 'PHYSICAL', baseDisposition: row.phaseApplicability?.['PDP-0']?.disposition, baseRationale: row.phaseApplicability?.['PDP-0']?.rationale })),
    ...compositions.map((row) => ({ surfaceId: row.surfaceId, surfaceType: row.surfaceId === 'media.composition.repository-root' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION', baseDisposition: row.phaseApplicability?.['PDP-0']?.disposition, baseRationale: row.phaseApplicability?.['PDP-0']?.rationale })),
    ...(topology?.consumerCrosswalk ?? []).map((row) => ({ surfaceId: row.surfaceId, surfaceType: 'LOGICAL_CONSUMER', baseDisposition: row.bindingState === 'ARCHIVED' ? 'ARCHIVED' : 'APPLICABLE', baseRationale: row.bindingState === 'ARCHIVED' ? 'The registered logical consumer is archived and is not an active PDP-0 surface.' : null })),
  ];
  const surfaceIds = surfaces.map((row) => row.surfaceId);
  const supportIds = surfaces.filter((row) => row.baseDisposition === 'NOT_APPLICABLE_SUPPORT').map((row) => row.surfaceId).sort();
  const archivedIds = surfaces.filter((row) => row.baseDisposition === 'ARCHIVED').map((row) => row.surfaceId).sort();
  const activeIds = surfaces.filter((row) => !['NOT_APPLICABLE_SUPPORT', 'ARCHIVED'].includes(row.baseDisposition)).map((row) => row.surfaceId).sort();
  const extensions = campaigns.map((row) => row.capabilityId).sort();
  const recordIds = records.map((row) => row.capabilityRef).sort();
  const byId = new Map(records.map((row) => [row.capabilityRef, row]));
  const capabilityById = new Map((authority?.capabilities?.capabilities ?? []).map((row) => [row.id, row]));
  const campaignById = new Map(campaigns.map((row) => [row.capabilityId, row]));
  const supportSet = new Set(supportIds);
  const archivedSet = new Set(archivedIds);
  const direct = new Set();
  const aggregate = new Set(['media.composition.repository-root', 'media.composition.creation-composition-and-delivery', 'media.composition.client-and-machine-interfaces']);
  const sourceDecisionRef = '.product-experience/decision-log.md#PXD-207';
  const auditPath = path.resolve(ROOT, 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json');
  const sourceAudit = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath, 'utf8')) : null;
  const auditById = new Map((sourceAudit?.originalAudit?.inventory ?? []).map((row) => [row.audit_id, row]));
  if (source?.decisionRef !== sourceDecisionRef || source?.status !== 'USER_DELEGATED_PDP0_APPLICABILITY_DECISIONS; source-current; independent acceptance pending'
      || source?.ownerApproval !== 'NOT_CLAIMED' || source?.independentAcceptance !== 'NOT_CLAIMED'
      || source?.executionAdmission !== 'NOT_ADMITTED'
      || source?.denominator?.capabilityDefinitionExtensions !== 7 || source?.denominator?.historicalOwnerAdjudications !== 462
      || source?.denominator?.channels !== 11 || source?.denominator?.totalSurfaceIdentities !== 54
      || surfaces.length !== 54 || new Set(surfaceIds).size !== 54 || channels.length !== 11 || new Set(channels).size !== 11) {
    findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_AUTHORITY', owner: 'PDP-0', message: 'PXD-207 applicability must preserve 7/462/11/54 denominators and keep owner acceptance, independent acceptance, and execution admission unclaimed.' });
  }
  if (records.length !== 7 || JSON.stringify(recordIds) !== JSON.stringify(extensions) || new Set(recordIds).size !== 7) {
    findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_DENOMINATOR', owner: 'PDP-0', message: 'PXD-207 must decide each of the seven current definition extensions exactly once.' });
  }
  if (JSON.stringify(versionDisposition?.decisionRefs ?? []) !== JSON.stringify([
        '.product-experience/decision-log.md#PXD-220',
        '.product-experience/decision-log.md#PXD-221',
      ])
      || versionDisposition?.futureVersionProposalCapabilityLeaves !== 7
      || versionDisposition?.currentVersionCapabilityLeaves !== 462
      || futureVersionById.size !== 7 || currentVersionExtensionIds.size !== 0
      || [...futureVersionById.keys()].some((id) => !campaignById.has(id) || capabilityById.get(id)?.scopeStatus !== 'DEFERRED')
      || [...currentVersionExtensionIds].some((id) => !campaignById.has(id) || capabilityById.get(id)?.scopeStatus !== 'TARGET')) {
    findings.push({ code: 'PDP0_VERSION_SCOPE_PARTITION', owner: 'PDP-0', message: 'PXD-220/PXD-221 future-version proposal and current-version extension memberships must exactly cover the seven extension records.' });
  }
  if (!source?.dispositionRule?.explicitExclusions?.includes('NOT_APPLICABLE_OWNER_DECISION')
      || !source?.dispositionRule?.derivedAggregate?.includes('DERIVED_AGGREGATE_OWNER_DECISION')
      || !source?.dispositionRule?.apiBoundary?.includes('does not imply HTTP, gRPC, SDK')) {
    findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_RULES', owner: 'PDP-0', message: 'PXD-207 must state explicit exclusion, derived aggregate, and protocol-neutral API rules.' });
  }
  const physicalById = new Map(physical.map((row) => [row.surfaceId, row]));
  const compositionById = new Map(compositions.map((row) => [row.surfaceId, row]));
  const reachesPhysical = (surfaceId, physicalId, visiting = new Set()) => {
    if (surfaceId === physicalId) return true;
    const composition = compositionById.get(surfaceId);
    if (!composition || visiting.has(surfaceId)) return false;
    const next = new Set(visiting).add(surfaceId);
    return (composition.children ?? []).some((child) => reachesPhysical(child, physicalId, next));
  };
  const cellRows = [];
  const surfaceRows = [];
  for (const campaign of campaigns) {
    const id = campaign.capabilityId;
    const record = byId.get(id);
    const capability = capabilityById.get(id);
    const decision = record?.decision ?? {};
    const candidateChannel = record?.candidateChannelRef;
    const sourceOwner = record?.sourceOwnerSurfaceRef;
    const candidateMap = mappings.get(candidateChannel);
    const supported = (capability?.supportedChannels ?? []).map((channel) => `media.channel.${channel}`).sort();
    const declared = [...(record?.declaredSupportedChannelRefs ?? [])].sort();
    const included = [...(decision.includedSurfaceRefs ?? [])].sort();
    const expectedIncluded = [sourceOwner, ...(record?.resolution?.physicalSurfaceRefs ?? []), ...aggregate].sort();
    const expectedExcluded = activeIds.filter((surfaceId) => !expectedIncluded.includes(surfaceId)).sort();
    const excluded = (decision.excludedSurfaceRefs ?? []).map((row) => row.surfaceRef).sort();
    const expectedExcludedChannels = channels.filter((channel) => channel !== candidateChannel).sort();
    const excludedChannels = (decision.excludedChannelRefs ?? []).map((row) => row.channelRef).sort();
    const physicalRefs = [...(record?.resolution?.physicalSurfaceRefs ?? [])].sort();
    const aggregateRefs = [...(record?.resolution?.compositeSurfaceRefs ?? [])].sort();
    const exactAuditIds = [...(campaign.sourceAuditIds ?? [])].sort();
    const recordAuditIds = [...(record?.sourceAuditIds ?? [])].sort();
    const sourceRefs = decision.sourceRefs ?? [];
    const sourceProposalRefs = record?.sourceOwnerSurfaceProposalRefs ?? [];
    const expectedProposalRefs = exactAuditIds.map((auditId) => `docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json#originalAudit.inventory/@audit_id=${auditId}/owner_surface_proposal`);
    const auditOwnerSurfaces = exactAuditIds.map((auditId) => auditById.get(auditId)?.owner_surface_proposal);
    if (!record || !capability || !candidateMap || !campaign.requirementRef || !campaign.familyRef
        || candidateChannel !== decision.includedChannelRef || decision.status !== 'DELEGATED_PDP0_APPLICABILITY_DECISION'
        || decision.sourceOfDecision !== 'explicit-user-delegated-Media-owner-PDP-0-applicability-only'
        || decision.decisionRef !== sourceDecisionRef || decision.ownerApproval !== 'NOT_CLAIMED'
        || decision.independentAcceptance !== 'NOT_CLAIMED' || decision.executionAdmission !== 'NOT_ADMITTED'
        || JSON.stringify(supported) !== JSON.stringify([candidateChannel]) || JSON.stringify(declared) !== JSON.stringify([candidateChannel])
        || JSON.stringify(exactAuditIds) !== JSON.stringify(recordAuditIds) || !candidateMap.candidateSurfaceRefs?.includes(sourceOwner)
        || !consumers.has(sourceOwner) || JSON.stringify(included) !== JSON.stringify(expectedIncluded)
        || JSON.stringify(excluded) !== JSON.stringify(expectedExcluded) || new Set(excluded).size !== excluded.length
        || JSON.stringify(excludedChannels) !== JSON.stringify(expectedExcludedChannels) || new Set(excludedChannels).size !== excludedChannels.length
        || physicalRefs.length !== 1
        || physicalRefs.some((surfaceId) => physicalById.get(surfaceId)?.phaseApplicability?.['PDP-0']?.disposition !== 'APPLICABLE' || !(consumers.get(sourceOwner)?.physicalRefs ?? []).includes(surfaceId))
        || JSON.stringify(aggregateRefs) !== JSON.stringify([...aggregate].sort())
        || !aggregateRefs.every((surfaceId) => reachesPhysical(surfaceId, physicalRefs[0]))
        || !decision.includeRationale?.trim() || !sourceRefs.includes(sourceDecisionRef)
        || !sourceRefs.includes(`.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`)
        || JSON.stringify(sourceProposalRefs) !== JSON.stringify(expectedProposalRefs)
        || auditOwnerSurfaces.some((surfaceId) => surfaceId !== sourceOwner)
        || (decision.excludedSurfaceRefs ?? []).some((row) => !row.rationale?.trim())
        || (decision.excludedChannelRefs ?? []).some((row) => !row.rationale?.trim())
        || (!futureVersionById.has(id) && !currentVersionExtensionIds.has(id))) {
      findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_RECORD', owner: id, message: 'PXD-207 needs an exact single-channel/surface positive set, complete rationale-backed channel/surface exclusion sets, valid source links, and current topology derivation.' });
    }
    for (const ref of [...sourceRefs, ...sourceProposalRefs]) {
      const sourcePath = ref.split('#', 1)[0];
      if (!fs.existsSync(path.resolve(ROOT, sourcePath))) findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_SOURCE_REF', owner: id, message: `Missing PXD-207 applicability source reference: ${ref}` });
    }
    const decisionExcludedSurfaces = new Map((decision.excludedSurfaceRefs ?? []).map((row) => [row.surfaceRef, row]));
    const decisionExcludedChannels = new Map((decision.excludedChannelRefs ?? []).map((row) => [row.channelRef, row]));
    for (const surface of surfaces) {
      const includedSurface = (decision.includedSurfaceRefs ?? []).includes(surface.surfaceId);
      const isAggregate = aggregate.has(surface.surfaceId);
      const surfaceDisposition = surface.baseDisposition === 'NOT_APPLICABLE_SUPPORT' ? 'NOT_APPLICABLE_SUPPORT'
        : surface.baseDisposition === 'ARCHIVED' ? 'NOT_APPLICABLE_ARCHIVED'
          : includedSurface ? (isAggregate ? 'DERIVED_AGGREGATE_OWNER_DECISION' : 'OWNER_DECIDED_APPLICABLE')
            : 'NOT_APPLICABLE_OWNER_DECISION';
      const surfaceRationale = surfaceDisposition === 'NOT_APPLICABLE_SUPPORT' || surfaceDisposition === 'NOT_APPLICABLE_ARCHIVED'
        ? surface.baseRationale
        : includedSurface ? decision.includeRationale : decisionExcludedSurfaces.get(surface.surfaceId)?.rationale;
      surfaceRows.push({ capabilityRef: id, surfaceId: surface.surfaceId, surfaceType: surface.surfaceType, disposition: surfaceDisposition,
        sourceAuditIds: campaign.sourceAuditIds ?? [], decisionRef: sourceDecisionRef,
        sourceRef: `${SOURCE_PATHS.applications}#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=${id}/decision`,
        ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', executionAdmission: 'NOT_ADMITTED', rationale: surfaceRationale });
      const futureVersionProposal = futureVersionById.get(id);
      const versionScopeStatus = futureVersionProposal?.scopeStatus ?? (currentVersionExtensionIds.has(id) ? 'CURRENT_VERSION_EXTENSION' : 'UNRESOLVED');
      const versionDispositionRef = futureVersionProposal
        ? `${futureVersionProposal.decisionRef}; ${futureVersionProposal.version}`
        : currentVersionExtensionIds.has(id) ? '.product-experience/decision-log.md#PXD-207' : null;
      for (const channelRef of channels) {
        let disposition = surfaceDisposition;
        let rationale = surfaceRationale;
        if (!['NOT_APPLICABLE_SUPPORT', 'NOT_APPLICABLE_ARCHIVED'].includes(surfaceDisposition)) {
          if (includedSurface && channelRef === candidateChannel) {
            disposition = surfaceDisposition;
          } else {
            disposition = 'NOT_APPLICABLE_OWNER_DECISION';
            rationale = includedSurface
              ? decisionExcludedChannels.get(channelRef)?.rationale
              : decisionExcludedSurfaces.get(surface.surfaceId)?.rationale;
          }
        }
        if (!nonblank(rationale)) findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_RATIONALE', owner: id, message: `Missing explicit rationale for ${channelRef} × ${surface.surfaceId}.` });
        cellRows.push({ capabilityRef: id, surfaceId: surface.surfaceId, surfaceType: surface.surfaceType, channelRef, disposition,
          versionScopeStatus, versionDispositionRef,
          sourceAuditIds: campaign.sourceAuditIds ?? [], decisionRef: sourceDecisionRef,
          sourceRef: `${SOURCE_PATHS.applications}#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=${id}/decision`,
          ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', executionAdmission: 'NOT_ADMITTED', rationale,
          channelRefs: ['OWNER_DECIDED_APPLICABLE', 'DERIVED_AGGREGATE_OWNER_DECISION'].includes(disposition) ? [channelRef] : [] });
      }
    }
  }
  const dispositionKinds = ['OWNER_DECIDED_APPLICABLE', 'DERIVED_AGGREGATE_OWNER_DECISION', 'NOT_APPLICABLE_OWNER_DECISION', 'NOT_APPLICABLE_SUPPORT', 'NOT_APPLICABLE_ARCHIVED'];
  const counts = Object.fromEntries(dispositionKinds.map((kind) => [kind, cellRows.filter((row) => row.disposition === kind).length]));
  const surfaceCounts = Object.fromEntries(dispositionKinds.map((kind) => [kind, surfaceRows.filter((row) => row.disposition === kind).length]));
  if (JSON.stringify(counts) !== JSON.stringify({ OWNER_DECIDED_APPLICABLE: 14, DERIVED_AGGREGATE_OWNER_DECISION: 21, NOT_APPLICABLE_OWNER_DECISION: 3430, NOT_APPLICABLE_SUPPORT: 616, NOT_APPLICABLE_ARCHIVED: 77 })) {
    findings.push({ code: 'PDP0_EXTENSION_APPLICABILITY_PARTITION', owner: 'PDP-0', message: `PXD-207 must partition all 4,158 cells exactly (actual ${JSON.stringify(counts)}).` });
  }
  return { ok: findings.length === 0, status: 'SOURCE_CURRENT_OWNER_DECISIONS_COMPLETE', channelCount: channels.length, surfaceCellCount: surfaceRows.length, counts, surfaceCounts,
    versionDisposition: { currentVersionExtensionCount: currentVersionExtensionIds.size, currentVersionExtensionCapabilityIds: [...currentVersionExtensionIds].sort(),
      futureVersionProposalCount: futureVersionById.size, futureVersionProposalCapabilityIds: [...futureVersionById.keys()].sort(), decisionRefs: versionDisposition?.decisionRefs ?? [] },
    records: cellRows, surfaceRecords: surfaceRows, findings };
}

export function readSources(root = ROOT) {
  const registry = parse(fs.readFileSync(path.resolve(root, SOURCE_PATHS.registry), 'utf8'));
  const topology = JSON.parse(fs.readFileSync(path.resolve(root, SOURCE_PATHS.topology), 'utf8'));
  return { registry, topology, authority: readPdp0AuthoritySources(root) };
}

export function readPdp0AuthoritySources(root = ROOT) {
  const readYaml = (relativePath) => parse(fs.readFileSync(path.resolve(root, relativePath), 'utf8'));
  return {
    applications: readYaml(SOURCE_PATHS.applications),
    capabilityLeafReview: readYaml(SOURCE_PATHS.capabilityLeafReview),
    recorderStudio: readYaml(SOURCE_PATHS.recorderStudio),
    capabilities: readYaml(SOURCE_PATHS.capabilities),
    requirements: readYaml(SOURCE_PATHS.requirements),
    campaignExtensions: readYaml(SOURCE_PATHS.campaignExtensions),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { registry, topology, authority } = readSources();
  const result = validatePdp0SurfaceDenominator(registry, topology, authority);
  const { records: _records, surfaceRecords: _surfaceRecords, ...proposalSummary } = result.proposalApplicability;
  console.log(JSON.stringify({ ...result, proposalApplicability: proposalSummary }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
