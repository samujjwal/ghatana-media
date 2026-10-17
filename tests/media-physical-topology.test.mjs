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

test('root contains seven compositions and only ungrouped support units directly', () => {
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

test('Agent Tool handler source maps bidirectionally to subsumed libs/common and retains non-admission', () => {
  const changed = copy();
  const consumer = changed.consumerCrosswalk.find((item) => item.surfaceId === 'media.surface.agent-tools');
  const common = changed.manifestCandidates.find((item) => item.surfaceId === 'media.physical.libs-common');
  consumer.physicalRefs = ['media.physical.runtime-contracts'];
  common.consumerSurfaceRefs = [];
  common.consumerMappingState = 'NO_DIRECT_CONSUMER_SUPPORT_ONLY';
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('preserve runtime-contracts association and map its libs/common handler source owner')));
  assert.ok(errors.some((error) => error.includes('libs/common must reverse-map')));
});

test('Agent Tool handler mappings cannot claim execution admission or lose exact handler source coverage', () => {
  const changed = copy();
  const consumer = changed.consumerCrosswalk.find((item) => item.surfaceId === 'media.surface.agent-tools');
  consumer.handlerSourceObservation.classification = 'ADMITTED';
  consumer.handlerSourceObservation.sourcePath = 'libs/common/src/main/java/com/ghatana/audio/video/tools/SpeechToTextToolHandler.java';
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('must remain observational, legacy/subsumed, and not admitted')));
  assert.ok(errors.some((error) => error.includes('four exact handler files under libs/common')));
});

test('Recorder/Studio successor logical surfaces are real source-registered units, not phantom physical implementations', () => {
  const changed = copy();
  const required = ['media.surface.experience-recorder','media.surface.capture-agent','media.surface.presentation-studio','media.surface.interactive-demo-player'];
  const actual = changed.consumerCrosswalk.filter((x) => required.includes(x.surfaceId));
  assert.equal(actual.length, 4);
  assert.equal(changed.activeManifestCandidateCount, 26);
  assert.equal(changed.consumerSurfaceCount, 21);
  assert.equal(changed.semanticCompositionCount, 7);
  assert.equal(changed.succession.physicalPackageCreation, 'NONE_DISCOVERY_ONLY');
  for (const item of actual) {
    assert.equal(item.bindingState, 'HOST_DEPENDENT');
    assert.ok(item.physicalRefs.length > 0);
    assert.equal(item.PDP3SuccessorStatus, 'UNAUTHORED');
  }
  changed.consumerCrosswalk = changed.consumerCrosswalk.filter((x) => x.surfaceId !== 'media.surface.capture-agent');
  assert.ok(validateTopology(changed).some((e) => e.includes('missing Recorder/Studio source surface')));
});
