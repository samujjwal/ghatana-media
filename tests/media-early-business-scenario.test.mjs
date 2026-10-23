import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { buildMediaEarlyBusinessScenario, resolveMediaScenarioSelector, validateMediaEarlyBusinessScenario, verifiedP1ResultBinding, verifiedP1SourceRecordBinding } from '../scripts/lib/media-early-business-scenario.mjs';
import { MEDIA_EARLY_SCENARIO_PATH } from '../scripts/lib/media-early-business-scenario.mjs';

const current = buildMediaEarlyBusinessScenario();

function copyScenarioSources(root) {
  for (const sourcePath of current.sourceFiles) {
    const destination = path.join(root, sourcePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(sourcePath, destination);
  }
}

test('builds a source-pinned declarative first-outcome recipe', () => {
  assert.deepEqual(current.orderedJourneyIds, ['J-01', 'J-02', 'J-20', 'J-03']);
  assert.equal(current.execution.executable, false);
  assert.equal(current.channelSelection.selectedChannelRef, null);
  assert.equal(validateMediaEarlyBusinessScenario(current, current).length, 0);
  assert.ok(current.blockers.some(x => x.startsWith('NO_REAL_CHANNEL_ADMITTED')));
  assert.equal(current.story.sceneStyleNarrationConfig.status, 'PDP2_PRESENTATION_AND_PDP3_WORKSPACE_SOURCE_BOUND; NARRATION_REMAINS_EDITORIAL');
  assert.equal(current.story.sceneStyleNarrationConfig.presentation.pdp3WorkspaceProposal.canonicalScreenBinding, 'UNBOUND_PROPOSAL');
  assert.equal(current.story.sceneStyleNarrationConfig.narrationPolicy.status, 'NOT_DEFINED_AS_PDP2_PDP3_VOICE_STYLE_OR_WORDING');
  assert.deepEqual(current.story.sceneStyleNarrationConfig.scenes.map(scene => scene.sceneId), ['s01', 's02', 's03', 's04', 's05', 's06', 's07']);
  assert.ok(current.story.sceneStyleNarrationConfig.scenes.every(scene => scene.narrationAuthority === 'EDITORIAL_INTENT_ONLY_NOT_PDP2_PDP3_VOICE_AUTHORITY'));
  assert.deepEqual(current.journeys.flatMap(journey => journey.p3PurposeBindingIds).length, 24);
  assert.ok(current.journeys.every(journey => journey.sourceSteps.every(step => step.purposeBindingRef && step.purposeBindingSourceRef && step.purposeBindingBridgeJoin?.id === step.purposeBindingRef)));
  assert.equal(current.story.title, 'Audio/video transcription through corrected captions');
  assert.deepEqual(current.story.actorRefs, ['media.creator', 'media.editor', 'media.reviewer']);
  assert.ok(current.story.customerGoals.every(goal => goal.sourceRef.startsWith('.product-experience/pdp-0-product-truth/goals-jtbd.yaml#')));
  assert.equal(current.story.recordingCandidateAuthority, 'EDITORIAL_PROFILE_ID_ONLY_NOT_PRODUCT_IDENTITY_OR_SEMANTIC_AUTHORITY');
  assert.ok(current.sourceCurrentness.length > 0 && current.sourceCurrentness.every(record => record.currentness === 'CURRENT' && record.phaseStatus === 'DEV_COMPLETE'));
  assert.equal(new Set(current.sourceCurrentness.map(record => record.sourcePath)).size, current.sourceCurrentness.length);
  assert.ok(current.journeys.every(journey => journey.p3ChannelEdges.every(edge => edge.sourceRef.includes('#edges/@id=') && edge.id && edge.channelRef)));
});

test('P1 result bindings use the exact primary operation source record and step schema', () => {
  const allResults = current.journeys.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins));
  assert.ok(allResults.some(binding => binding.sourceRecordBinding?.selectorKind === 'SOURCE_RECORD_SELECTOR' && binding.resultBindingValid));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-wrong-p1-selector-'));
  copyScenarioSources(tempRoot);
  const bridgePath = path.join(tempRoot, 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  const operationRef = allResults.find(binding => binding.sourceRecordBinding?.selectorKind === 'SOURCE_RECORD_SELECTOR')?.operationRef;
  const identity = bridge.identities.find(row => row.id === `PDP-1:operations:${operationRef}`);
  identity.sourceRecordSelectors = [];
  fs.writeFileSync(bridgePath, JSON.stringify(bridge, null, 2) + '\n');
  const mutated = buildMediaEarlyBusinessScenario({ root: tempRoot });
  const rejected = mutated.journeys.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins)).find(binding => binding.operationRef === operationRef);
  assert.equal(rejected.sourceRecordBinding, null);
  assert.ok(rejected.blockers.includes(`P1_OPERATION_NOT_IN_BRIDGE:${operationRef}`));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('P1 identities, primary selectors, source pins, result bindings, and schema selectors fail closed', () => {
  const bridgeSource = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json', 'utf8'));
  const operationRef = 'media.operation.action.view-job-status';
  const baseIdentity = bridgeSource.identities.find(row => row.id === `PDP-1:operations:${operationRef}`);
  const pin = current.sourceCurrentness.find(row => row.sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const bind = (identities, pins = [pin]) => verifiedP1SourceRecordBinding(process.cwd(), { identities }, operationRef, new Map(), pins);

  assert.ok(bind([baseIdentity]));
  assert.equal(bind([]), null);
  assert.equal(bind([baseIdentity, structuredClone(baseIdentity)]), null);
  assert.equal(bind([{ ...structuredClone(baseIdentity), identity: 'wrong-operation' }]), null);
  assert.equal(bind([{ ...structuredClone(baseIdentity), sourceRecordSelectors: [] }]), null);
  assert.equal(bind([{ ...structuredClone(baseIdentity), sourceRecordSelectors: [...baseIdentity.sourceRecordSelectors, ...baseIdentity.sourceRecordSelectors] }]), null);
  const wrongSelector = bridgeSource.identities.find(row => row.id === 'PDP-1:operations:media.operation.action.check-job-outcome').sourceRecordSelectors[0];
  assert.equal(bind([{ ...structuredClone(baseIdentity), sourceRecordSelectors: [wrongSelector] }]), null);
  assert.equal(bind([{
    ...structuredClone(baseIdentity),
    sourceRecordSelectors: [],
    joins: { p1Operation: [{ phase: 'PDP-1', id: operationRef, endpointClassification: 'TRACE_IDENTITY' }] },
  }]), null);
  assert.equal(bind([baseIdentity], [{ ...pin, currentness: 'STALE' }]), null);
  assert.equal(bind([baseIdentity], []), null);

  const result = current.journeys.flatMap(journey => journey.p1OperationResultBindings).find(row => row.operationRef === operationRef);
  const sourceRecord = bind([baseIdentity]);
  assert.ok(result && sourceRecord);
  const [contractPath, stepSegment] = result.journeyStepRef.split('#');
  const stepIndex = Number(stepSegment.split('/').at(-1));
  const check = rows => verifiedP1ResultBinding(process.cwd(), contractPath, stepIndex, operationRef, sourceRecord.sourceRef, sourceRecord.expectedResultSchemaRef, rows, new Map());
  assert.ok(check([result]));
  assert.equal(check([result, structuredClone(result)]), null);
  assert.equal(check([{ ...result, operationRef: 'wrong-operation' }]), null);
  assert.equal(check([{ ...result, operationSourceRef: '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=wrong-operation' }]), null);
  assert.equal(check([{ ...result, operationVersion: 2 }]), null);
  assert.equal(check([{ ...result, resultSchemaRef: '.product-experience/pdp-1-domain-data/operations.yaml#missing/schema' }]), null);
});

test('P1 bridge joins require one exact current operation record selector and current source pin', () => {
  const bridge = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json', 'utf8'));
  const operationRef = 'media.operation-slice.list-projects';
  const pin = current.sourceCurrentness.find(row => row.sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml');
  const rows = bridge.identities.flatMap(identity => Object.entries(identity.joins ?? {}).flatMap(([joinType, joins]) => joins
    .filter(join => join.phase === 'PDP-1' && join.id === operationRef)
    .map(join => ({ bridgeIdentity: identity.id, joinType, sourceRef: join.sourceRef, targetSelector: join.targetSelector, endpointClassification: join.endpointClassification }))));
  const validIndex = new Map([[operationRef, rows]]);
  const resolve = (index, sourcePin = pin) => verifiedP1SourceRecordBinding(process.cwd(), bridge, operationRef, new Map(), [sourcePin], index);
  assert.ok(resolve(validIndex)?.selectorKind === 'SOURCE_SELECTOR_BRIDGE_JOIN');
  assert.equal(resolve(new Map([[operationRef, []]])), null);
  const operationDocument = yaml.parse(fs.readFileSync('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
  const recordIndex = operationDocument.individualOperationContracts.records.findIndex(row => row.id === operationRef);
  const alternateSelector = `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/${recordIndex}`;
  const nonCanonicalJoin = { ...rows[0], targetSelector: alternateSelector };
  const withNonCanonicalJoin = resolve(new Map([[operationRef, [...rows, nonCanonicalJoin]]]));
  assert.equal(withNonCanonicalJoin?.selectorKind, 'SOURCE_SELECTOR_BRIDGE_JOIN');
  assert.deepEqual(withNonCanonicalJoin, resolve(validIndex));
  assert.equal(resolve(new Map([[operationRef, [nonCanonicalJoin]]])), null);
  assert.equal(resolve(validIndex, { ...pin, currentness: 'STALE' }), null);
});

test('rejects a missing source-defined P1 result binding', () => {
  const mutated = structuredClone(current);
  mutated.journeys.find(x => x.journeyId === 'J-03').p1OperationResultBindings = [];
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('missing or mismatched P1 result')));
});

test('requires each P1 operation result to retain its separate source-record binding', () => {
  const result = current.journeys.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins)).find(row => row.sourceRecordBinding?.selectorKind === 'SOURCE_RECORD_SELECTOR');
  assert.ok(result?.sourceRecordBinding?.selectorKind === 'SOURCE_RECORD_SELECTOR');
  const mutated = structuredClone(current);
  const target = mutated.journeys.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins)).find(row => row.operationRef === result.operationRef && row.sourceRecordBinding?.selectorKind === 'SOURCE_RECORD_SELECTOR');
  target.sourceRecordBinding = null;
  target.blockers = [`P1_OPERATION_NOT_IN_BRIDGE:${target.operationRef}`];
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('missing or mismatched P1 bridge join')));
});

