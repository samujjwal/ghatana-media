import crypto from 'node:crypto';
import fs from 'node:fs';
import yaml from 'yaml';

export const MEDIA_EARLY_SCENARIO_PATH = 'docs/implementation/MEDIA-EARLY-BUSINESS-SCENARIO.v1.json';
const PLAN = 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md';
const BRIDGE = 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json';
const PROFILE = 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json';
const PHASE_STATUS_FILES = {
  'PDP-0': 'docs/implementation/pdp-0-phase-dev-status.json',
  'PDP-1': 'docs/implementation/pdp-1-phase-dev-status.json',
  'PDP-2': 'docs/implementation/pdp-2-phase-dev-status.json',
  'PDP-3': 'docs/implementation/pdp-3-phase-dev-status.json',
};
const P2_INTERFACE = '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml';
const P3_EXPERIENCE = '.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml';
const P3_PURPOSE_BINDINGS = '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml';
const SOURCES = [
  PLAN, BRIDGE, PROFILE,
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
  '.product-experience/pdp-0-product-truth/goals-jtbd.yaml',
  '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/authority.yaml',
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
  P2_INTERFACE,
  '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml',
  '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml',
  P3_EXPERIENCE,
  P3_PURPOSE_BINDINGS,
  '.product-experience/pdp-3-product-experience/screen-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml',
  '.product-experience/pdp-3-product-experience/application-channel-registry.yaml',
  ...Object.values(PHASE_STATUS_FILES),
];
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const read = (root, path) => fs.readFileSync(`${root}/${path}`, 'utf8');
const loadYaml = (root, path) => yaml.parse(read(root, path));
const byId = (rows, id) => (rows ?? []).find(row => row.id === id);
const asArray = value => Array.isArray(value) ? value : [];

function indexBridgeOperationJoinRows(bridge) {
  const index = new Map();
  for (const row of asArray(bridge.identities)) {
    for (const [joinType, joins] of Object.entries(row.joins ?? {})) {
      for (const join of asArray(joins)) {
        if (join.phase !== 'PDP-1') continue;
        const rows = index.get(join.id) ?? [];
        rows.push({ bridgeIdentity: row.id, joinType, sourceRef: join.sourceRef, targetSelector: join.targetSelector ?? null, endpointClassification: join.endpointClassification });
        index.set(join.id, rows);
      }
    }
  }
  return index;
}

function bridgeOperationJoinRows(bridge, operationRef, operationBridgeIndex) {
  return operationBridgeIndex?.get(operationRef) ?? asArray(bridge.identities).flatMap(row => Object.entries(row.joins ?? {}).flatMap(([joinType, joins]) =>
    asArray(joins).filter(join => join.phase === 'PDP-1' && join.id === operationRef).map(join => ({ bridgeIdentity: row.id, joinType, sourceRef: join.sourceRef, targetSelector: join.targetSelector ?? null, endpointClassification: join.endpointClassification }))));
}

// These selectors are deliberately explicit and deterministic. A selector must
// resolve to one authored source; it is never inferred from a name or UI route.
const PDP_SELECTORS = [
  { phase: 'PDP-0', sourceRef: '.product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.speech.transcription.file', identityField: 'id' },
  { phase: 'PDP-0', sourceRef: '.product-experience/pdp-0-product-truth/requirements.yaml#/requirements/@id=MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION', identityField: 'id' },
  { phase: 'PDP-1', sourceRef: '.product-experience/pdp-1-domain-data/operations.yaml#/operations/@id=media.operation.transcription-submission', identityField: 'id' },
  { phase: 'PDP-1', sourceRef: '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml#/objects/@id=media.recorder.production-project', identityField: 'id' },
  { phase: 'PDP-3', sourceRef: '.product-experience/pdp-3-product-experience/journey-registry.yaml#/journeys/@id=J-01', identityField: 'id' },
  { phase: 'PDP-3', sourceRef: '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#/records/@id=media.pdp3.step-purpose-binding.j01-step-01.v1', identityField: 'id' },
  { phase: 'PDP-3', sourceRef: '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#/edges/@id=media.pdp3.channel-binding.j01.web.v1', identityField: 'id' },
  { phase: 'PDP-2', sourceRef: `${P2_INTERFACE}#/surfaceInterfaces/@surfaceId=media.surface.production-studio`, identityField: 'surfaceId' },
  { phase: 'PDP-2', sourceRef: `${P2_INTERFACE}#/productionStudioPageCompositionContracts/pages/@workspaceKey=scene-storyboard`, identityField: 'workspaceKey' },
  { phase: 'PDP-2', sourceRef: `${P2_INTERFACE}#/experiencePresentationProfiles/@id=media.recorder.p2.profile.audio-only`, identityField: 'id' },
  { phase: 'PDP-3', sourceRef: `${P3_EXPERIENCE}#/productionStudioWorkspace/pages/@id=media.recorder.p3.workspace.scene-storyboard.v1`, identityField: 'id' },
];
const PRIOR_BLOCKER_IDS = [
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.list-projects',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.project.create:media.operation-slice.create-project',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.create-project',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.project.inspect:media.operation-slice.inspect-project',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.inspect-project',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.artifact.upload:media.operation-slice.begin-upload',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.begin-upload',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.artifact.upload.resume:media.operation-slice.append-upload-chunk',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.artifact.upload.resume:media.operation-slice.complete-upload',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.artifact.upload.resume:media.operation-slice.inspect-upload',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.append-upload-chunk',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.complete-upload',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.inspect-upload',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.job.cancel:media.operation-slice.cancel-job',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.cancel-job',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.job.retry:media.operation-slice.retry-job',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.retry-job',
  'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:media.speech.transcription.file:media.operation.transcription-submission',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.transcription-submission',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.transcript-version-read',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.caption-draft-write',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.caption-version-write',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.caption-version-read',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.action.view-job-status',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation-slice.inspect-artifact-version',
  'P1_OPERATION_NOT_IN_BRIDGE:media.operation.action.check-job-outcome',
  'NO_REAL_CHANNEL_ADMITTED:media.channel.web,media.channel.cli',
  'RECORDER_SCENE_STYLE_NARRATION_CONFIG_NOT_BOUND_TO_PDP2_PDP3_SOURCE',
];

