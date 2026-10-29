import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topologyPath = path.join(repo, '.product-experience/surfaces/media-physical-topology.v1.json');
const source = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const sourcePath = (ref) => ref.split('#', 1)[0];
const existsRef = (root, ref) => fs.existsSync(path.join(root, sourcePath(ref)));
const ids = (p) => new Set([...source(p).matchAll(/^\s*-?\s*id:\s*['"]?([^\s,'"]+)/gm)].map((m) => m[1]));
const idList = (p) => [...source(p).matchAll(/^\s*-?\s*id:\s*['"]?([^\s,'"]+)/gm)].map((m) => m[1]);
const manifestNames = new Set(['package.json', 'build.gradle', 'build.gradle.kts', 'Cargo.toml']);
const ignoredManifestDirectories = new Set(['.git', 'node_modules', 'build', 'dist', '.gradle', '.vite', 'target']);

function activeBuildManifests(root) {
  const refs = [];
  const roots = ['apps', 'libs', 'modules', 'adapters', 'providers', 'launcher', 'runtime-contracts', 'audio-video-observability', 'integration-tests'];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!ignoredManifestDirectories.has(entry.name)) walk(path.join(directory, entry.name));
      } else if (entry.isFile() && manifestNames.has(entry.name)) {
        refs.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  for (const relative of roots) walk(path.join(root, relative));
  return refs.sort();
}

function compareExactIds(actualValues, expectedValues, label, fail) {
  const actual = new Set(actualValues ?? []);
  const expected = new Set(expectedValues ?? []);
  if (actual.size !== (actualValues ?? []).length) fail(`${label} contains duplicate IDs`);
  if (expected.size !== (expectedValues ?? []).length) fail(`${label} canonical source contains duplicate IDs`);
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length || extra.length) fail(`${label} must exactly match canonical IDs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
}

export function validateTopology(topology, root = repo) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const candidates = topology.manifestCandidates ?? [];
  const byId = new Map(candidates.map((candidate) => [candidate.surfaceId, candidate]));
  if (topology.schemaVersion !== 'media.physical-topology.v1') fail('schemaVersion must be media.physical-topology.v1');
  if (candidates.length !== topology.activeManifestCandidateCount || candidates.length !== 29) fail('active manifest candidate count must include every authored FULL-scope build manifest (29 total)');
  if (new Set(candidates.map((candidate) => candidate.sourcePath)).size !== candidates.length) fail('physical source paths must be unique');
  if (new Set(candidates.map((candidate) => candidate.surfaceId)).size !== candidates.length) fail('physical identities must be unique');
  const dispositions = new Set(['PHYSICAL', 'SUBSUMED', 'SUPPORT_ONLY', 'ARCHIVED', 'EXTERNAL']);
  const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
  for (const candidate of candidates) {
    if (!dispositions.has(candidate.disposition)) fail(`${candidate.surfaceId}: unsupported physical disposition ${candidate.disposition}`);
    for (const ref of [candidate.manifestPath, candidate.publicBoundaryRef]) {
      if (!fs.existsSync(path.join(root, ref))) fail(`${candidate.surfaceId}: missing source ref ${ref}`);
    }
    if (!candidate.manifestPath.startsWith(`${candidate.sourcePath}/`)
      || !candidate.publicBoundaryRef.startsWith(`${candidate.sourcePath}/`)) {
      fail(`${candidate.surfaceId}: manifest and public boundary refs must resolve inside the declared source owner`);
    }
    for (const phase of phases) {
      const cell = candidate.phaseApplicability?.[phase];
      if (!cell || !cell.disposition || !cell.rationale) fail(`${candidate.surfaceId}: ${phase} applicability cell is incomplete`);
      const refs = [cell.authorityRef, cell.operationAuthorityRef, ...(cell.authorityRefs ?? [])].filter(Boolean);
      for (const ref of refs) if (!existsRef(root, ref)) fail(`${candidate.surfaceId}: ${phase} has missing authority ref ${ref}`);
      for (const ref of cell.implementationRefs ?? []) if (!existsRef(root, ref)) fail(`${candidate.surfaceId}: ${phase} has missing implementation ref ${ref}`);
    }
  }
  const activeManifests = new Set(activeBuildManifests(root));
  const candidateManifests = new Set(candidates.map((candidate) => candidate.manifestPath));
  for (const manifest of activeManifests) if (!candidateManifests.has(manifest)) fail(`active build manifest has no topology candidate/disposition: ${manifest}`);
  for (const manifest of candidateManifests) if (!activeManifests.has(manifest)) fail(`topology candidate manifest is not in the active authored build inventory: ${manifest}`);
  const crosswalk = topology.consumerCrosswalk ?? [];
  const successor = topology.recorderStudioConsumerSuccessor;
  if (!successor || successor.status !== 'SOURCE_DEFINED_PENDING_DISCOVERY_READMISSION'
    || successor.historicalConsumerCount !== 17 || successor.currentConsumerCount !== 21
    || successor.historicalPhysicalCount !== 26 || successor.historicalCompositionCount !== 7
    || successor.historicalPhaseCells !== 200 || successor.successorProposedPhaseCells !== 216
    || successor.externalAndRuntimeAdmission !== 'NOT_ADMITTED') {
    fail('recorder studio successor consumer census and stage boundary must be explicit (17 retained plus four, 216 target PDP cells)');
  }
  const historic = new Set(successor?.historicalConsumerIds ?? []);
  const added = new Set(successor?.addedLogicalConsumerSurfaceIds ?? []);
  if (historic.size !== 17 || added.size !== 4
    || [...historic].some(id => !crosswalk.some(x => x.surfaceId === id))
    || [...added].some(id => !crosswalk.some(x => x.surfaceId === id))
    || [...historic].some(id => added.has(id))) {
    fail('recorder studio successor must preserve all 17 historical consumer IDs and bind exactly four new logical IDs');
  }
  if (crosswalk.length !== 21 || new Set(crosswalk.map((x) => x.surfaceId)).size !== 21)
    fail('consumer crosswalk must contain exactly 21 unique surfaces (17 historical plus four Recorder Studio)');
  const registryIds = new Set([...source('.product-experience/surface-registry.yaml').matchAll(/^\s+- surfaceId:\s*([^\s]+)/gm)].map((m) => m[1]));
  const crosswalkIds = new Set(crosswalk.map((x) => x.surfaceId));
  if (registryIds.size !== crosswalk.length || [...registryIds].some((id) => !crosswalkIds.has(id)) || [...crosswalkIds].some((id) => !registryIds.has(id))) fail('crosswalk must match every surface-registry identity in both directions');
  const bindingStates = new Set(['PHYSICAL', 'CONTRACT_ONLY', 'HOST_DEPENDENT', 'ARCHIVED']);
  const reverse = new Map(candidates.map((c) => [c.surfaceId, []]));
  for (const consumer of crosswalk) {
    if (!bindingStates.has(consumer.bindingState) || !consumer.statusReason) fail(`${consumer.surfaceId}: binding state and reason are required`);
    if (!registryIds.has(consumer.surfaceId)) fail(`${consumer.surfaceId}: not present in surface-registry.yaml`);
    for (const ref of consumer.sourceContracts ?? []) if (!existsRef(root, ref)) fail(`${consumer.surfaceId}: missing contract source ${ref}`);
    for (const ref of consumer.physicalRefs) {
      if (!byId.has(ref)) fail(`${consumer.surfaceId}: unknown physical ref ${ref}`);
      else reverse.get(ref).push(consumer.surfaceId);
    }
    if (consumer.bindingState !== 'ARCHIVED' && consumer.physicalRefs.length === 0) fail(`${consumer.surfaceId}: active consumer needs an explicit physical or contract binding`);
  }
  for (const candidate of candidates) {
    const expected = [...(reverse.get(candidate.surfaceId) ?? [])].sort();
    const recorded = [...(candidate.consumerSurfaceRefs ?? [])].sort();
    if (JSON.stringify(expected) !== JSON.stringify(recorded)) fail(`${candidate.surfaceId}: physical-to-consumer reverse refs do not match the crosswalk`);
    if (!['MAPPED', 'NO_DIRECT_CONSUMER_SUPPORT_ONLY'].includes(candidate.consumerMappingState)) fail(`${candidate.surfaceId}: explicit consumer mapping state is required`);
    if (expected.length === 0 && candidate.consumerMappingState !== 'NO_DIRECT_CONSUMER_SUPPORT_ONLY') fail(`${candidate.surfaceId}: missing consumer must be explicitly support-only`);
  }
  const aiVoiceUi = byId.get('media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react');
  if (aiVoiceUi) {
    const p2 = aiVoiceUi.phaseApplicability?.['PDP-2'];
    const expectedComponents = ['media.component.voice-production-workflow', 'media.component.waveform-spectrogram', 'media.component.timeline-keyframe-editor'];
    const expectedAuthorityRefs = [
      '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml#channels/GUI',
      '.product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml',
      '.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#media.component.voice-production-workflow',
      '.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#media.component.waveform-spectrogram',
      '.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml#media.component.timeline-keyframe-editor',
      '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#media.component.voice-production-workflow',
      '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#media.component.waveform-spectrogram',
      '.product-experience/pdp-2-design-interface-system/component-contracts.yaml#media.component.timeline-keyframe-editor',
      '.product-experience/pdp-2-design-interface-system/component-value-types.yaml'
    ];
    const expectedImplementationRefs = [
      'modules/intelligence/ai-voice/libs/ai-voice-ui-react/package.json#exports',
      'modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts#PhraseTimeline,Waveform,VoiceProductionWorkflow'
    ];
    if (p2?.disposition !== 'GUI_LIBRARY_HOST_DEPENDENT') fail(`${aiVoiceUi.surfaceId}: exported React component library must be classified as host-dependent GUI applicability`);
    compareExactIds(p2?.componentRefs, expectedComponents, `${aiVoiceUi.surfaceId} PDP-2 GUI component refs`, fail);
    compareExactIds(p2?.authorityRefs, expectedAuthorityRefs, `${aiVoiceUi.surfaceId} PDP-2 GUI authority refs`, fail);
    compareExactIds(p2?.implementationRefs, expectedImplementationRefs, `${aiVoiceUi.surfaceId} PDP-2 implementation refs`, fail);
    const packageManifest = source(aiVoiceUi.manifestPath);
    const entry = source('modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts');
    const guiBindings = source('.product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml');
    const componentContracts = source('.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
    if (!packageManifest.includes('"name": "@ghatana/ai-voice-ui-react"')
      || !packageManifest.includes('"exports":')
      || !['PhraseTimeline', 'Waveform', 'VoiceProductionWorkflow'].every((name) => entry.includes(name))
      || expectedComponents.some((id) => !guiBindings.includes(`componentRef: ${id}`)
        || !componentContracts.includes(`id: ${id}`))) {
      fail(`${aiVoiceUi.surfaceId}: package manifest and public component exports do not support the declared GUI source trace`);
    }
    const p0 = aiVoiceUi.phaseApplicability?.['PDP-0'];
    if ((p0?.capabilityIntentIds ?? []).length > 1 || (p0?.capabilityIntentIds ?? []).some((id) => !id.startsWith('media.speech.synthesis.text-to-speech'))) {
      fail(`${aiVoiceUi.surfaceId}: PDP-0 UI scope cannot imply every speech-synthesis processing leaf`);
    }
  }
  const mediaExplorer = byId.get('media.physical.apps-media-experience-explorer');
  if (mediaExplorer) {
    const p2 = mediaExplorer.phaseApplicability?.['PDP-2'];
    const expectedAuthorityRefs = [
      '.product-experience/pdp-2-design-interface-system/gui/explorer-workbench.yaml',
      '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml#channels/GUI',
      '.product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml',
      '.product-experience/pdp-2-design-interface-system/accessibility.yaml',
      '.product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml'
    ];
    if (p2?.disposition !== 'GUI_TOOLING_CONSUMER') {
      fail(`${mediaExplorer.surfaceId}: mapped browser workbench must be classified as an applicable PDP-2 GUI tooling consumer`);
    }
    compareExactIds(p2?.authorityRefs, expectedAuthorityRefs, `${mediaExplorer.surfaceId} PDP-2 GUI authority refs`, fail);
    if (!/browser workbench/u.test(p2?.rationale ?? '')
      || !/not a production Media UI/u.test(p2?.rationale ?? '')
      || !/does not claim runtime admission, owner acceptance, or phase acceptance/u.test(p2?.rationale ?? '')) {
      fail(`${mediaExplorer.surfaceId}: PDP-2 rationale must bind its own GUI contract while preserving local-tool and non-authority boundaries`);
    }
    const registry = source('.product-experience/surface-registry.yaml');
    const explorerRegistryEntry = registry.split(/^  - surfaceId:\s*/m).find((entry) => entry.startsWith('media.surface.explorer\n')) ?? '';
    if (!/applicablePdpArtifacts:\s*\[PDP-0, PDP-1, PDP-2, PDP-3\]/u.test(explorerRegistryEntry)) {
      fail(`${mediaExplorer.surfaceId}: PDP-2 physical applicability must agree with the logical Explorer surface registry`);
    }
    const explorerContract = source('.product-experience/pdp-2-design-interface-system/gui/explorer-workbench.yaml');
    if (!explorerContract.includes('physicalSurfaceId: media.physical.apps-media-experience-explorer')
      || !explorerContract.includes('logicalSurfaceId: media.surface.explorer')
      || !['Product', 'Explore', 'Specification', 'Verify', 'Tools Review'].every((mode) => explorerContract.includes(mode))
      || !explorerContract.includes('owner review and phase acceptance are not claimed')
      || !explorerContract.includes('Explorer is a projection')) {
      fail(`${mediaExplorer.surfaceId}: PDP-2 workbench contract must bind the mapped GUI modes and retain the non-authoritative Explorer boundary`);
    }
  }
  const agentTools = crosswalk.find((consumer) => consumer.surfaceId === 'media.surface.agent-tools');
  const agentToolAdapters = byId.get('media.physical.adapters-agent-tools-media');
  if (agentTools && agentToolAdapters) {
    const observation = agentTools.handlerSourceObservation;
    if (!agentTools.physicalRefs.includes('media.physical.runtime-contracts')
      || !agentTools.physicalRefs.includes('media.physical.adapters-agent-tools-media')) {
      fail('media.surface.agent-tools must preserve runtime-contracts association and map its optional adapter source owner');
    }
    if (observation?.physicalOwner !== 'media.physical.adapters-agent-tools-media'
      || observation?.operationAssociation !== 'media.physical.runtime-contracts'
      || observation?.classification !== 'LEGACY_SUBSUMED_NOT_ADMITTED'
      || !existsRef(root, observation?.sourcePath ?? '')) {
      fail('media.surface.agent-tools handler source must remain observational, legacy/subsumed, and not admitted');
    }
    const sourceRegistry = source('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml');
    const handlers = [...sourceRegistry.matchAll(/^\s+handlerSource:\s*([^\s]+)$/gm)].map((match) => match[1]);
    if (handlers.length !== 4 || handlers.some((handler) => !handler.startsWith(`${observation?.sourcePath}/`) || !existsRef(root, handler))) {
      fail('Agent Tool source observation must cover the four exact handler files under adapters/agent-tools-media');
    }
    if (!agentToolAdapters.consumerSurfaceRefs.includes('media.surface.agent-tools')
      || !agentToolAdapters.sourceOwnedObservations?.some((item) => item.consumerSurfaceId === 'media.surface.agent-tools'
        && item.classification === 'LEGACY_SUBSUMED_NOT_ADMITTED'
        && item.sourcePath === observation?.sourcePath)) {
      fail('agent-tools-media must reverse-map the Agent Tool observational source link without claiming runtime admission');
    }
  }
  const compositions = topology.compositions ?? [];
  const compositionById = new Map(compositions.map((x) => [x.surfaceId, x]));
  if (new Set(compositions.map((x) => x.surfaceId)).size !== compositions.length) fail('composition identities must be unique');
  for (const composition of compositions) {
    if (composition.canonicalOwner !== 'media' || !composition.directMeaning || !composition.children?.length) fail(`${composition.surfaceId}: composition must state Media canonical owner, direct meaning and children`);
    if (!composition.membershipSemantics || composition.membershipSemantics.relation !== 'CONTAINS'
      || composition.membershipSemantics.meaning !== 'children are direct members only'
      || composition.membershipSemantics.aggregationKey !== 'surfaceId'
      || composition.membershipSemantics.aggregateUniqueMembers !== true
      || composition.membershipSemantics.dependenciesAreMembership !== false) {
      fail(`${composition.surfaceId}: direct CONTAINS and unique surfaceId aggregation semantics are required`);
    }
    if (new Set(composition.children).size !== composition.children.length) fail(`${composition.surfaceId}: direct CONTAINS children must be unique`);
    if (!Array.isArray(composition.dependencies ?? [])) fail(`${composition.surfaceId}: dependencies must be a separate list from containment`);
    for (const dependency of composition.dependencies ?? []) {
      if (composition.children.includes(dependency)) fail(`${composition.surfaceId}: DEPENDS_ON cannot also be direct CONTAINS membership: ${dependency}`);
      if (!byId.has(dependency) && !compositionById.has(dependency)) fail(`${composition.surfaceId}: unknown DEPENDS_ON target ${dependency}`);
    }
    for (const phase of phases) {
      const cell = composition.phaseApplicability?.[phase];
      if (!cell?.disposition || !cell?.rationale) fail(`${composition.surfaceId}: ${phase} applicability cell is incomplete`);
      for (const ref of [cell.authorityRef, ...(cell.authorityRefs ?? [])].filter(Boolean)) {
        if (!existsRef(root, ref)) fail(`${composition.surfaceId}: ${phase} has missing authority ref ${ref}`);
      }
    }
    for (const child of composition.children ?? []) {
      if (typeof child !== 'string') fail(`${composition.surfaceId}: children must be direct CONTAINS IDs; dependency edges belong in dependencies`);
      else if (!byId.has(child) && !compositionById.has(child)) fail(`${composition.surfaceId}: unknown direct CONTAINS child ${child}`);
    }
    if (composition.kind === 'SEMANTIC_COMPOSITION') {
      const obligations = composition.crossChildObligations ?? [];
      if (obligations.length !== 1) fail(`${composition.surfaceId}: one explicit Media-owned direct cross-child integration obligation is required`);
      for (const obligation of obligations) {
        if (obligation.canonicalOwner !== composition.canonicalOwner || obligation.status !== 'SOURCE_PLANNING_ONLY'
          || obligation.meaning !== composition.directMeaning) {
          fail(`${composition.surfaceId}: cross-child obligation must retain Media ownership, composition meaning, and source-planning status`);
        }
        compareExactIds(obligation.participantSurfaceIds, composition.children, `${composition.surfaceId} cross-child participants`, fail);
      }
    }
  }
  const roots = compositions.filter((x) => x.kind === 'REPOSITORY_ROOT');
  if (roots.length !== 1) fail('exactly one repository root composition is required');
  if (compositions.length !== 7) fail('topology must contain one repository root and exactly six semantic compositions');
  const rootNode = roots[0];
  if (rootNode) {
    const semanticIds = compositions.filter((x) => x.kind !== 'REPOSITORY_ROOT').map((x) => x.surfaceId);
    const semanticPhysicalIds = new Set(compositions.filter((x) => x.kind !== 'REPOSITORY_ROOT').flatMap((x) => x.children.filter((id) => byId.has(id))));
    const ungroupedSupportIds = candidates.filter((candidate) => !semanticPhysicalIds.has(candidate.surfaceId)).map((candidate) => candidate.surfaceId);
    const expectedRootChildren = [...semanticIds, ...ungroupedSupportIds].sort();
    const actualRootChildren = [...rootNode.children].sort();
    if (JSON.stringify(actualRootChildren) !== JSON.stringify(expectedRootChildren)) {
      fail('repository root direct CONTAINS must be the six semantic compositions plus only ungrouped physical support units');
    }
    if (rootNode.children.some((id) => byId.has(id) && semanticPhysicalIds.has(id))) fail('repository root cannot directly repeat a physical member already grouped by a semantic composition');
    if (!rootNode.membershipSemantics || rootNode.membershipSemantics.aggregateUniqueMembers !== true) fail('repository root must declare deduplicated aggregation by surfaceId');
    const membershipParents = new Map();
    for (const composition of compositions.filter((x) => x.kind !== 'REPOSITORY_ROOT')) {
      for (const child of composition.children) if (byId.has(child)) membershipParents.set(child, [...(membershipParents.get(child) ?? []), composition.surfaceId]);
    }
    const expectedShared = [...membershipParents].filter(([, parents]) => parents.length > 1).map(([surfaceId, parents]) => ({ surfaceId, parentCompositionIds: [...parents].sort() })).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
    const declaredShared = [...(rootNode.sharedPhysicalMemberships ?? [])].map(({ surfaceId, parentCompositionIds }) => ({ surfaceId, parentCompositionIds: [...parentCompositionIds].sort() })).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
    if (JSON.stringify(declaredShared) !== JSON.stringify(expectedShared)) fail('shared physical membership must enumerate each multi-parent leaf and its distinct semantic compositions exactly once');
    for (const item of rootNode.sharedPhysicalMemberships ?? []) {
      for (const parentId of item.parentCompositionIds ?? []) {
        const parent = compositionById.get(parentId);
        if (!parent?.directMeaning) fail(`${item.surfaceId}: shared membership parent ${parentId} lacks a distinct semantic role`);
      }
      const meanings = (item.parentCompositionIds ?? []).map((parentId) => compositionById.get(parentId)?.directMeaning).filter(Boolean);
      if (new Set(meanings).size !== meanings.length) fail(`${item.surfaceId}: shared membership parents must declare distinct semantic roles`);
    }
  }
  const reachable = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) { fail(`containment cycle reaches ${id}`); return; }
    if (reachable.has(id)) return;
    visiting.add(id);
    reachable.add(id);
    const node = compositionById.get(id);
    for (const child of node?.children ?? []) {
      if (compositionById.has(child)) visit(child);
      else if (byId.has(child)) reachable.add(child);
    }
    visiting.delete(id);
  };
  if (roots[0]) {
    visit(roots[0].surfaceId);
    for (const id of byId.keys()) if (!reachable.has(id)) fail(`orphan physical candidate ${id} has no containment path from repository root`);
    for (const item of [...byId.keys(), ...compositionById.keys()]) if (!reachable.has(item)) fail(`unreachable topology node ${item}`);
  }
  const sourceIds = new Set();
  for (const file of ['.product-experience/pdp-0-product-truth/capabilities.yaml', '.product-experience/pdp-0-product-truth/requirements.yaml', '.product-experience/pdp-0-product-truth/goals-jtbd.yaml', '.product-experience/pdp-1-domain-data/domain-objects.yaml', '.product-experience/pdp-1-domain-data/operations.yaml', '.product-experience/pdp-3-product-experience/screen-registry.yaml', '.product-experience/pdp-3-product-experience/journey-registry.yaml']) {
    for (const id of ids(file)) sourceIds.add(id);
  }
  for (const node of [...candidates, ...compositions]) {
    const p0 = node.phaseApplicability?.['PDP-0'];
    for (const ref of [...(p0?.capabilityFamilyIds ?? []), ...(p0?.requirementIds ?? []), ...(p0?.capabilityIntentIds ?? []), ...(p0?.intentIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-0 reference is not in canonical source: ${ref}`);
    const p3 = node.phaseApplicability?.['PDP-3'];
    for (const ref of [...(p3?.screenIds ?? []), ...(p3?.journeyIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-3 experience ref is not in canonical source: ${ref}`);
    const p1 = node.phaseApplicability?.['PDP-1'];
    for (const ref of [...(p1?.operationIds ?? []), ...(p1?.domainObjectIds ?? [])]) if (!sourceIds.has(ref)) fail(`${node.surfaceId}: PDP-1 ref is not in canonical source: ${ref}`);
  }
  const rootPdp3 = rootNode?.phaseApplicability?.['PDP-3'];
  compareExactIds(rootPdp3?.screenIds, idList('.product-experience/pdp-3-product-experience/screen-registry.yaml'), 'repository root PDP-3 screen IDs', fail);
  compareExactIds(rootPdp3?.journeyIds, idList('.product-experience/pdp-3-product-experience/journey-registry.yaml'), 'repository root PDP-3 journey IDs', fail);
  const responsibleNodes = [...candidates, ...compositions.filter((composition) => composition.kind !== 'REPOSITORY_ROOT')];
  compareExactIds([...new Set(responsibleNodes.flatMap((node) => node.phaseApplicability?.['PDP-3']?.screenIds ?? []))], idList('.product-experience/pdp-3-product-experience/screen-registry.yaml'), 'responsible physical/composition PDP-3 screen IDs', fail);
  compareExactIds([...new Set(responsibleNodes.flatMap((node) => node.phaseApplicability?.['PDP-3']?.journeyIds ?? []))], idList('.product-experience/pdp-3-product-experience/journey-registry.yaml'), 'responsible physical/composition PDP-3 journey IDs', fail);
  for (const entry of topology.additionalBoundarySources ?? []) {
    if (!existsRef(root, entry.sourcePath)) fail(`additional boundary source is missing: ${entry.sourcePath}`);
    if (!registryIds.has(entry.consumerSurfaceId)) fail(`additional boundary source has unknown consumer: ${entry.consumerSurfaceId}`);
    if (!entry.binding || !entry.kind) fail(`additional boundary source lacks an explicit binding decision: ${entry.sourcePath}`);
  }
  const archivedPaths = new Set(topology.archivedManifestLocations.map((x) => x.path));
  if (archivedPaths.size !== 4 || [...archivedPaths].some((p) => !fs.existsSync(path.join(root, p)))) fail('four archived desktop manifests must be accounted for with extant source paths');
  if (topology.lifecycleContractStatus?.status !== 'SOURCE_CANDIDATE_AVAILABLE_PUBLIC_ADMISSION_PENDING') fail('Lifecycle availability must distinguish source candidate from public admission');
  if (topology.lifecycleContractStatus?.hierarchicalMediaContractStatus !== 'SOURCE_CANDIDATE_AVAILABLE_PUBLIC_ADMISSION_PENDING') fail('Lifecycle source candidate must remain public-admission-pending');
  if (topology.lifecycleContractStatus?.sourceCandidate?.mediaUse !== 'TEST_ONLY'
    || topology.lifecycleContractStatus?.sourceCandidate?.publicAdmission !== 'PENDING'
    || topology.lifecycleContractStatus?.sourceCandidate?.nativeLifecycleStatus !== 'NOT_ADMITTED') {
    fail('Lifecycle source candidate must remain TEST_ONLY and native NOT_ADMITTED');
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
  const errors = validateTopology(topology);
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Media physical topology valid: ${topology.manifestCandidates.length} manifest candidates, ${topology.consumerCrosswalk.length} consumers, ${topology.compositions.length} compositions.`);
  }
}
