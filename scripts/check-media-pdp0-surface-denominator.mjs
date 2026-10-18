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
  const leafApplicableToChannel = (id, channelRef) => channelRef === 'media.channel.web' ? webApplicableIds.has(id) : applicableLeafDispositions.has(channelDisposition(leafById.get(id), channelRef));
  const leafIds = leafRecords.map((leaf) => leaf.capabilityRef);
  const capabilityIds = capabilityCatalog.map((capability) => capability.id);
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
      || studioConsumerApplicability.capabilityIntentRefs?.length !== 15
      || !unique(studioConsumerApplicability.capabilityIntentRefs ?? [])
      || !nonblank(studioConsumerApplicability.sourceRef)
      || !nonblank(studioConsumerApplicability.rationale)
      || (studioConsumerApplicability.capabilityIntentRefs ?? []).some((id) => !webNotApplicableIds.has(id))) {
    error(findings, 'PDP0_WEB_CONSUMER_APPLICABILITY', 'media.surface.production-studio', 'Studio consumer-specific Web applicability must be exact, source-backed, definition-only, and drawn from the generic Web non-applicable set.');
    globalScopeIntegrity = false;
  }
  if (!unique(leafIds) || !unique(capabilityIds) || JSON.stringify([...leafIds].sort()) !== JSON.stringify([...capabilityIds].sort())) {
    error(findings, 'PDP0_LEAF_IDENTITY_SET', 'PDP-0', 'Capability catalog and exact leaf review must contain the same unique capabilityIntentId set.');
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
    ['media.surface.recorder-orchestrator', 13],
    ['media.surface.capture-adapters', 9],
    ['media.surface.production-studio', 20],
    ['media.surface.interactive-demo-player', 3],
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
      selectedLeafIds = [...new Set(groups.flatMap((group) => capabilityBindings[group] ?? []))].sort();
      if (!profiles.length || !selectedLeafIds.length) error(findings, 'RECORDER_SCOPE_EMPTY', surfaceId, 'Recorder owner surface must resolve feature profiles and exact capability bindings.');
      if (groups.some((group) => !/^REC-C\d\d$/.test(group))) error(findings, 'RECORDER_SCOPE_GROUP', surfaceId, 'Recorder profile group identity is malformed.');
      if (groups.some((group) => !Array.isArray(capabilityBindings[group]))) error(findings, 'RECORDER_SCOPE_BINDING_MISSING', surfaceId, 'Recorder capability group has no exact leaf binding.');
      assertLeafRefs(surfaceId, selectedLeafIds);
      if (extensionSurface?.channel !== channelRef) {
        const expectedOverrideRef = `${SOURCE_PATHS.recorderStudio}#/surfaces/@id=${surfaceId}/channel`;
        if (record.sourceChannelOverrideRef !== expectedOverrideRef || !nonblank(record.sourceChannelOverrideRationale)) error(findings, 'RECORDER_CHANNEL_OVERRIDE', surfaceId, `Changed Recorder channel needs an explicit source-bound override of ${expectedOverrideRef}.`);
      } else if (record.sourceChannelOverrideRef || record.sourceChannelOverrideRationale) {
        error(findings, 'RECORDER_CHANNEL_OVERRIDE_UNNEEDED', surfaceId, 'Do not retain a superseded-channel override when the source channel agrees.');
      }
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
        if (consumerRefs.some((id) => !selectedLeafIds.includes(id)) || consumerRefs.length !== 15) error(findings, 'RECORDER_CONSUMER_APPLICABILITY_SCOPE', surfaceId, 'Studio owner record must exactly resolve within its 20 source-bound Recorder profile leaves.');
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
        requirementRefs: [...new Set(selectedLeafIds.flatMap((id) => leafById.get(id)?.requirementRefs ?? []))].sort(),
      });
    }
  }
  for (const record of scopeRecords) {
    if (!consumerSet.has(record.surfaceRef)) error(findings, 'CONSUMER_PDP0_SCOPE_UNKNOWN', record.surfaceRef, 'PDP-0 scope record does not identify a topology consumer.');
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
  return { ok: findings.length === 0, stats, findings, consumerScopes: resolvedConsumerScopes };
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
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { registry, topology, authority } = readSources();
  const result = validatePdp0SurfaceDenominator(registry, topology, authority);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
