import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { verifyRecorderStudioDefinitions } from '../scripts/check-media-recorder-studio-definitions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = filename => fs.readFileSync(path.join(repo, filename), 'utf8');

test('PDP0–2 Recorder Studio requirements/surfaces/parity are structurally complete', () => {
  const result = verifyRecorderStudioDefinitions();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.stats.recorderCases, 84);
  assert.equal(result.stats.manualEditKinds, 52);
  assert.equal(result.stats.proposedPdpCells, 216);
});
test('rejects an omitted PDP2 acceptance binding', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace('MEDIA-REC-P0-AC-084', 'MEDIA-REC-P0-AC-083');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('PDP2 surface interface profiles')), result.errors.join('\n'));
});
test('rejects a missing keyboard/manual parity operation', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace(/^  - kind: roll\n/m, '  - kind: unsupported-roll\n');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('52 versioned PDP1 edit discriminants')), result.errors.join('\n'));
});
test('rejects removal or duplication of a logical surface', () => {
  const j = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
  j.consumerCrosswalk = j.consumerCrosswalk.slice(0, -1);
  const result = verifyRecorderStudioDefinitions({overrides:{topology:JSON.stringify(j)}});
  assert.ok(result.errors.some(s => s.includes('successor consumer denominator') || s.includes('surface-registry')), result.errors.join('\n'));
});
test('rejects fictional Media domain identities', () => {
  const source = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed = source.replace('extends: media.domain.media-run', 'extends: media.domain.media-job');
  const result = verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(s => s.includes('merges Media job and attempt')), result.errors.join('\n'));
});

test('rejects a valid but incorrectly grouped capability without changing case counts', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  // The capability exists in Media, but it is not REC-C01's authority.
  const changed = source.replace('ownerCapabilityGroup: REC-C01', 'ownerCapabilityGroup: REC-C07');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('capability leaf not bound by feature capability group')), result.errors.join('\n'));
});
test('rejects a source-valid acceptance case attached to a different owner surface', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace('ownerSurface: media.surface.recorder-orchestrator',
    'ownerSurface: media.surface.production-studio');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('case surface differs from feature owner surface')), result.errors.join('\n'));
});
test('rejects removal of a capability leaf that still owns acceptance cases', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace(', media.deliver.publish-governed, media.job.watch', '');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(s => s.includes('capability leaf not bound by feature capability group')), result.errors.join('\n'));
});

test('native YAML grammar and duplicate-key checks cover Recorder Studio changed sources', () => {
  for (const filename of [
    '.product-experience/surface-registry.yaml',
    '.product-experience/pdp-0-product-truth/requirements.yaml',
    '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml',
    '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
    '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
    '.product-experience/pdp-1-domain-data/domain-objects.yaml',
    '.product-experience/pdp-1-domain-data/versioning.yaml',
    '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
    '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  ]) {
    const document = parseDocument(read(filename), { uniqueKeys: true, strict: true });
    assert.deepEqual(document.errors.map(error => error.message), [], filename);
  }
});
test('native YAML parser rejects malformed Recorder Studio authoring', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const document = parseDocument(source + '\ninvalid: [unterminated', { uniqueKeys: true, strict: true });
  assert.notEqual(document.errors.length, 0);
});

test('mandatory definition checker rejects invalid YAML in changed journey source', () => {
  const source = read('.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const result = verifyRecorderStudioDefinitions({ overrides: {
    journeyCatalog: source + '\ninvalid: [unterminated',
  }});
  assert.ok(result.errors.some(error => error.includes('journeyCatalog: invalid or duplicate YAML mapping')),
    result.errors.join('\n'));
});

test('mandatory definition checker rejects duplicate keys in changed interface grammar', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/interface-grammar.yaml');
  const result = verifyRecorderStudioDefinitions({ overrides: {
    interfaceGrammar: source + '\nrecorderStudioDuplicateProbe: value\nrecorderStudioDuplicateProbe: other',
  }});
  assert.ok(result.errors.some(error => error.includes('interfaceGrammar: invalid or duplicate YAML mapping')),
    result.errors.join('\n'));
});