test('rejects a mismatched PDP-3 edge', () => {
  const mutated = structuredClone(current);
  mutated.journeys.find(x => x.journeyId === 'J-03').p3ChannelEdges[0].id = 'invented-edge';
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('mismatched PDP-3 edge')));
});

test('rejects missing, altered, and reordered source selectors', () => {
  for (const mutate of [
    value => value.pop(),
    value => { value[0].sourceRef = '.product-experience/not-authority.yaml#/capabilities'; },
    value => { value.reverse(); },
  ]) {
    const mutated = structuredClone(current);
    mutate(mutated.sourceSelectors);
    assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('canonical source selector')));
  }
});

test('preserves all current source blockers and rejects blocker deletion', () => {
  assert.deepEqual(current.blockers, [
    'NO_REAL_CHANNEL_ADMITTED:media.channel.web,media.channel.cli',
    'VOICE_STYLE_AND_NARRATION_WORDING_REMAIN_EDITORIAL_NOT_PDP2_PDP3_AUTHORITY',
  ]);
  assert.ok(current.journeys.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins)).every(binding => binding.resultBindingValid && binding.sourceRecordBinding));
  assert.equal(current.blockerReconciliation.length, 28);
  assert.equal(current.blockerReconciliation.filter(row => row.status.startsWith('RESOLVED_BY_EXACT_')).length, 27);
  assert.equal(current.blockerReconciliation.filter(row => row.status === 'RESOLVED_BY_EXACT_PDP1_PRIMARY_SOURCE_RECORD_AND_PDP3_RESULT_BINDING').length, 3);
  assert.deepEqual(current.blockerReconciliation.filter(row => row.status === 'REMAINS_BLOCKED').map(row => row.blockerId), ['NO_REAL_CHANNEL_ADMITTED:media.channel.web,media.channel.cli']);
  assert.ok(current.blockerReconciliation.filter(row => row.status.startsWith('RESOLVED_BY_EXACT_CURRENT_')).every(row => row.evidenceRefs.length > 0));
  const mutated = structuredClone(current);
  mutated.blockers.pop();
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).includes('source blockers were removed or changed'));
  const missingReconciliation = structuredClone(current);
  missingReconciliation.blockerReconciliation.pop();
  assert.ok(validateMediaEarlyBusinessScenario(missingReconciliation, current).includes('prior blocker reconciliation differs from exact current source joins'));
});