function exactlyOne(rows, predicate, description) {
  const matches = asArray(rows).filter(predicate);
  if (matches.length !== 1) throw new Error(`${description} must resolve exactly once; found ${matches.length}`);
  return matches[0];
}

export function resolveMediaScenarioSelector(root, { sourceRef, identityField }, sourceCache = new Map()) {
  const separator = sourceRef.indexOf('#');
  if (separator < 1 || separator !== sourceRef.lastIndexOf('#')) throw new Error(`malformed source selector: ${sourceRef}`);
  const sourcePath = sourceRef.slice(0, separator);
  const fragment = sourceRef.slice(separator + 1);
  if (!sourceCache.has(sourcePath)) sourceCache.set(sourcePath, sourcePath.endsWith('.json') ? JSON.parse(read(root, sourcePath)) : loadYaml(root, sourcePath));
  let value = sourceCache.get(sourcePath);
  const segments = fragment.split('/').filter(Boolean);
  for (const segment of segments) {
    const match = /^@([^=]+)=(.*)$/.exec(segment);
    if (match) {
      const rows = asArray(value);
      const selected = rows.filter(row => String(row?.[match[1]]) === match[2]);
      if (selected.length !== 1) throw new Error(`source selector ${sourceRef} must resolve exactly once; found ${selected.length}`);
      value = selected[0];
    } else if (/^\d+$/.test(segment)) {
      if (!Array.isArray(value) || !Object.hasOwn(value, Number(segment))) throw new Error(`source selector ${sourceRef} must resolve exactly once; found 0`);
      value = value[Number(segment)];
    } else {
      if (value == null || !Object.hasOwn(value, segment)) throw new Error(`source selector ${sourceRef} must resolve exactly once; found 0`);
      value = value[segment];
    }
  }
  if (value == null || Array.isArray(value) || typeof value !== 'object') throw new Error(`source selector ${sourceRef} must resolve exactly once; found ${value == null ? 0 : Array.isArray(value) ? value.length : 0}`);
  if (!identityField || value[identityField] == null) throw new Error(`source selector ${sourceRef} has no ${identityField || 'declared identity field'}`);
  return { sourcePath, sourceRef, identity: value[identityField] };
}

function validateCurrentPdpInputPins(root, sourceCache) {
  const sourceCurrentness = [];
  const blockers = [];
  for (const sourcePath of [...new Set(SOURCES)].filter(path => path.startsWith('.product-experience/pdp-'))) {
    const phase = `PDP-${sourcePath.match(/\.product-experience\/pdp-(\d)-/)?.[1]}`;
    const statusRef = PHASE_STATUS_FILES[phase];
    if (!statusRef) {
      blockers.push(`SOURCE_PHASE_STATUS_UNKNOWN:${sourcePath}`);
      continue;
    }
    if (!sourceCache.has(statusRef)) sourceCache.set(statusRef, JSON.parse(read(root, statusRef)));
    const status = sourceCache.get(statusRef);
    const expectedSha256 = status.sourceShaSet?.[sourcePath] ?? null;
    const currentSha256 = sha(Buffer.from(read(root, sourcePath)));
    const phaseStatus = status.status ?? 'UNKNOWN';
    const currentness = expectedSha256 == null ? 'UNKNOWN_NO_SOURCE_STATUS_PIN' : expectedSha256 === currentSha256 ? 'CURRENT' : 'STALE';
    sourceCurrentness.push({ phase, statusRef, phaseStatus, sourcePath, expectedSha256, currentSha256, currentness });
    if (phaseStatus !== 'DEV_COMPLETE') blockers.push(`SOURCE_PHASE_STATUS_NOT_DEV_COMPLETE:${phase}:${phaseStatus}`);
    if (currentness !== 'CURRENT') blockers.push(`${currentness === 'STALE' ? 'SOURCE_STATUS_PIN_STALE' : 'SOURCE_STATUS_PIN_MISSING'}:${sourcePath}`);
  }
  return { sourceCurrentness, blockers };
}

function verifiedOperationBridgeJoins(root, bridge, operationRef, sourceCache, operationBridgeIndex) {
  return bridgeOperationJoinRows(bridge, operationRef, operationBridgeIndex).filter(join => {
    if (join.endpointClassification !== 'SOURCE_SELECTOR' || !join.targetSelector) return false;
    const identityField = /\/@([^/=]+)=([^/]+)$/.exec(join.targetSelector)?.[1];
    if (!identityField) return false;
    try {
      return resolveMediaScenarioSelector(root, { sourceRef: join.targetSelector, identityField }, sourceCache).identity === operationRef;
    } catch {
      return false;
    }
  });
}

