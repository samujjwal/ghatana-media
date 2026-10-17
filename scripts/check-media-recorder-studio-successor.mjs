#!/usr/bin/env node
/**
 * Source-only Recorder/Studio PDP-0–2 successor auditor.
 * This does not certify stage currentness, third-party approvals or runtime.
 */
import assert from 'node:assert/strict';
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
  const p1Revision = read('.product-experience/pdp-1-domain-data/versioning.yaml');
  const p1Actions = read('.product-experience/pdp-1-domain-data/action-contracts.yaml');
  const p1Objects = read('.product-experience/pdp-1-domain-data/domain-objects.yaml');
  const p2Studio = read('.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml');
  const p2Interface = read('.product-experience/pdp-2-design-interface-system/interface-grammar.yaml');
  const p2A11y = read('.product-experience/pdp-2-design-interface-system/accessibility.yaml');
  const p2Components = read('.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
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
  for (const value of [
    'same-revision-authorized-CAS', 'scene-only', 'manual-lock', 'no-product',
  ]) {
    // These are semantic pointers only: use explicit tests above for source identity.
    if (typeof value !== 'string') errors.push('invalid semantic token');
  }
  const componentsRaw = p2Studio.match(/reusableComponents: \[([^\]]+)\]/)?.[1] ?? '';
  const components = componentsRaw.split(',').map((value) => value.trim()).filter(Boolean);
  reject(components.length >= 12, 'complete studio component reuse declaration required');
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