test('rejects mismatched logical parent in the physical consumer crosswalk', () => {
  const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
  const consumer = topology.consumerCrosswalk.find(item => item.surfaceId === 'media.surface.recorder-orchestrator');
  consumer.parentSurfaceId = 'media.surface.web';
  const result = verifyRecorderStudioDefinitions({overrides:{topology:JSON.stringify(topology)}});
  assert.ok(result.errors.some(error => error.includes('physical consumer crosswalk parent differs')),
    result.errors.join('\n'));
});
test('rejects a registry parent that conflicts with the source PDP-0 hierarchy', () => {
  const registry = read('.product-experience/surface-registry.yaml');
  const original = '  - surfaceId: media.surface.production-studio\n    parentSurfaceId: media.surface.web';
  assert.ok(registry.includes(original));
  const changed = registry.replace(original,
    '  - surfaceId: media.surface.production-studio\n    parentSurfaceId: media.surface.cli');
  const result = verifyRecorderStudioDefinitions({overrides:{registry:changed}});
  assert.ok(result.errors.some(error => error.includes('surface registry parent differs')),
    result.errors.join('\n'));
});
test('rejects successor surface type drift without changing the surface census', () => {
  const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
  const consumer = topology.consumerCrosswalk.find(item => item.surfaceId === 'media.surface.interactive-demo-player');
  consumer.consumerType = 'PUBLIC_API';
  const result = verifyRecorderStudioDefinitions({overrides:{topology:JSON.stringify(topology)}});
  assert.ok(result.errors.some(error => error.includes('registry surface type differs')),
    result.errors.join('\n'));
});
test('rejects false runtime qualification on a source-only logical surface', () => {
  const registry = read('.product-experience/surface-registry.yaml');
  const start = registry.indexOf('  - surfaceId: media.surface.recorder-orchestrator\n');
  const next = registry.indexOf('  - surfaceId:', start + 5);
  assert.ok(start >= 0);
  const block = next < 0 ? registry.slice(start) : registry.slice(start, next);
  assert.ok(block.includes('implementationStatus: SOURCE_ONLY'));
  const changed = registry.replace(block, block.replace('implementationStatus: SOURCE_ONLY',
    'implementationStatus: PRODUCTION_READY'));
  const result = verifyRecorderStudioDefinitions({overrides:{registry:changed}});
  assert.ok(result.errors.some(error => error.includes('source-only and unqualified')),
    result.errors.join('\n'));
});

test('rejects a fictional actor in a scoped Recorder Studio feature', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace('participantActorRefs: [media.creator, media.automation-client, media.developer-integrator]',
    'participantActorRefs: [media.fictional-authorizer, media.automation-client, media.developer-integrator]');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(error => error.includes('unknown or unscoped canonical participant actor')),
    result.errors.join('\n'));
});
test('rejects empty feature participant actors even if the P0 aggregate is unchanged', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace('participantActorRefs: [media.creator, media.editor]',
    'participantActorRefs: []');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(error => error.includes('unique canonical participant actor references')),
    result.errors.join('\n'));
});
test('does not allow actor applicability to invent authorization or audience privileges', () => {
  const source = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const changed = source.replace('  actorBindingRule:', '  unauthorizedBindingRule:');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:changed}});
  assert.ok(result.errors.some(error => error.includes('actor participants may not imply grants')),
    result.errors.join('\n'));
});

test('additional Studio editing affordances are present in the canonical 52-kind parity inventory', () => {
  const p1 = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const p2 = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const required = ['scene-group', 'crop', 'cursor-click', 'background', 'frame',
    'annotation', 'track-mute', 'track-solo', 'speed-ramp', 'audio-denoise'];
  const kinds = p1.match(/^    operationKinds: \[([^\]]+)\]$/m)?.[1]
    .split(',').map(kind => kind.trim());
  assert.equal(kinds?.length, 52);
  for (const kind of required) {
    assert.ok(kinds.includes(kind), 'missing P1 operation kind '+kind);
    assert.ok(p2.includes('  - kind: '+kind+'\n'), 'missing P2 manual interface parity for '+kind);
  }
});
test('rejects removal of Studio mute/solo/speed-ramp parity from PDP2', () => {
  const p2 = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = p2.replace('  - kind: track-solo\n', '  - kind: unsupported-track-solo\n');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(error => error.includes('52 versioned PDP1 edit discriminants')),
    result.errors.join('\n'));
});

