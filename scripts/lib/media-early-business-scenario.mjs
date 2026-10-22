import crypto from 'node:crypto';
import fs from 'node:fs';
import yaml from 'yaml';

export const MEDIA_EARLY_SCENARIO_PATH = 'docs/implementation/MEDIA-EARLY-BUSINESS-SCENARIO.v1.json';
const PLAN = 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md';
const BRIDGE = 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json';
const PROFILE = 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json';
const SOURCES = [
  PLAN, BRIDGE, PROFILE,
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/authority.yaml',
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
  '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml',
  '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml',
  '.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml',
  '.product-experience/pdp-3-product-experience/screen-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml',
  '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml',
  '.product-experience/pdp-3-product-experience/application-channel-registry.yaml',
];
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const read = (root, path) => fs.readFileSync(`${root}/${path}`, 'utf8');
const loadYaml = (root, path) => yaml.parse(read(root, path));
const byId = (rows, id) => (rows ?? []).find(row => row.id === id);

export function buildMediaEarlyBusinessScenario({ root = process.cwd() } = {}) {
  const bridge = JSON.parse(read(root, BRIDGE));
  const profile = JSON.parse(read(root, PROFILE));
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
    const purposeIds = (trace?.joins?.p3Purpose ?? []).map(x => x.id);
    const edgeRefs = (trace?.joins?.p3ChannelEdge ?? []).map(x => ({ id: x.id, sourceRef: x.sourceRef }));
    return {
      ordinal: index + 1,
      journeyId,
      title: contract.title ?? journeyId,
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
          const operation = byId(bridge.identities, `PDP-1:operations:${binding.operationRef}`);
          return { operationRef: binding.operationRef, resultSchemaRef: binding.resultSchemaRef, bridgeIdentity: operation?.id ?? null, bridgeJoins: operation?.joins ?? {}, blockers: operation?.unresolvedSourceBlockers ?? [`P1_OPERATION_NOT_IN_BRIDGE:${binding.operationRef}`] };
        }),
        result: step.result ?? null,
        purposeBindingRef: purposeIds[stepIndex] ?? null,
      })),
      p3PurposeBindingIds: purposeIds,
      p3ChannelEdges: edgeRefs,
      p1OperationResultBindings: contract.pdp1ResultEvidence?.operationResultBindings ?? [],
    };
  });
  const p0Journey = loadYaml(root, '.product-experience/pdp-0-product-truth/journey-catalog.yaml');
  const terminal = (p0Journey.journeys ?? []).find(x => x.id === 'J-03');
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
  blockers.push('NO_REAL_CHANNEL_ADMITTED:media.channel.web,media.channel.cli');
  blockers.push('RECORDER_SCENE_STYLE_NARRATION_CONFIG_NOT_BOUND_TO_PDP2_PDP3_SOURCE');
  return {
    schemaVersion: 'media.early-business-scenario.v1',
    authority: 'Declarative source-derived BUILD planning recipe only; not executable actions, product behavior, proof, approval, or recording.',
    taskId: 'M-BLD-L01.T01',
    stage: 'BUILD', phase: 'KDEV-STAGE-PLAN-IMPLEMENTATION',
    status: blockers.length ? 'BLOCKED_SOURCE_JOINS_OR_ADMISSION' : 'SOURCE_BOUND_RECIPE',
    story: {
      identity: profile.firstCandidate?.profileId ?? null,
      title: profile.firstCandidate?.title ?? null,
      actorRefs: profile.firstCandidate?.roles ?? [],
      customerGoal: profile.firstCandidate?.endUserOutcome ?? null,
      tenantContext: { status: 'UNBOUND_SAFE_REFERENCE_REQUIRED', value: null },
      safeFixtureSeed: { status: 'NOT_AUTHORIZED_OR_PRESENT', seedRef: null },
      narrative: profile.storyboard?.scenes ?? [],
      sceneStyleNarrationConfig: { status: 'SOURCE_CONFIG_NOT_BOUND', sourceRefs: ['.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml', '.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml'], editorialPolicy: profile.storyboard?.policy ?? null, sceneIds: (profile.storyboard?.scenes ?? []).map(x => x.id) },
      retainedHumanEdits: { required: true, sourceRef: 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#/storyboard' },
    },
    orderedJourneyIds: journeyOrder,
    journeys: p3,
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
    execution: { executable: false, productActions: false, mockProof: false, approval: false },
  };
}

export function validateMediaEarlyBusinessScenario(candidate, expected) {
  const errors = [];
  if (candidate?.schemaVersion !== 'media.early-business-scenario.v1') errors.push('unsupported scenario schema version');
  if ((candidate?.orderedJourneyIds ?? []).join('|') !== 'J-01|J-02|J-20|J-03') errors.push('source journey order mismatch');
  if (new Set((candidate?.journeys ?? []).map(x => x.journeyId)).size !== (candidate?.journeys ?? []).length) errors.push('duplicate story journey identity');
  if (candidate?.story?.identity !== expected?.story?.identity) errors.push('story identity differs from source profile');
  if (JSON.stringify(candidate?.materialSourcePins) !== JSON.stringify(expected?.materialSourcePins)) errors.push('stale material source hash');
  const expByJourney = new Map((expected?.journeys ?? []).map(x => [x.journeyId, x]));
  for (const journey of candidate?.journeys ?? []) {
    const exp = expByJourney.get(journey.journeyId);
    if (!exp) { errors.push(`unknown journey identity ${journey.journeyId}`); continue; }
    if (JSON.stringify(journey.p1OperationResultBindings) !== JSON.stringify(exp.p1OperationResultBindings)) errors.push(`missing or mismatched P1 result for ${journey.journeyId}`);
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
  return [...new Set(errors)];
}