test('rejects changed scene source joins, editorial intent attribution, and PDP-3 purpose references', () => {
  const changedSceneJoin = structuredClone(current);
  changedSceneJoin.story.sceneStyleNarrationConfig.scenes[1].journeyRefs[0].journeyId = 'J-03';
  assert.ok(validateMediaEarlyBusinessScenario(changedSceneJoin, current).some(x => x.includes('scene presentation or editorial narration source binding')));

  const reattributedNarration = structuredClone(current);
  reattributedNarration.story.sceneStyleNarrationConfig.scenes[0].narrationAuthority = 'PDP3_CANONICAL_VOICE_AUTHORITY';
  assert.ok(validateMediaEarlyBusinessScenario(reattributedNarration, current).some(x => x.includes('scene presentation or editorial narration source binding')));

  const missingPurpose = structuredClone(current);
  missingPurpose.journeys.find(x => x.journeyId === 'J-03').sourceSteps[0].purposeBindingSourceRef = null;
  assert.ok(validateMediaEarlyBusinessScenario(missingPurpose, current).some(x => x.includes('PDP-3 purpose source joins')));
});

test('generator fails closed when an exact PDP selector is missing or ambiguous', () => {
  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-duplicate-source-'));
  copyScenarioSources(duplicateRoot);
  const interfacePath = path.join(duplicateRoot, '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml');
  const duplicateInterface = yaml.parse(fs.readFileSync(interfacePath, 'utf8'));
  duplicateInterface.surfaceInterfaces.push(structuredClone(duplicateInterface.surfaceInterfaces.find(row => row.surfaceId === 'media.surface.production-studio')));
  fs.writeFileSync(interfacePath, yaml.stringify(duplicateInterface));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: duplicateRoot }), /source selector .* must resolve exactly once; found 2/);
  fs.rmSync(duplicateRoot, { recursive: true, force: true });

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-missing-purpose-'));
  copyScenarioSources(missingRoot);
  const purposePath = path.join(missingRoot, '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml');
  const purposes = yaml.parse(fs.readFileSync(purposePath, 'utf8'));
  purposes.records = purposes.records.filter(row => row.id !== 'media.pdp3.step-purpose-binding.j03-step-01.v1');
  fs.writeFileSync(purposePath, yaml.stringify(purposes));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: missingRoot }), /PDP-3 purpose binding for .* must resolve exactly once; found 0/);
  fs.rmSync(missingRoot, { recursive: true, force: true });
});