test('rejects a profile that claims fewer acceptance clauses than it owns', () => {
  const p0 = read('.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml');
  const result = verifyRecorderStudioDefinitions({overrides:{p0:p0.replace('scopedProfileCaseCount: 84',
    'scopedProfileCaseCount: 83')}});
  assert.ok(result.errors.some(error => error.includes('scoped case counts must agree')),
    result.errors.join('\n'));
});
test('rejects canonical requirements with a stale accepted 78-case denominator', () => {
  const req = read('.product-experience/pdp-0-product-truth/requirements.yaml');
  const result = verifyRecorderStudioDefinitions({overrides:{requirements:req.replace('requiredClauseCount: 84',
    'requiredClauseCount: 78')}});
  assert.ok(result.errors.some(error => error.includes('scoped case counts must agree')),
    result.errors.join('\n'));
});
test('rejects falsely declared manual operation count even if all edit kinds still match', () => {
  const p2 = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:p2.replace('canonicalOperationCount: 52',
    'canonicalOperationCount: 42')}});
  assert.ok(result.errors.some(error => error.includes('manual operation parity denominator differs')),
    result.errors.join('\n'));
});

test('rejects an existing but wrong requirement family for a Recorder capability', () => {
  const source = read('.product-experience/pdp-0-product-truth/requirements.yaml');
  const changed = source.replace('parentRequirementId: MEDIA-REQ-CAP-RECIPE-TEMPLATE',
    'parentRequirementId: MEDIA-REQ-CAP-PROJECT');
  const result = verifyRecorderStudioDefinitions({overrides:{requirements:changed}});
  assert.ok(result.errors.some(s => s.includes('canonical parent requirement does not own capability leaf')), result.errors.join('\n'));
});
test('rejects a canonical case moved into a different PDP1 operation group', () => {
  const source = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed = source.replace('acceptanceCaseIds: [MEDIA-REC-P0-AC-001, MEDIA-REC-P0-AC-002',
    'acceptanceCaseIds: [MEDIA-REC-P0-AC-022, MEDIA-REC-P0-AC-002');
  const result = verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(s => s.includes('wrong canonical PDP1 case-to-operation binding')), result.errors.join('\n'));
});
test('rejects a valid but incorrect PDP2 operation mapping', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace('pdp1OperationRefs: [media.recorder.operation.project.plan.evaluate.v1, media.recorder.operation.run.submit.v1]',
    'pdp1OperationRefs: [media.recorder.operation.quality.assess.v1, media.recorder.operation.run.submit.v1]');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('PDP1/PDP2 operation selection mismatch')), result.errors.join('\n'));
});
test('rejects a Studio manual edit with the wrong CLI/API intent', () => {
  const source = read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed = source.replace('cliSdkApiIntent: media.recorder.edit-operation.speed-ramp',
    'cliSdkApiIntent: media.recorder.edit-operation.trim');
  const result = verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(s => s.includes('PDP2 manual operation missing exact')), result.errors.join('\n'));
});
test('rejects a PDP1 operation without its mandatory wrong-tenant denial', () => {
  const source = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed = source.replace('negativeCases: [wrong-tenant,','negativeCases: [no-tenant,');
  const result = verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(s => s.includes('PDP1 proposed operation missing typed effect/request/result/tenant denial/currentness')), result.errors.join('\n'));
});

test('PDP1 value contracts and PDP2 editor bindings use one source authority', () => {
  const result=verifyRecorderStudioDefinitions();
  assert.deepEqual(result.errors,[],result.errors.join('\n'));
  const source=read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const altered=source.replace('id: media.recorder.value.render-profile.v1','id: media.recorder.value.invalid-render-profile.v1');
  const bad=verifyRecorderStudioDefinitions({overrides:{p1:altered}});
  assert.ok(bad.errors.some(x=>x.includes('PDP1 source-bound Studio value projection missing')),bad.errors.join('\n'));
});
test('PDP2 source-bound editor must retain accessible denial', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const altered=source.replace('denial: unavailable-quality-profile-or-unsupported-aspect-is-visible','denial:');
  const bad=verifyRecorderStudioDefinitions({overrides:{p2:altered}});
  assert.ok(bad.errors.some(x=>x.includes('PDP2 Studio value needs editor/keyboard/API and denial parity')),bad.errors.join('\n'));
});