function resolveMediaScenarioValue(root, sourceRef, sourceCache) {
  const separator = sourceRef.indexOf('#');
  if (separator < 1 || separator !== sourceRef.lastIndexOf('#')) throw new Error(`malformed source selector: ${sourceRef}`);
  const sourcePath = sourceRef.slice(0, separator);
  if (!sourceCache.has(sourcePath)) sourceCache.set(sourcePath, sourcePath.endsWith('.json') ? JSON.parse(read(root, sourcePath)) : loadYaml(root, sourcePath));
  let value = sourceCache.get(sourcePath);
  for (const segment of sourceRef.slice(separator + 1).split('/').filter(Boolean)) {
    const match = /^@([^=]+)=(.*)$/.exec(segment);
    if (match) {
      value = exactlyOne(value, row => String(row?.[match[1]]) === match[2], `source selector ${sourceRef}`);
    } else if (/^\d+$/.test(segment)) {
      if (!Array.isArray(value) || !Object.hasOwn(value, Number(segment))) throw new Error(`source selector ${sourceRef} must resolve exactly once; found 0`);
      value = value[Number(segment)];
    } else {
      if (value == null || !Object.hasOwn(value, segment)) throw new Error(`source selector ${sourceRef} must resolve exactly once; found 0`);
      value = value[segment];
    }
  }
  if (value == null) throw new Error(`source selector ${sourceRef} must resolve exactly once; found 0`);
  return value;
}

export function verifiedP1SourceRecordBinding(root, bridge, operationRef, sourceCache = new Map(), sourceCurrentness = [], operationBridgeIndex = null) {
  try {
    let selectorKind;
    let sourceRef;
    let bridgeIdentity = null;
    let sourceJoinEvidence = [];
    const identities = asArray(bridge.identities).filter(row => row.id === `PDP-1:operations:${operationRef}`);
    if (identities.length > 0) {
      const identity = exactlyOne(identities, () => true, `PDP-1 operation identity ${operationRef}`);
      if (identity.identity !== operationRef) return null;
      sourceRef = exactlyOne(identity.sourceRecordSelectors, () => true, `PDP-1 primary operation source selector ${operationRef}`);
      if (typeof sourceRef !== 'string') return null;
      selectorKind = 'SOURCE_RECORD_SELECTOR';
      bridgeIdentity = identity.id;
    } else {
      const joins = verifiedOperationBridgeJoins(root, bridge, operationRef, sourceCache, operationBridgeIndex);
      const selectors = [...new Set(joins.map(join => join.targetSelector))];
      sourceRef = exactlyOne(selectors, () => true, `PDP-1 exact SOURCE_SELECTOR operation record ${operationRef}`);
      if (!sourceRef) return null;
      selectorKind = 'SOURCE_SELECTOR_BRIDGE_JOIN';
      sourceJoinEvidence = joins.filter(join => join.targetSelector === sourceRef);
      bridgeIdentity = [...new Set(sourceJoinEvidence.map(join => join.bridgeIdentity))];
    }
    if (!sourceRef.startsWith('.product-experience/pdp-1-domain-data/operations.yaml#')) return null;
    const pin = exactlyOne(sourceCurrentness, row => row.sourcePath === sourceRef.split('#')[0], `PDP-1 operation source pin ${operationRef}`);
    if (pin.currentness !== 'CURRENT' || pin.phaseStatus !== 'DEV_COMPLETE') return null;
    const operation = resolveMediaScenarioValue(root, sourceRef, sourceCache);
    if (operation.id !== operationRef) return null;
    const schemaSuffix = operation.profileRef ? null
      : operation.ownerWireSchema?.resultSchema != null ? '/ownerWireSchema/resultSchema'
        : operation.resultSchema != null ? '/resultSchema'
          : operation.outputSemantics != null ? '/outputSemantics'
            : operation.readSemantics != null ? '/readSemantics'
              : null;
    const expectedResultSchemaRef = operation.profileRef
      ? `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=${operation.profileRef}/resultEnvelope`
      : schemaSuffix ? `${sourceRef}${schemaSuffix}` : null;
    if (!expectedResultSchemaRef) return null;
    return { bridgeIdentity, identity: operationRef, sourceRef, selectorKind, expectedResultSchemaRef, sourceJoinEvidence };
  } catch {
    return null;
  }
}

export function verifiedP1ResultBinding(root, contractPath, stepIndex, operationRef, expectedOperationSourceRef, expectedResultSchemaRef, bindings, sourceCache = new Map()) {
  const stepRef = `${contractPath}#/steps/${stepIndex}`;
  try {
    const binding = exactlyOne(bindings, row => row.journeyStepRef === stepRef && row.operationRef === operationRef, `PDP-3 P1 result binding for ${stepRef} and ${operationRef}`);
    if (binding.resultSchemaRef !== expectedResultSchemaRef) return null;
    if (binding.operationSourceRef) {
      if (binding.operationSourceRef !== expectedOperationSourceRef) return null;
      const operationSource = resolveMediaScenarioValue(root, binding.operationSourceRef, sourceCache);
      if ((operationSource.id ?? operationSource.operationRef) !== operationRef) return null;
    }
    if (binding.operationVersionRef) {
      if (!binding.operationVersionRef.startsWith(`${expectedOperationSourceRef}/`)) return null;
      const selectedVersion = resolveMediaScenarioValue(root, binding.operationVersionRef, sourceCache);
      if (binding.operationVersion == null || String(selectedVersion) !== String(binding.operationVersion)) return null;
    }
    resolveMediaScenarioValue(root, binding.resultSchemaRef, sourceCache);
    return binding;
  } catch {
    return null;
  }
}