test('generator resolves every emitted PDP-3 edge through its exact current source selector', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-edge-selector-'));
  copyScenarioSources(tempRoot);
  const bridgePath = path.join(tempRoot, 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  const edge = current.journeys.find(journey => journey.journeyId === 'J-03').p3ChannelEdges[0];
  const edgeRow = bridge.identities.find(row => row.id === `PDP-3:journey-channel-edge:${edge.id}`);
  assert.ok(edgeRow);
  const otherSelector = bridge.identities.find(row => row.kind === 'journey-channel-edge' && row.id !== edgeRow.id)?.sourceRecordSelectors?.[0];
  assert.ok(otherSelector);

  edgeRow.sourceRecordSelectors[0] = otherSelector;
  fs.writeFileSync(bridgePath, JSON.stringify(bridge, null, 2) + '\n');
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /does not resolve to .* for J-03/);

  edgeRow.sourceRecordSelectors = [];
  fs.writeFileSync(bridgePath, JSON.stringify(bridge, null, 2) + '\n');
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /PDP-3 channel edge source selector .* must resolve exactly once; found 0/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('J-03 terminal must resolve exactly once from the PDP-0 journey catalog', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-j03-terminal-'));
  copyScenarioSources(tempRoot);
  const journeyPath = path.join(tempRoot, '.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const catalog = yaml.parse(fs.readFileSync(journeyPath, 'utf8'));
  catalog.journeys = catalog.journeys.filter(row => row.id !== 'J-03');
  fs.writeFileSync(journeyPath, yaml.stringify(catalog));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /PDP-0 J-03 terminal journey must resolve exactly once; found 0/);
  catalog.journeys.push(structuredClone(yaml.parse(fs.readFileSync('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8')).journeys.find(row => row.id === 'J-03')));
  catalog.journeys.push(structuredClone(catalog.journeys.at(-1)));
  fs.writeFileSync(journeyPath, yaml.stringify(catalog));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /PDP-0 J-03 terminal journey must resolve exactly once; found 2/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('PDP source status pin drift remains an explicit scenario blocker', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-stale-status-pin-'));
  copyScenarioSources(tempRoot);
  const statusPath = path.join(tempRoot, 'docs/implementation/pdp-0-phase-dev-status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const sourcePath = '.product-experience/pdp-0-product-truth/capabilities.yaml';
  status.sourceShaSet[sourcePath] = '0'.repeat(64);
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n');
  const mutated = buildMediaEarlyBusinessScenario({ root: tempRoot });
  assert.ok(mutated.blockers.includes(`SOURCE_STATUS_PIN_STALE:${sourcePath}`));
  assert.equal(mutated.sourceCurrentness.find(record => record.sourcePath === sourcePath).currentness, 'STALE');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('resolves every emitted selector exactly once and rejects malformed, missing, and duplicate identities', () => {
  assert.ok(current.sourceSelectors.length > 11);
  assert.ok(current.sourceSelectors.every(selector => selector.identity != null && selector.sourcePath));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-selector-cardinality-'));
  copyScenarioSources(tempRoot);
  const capPath = path.join(tempRoot, '.product-experience/pdp-0-product-truth/capabilities.yaml');
  const caps = yaml.parse(fs.readFileSync(capPath, 'utf8'));
  const selector = current.sourceSelectors[0];
  const selectedCapability = structuredClone(caps.capabilities.find(row => row.id === selector.identity));
  assert.throws(() => resolveMediaScenarioSelector(tempRoot, { ...selector, sourceRef: 'not-a-selector' }), /malformed source selector/);

  caps.capabilities = caps.capabilities.filter(row => row.id !== selector.identity);
  fs.writeFileSync(capPath, yaml.stringify(caps));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /must resolve exactly once; found 0/);

  caps.capabilities.push(selectedCapability, structuredClone(selectedCapability));
  fs.writeFileSync(capPath, yaml.stringify(caps));
  assert.throws(() => buildMediaEarlyBusinessScenario({ root: tempRoot }), /must resolve exactly once; found 2/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('rejects selecting a channel without actual admission', () => {
  const mutated = structuredClone(current);
  mutated.channelSelection.selectedChannelRef = 'media.channel.web';
  mutated.channelSelection.candidates.find(x => x.channelRef === 'media.channel.web').runtimeAdmission = 'ADMITTED';
  assert.ok(validateMediaEarlyBusinessScenario(mutated, current).some(x => x.includes('unadmitted channel selected')));
});

test('rejects duplicate scene identity and stale material pins', () => {
  const duplicated = structuredClone(current);
  duplicated.story.narrative[1].id = duplicated.story.narrative[0].id;
  assert.ok(validateMediaEarlyBusinessScenario(duplicated, current).some(x => x.includes('duplicate story identity')));
  const stale = structuredClone(current);
  stale.materialSourcePins[Object.keys(stale.materialSourcePins)[0]] = '0'.repeat(64);
  assert.ok(validateMediaEarlyBusinessScenario(stale, current).some(x => x.includes('stale material source hash')));
  const duplicateJourney = structuredClone(current);
  duplicateJourney.journeys[1].journeyId = duplicateJourney.journeys[0].journeyId;
  assert.ok(validateMediaEarlyBusinessScenario(duplicateJourney, current).some(x => x.includes('duplicate story journey identity')));
});

test('generator check mode passes current output and reports stale output without writing', () => {
  const generator = path.resolve('scripts/generate-media-early-business-scenario.mjs');
  const currentCheck = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  assert.equal(currentCheck.status, 0, currentCheck.stderr);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-check-'));
  const stalePath = path.join(tempDir, 'stale.json');
  const staleContent = '{"stale":true}\n';
  fs.writeFileSync(stalePath, staleContent);
  const staleCheck = spawnSync(process.execPath, [generator, '--check', '--output', stalePath], { encoding: 'utf8' });
  assert.equal(staleCheck.status, 1);
  assert.match(staleCheck.stderr, /Stale generated projection/);
  assert.equal(fs.readFileSync(stalePath, 'utf8'), staleContent);
  assert.ok(fs.existsSync(MEDIA_EARLY_SCENARIO_PATH));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('generator output is byte-for-byte deterministic', () => {
  const generator = path.resolve('scripts/generate-media-early-business-scenario.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-scenario-determinism-'));
  const first = path.join(tempDir, 'first.json');
  const second = path.join(tempDir, 'second.json');
  for (const output of [first, second]) {
    const result = spawnSync(process.execPath, [generator, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8'));
  fs.rmSync(tempDir, { recursive: true, force: true });
});