test('returns diagnostics rather than throwing on malformed YAML in a typed contract owner', () => {
  const p1 = read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const result = verifyRecorderStudioDefinitions({overrides:{p1:p1+'\ninvalid: [unterminated'}});
  assert.ok(result.errors.some(error => error.includes('p1: invalid or duplicate YAML mapping')),
    result.errors.join('\n'));
});
test('returns diagnostics rather than throwing on invalid topology JSON', () => {
  const result = verifyRecorderStudioDefinitions({overrides:{topology:'{"invalid":'}});
  assert.ok(result.errors.some(error => error.includes('topology: invalid JSON')),
    result.errors.join('\n'));
});

// PDP-1 typed operation parameters and PDP-2 per-kind component reuse are
// required source definitions, not implementation or independent acceptance.
test('rejects deletion of a typed Studio operation parameter contract', () => {
  const source=read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed=source.replace('    - kind: audio-denoise\n      parameters:', '    - kind: deleted-audio-denoise\n      parameters:');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(e=>e.includes('every manual edit kind requires one typed parameter contract')),result.errors.join('\n'));
});
test('rejects Studio parameter binding to a fictional Media component', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed=source.replace('    componentRef: media.component.audio-mixer','    componentRef: media.component.not-registered');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(e=>e.includes('existing component binding')),result.errors.join('\n'));
});
test('rejects an edit parameter contract with missing required field', () => {
  const source=read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed=source.replace('      requiredFields: [clipId, edge, newBoundary]','      requiredFields: [clipId, edge]');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(e=>e.includes('incomplete typed parameters')),result.errors.join('\n'));
});

test('rejects a typed Studio parameter using an unresolved value type', () => {
  const source=read('.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml');
  const changed=source.replace('parameters: {clipId: ClipRef, edge: StartOrEnd', 'parameters: {clipId: MissingUnregisteredType, edge: StartOrEnd');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p1:changed}});
  assert.ok(result.errors.some(e=>e.includes('unresolved typed value')),result.errors.join('\n'));
});

test('PDP2 defines all thirteen Studio workspace design compositions', () => {
  const result=verifyRecorderStudioDefinitions();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.stats.studioPageDesignContracts,13);
});
test('PDP2 rejects a Studio page disconnected from the reusable Media template catalog', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed=source.replace('templateRef: "media.gui.template.collection"', 'templateRef: "media.gui.template.not-real"');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(x=>x.includes('ungrounded template/layout/recipe chain')),result.errors.join('\n'));
});
test('PDP2 rejects an absent Studio workspace despite stable other phase denominators', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed=source.replace('workspaceKey: "camera-multiview"', 'workspaceKey: "missing-camera-multiview"');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(x=>x.includes('13 canonical workspace keys')),result.errors.join('\n'));
});
test('PDP2 rejects missing Studio page headless parity and safe denial', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed=source.replace(
    'headlessEquivalent: "Project project-library selections and state as typed source-bound JSON/CLI without invented GUI effects"',
    'headlessEquivalent: ""'
  );
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(x=>x.includes('responsive/accessibility/headless/denial/admission meaning')),result.errors.join('\n'));
});
test('PDP2 rejects a Studio page composition referencing an unregistered component', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const changed=source.replace('componentRefs: ["media.component.project-browser"', 'componentRefs: ["media.component.unregistered"');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{p2:changed}});
  assert.ok(result.errors.some(x=>x.includes('component outside canonical Media Studio composition')),result.errors.join('\n'));
});

test('PDP2 rejects a layout catalog missing its reciprocal template compatibility', () => {
  const source=read('.product-experience/pdp-2-design-interface-system/gui/layout.yaml');
  const changed=source.replace('compatibleTemplateRefs: [media.gui.template.collection]',
    'compatibleTemplateRefs: [media.gui.template.task-setup]');
  assert.notEqual(changed,source);
  const result=verifyRecorderStudioDefinitions({overrides:{layouts:changed}});
  assert.ok(result.errors.some(x=>x.includes('ungrounded template/layout/recipe chain')),result.errors.join('\n'));
});