function reconcilePriorBlockers(root, bridge, sourceBoundPresentation, sourceCache, operationBridgeIndex, p1ResultBindings) {
  const reconciliations = [];
  const retained = [];
  for (const blockerId of PRIOR_BLOCKER_IDS) {
    if (blockerId.startsWith('P1_OPERATION_NOT_IN_BRIDGE:')) {
      const operationRef = blockerId.slice('P1_OPERATION_NOT_IN_BRIDGE:'.length);
      const joins = verifiedOperationBridgeJoins(root, bridge, operationRef, sourceCache, operationBridgeIndex);
      const sourceResults = p1ResultBindings.filter(binding => binding.operationRef === operationRef && binding.sourceRecordBinding && binding.resultBindingValid);
      const resolved = joins.length > 0 || sourceResults.length > 0;
      const viaPrimaryRecord = joins.length === 0 && sourceResults.length > 0;
      reconciliations.push({
        blockerId,
        status: !resolved ? 'REMAINS_BLOCKED' : viaPrimaryRecord ? 'RESOLVED_BY_EXACT_PDP1_PRIMARY_SOURCE_RECORD_AND_PDP3_RESULT_BINDING' : 'RESOLVED_BY_EXACT_CURRENT_P1_SOURCE_JOIN',
        evidenceRefs: viaPrimaryRecord
          ? sourceResults.flatMap(binding => [binding.sourceRecordBinding.sourceRef, binding.journeyStepRef, binding.resultSchemaRef])
          : joins.map(join => join.targetSelector),
      });
      if (!resolved) retained.push(blockerId);
    } else if (blockerId.startsWith('REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:')) {
      const [capabilityRef, operationRef] = blockerId.slice('REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:'.length).split(':');
      const trace = exactlyOne(bridge.identities, row => row.id === `PDP-0:capability-intent:${capabilityRef}`, `PDP-0 capability trace ${capabilityRef}`);
      const joins = (trace.joins?.p1Operation ?? []).filter(join => join.id === operationRef && verifiedOperationBridgeJoins(root, bridge, operationRef, sourceCache, operationBridgeIndex).some(verified => verified.targetSelector === join.targetSelector));
      const resolved = joins.length > 0;
      reconciliations.push({ blockerId, status: resolved ? 'RESOLVED_BY_EXACT_CURRENT_P1_SOURCE_JOIN' : 'REMAINS_BLOCKED', evidenceRefs: joins.map(join => join.targetSelector) });
      if (!resolved) retained.push(blockerId);
    } else if (blockerId === 'RECORDER_SCENE_STYLE_NARRATION_CONFIG_NOT_BOUND_TO_PDP2_PDP3_SOURCE') {
      reconciliations.push({ blockerId, status: sourceBoundPresentation ? 'RESOLVED_BY_EXACT_CURRENT_PDP2_PDP3_SOURCE_SELECTORS' : 'REMAINS_BLOCKED', evidenceRefs: sourceBoundPresentation ? PDP_SELECTORS.filter(selector => ['PDP-2', 'PDP-3'].includes(selector.phase)).map(selector => selector.sourceRef) : [] });
      if (!sourceBoundPresentation) retained.push(blockerId);
    } else {
      reconciliations.push({ blockerId, status: 'REMAINS_BLOCKED', evidenceRefs: [] });
      retained.push(blockerId);
    }
  }
  return { reconciliations, retained };
}

