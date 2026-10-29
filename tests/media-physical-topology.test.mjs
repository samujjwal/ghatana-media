import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTopology } from '../scripts/check-media-physical-topology.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topology = JSON.parse(fs.readFileSync(path.join(repo, '.product-experience/surfaces/media-physical-topology.v1.json'), 'utf8'));
const copy = () => structuredClone(topology);

test('physical topology is deterministic and source-backed', () => {
  assert.deepEqual(validateTopology(topology), []);
});

test('rejects an active authored public build module missing from the topology', () => {
  const changed = copy();
  changed.manifestCandidates = changed.manifestCandidates.filter((candidate) => candidate.sourcePath !== 'adapters/data-cloud-media');
  changed.activeManifestCandidateCount = changed.manifestCandidates.length;
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('active build manifest has no topology candidate/disposition: adapters/data-cloud-media/build.gradle.kts')));
});

test('rejects an unclassified or duplicate manifest candidate', () => {
  const changed = copy();
  changed.manifestCandidates[0].disposition = 'MAYBE';
  changed.manifestCandidates[1].sourcePath = changed.manifestCandidates[0].sourcePath;
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('unsupported physical disposition')));
  assert.ok(errors.some((error) => error.includes('physical source paths must be unique')));
});

test('rejects missing crosswalk members and dangling physical bindings', () => {
  const changed = copy();
  changed.consumerCrosswalk.pop();
  changed.consumerCrosswalk[0].physicalRefs = ['media.physical.unknown'];
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('exactly 21 unique surfaces')));
  assert.ok(errors.some((error) => error.includes('unknown physical ref')));
});

test('rejects containment cycles and unreferenced phase meaning', () => {
  const changed = copy();
  const comp = changed.compositions.find((x) => x.kind === 'SEMANTIC_COMPOSITION');
  comp.children.push(changed.compositions[0].surfaceId);
  changed.manifestCandidates[0].phaseApplicability['PDP-0'].capabilityIntentIds.push('media.unknown.capability');
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('containment cycle')));
  assert.ok(errors.some((error) => error.includes('not in canonical source')));
});

test('root screen and journey references exactly match canonical registries', () => {
  const changed = copy();
  const root = changed.compositions.find((item) => item.kind === 'REPOSITORY_ROOT');
  root.phaseApplicability['PDP-3'].screenIds = root.phaseApplicability['PDP-3'].screenIds.filter((id) => id !== 'media.view.review-workspace-settings');
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('repository root PDP-3 screen IDs must exactly match')));
});

test('requires a physical host or semantic composition for every PDP-3 screen and journey', () => {
  const changed = copy();
  for (const node of [...changed.manifestCandidates, ...changed.compositions.filter((item) => item.kind !== 'REPOSITORY_ROOT')]) {
    node.phaseApplicability['PDP-3'].screenIds = node.phaseApplicability['PDP-3'].screenIds.filter((id) => id !== 'media.view.review-workspace-settings');
    node.phaseApplicability['PDP-3'].journeyIds = node.phaseApplicability['PDP-3'].journeyIds.filter((id) => id !== 'J-23');
  }
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('responsible physical/composition PDP-3 screen IDs must exactly match')));
  assert.ok(errors.some((error) => error.includes('responsible physical/composition PDP-3 journey IDs must exactly match')));
});

test('root contains six compositions and only ungrouped support units directly', () => {
  const changed = copy();
  const root = changed.compositions.find((item) => item.kind === 'REPOSITORY_ROOT');
  root.children.push('media.physical.launcher');
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('repository root direct CONTAINS must be')));
  assert.ok(errors.some((error) => error.includes('cannot directly repeat a physical member')));
});

test('shared physical members are enumerated once by canonical surface ID and keep distinct composition roles', () => {
  const changed = copy();
  const root = changed.compositions.find((item) => item.kind === 'REPOSITORY_ROOT');
  root.sharedPhysicalMemberships.pop();
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('shared physical membership must enumerate')));
});

test('dependency edges cannot be represented as containment members', () => {
  const changed = copy();
  const composition = changed.compositions.find((item) => item.kind === 'SEMANTIC_COMPOSITION');
  composition.children.push({ relation: 'DEPENDS_ON', targetId: 'media.physical.launcher' });
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('children must be direct CONTAINS IDs')));
});

test('AI Voice React package is a source-bound host-dependent GUI library with bounded PDP-0 scope', () => {
  const changed = copy();
  const candidate = changed.manifestCandidates.find((item) => item.surfaceId === 'media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react');
  candidate.phaseApplicability['PDP-2'].disposition = 'HEADLESS_CONTRACT';
  candidate.phaseApplicability['PDP-0'].capabilityIntentIds.push('media.speech.synthesis.dub');
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('host-dependent GUI applicability')));
  assert.ok(errors.some((error) => error.includes('cannot imply every speech-synthesis processing leaf')));
});

test('AI Voice GUI applicability rejects missing exact component or grammar references', () => {
  const changed = copy();
  const candidate = changed.manifestCandidates.find((item) => item.surfaceId === 'media.physical.modules-intelligence-ai-voice-libs-ai-voice-ui-react');
  candidate.phaseApplicability['PDP-2'].componentRefs.pop();
  candidate.phaseApplicability['PDP-2'].authorityRefs = candidate.phaseApplicability['PDP-2'].authorityRefs.filter((ref) => !ref.includes('gui/semantic-component-bindings.yaml'));
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('PDP-2 GUI component refs must exactly match')));
  assert.ok(errors.some((error) => error.includes('PDP-2 GUI authority refs must exactly match')));
});

test('Agent Tool handler source maps bidirectionally to optional adapter and retains non-admission', () => {
  const changed = copy();
  const consumer = changed.consumerCrosswalk.find((item) => item.surfaceId === 'media.surface.agent-tools');
  const adapter = changed.manifestCandidates.find((item) => item.surfaceId === 'media.physical.adapters-agent-tools-media');
  consumer.physicalRefs = ['media.physical.runtime-contracts'];
  adapter.consumerSurfaceRefs = [];
  adapter.consumerMappingState = 'NO_DIRECT_CONSUMER_SUPPORT_ONLY';
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('preserve runtime-contracts association and map its optional adapter source owner')));
  assert.ok(errors.some((error) => error.includes('agent-tools-media must reverse-map')));
});

test('Agent Tool handler mappings cannot claim execution admission or lose exact handler source coverage', () => {
  const changed = copy();
  const consumer = changed.consumerCrosswalk.find((item) => item.surfaceId === 'media.surface.agent-tools');
  consumer.handlerSourceObservation.classification = 'ADMITTED';
  consumer.handlerSourceObservation.sourcePath = 'adapters/agent-tools-media/src/main/java/com/ghatana/audio/video/tools/SpeechToTextToolHandler.java';
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('must remain observational, legacy/subsumed, and not admitted')));
  assert.ok(errors.some((error) => error.includes('four exact handler files under adapters/agent-tools-media')));
});
