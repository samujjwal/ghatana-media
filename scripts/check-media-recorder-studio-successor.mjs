#!/usr/bin/env node
/**
 * Source-only Recorder/Studio PDP-0–2 successor auditor.
 * This does not certify stage currentness, third-party approvals or runtime.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTopology } from './check-media-physical-topology.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const expectedSurfaces = [
  'media.surface.experience-recorder',
  'media.surface.capture-agent',
  'media.surface.presentation-studio',
  'media.surface.interactive-demo-player',
];
const expectedRules = Array.from({ length: 8 }, (_, index) =>
  `MEDIA-EXP-REQ-${String(index + 1).padStart(2, '0')}`
);

export function validateRecorderStudioSuccessor(topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'))) {
  const errors = [...validateTopology(topology)];
  const reject = (condition, message) => { if (!condition) errors.push(message); };
  const rootNode = topology.compositions.find((item) => item.surfaceId === 'media.composition.repository-root');
  const aggregate = topology.compositions.find((item) => item.surfaceId === 'media.composition.experience-recorder-studio');
  const registry = read('.product-experience/surface-registry.yaml');
  const req = read('.product-experience/pdp-0-product-truth/requirements.yaml');
  const profile = read('.product-experience/pdp-0-product-truth/profile-semantics.yaml');
  const channels = read('.product-experience/pdp-0-product-truth/applications-channels.yaml');
  const information = read('.product-experience/pdp-0-product-truth/information-architecture.yaml');
  const journeyCatalog = read('.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const p1Revision = read('.product-experience/pdp-1-domain-data/versioning.yaml');
  const p1Actions = read('.product-experience/pdp-1-domain-data/action-contracts.yaml');
  const p1Objects = read('.product-experience/pdp-1-domain-data/domain-objects.yaml');
  const p1Privacy = read('.product-experience/pdp-1-domain-data/privacy.yaml');
  const p1Relations = read('.product-experience/pdp-1-domain-data/relationships.yaml');
  const p1States = read('.product-experience/pdp-1-domain-data/states.yaml');
  const p2Studio = read('.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml');
  const p2Interface = read('.product-experience/pdp-2-design-interface-system/interface-grammar.yaml');
  const p2A11y = read('.product-experience/pdp-2-design-interface-system/accessibility.yaml');
  const p2Components = read('.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
  const p2Screen = read('.product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml');
  const p2Templates = read('.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml');
  const p2Layouts = read('.product-experience/pdp-2-design-interface-system/gui/layout.yaml');
  const canonicalOperations = read('.product-experience/pdp-1-domain-data/operations.yaml');
  const handoffs = [
    read('.product-experience/pdp-0-product-truth/handoff-contracts.yaml'),
    read('.product-experience/pdp-1-domain-data/handoff-contracts.yaml'),
    read('.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml'),
  ];
  const matrix = JSON.parse(read('docs/implementation/observations/media-recorder-studio-pdp0-2-surface-crosswalk-2026-10-17.json'));
  const registrySurfaceIds = [...registry.matchAll(/^  - surfaceId: (media\.surface\.[^\s]+)/gm)].map((match) => match[1]);
  const matrixIds = matrix.records.map((item) => item.surfaceId);
  const total = topology.manifestCandidates.length + topology.compositions.length + topology.consumerCrosswalk.length;
  reject(topology.manifestCandidates.length === 26, 'physical candidate historical population changed');
  reject(topology.compositions.length === 8 && topology.semanticCompositionCount === 7, 'seven semantic compositions and one root required');
  reject(topology.consumerCrosswalk.length === 21 && topology.consumerSurfaceCount === 21, '21 consumer surfaces required');
  reject(new Set(registrySurfaceIds).size === 21, 'registry must contain 21 unique consumer surface IDs');
  reject(total === 55 && matrix.records.length === total, '55 surface crosswalk rows required');
  reject(matrix.counts.pdp0ToPdp2Cells === 165 && matrix.counts.pdp0ToPdp3Cells === 220, 'PDP cell counts inconsistent');
  reject(new Set(matrixIds).size === total, 'surface crosswalk contains duplicate IDs');
  reject(topology.succession?.physicalPackageCreation === 'NONE_DISCOVERY_ONLY', 'no phantom physical implementation permitted');
  reject(topology.succession?.PDP3 === 'NOT_AUTHORED_FOR_NEW_SCOPE', 'PDP3 must remain explicit successor');
  reject(Boolean(aggregate) && Boolean(rootNode?.children.includes('media.composition.experience-recorder-studio')), 'new cross-child composition missing root membership');
  for (const id of expectedSurfaces) {
    const source = topology.consumerCrosswalk.find((item) => item.surfaceId === id);
    reject(Boolean(source), `missing Recorder/Studio consumer ${id}`);
    reject(source?.bindingState === 'HOST_DEPENDENT', `source-only consumer unexpectedly admitted: ${id}`);
    reject(registrySurfaceIds.includes(id), `surface-registry missing ${id}`);
    reject(source?.PDP3SuccessorStatus === 'UNAUTHORED', `fabricated PDP3 completion: ${id}`);
    reject(profile.includes(`surfaceId: ${id}`), `PDP0 profile missing surface ${id}`);
    reject(p2Interface.includes(`surfaceId: ${id}`), `PDP2 grammar missing surface ${id}`);
    reject(matrixIds.includes(id), `surface crosswalk missing ${id}`);
  }
  const capSource = read('.product-experience/pdp-0-product-truth/capabilities.yaml');
  const leafText = capSource.split('capabilities:\n')[1]?.split('\ncapabilityAliases:')[0] ?? '';
  const leafIds = new Set([...leafText.matchAll(/^  - id: (media\.[^\s]+)/gm)].map((match) => match[1]));
  reject(leafIds.size === 462, 'canonical capability leaf denominator changed unexpectedly');
  for (const capabilityId of aggregate?.phaseApplicability?.['PDP-0']?.capabilityIntentIds ?? []) {
    reject(leafIds.has(capabilityId), `unknown PDP0 capability ${capabilityId}`);
  }
  for (const rule of expectedRules) reject(req.includes(`ruleId: ${rule}`) && profile.includes(rule), `PDP0 requirement/profile gap ${rule}`);
  for (const [ref, source] of [
    ['experienceProductionRevisionContract:', p1Revision],
    ['experienceProductionActionOrchestration:', p1Actions],
    ['ownerDefinedExperienceProductionObjectProjection:', p1Objects],
    ['professionalStudioGrammar:', p2Studio],
    ['experienceProductionChannelGrammar:', p2Interface],
    ['experienceProductionAccessibility:', p2A11y],
  ]) reject(source.includes(ref), `missing normative source ${ref}`);
  const relatedSections = [
    ['ownerDefinedExperienceProductionChannelSurfaces:', channels],
    ['experienceProductionInformationArchitecture:', information],
    ['experienceProductionPrivacyTrustContract:', p1Privacy],
    ['experienceProductionRelationshipProjection:', p1Relations],
    ['experienceProductionStateProjection:', p1States],
    ['experienceProductionScreenCompositionRules:', p2Screen],
  ];
  for (const [id, source] of relatedSections) reject(source.includes(id), `missing cross-phase source section ${id}`);
  const canonicalChannelText = channels.split('channels:\n')[1]?.split('\nownerNormativeRuleRecords:')[0] ?? '';
  const channelIds = new Set(canonicalChannelText.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- id: media.channel.'))
    .map((line) => line.slice('- id: '.length)));
  reject(channelIds.size === 9, 'existing canonical channel count must remain nine');
  const newChannelSection = channels.slice(channels.indexOf('ownerDefinedExperienceProductionChannelSurfaces:'));
  for (const id of expectedSurfaces) {
    reject(newChannelSection.includes(`surfaceId: ${id}`), `missing PDP0 channel-surface binding ${id}`);
    reject(information.includes(`surfaceId: ${id}`), `missing PDP0 information-architecture binding ${id}`);
  }
  const proposedChannels = newChannelSection.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('applicableChannelRefs: ['))
    .flatMap((line) => line.slice(line.indexOf('[') + 1, line.lastIndexOf(']')).split(',').map((id) => id.trim()));
  for (const id of proposedChannels) reject(channelIds.has(id), `Recorder/Studio created unregistered PDP0 channel ${id}`);
  const iaSection = information.slice(information.indexOf('experienceProductionInformationArchitecture:'));
  const viewNames = new Set((iaSection.match(/M-[A-Z]+(?:-[A-Z]+)*/g) ?? []));
  for (const id of viewNames) reject(journeyCatalog.includes(id), `unregistered PDP0 view ${id}`);
  const relationshipIds = new Set(p1Relations.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- id: media.rel.'))
    .map((line) => line.slice('- id: '.length)));
  const stateMachineIds = new Set(p1States.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- machineId: '))
    .map((line) => line.slice('- machineId: '.length)));
  reject(relationshipIds.size === 13 && stateMachineIds.size === 11, 'canonical PDP1 relationship/state machine populations changed');
  for (const ref of p1Relations.slice(p1Relations.indexOf('experienceProductionRelationshipProjection:')).match(/media\.rel\.[a-z0-9.-]+/g) ?? []) {
    reject(relationshipIds.has(ref), `Recorder/Studio references unknown PDP1 relationship ${ref}`);
  }
  const machineLine = p1States.split('\n').find((line) => line.trim().startsWith('existingMachineRefs: [')) ?? '';
  for (const ref of machineLine.slice(machineLine.indexOf('[') + 1, machineLine.lastIndexOf(']')).split(',').map((s) => s.trim()).filter(Boolean)) {
    reject(stateMachineIds.has(ref), `Recorder/Studio references unknown PDP1 state machine ${ref}`);
  }
  const p1OperationIds = new Set(canonicalOperations.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- id: media.operation'))
    .map((line) => line.slice('- id: '.length).split(' ')[0]));
  const commandRefs = p1Actions.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('canonicalOperationRef: media.operation'))
    .map((line) => line.slice('canonicalOperationRef: '.length).split(' ')[0]);
  reject(commandRefs.length === 7 && new Set(commandRefs).size === 7, 'seven unique canonical PDP1 command compositions required');
  for (const id of commandRefs) reject(p1OperationIds.has(id), `unknown canonical PDP1 operation ${id}`);
  const p0Rules = req.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ruleId: MEDIA-EXP-REQ-'))
    .map((line) => line.slice('- ruleId: '.length));
  reject(p0Rules.length === 8 && new Set(p0Rules).size === 8, 'eight unique PDP0 successor rules required');
  const expectedPhysicalRoles = [
    'media.physical.launcher',
    'media.physical.runtime-contracts',
    'media.physical.libs-audio-video-types',
    'media.physical.libs-audio-video-client',
    'media.physical.libs-audio-video-ui',
    'media.physical.modules-infrastructure-security',
    'media.physical.modules-infrastructure-persistence',
    'media.physical.modules-infrastructure-messaging',
  ];
  for (const id of expectedPhysicalRoles) {
    const leaf = topology.manifestCandidates.find((item) => item.surfaceId === id);
    reject(Boolean(leaf), `Recorder/Studio physical owner is missing ${id}`);
    for (const phase of ['PDP-0','PDP-1','PDP-2']) {
      const role = leaf?.phaseApplicability?.[phase]?.experienceProductionSuccessor;
      reject(role?.authorityRef && role?.stageAdmission === 'NOT_ADMITTED' && role?.summary,
        `${id} must provide source-only Recorder/Studio responsibility for ${phase}`);
    }
  }
  for (const id of expectedSurfaces) {
    const consumer = topology.consumerCrosswalk.find((item) => item.surfaceId === id);
    reject(Boolean(consumer?.consumerType) && consumer?.registryAuthority === '.product-experience/surface-registry.yaml',
      `${id} must bind a canonical consumer type and registry owner`);
  }
  const componentsRaw = p2Studio.match(/reusableComponents: \[([^\]]+)\]/)?.[1] ?? '';
  const components = componentsRaw.split(',').map((value) => value.trim()).filter(Boolean);
  reject(components.length >= 12, 'complete studio component reuse declaration required');
  const templateLine = p2Studio.split('\n').find((line) => line.trim().startsWith('templateReuse: [')) ?? '';
  const layoutLine = p2Studio.split('\n').find((line) => line.trim().startsWith('layoutReuse: [')) ?? '';
  const templateRaw = templateLine.slice(templateLine.indexOf('[') + 1, templateLine.lastIndexOf(']'));
  const layoutsRaw = layoutLine.slice(layoutLine.indexOf('[') + 1, layoutLine.lastIndexOf(']'));
  for (const id of templateRaw.split(',').map((v) => v.trim()).filter(Boolean)) {
    reject(p2Templates.includes(`id: ${id}`), `Studio invented template ${id}`);
  }
  for (const id of layoutsRaw.split(',').map((v) => v.trim()).filter(Boolean)) {
    reject(p2Layouts.includes(`id: ${id}`), `Studio invented layout ${id}`);
  }
  for (const id of components) reject(p2Components.includes(`id: ${id}`), `Studio invented a component without PDP2 authority: ${id}`);
  reject(handoffs.every((text) => text.includes('recorderStudioPdp')), 'all three PDP handoffs must bind the successor');
  reject(matrix.status.mediaBuild === 'NOT_ADMITTED' && matrix.status.successorPdp3 === 'DEFINITION_EXTENSION_REQUIRED', 'successor may not assert Build or PDP3 completion');
  reject(matrix.records.every((entry) => ['PDP-0','PDP-1','PDP-2','PDP-3'].every((p) => entry.phaseApplicability?.[p]?.authorityRef)), 'every surface must have a 4-phase source reference');
  reject(topology.manifestCandidates.every((leaf) => leaf.consumerMappingState === (leaf.consumerSurfaceRefs.length ? 'MAPPED' : 'NO_DIRECT_CONSUMER_SUPPORT_ONLY')), 'reverse-consumer membership mismatch');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = validateRecorderStudioSuccessor();
  if (problems.length) {
    for (const error of problems) console.error('- ' + error);
    process.exitCode = 1;
  } else {
    console.log('Recorder/Studio successor source crosswalk valid: 26 physical candidates, 7 semantic compositions, 1 root, 21 consumer surfaces, 55 total, 165 PDP0–2 cells.');
  }
}