export function buildMediaEarlyBusinessScenario({ root = process.cwd() } = {}) {
  const bridge = JSON.parse(read(root, BRIDGE));
  const operationBridgeIndex = indexBridgeOperationJoinRows(bridge);
  const profile = JSON.parse(read(root, PROFILE));
  const p2Interface = loadYaml(root, P2_INTERFACE);
  const p3Experience = loadYaml(root, P3_EXPERIENCE);
  const purposeBindings = loadYaml(root, P3_PURPOSE_BINDINGS);
  const p0Journey = loadYaml(root, '.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const terminal = exactlyOne(p0Journey.journeys, row => row.id === 'J-03', 'PDP-0 J-03 terminal journey');
  const goals = loadYaml(root, '.product-experience/pdp-0-product-truth/goals-jtbd.yaml');
  const actors = loadYaml(root, '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml');
  const sourceCache = new Map();
  const selectedSourceSelectors = [
    { phase: 'PDP-0', sourceRef: '.product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-03', identityField: 'id' },
    ...(terminal.outcomeRefs ?? []).map(id => ({ phase: 'PDP-0', sourceRef: `.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/outcomes/@id=${id}`, identityField: 'id' })),
    ...(terminal.actors ?? []).map(id => ({ phase: 'PDP-0', sourceRef: `.product-experience/pdp-0-product-truth/actors-responsibilities.yaml#/actors/@id=${id}`, identityField: 'id' })),
  ];
  const resolvedSelectors = [...PDP_SELECTORS, ...selectedSourceSelectors].map(selector => ({ ...selector, ...resolveMediaScenarioSelector(root, selector, sourceCache) }));
  const { sourceCurrentness, blockers: sourceCurrentnessBlockers } = validateCurrentPdpInputPins(root, sourceCache);
  const studioSurface = exactlyOne(p2Interface.surfaceInterfaces, row => row.surfaceId === 'media.surface.production-studio', 'PDP-2 production-studio interface');
  const storyboardComposition = exactlyOne(p2Interface.productionStudioPageCompositionContracts?.pages, row => row.workspaceKey === 'scene-storyboard', 'PDP-2 scene-storyboard composition');
  const audioOnlyProfile = exactlyOne(p2Interface.experiencePresentationProfiles, row => row.id === 'media.recorder.p2.profile.audio-only', 'PDP-2 audio-only presentation profile');
  const storyboardWorkspace = exactlyOne(p3Experience.productionStudioWorkspace?.pages, row => row.id === 'media.recorder.p3.workspace.scene-storyboard.v1', 'PDP-3 scene-storyboard workspace proposal');
  const journeyOrder = ['J-01', 'J-02', 'J-20', 'J-03'];
  const contracts = {
    'J-01': '.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml',
    'J-02': '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml',
    'J-20': '.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml',
    'J-03': '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml',
  };
  const p3 = journeyOrder.map((journeyId, index) => {
    const contractPath = contracts[journeyId];
    const contract = loadYaml(root, contractPath);
    const trace = byId(bridge.identities, `PDP-3:journey:${journeyId}`);
    const purposeJoins = trace?.joins?.p3Purpose ?? [];
    const journeySource = exactlyOne(loadYaml(root, '.product-experience/pdp-3-product-experience/journey-registry.yaml').journeys, row => row.id === journeyId, `PDP-3 journey ${journeyId}`);
    const channelBindings = loadYaml(root, '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml');
    const edgeRefs = channelBindings.edges.filter(edge => edge.journeyRef === journeyId).map(edge => {
      const identity = exactlyOne(bridge.identities, row => row.id === `PDP-3:journey-channel-edge:${edge.id}`, `PDP-3 channel edge bridge identity ${edge.id}`);
      const sourceRef = exactlyOne(identity.sourceRecordSelectors, selector => selector.startsWith('.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#'), `PDP-3 channel edge source selector ${edge.id}`);
      const selected = resolveMediaScenarioSelector(root, { sourceRef, identityField: 'id' }, sourceCache);
      if (selected.identity !== edge.id || edge.journeyRef !== journeyId) throw new Error(`PDP-3 channel edge source selector ${sourceRef} does not resolve to ${edge.id} for ${journeyId}`);
      return { id: selected.identity, sourceRef, channelRef: edge.channelRef, runtimeAdmission: 'NOT_ADMITTED' };
    });
    const purposeBindingRows = (contract.steps ?? []).map((_, stepIndex) => {
      const stepRef = `${contractPath}#/steps/${stepIndex}`;
      const purpose = exactlyOne(purposeBindings.records, row => row.stepRef === stepRef, `PDP-3 purpose binding for ${stepRef}`);
      if (purpose.journeyRef !== journeyId) throw new Error(`PDP-3 purpose binding ${purpose.id} belongs to ${purpose.journeyRef}, expected ${journeyId}`);
      const bridgeJoin = exactlyOne(purposeJoins, row => row.id === purpose.id, `PDP-3 bridge join for ${purpose.id}`);
      return { purpose, bridgeJoin };
    });
    return {
      ordinal: index + 1,
      journeyId,
      title: contract.title ?? journeyId,
      journeySourceRef: `.product-experience/pdp-3-product-experience/journey-registry.yaml#/journeys/@id=${journeyId}`,
      journeyContractRef: journeySource.contract,
      sourceRef: `${contractPath}#/`,
      sourceSteps: (contract.steps ?? []).map((step, stepIndex) => ({
        ordinal: stepIndex + 1,
        sourceRef: `${contractPath}#/steps/${stepIndex}`,
        view: step.view ?? null,
        action: step.action ?? null,
        canonicalOperationRef: step.canonicalOperationRef ?? null,
        capabilityRefs: step.capabilityRefs ?? [],
        p0CapabilityJoins: (step.capabilityRefs ?? []).map(capabilityRef => {
          const p0 = byId(bridge.identities, `PDP-0:capability-intent:${capabilityRef}`);
          return { capabilityRef, bridgeIdentity: p0?.id ?? null, p1CapabilityOperation: p0?.joins?.p1CapabilityOperation ?? [], p1Operations: p0?.joins?.p1Operation ?? [], blockers: p0?.unresolvedSourceBlockers ?? [`P0_CAPABILITY_NOT_IN_BRIDGE:${capabilityRef}`] };
        }),
        p1OperationBridgeJoins: (contract.pdp1ResultEvidence?.operationResultBindings ?? []).filter(binding => binding.journeyStepRef === `${contractPath}#/steps/${stepIndex}`).map(binding => {
          const sourceRecordBinding = verifiedP1SourceRecordBinding(root, bridge, binding.operationRef, sourceCache, sourceCurrentness, operationBridgeIndex);
          const resultBinding = sourceRecordBinding && verifiedP1ResultBinding(root, contractPath, stepIndex, binding.operationRef, sourceRecordBinding.sourceRef, sourceRecordBinding.expectedResultSchemaRef, contract.pdp1ResultEvidence?.operationResultBindings ?? [], sourceCache);
          const bridgeJoins = verifiedOperationBridgeJoins(root, bridge, binding.operationRef, sourceCache, operationBridgeIndex);
          return {
            operationRef: binding.operationRef,
            journeyStepRef: binding.journeyStepRef,
            resultSchemaRef: binding.resultSchemaRef,
            sourceRecordBinding: sourceRecordBinding ? { ...sourceRecordBinding, expectedResultSchemaRef: undefined, sourceJoinEvidence: undefined } : null,
            sourceJoinEvidence: sourceRecordBinding?.sourceJoinEvidence ?? [],
            resultBindingValid: Boolean(resultBinding),
            bridgeJoins,
            blockers: sourceRecordBinding && resultBinding ? [] : [`P1_OPERATION_NOT_IN_BRIDGE:${binding.operationRef}`],
          };
        }),
        result: step.result ?? null,
        purposeBindingRef: purposeBindingRows[stepIndex].purpose.id,
        purposeBindingSourceRef: `${P3_PURPOSE_BINDINGS}#/records/@id=${purposeBindingRows[stepIndex].purpose.id}`,
        purposeBindingBridgeJoin: purposeBindingRows[stepIndex].bridgeJoin,
      })),
      p3PurposeBindingIds: purposeBindingRows.map(row => row.purpose.id),
      p3ChannelEdges: edgeRefs,
      p1OperationResultBindings: contract.pdp1ResultEvidence?.operationResultBindings ?? [],
    };
  });
  const sourceBoundScenes = (profile.storyboard?.scenes ?? []).map(scene => ({
    sceneId: scene.id,
    sourceRef: `${PROFILE}#/storyboard/scenes/@id=${scene.id}`,
    editorialNarrationIntent: scene.narrationIntent,
    sharedNarrationIntentId: scene.narration?.sharedNarrationIntentId ?? null,
    narrationAuthority: 'EDITORIAL_INTENT_ONLY_NOT_PDP2_PDP3_VOICE_AUTHORITY',
    journeyRefs: scene.journeyIds.map(journeyId => {
      const journey = exactlyOne(p3, row => row.journeyId === journeyId, `PDP-3 scenario journey ${journeyId}`);
      return {
        journeyId,
        joinKind: 'EDITORIAL_SCENE_DECLARED_JOURNEY_REFERENCE_NOT_STEP_OR_TIME_ALIGNMENT',
        journeySourceRef: journey.journeySourceRef,
        journeyContractRef: journey.journeyContractRef,
        purposeBindingIds: journey.p3PurposeBindingIds,
      };
    }),
  }));
  const sourceActorRecords = (terminal.actors ?? []).map(actorRef => exactlyOne(actors.actors, row => row.id === actorRef, `PDP-0 actor ${actorRef}`));
  const sourceGoalRecords = (terminal.outcomeRefs ?? []).map(goalRef => exactlyOne(goals.outcomes, row => row.id === goalRef, `PDP-0 outcome ${goalRef}`));
  const capabilityJoinIds = [...new Set(p3.flatMap(journey => journey.sourceSteps.flatMap(step => step.p0CapabilityJoins.flatMap(join => [
    ...join.p1CapabilityOperation.map(x => x.id), ...join.p1Operations.map(x => x.id),
  ]))))].sort();
  const channelRegistry = loadYaml(root, '.product-experience/pdp-3-product-experience/application-channel-registry.yaml');
  const profileChannelRefs = [profile.selectionPolicy?.recommendedCaptureChannel, profile.selectionPolicy?.sourcePermittedAlternateChannel].filter(Boolean);
  const channels = profileChannelRefs.map(channelRef => {
    const record = (channelRegistry.channels ?? []).find(x => x.channelRef === channelRef);
    const suffix = `.${channelRef.split('.').at(-1)}.`;
    const edgeRefs = p3.flatMap(j => j.p3ChannelEdges.filter(edge => edge.id.includes(suffix)).map(edge => edge.id));
    const coveredJourneyIds = p3.filter(j => j.p3ChannelEdges.some(edge => edge.id.includes(suffix))).map(j => j.journeyId);
    return { channelRef, sourceSupport: record?.support ?? null, runtimeAdmission: 'NOT_ADMITTED', matchingP3EdgeIds: edgeRefs, coveredJourneyIds, missingJourneyIds: journeyOrder.filter(id => !coveredJourneyIds.includes(id)) };
  });
  const sourcePins = Object.fromEntries([...new Set(SOURCES)].sort().map(path => [path, sha(Buffer.from(read(root, path)))]));
  const blockers = [];
  for (const journey of p3) {
    if (!journey.p1OperationResultBindings.length) blockers.push(`P1_RESULT_BINDINGS_NOT_SOURCE_DECLARED:${journey.journeyId}`);
    if (journey.p3ChannelEdges.length === 0) blockers.push(`PDP3_CHANNEL_EDGE_MISSING:${journey.journeyId}`);
  }
  const bridgeBlockers = [...new Set(p3.flatMap(journey => journey.sourceSteps.flatMap(step => [...step.p0CapabilityJoins, ...step.p1OperationBridgeJoins].flatMap(join => join.blockers ?? []))))];
  blockers.push(...bridgeBlockers);
  blockers.push(...sourceCurrentnessBlockers);
  const p1ResultBindings = p3.flatMap(journey => journey.sourceSteps.flatMap(step => step.p1OperationBridgeJoins));
  const { reconciliations: blockerReconciliation, retained: priorBlockersRetained } = reconcilePriorBlockers(root, bridge, resolvedSelectors.some(selector => selector.phase === 'PDP-2') && resolvedSelectors.some(selector => selector.phase === 'PDP-3'), sourceCache, operationBridgeIndex, p1ResultBindings);
  blockers.push(...priorBlockersRetained);
  blockers.push('VOICE_STYLE_AND_NARRATION_WORDING_REMAIN_EDITORIAL_NOT_PDP2_PDP3_AUTHORITY');
  return {
    schemaVersion: 'media.early-business-scenario.v1',
    authority: 'Declarative source-derived BUILD planning recipe only; not executable actions, product behavior, proof, approval, or recording.',
    taskId: 'M-BLD-L01.T01',
    stage: 'BUILD', phase: 'KDEV-STAGE-PLAN-IMPLEMENTATION',
    status: blockers.length ? 'BLOCKED_SOURCE_JOINS_OR_ADMISSION' : 'SOURCE_BOUND_RECIPE',
    story: {
      recordingCandidateRef: profile.firstCandidate?.profileId ?? null,
      recordingCandidateAuthority: 'EDITORIAL_PROFILE_ID_ONLY_NOT_PRODUCT_IDENTITY_OR_SEMANTIC_AUTHORITY',
      title: terminal.title ?? null,
      titleSourceRef: '.product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-03/title',
      actorRefs: terminal.actors ?? [],
      actorSourceRefs: sourceActorRecords.map(actor => `.product-experience/pdp-0-product-truth/actors-responsibilities.yaml#/actors/@id=${actor.id}`),
      customerGoals: sourceGoalRecords.map(goal => ({ id: goal.id, outcome: goal.outcome, sourceRef: `.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/outcomes/@id=${goal.id}` })),
      customerGoalAuthority: 'PDP0_JOURNEY_OUTCOME_REFS_RESOLVED_TO_EXACT_PDP0_GOAL_RECORDS',
      tenantContext: { status: 'UNBOUND_SAFE_REFERENCE_REQUIRED', value: null },
      safeFixtureSeed: { status: 'NOT_AUTHORIZED_OR_PRESENT', seedRef: null },
      narrative: profile.storyboard?.scenes ?? [],
      narrativeAuthority: 'EDITORIAL_PROFILE_SCENES_ONLY_NOT_PRODUCT_SEMANTIC_AUTHORITY',
      sceneStyleNarrationConfig: {
        status: 'PDP2_PRESENTATION_AND_PDP3_WORKSPACE_SOURCE_BOUND; NARRATION_REMAINS_EDITORIAL',
        sourceRefs: [P2_INTERFACE, P3_EXPERIENCE, P3_PURPOSE_BINDINGS, PROFILE],
        editorialPolicy: profile.storyboard?.policy ?? null,
        presentation: {
          surface: { sourceRef: `${P2_INTERFACE}#/surfaceInterfaces/@surfaceId=${studioSurface.surfaceId}`, surfaceId: studioSurface.surfaceId, kind: studioSurface.kind, pages: studioSurface.pages },
          storyboardComposition: { sourceRef: `${P2_INTERFACE}#/productionStudioPageCompositionContracts/pages/@workspaceKey=${storyboardComposition.workspaceKey}`, ...storyboardComposition },
          audioOnlyProfile: { sourceRef: `${P2_INTERFACE}#/experiencePresentationProfiles/@id=${audioOnlyProfile.id}`, ...audioOnlyProfile },
          pdp3WorkspaceProposal: {
            sourceRef: `${P3_EXPERIENCE}#/productionStudioWorkspace/pages/@id=${storyboardWorkspace.id}`,
            id: storyboardWorkspace.id,
            pdp2WorkspaceKey: storyboardWorkspace.pdp2WorkspaceKey,
            semanticIntent: storyboardWorkspace.semanticIntent,
            candidateCanonicalScreenRefs: storyboardWorkspace.candidateCanonicalScreenRefs,
            canonicalScreenBinding: storyboardWorkspace.canonicalScreenBinding,
            implementationStatus: storyboardWorkspace.implementationStatus,
            designChainBindingStatus: storyboardWorkspace.designChainBindingStatus,
          },
        },
        narrationPolicy: { status: 'NOT_DEFINED_AS_PDP2_PDP3_VOICE_STYLE_OR_WORDING', editorialPolicy: profile.storyboard?.policy ?? null },
        scenes: sourceBoundScenes,
        sceneIds: (profile.storyboard?.scenes ?? []).map(x => x.id),
      },
      retainedHumanEdits: { required: true, sourceRef: 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#/storyboard' },
    },
    orderedJourneyIds: journeyOrder,
    sourceSelectors: resolvedSelectors,
    executionModes: {
      explorerSimulated: { id: 'EXPLORER_SIMULATED', status: 'SIMULATED_ONLY', mayCallProduct: false, mayClaimRealOutcome: false },
      realProduct: { id: 'PRODUCT_EXECUTED', status: 'NOT_RECORDED', requiresAdmittedChannel: true, requiresRunBoundEvidence: true },
    },
    journeys: p3,
    sourceCurrentness,
    phaseStatusRefs: PHASE_STATUS_FILES,
    expectedOwnerResult: {
      pdp0Completion: terminal?.completion ?? null,
      pdp3TerminalSuccessRef: `${contracts['J-03']}#terminalSuccess`,
      p1ResultSourceRefs: p3.find(j => j.journeyId === 'J-03').p1OperationResultBindings.map(b => b.resultSchemaRef).filter(Boolean),
      productFinality: 'Reviewable immutable caption version only; excludes J-21 approval, J-22 external delivery, and release.',
    },
    p1CapabilityOperationJoinIds: capabilityJoinIds,
    channelSelection: {
      selectedChannelRef: null,
      selectionStatus: 'UNSELECTED_NO_ADMITTED_CHANNEL',
      sourceRecommendedChannelRef: profile.selectionPolicy?.recommendedCaptureChannel ?? null,
      sourcePermittedAlternateChannelRef: profile.selectionPolicy?.sourcePermittedAlternateChannel ?? null,
      candidates: channels,
    },
    uncertaintyAndDenialBranches: terminal?.recovery ?? null,
    semanticAnchors: p3.flatMap(journey => journey.sourceSteps.map(step => ({ journeyId: journey.journeyId, sourceStepRef: step.sourceRef, view: step.view, action: step.action, canonicalOperationRef: step.canonicalOperationRef, capabilityRefs: step.capabilityRefs, result: step.result, purposeBindingRef: step.purposeBindingRef }))),
    materialSourcePins: sourcePins,
    sourceFiles: Object.keys(sourcePins),
    blockers: [...new Set(blockers)],
    blockerReconciliation,
    execution: { executable: false, productActions: false, mockProof: false, approval: false },
  };
}

export function validateMediaEarlyBusinessScenario(candidate, expected) {
  const errors = [];
  if (candidate?.schemaVersion !== 'media.early-business-scenario.v1') errors.push('unsupported scenario schema version');
  if ((candidate?.orderedJourneyIds ?? []).join('|') !== 'J-01|J-02|J-20|J-03') errors.push('source journey order mismatch');
  if (new Set((candidate?.journeys ?? []).map(x => x.journeyId)).size !== (candidate?.journeys ?? []).length) errors.push('duplicate story journey identity');
  if (JSON.stringify(candidate?.story) !== JSON.stringify(expected?.story)) errors.push('story meaning or editorial attribution differs from current PDP source');
  if (JSON.stringify(candidate?.materialSourcePins) !== JSON.stringify(expected?.materialSourcePins)) errors.push('stale material source hash');
  if (JSON.stringify(candidate?.sourceSelectors) !== JSON.stringify(expected?.sourceSelectors)) errors.push('missing or mismatched canonical source selector');
  if (JSON.stringify(candidate?.blockers) !== JSON.stringify(expected?.blockers)) errors.push('source blockers were removed or changed');
  if (JSON.stringify(candidate?.blockerReconciliation) !== JSON.stringify(expected?.blockerReconciliation)) errors.push('prior blocker reconciliation differs from exact current source joins');
  if (JSON.stringify(candidate?.sourceCurrentness) !== JSON.stringify(expected?.sourceCurrentness)) errors.push('PDP input currentness differs from current phase sourceShaSet pins');
  if (JSON.stringify(candidate?.phaseStatusRefs) !== JSON.stringify(expected?.phaseStatusRefs)) errors.push('phase status pin authorities differ from current sources');
  if (JSON.stringify(candidate?.executionModes) !== JSON.stringify(expected?.executionModes)) errors.push('execution modes differ from source policy');
  const expByJourney = new Map((expected?.journeys ?? []).map(x => [x.journeyId, x]));
  for (const journey of candidate?.journeys ?? []) {
    const exp = expByJourney.get(journey.journeyId);
    if (!exp) { errors.push(`unknown journey identity ${journey.journeyId}`); continue; }
    if (JSON.stringify(journey.p1OperationResultBindings) !== JSON.stringify(exp.p1OperationResultBindings)) errors.push(`missing or mismatched P1 result for ${journey.journeyId}`);
    if (JSON.stringify(journey.p3PurposeBindingIds) !== JSON.stringify(exp.p3PurposeBindingIds)) errors.push(`missing or mismatched PDP-3 purpose bindings for ${journey.journeyId}`);
    if (JSON.stringify(journey.sourceSteps?.map(step => [step.purposeBindingRef, step.purposeBindingSourceRef, step.purposeBindingBridgeJoin])) !== JSON.stringify(exp.sourceSteps?.map(step => [step.purposeBindingRef, step.purposeBindingSourceRef, step.purposeBindingBridgeJoin]))) errors.push(`missing or mismatched PDP-3 purpose source joins for ${journey.journeyId}`);
    if (JSON.stringify(journey.sourceSteps?.map(step => step.p1OperationBridgeJoins)) !== JSON.stringify(exp.sourceSteps?.map(step => step.p1OperationBridgeJoins))) errors.push(`missing or mismatched P1 bridge join for ${journey.journeyId}`);
    if (JSON.stringify(journey.p3ChannelEdges) !== JSON.stringify(exp.p3ChannelEdges)) errors.push(`mismatched PDP-3 edge for ${journey.journeyId}`);
  }
  const selection = candidate?.channelSelection ?? {};
  if (JSON.stringify(selection.candidates) !== JSON.stringify(expected?.channelSelection?.candidates)) errors.push('channel candidates differ from current source admission and edge bindings');
  if (selection.selectedChannelRef) {
    const channel = expected?.channelSelection?.candidates?.find(c => c.channelRef === selection.selectedChannelRef);
    if (!channel || channel.runtimeAdmission !== 'ADMITTED') errors.push(`unadmitted channel selected: ${selection.selectedChannelRef}`);
  }
  const sceneIds = candidate?.story?.narrative?.map(x => x.id) ?? [];
  if (new Set(sceneIds).size !== sceneIds.length) errors.push('duplicate story identity');
  if (JSON.stringify(candidate?.story?.sceneStyleNarrationConfig) !== JSON.stringify(expected?.story?.sceneStyleNarrationConfig)) errors.push('scene presentation or editorial narration source binding differs from current PDP sources');
  if (JSON.stringify(candidate?.story?.narrative) !== JSON.stringify(expected?.story?.narrative)) errors.push('editorial storyboard differs from current recording profile');
  return [...new Set(errors)];
}
