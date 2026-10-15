import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  assessPdp3SourceBaseline,
  assertConsequentialStepCohort,
  buildPdp3CurrentnessObservation,
  comparePdp3CaptureDigests,
  selectCurrentConsequentialSteps,
  validatePdp3ChannelEdges,
  validatePdp3CurrentnessDenominators,
  writeAppendOnlyObservation,
} from '../scripts/record-media-discovery-pdp3-currentness.mjs';

const requireTools = createRequire(path.resolve(process.cwd(), '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;

function validFixture() {
  return {
    cells: Array.from({ length: 50 }, (_, index) => ({ cellId: `cell-${index}`, surfaceId: `surface-${index}` })),
    edges: Array.from({ length: 61 }, (_, index) => ({ id: `edge-${index}`, taskId: `task-${index < 58 ? Math.floor(index / 2) : 29}`, journeyRef: `journey-${index}`, channelRef: 'channel' })),
    consequentialSteps: Array.from({ length: 14 }, (_, index) => ({
      taskId: `task-${index}`,
      journeyId: `J-${index}`,
      ordinal: index + 1,
      stepRef: `journey-${index}/steps/0`,
      exactPurposeBindingRef: `purpose-${index}`,
      exactSourceStepRef: `source-${index}`,
    })),
  };
}

test('PDP-3 currentness denominator validator accepts exact unique 50/61/14 fixture', () => {
  assert.deepEqual(validatePdp3CurrentnessDenominators(validFixture()), {
    cells: 50,
    edges: 61,
    uniqueJourneyTasks: 30,
    consequentialSteps: 14,
  });
});

test('PDP-3 currentness denominator validator fails closed on incomplete or duplicate identities', () => {
  const missing = validFixture();
  missing.edges.pop();
  assert.throws(() => validatePdp3CurrentnessDenominators(missing), /Expected 61/u);

  const duplicate = validFixture();
  duplicate.edges[1].id = duplicate.edges[0].id;
  assert.throws(() => validatePdp3CurrentnessDenominators(duplicate), /duplicate identities/u);

  const missingEdgeTask = validFixture();
  missingEdgeTask.edges[2].taskId = '';
  assert.throws(() => validatePdp3CurrentnessDenominators(missingEdgeTask), /channel edges contain a missing task identity/u);

  const wrongTaskSet = validFixture();
  wrongTaskSet.edges = wrongTaskSet.edges.map((edge) => ({ ...edge, taskId: 'one-task' }));
  assert.throws(() => validatePdp3CurrentnessDenominators(wrongTaskSet), /exactly 30 journey tasks/u);

  const duplicatePair = validFixture();
  duplicatePair.edges[1].journeyRef = duplicatePair.edges[0].journeyRef;
  assert.throws(() => validatePdp3CurrentnessDenominators(duplicatePair), /duplicate journey\/channel pairs/u);

  const ambiguousStep = validFixture();
  ambiguousStep.consequentialSteps[1].stepRef = ambiguousStep.consequentialSteps[0].stepRef;
  assert.throws(() => validatePdp3CurrentnessDenominators(ambiguousStep), /duplicate identities/u);

  const duplicatePurpose = validFixture();
  duplicatePurpose.consequentialSteps[1].exactPurposeBindingRef = duplicatePurpose.consequentialSteps[0].exactPurposeBindingRef;
  assert.throws(() => validatePdp3CurrentnessDenominators(duplicatePurpose), /purpose bindings contains duplicate identities/u);

  const duplicateSourceStep = validFixture();
  duplicateSourceStep.consequentialSteps[1].exactSourceStepRef = duplicateSourceStep.consequentialSteps[0].exactSourceStepRef;
  assert.throws(() => validatePdp3CurrentnessDenominators(duplicateSourceStep), /source steps contains duplicate identities/u);

  const duplicateJourneyOrdinal = validFixture();
  duplicateJourneyOrdinal.consequentialSteps[1].journeyId = duplicateJourneyOrdinal.consequentialSteps[0].journeyId;
  duplicateJourneyOrdinal.consequentialSteps[1].ordinal = duplicateJourneyOrdinal.consequentialSteps[0].ordinal;
  assert.throws(() => validatePdp3CurrentnessDenominators(duplicateJourneyOrdinal), /journey\/ordinal selectors contains duplicate identities/u);
});

function channelFixture() {
  return Array.from({ length: 61 }, (_, index) => {
    const taskIndex = index < 58 ? Math.floor(index / 2) : 29;
    const taskId = `task-${taskIndex}`;
    return {
      id: `edge-${index}`,
      taskId,
      journeyRef: `journey-${taskIndex}`,
      channelRef: `media.channel.fixture-${index}`,
      journeyContractRef: `contract-${taskIndex}`,
      ownerPacketRef: `docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json#/journeyChannelTasks/@taskId=${taskId}`,
      transportRefOrUnbound: 'UNBOUND',
      channelTransportEquivalence: 'UNBOUND',
      runtimeAdmission: 'NOT_ADMITTED',
    };
  });
}

function ownerTaskFixture(edges = channelFixture()) {
  return [...new Map(edges.map((edge) => [edge.taskId, {
    taskId: edge.taskId,
    journeyId: edge.journeyRef,
    contractSource: edge.journeyContractRef,
  }])).values()];
}

function fixtureChannelGrammar(edges) {
  return Object.fromEntries(edges.map((edge) => [edge.channelRef, { consumerSurfaceId: 'media.surface.fixture' }]));
}

function fixtureContractReader(edges) {
  const contracts = new Map();
  for (const edge of edges) {
    const contract = contracts.get(edge.journeyContractRef) ?? { journeyId: edge.journeyRef, channels: [] };
    contract.channels.push(edge.channelRef);
    contracts.set(edge.journeyContractRef, contract);
  }
  return (sourcePath) => contracts.get(sourcePath);
}

function validateChannelFixture(edges, { ownerTasks = ownerTaskFixture(edges), readContract = fixtureContractReader(edges) } = {}) {
  const journeys = [...new Map(edges.map((edge) => [edge.journeyRef, {
    journeyId: edge.journeyRef,
    contractRef: edge.journeyContractRef,
  }])).values()];
  return validatePdp3ChannelEdges(edges, fixtureChannelGrammar(edges), journeys, ownerTasks, { readContract });
}

test('61 channel edges must resolve current journeys, channel grammar, and matching contract refs', () => {
  const edges = channelFixture();
  assert.equal(validateChannelFixture(edges).length, 61);

  const inventedJourney = channelFixture();
  inventedJourney[0].journeyRef = 'J-NOT-DEFINED';
  assert.throws(() => validateChannelFixture(inventedJourney), /does not exactly join its owner packet task/u);

  const inventedChannel = channelFixture();
  inventedChannel[0].channelRef = 'media.channel.not-declared';
  const inventedGrammar = fixtureChannelGrammar(inventedChannel);
  delete inventedGrammar[inventedChannel[0].channelRef];
  const inventedTasks = ownerTaskFixture(inventedChannel);
  const inventedJourneys = inventedTasks.map((task) => ({ journeyId: task.journeyId, contractRef: task.contractSource }));
  assert.throws(() => validatePdp3ChannelEdges(inventedChannel, inventedGrammar, inventedJourneys, inventedTasks, {
    readContract: fixtureContractReader(inventedChannel),
  }), /not declared in current grammar/u);

  const mismatchedContract = channelFixture();
  mismatchedContract[0].journeyContractRef = 'wrong-contract';
  assert.throws(() => validateChannelFixture(mismatchedContract), /does not match current journey contract/u);
});

test('61 channel edges must join the exact owner packet task and its journey contract content', () => {
  const edges = channelFixture();
  const wrongOwnerRef = channelFixture();
  wrongOwnerRef[0].ownerPacketRef = wrongOwnerRef[2].ownerPacketRef;
  assert.throws(() => validateChannelFixture(wrongOwnerRef), /does not exactly join its owner packet task/u);

  const mismatchedOwner = ownerTaskFixture(edges);
  mismatchedOwner[0].journeyId = 'journey-other';
  assert.throws(() => validateChannelFixture(edges, { ownerTasks: mismatchedOwner }), /does not exactly join its owner packet task/u);

  const wrongJourneyContract = channelFixture();
  const readWrongJourney = fixtureContractReader(wrongJourneyContract);
  const contractPath = wrongJourneyContract[0].journeyContractRef;
  const originalContract = readWrongJourney(contractPath);
  assert.throws(() => validateChannelFixture(wrongJourneyContract, {
    readContract: (sourcePath) => sourcePath === contractPath ? { ...originalContract, journeyId: 'J-WRONG' } : readWrongJourney(sourcePath),
  }), /contract content does not declare its journey and channel/u);

  const wrongContractChannel = channelFixture();
  const readWithoutChannel = fixtureContractReader(wrongContractChannel);
  const channelContractPath = wrongContractChannel[0].journeyContractRef;
  const channelContract = readWithoutChannel(channelContractPath);
  assert.throws(() => validateChannelFixture(wrongContractChannel, {
    readContract: (sourcePath) => sourcePath === channelContractPath
      ? { ...channelContract, channels: channelContract.channels.filter((channel) => channel !== wrongContractChannel[0].channelRef) }
      : readWithoutChannel(sourcePath),
  }), /contract content does not declare its journey and channel/u);
});

test('live channel and oracle sources resolve the exact 61 edges, 30 tasks, and all material references', () => {
  const repositoryRoot = process.cwd();
  const channel = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml'), 'utf8'));
  const oracle = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml'), 'utf8'));
  const ownerPacket = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json'), 'utf8'));
  const journeys = oracle.journeys.map((journey) => ({ ...journey, contractRef: journey.sourceRef }));
  const edges = validatePdp3ChannelEdges(channel.edges, channel.channelGrammar, journeys, ownerPacket.journeyChannelTasks);
  assert.equal(edges.length, 61);
  assert.equal(new Set(edges.map((edge) => edge.taskId)).size, 30);
  assert.ok(edges.every((edge) => journeys.some((journey) => journey.journeyId === edge.journeyRef && journey.contractRef === edge.journeyContractRef)));
  assert.ok(edges.every((edge) => Object.hasOwn(channel.channelGrammar, edge.channelRef)));
  const paths = [...new Set(edges.flatMap((edge) => edge.materialSourcePaths))];
  assert.ok(paths.length > 0);
  assert.deepEqual(paths.filter((sourcePath) => !fs.existsSync(path.join(repositoryRoot, sourcePath))), []);
});

test('live R5 selectors resolve 14 unique current purpose/oracle/contract joins and exclude J21', () => {
  const repositoryRoot = process.cwd();
  const r5 = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json'), 'utf8'));
  const purpose = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml'), 'utf8'));
  const oracles = parseYaml(fs.readFileSync(path.join(repositoryRoot, '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml'), 'utf8'));
  const ownerPacket = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json'), 'utf8'));
  const steps = selectCurrentConsequentialSteps(repositoryRoot, r5, purpose, oracles, ownerPacket.consequentialStepTasks);
  assert.equal(steps.length, 14);
  assert.equal(new Set(steps.map((step) => step.taskId)).size, 14);
  assert.equal(new Set(steps.map((step) => step.exactPurposeBindingRef)).size, 14);
  assert.equal(new Set(steps.map((step) => step.exactSourceStepRef)).size, 14);
  assert.equal(new Set(steps.map((step) => `${step.journeyId}\u0000${step.ordinal}`)).size, 14);
  assert.ok(steps.every((step) => step.journeyId !== 'J-21'));
  assert.ok(steps.every((step) => step.materialSourcePaths.length > 0));
  assert.deepEqual([...new Set(steps.flatMap((step) => step.materialSourcePaths))]
    .filter((sourcePath) => !fs.existsSync(path.join(repositoryRoot, sourcePath))), []);

  const omittedOwnerTask = ownerPacket.consequentialStepTasks.slice(1);
  assert.throws(() => selectCurrentConsequentialSteps(repositoryRoot, r5, purpose, oracles, omittedOwnerTask), /missing or not 14 rows/u);

  const mismatchedOwnerTask = ownerPacket.consequentialStepTasks.map((row) => ({ ...row }));
  mismatchedOwnerTask[0].sourceStepRef = mismatchedOwnerTask[1].sourceStepRef;
  assert.throws(() => selectCurrentConsequentialSteps(repositoryRoot, r5, purpose, oracles, mismatchedOwnerTask), /does not exactly join its owner packet task/u);

  const mismatchedSelector = structuredClone(r5);
  mismatchedSelector.consequentialStepProgress.steps[0].ordinal += 1;
  assert.throws(() => selectCurrentConsequentialSteps(repositoryRoot, mismatchedSelector, purpose, oracles, ownerPacket.consequentialStepTasks), /does not exactly join its owner packet task/u);
});

test('missing historical pins preserve capture but leave source currentness UNKNOWN', () => {
  const lifecycleCurrentness = { continuity: 'CONTINUOUS', blockers: [], cells: [{ sourceCurrentness: 'CURRENT', blockers: [] }] };
  const completeBaseline = assessPdp3SourceBaseline({
    sourceDigests: [{ path: 'definition.yaml', role: 'MATERIAL', currentSha256: 'sha256:abc', pinnedSha256: 'sha256:abc' }],
    contextDigests: [
      { path: 'status.json', role: 'STATUS_CONTEXT_NOT_SELF_PINNED', currentSha256: 'sha256:def' },
      { path: 'r5.json', role: 'HISTORICAL_SELECTOR_ONLY', currentSha256: 'sha256:123' },
    ],
    lifecycleCurrentness,
  });
  assert.equal(completeBaseline.sourceCurrentness, 'CURRENT');
  assert.equal(completeBaseline.contextDigestCount, 2);

  const contextualUnpinned = assessPdp3SourceBaseline({
    sourceDigests: [{ path: 'context.yaml', role: 'MATERIAL', currentSha256: 'sha256:abc', pinnedSha256: null }],
    lifecycleCurrentness,
  });
  assert.equal(contextualUnpinned.authoritativeBaselineCoverage, 'INCOMPLETE_OR_CHANGED');
  assert.equal(contextualUnpinned.sourceCurrentness, 'UNKNOWN');

  const missingMaterial = assessPdp3SourceBaseline({
    sourceDigests: [{ path: 'missing-contract.yaml', role: 'MATERIAL', currentSha256: null, pinnedSha256: null }],
    lifecycleCurrentness,
  });
  assert.equal(missingMaterial.sourceCurrentness, 'UNKNOWN');

  const incompleteBaseline = assessPdp3SourceBaseline({
    sourceDigests: [
      { path: 'definition.yaml', role: 'MATERIAL', currentSha256: 'sha256:abc', pinnedSha256: 'sha256:abc' },
      { path: 'new-context.yaml', role: 'MATERIAL', currentSha256: 'sha256:def', pinnedSha256: null },
    ],
    lifecycleCurrentness,
  });
  assert.equal(incompleteBaseline.sourceCurrentness, 'UNKNOWN');
});

test('Lifecycle cell blockers prevent an overall CURRENT source baseline', () => {
  const lifecycleCurrentness = {
    continuity: 'CONTINUOUS',
    blockers: [],
    cells: [{ sourceCurrentness: 'UNKNOWN', blockers: ['SOURCE_PATH_CHANGED_SINCE_PRIOR_CAPTURE'] }],
  };
  const assessment = assessPdp3SourceBaseline({
    sourceDigests: [{ path: 'definition.yaml', role: 'MATERIAL', currentSha256: 'sha256:abc', pinnedSha256: 'sha256:abc' }],
    lifecycleCurrentness,
    digestAgreement: [{ path: 'definition.yaml', status: 'MATCH' }],
  });
  assert.equal(assessment.sourceCurrentness, 'UNKNOWN');
  assert.ok(assessment.blockers.includes('LIFECYCLE_CELL_CURRENTNESS_NOT_ESTABLISHED'));
});

test('builder fails closed when Lifecycle captured digests differ from direct hashes using injected capture', () => {
  const repositoryRoot = process.cwd();
  const mismatchDigest = `sha256:${'0'.repeat(64)}`;
  const baselineDigest = `sha256:${'1'.repeat(64)}`;
  let captureCalls = 0;
  const capture = () => {
    captureCalls += 1;
    return {
      schemaVersion: 'ghatana.repository-source-currentness.v1',
      status: 'OBSERVED',
      rootIdentity: baselineDigest,
      pathMembershipDigest: baselineDigest,
      contentFingerprint: baselineDigest,
      sourceToken: baselineDigest,
      journal: {
        continuity: 'CONTINUOUS',
        membershipChangeState: 'KNOWN',
        membershipAdditions: [],
        membershipRemovals: [],
        changedPaths: [],
        externalChanges: [],
      },
      metrics: { snapshotScope: 'REPOSITORY_SCOPE' },
      ownerGraphFingerprint: baselineDigest,
      physicalCatalogFingerprint: baselineDigest,
      providerRegistryFingerprint: baselineDigest,
      fileContentDigests: {
        '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml': { digest: mismatchDigest },
      },
    };
  };
  const observation = buildPdp3CurrentnessObservation(repositoryRoot, { capture });
  assert.equal(captureCalls, 2);
  const channelAgreement = observation.campaign.lifecycleDigestAgreement.find((row) => row.path.endsWith('journey-channel-contract-bindings.yaml'));
  assert.equal(channelAgreement.status, 'MISMATCH');
  assert.equal(observation.campaign.sourceCurrentness, 'UNKNOWN');
  assert.ok(observation.campaign.sourceCurrentnessBlockers.includes('LIFECYCLE_CAPTURE_DIGEST_DISAGREEMENT_OR_MISSING'));
  assert.equal(observation.campaign.denominators.pdp3PhaseCells, 50);
});

test('J21 is rejected from the selected consequential-step cohort', () => {
  const rows = validFixture().consequentialSteps;
  rows[4].journeyId = 'J-21';
  assert.throws(() => assertConsequentialStepCohort(rows), /J-21 is excluded/u);
  const fixture = validFixture();
  fixture.consequentialSteps[4].journeyId = 'J-21';
  assert.throws(() => validatePdp3CurrentnessDenominators(fixture), /J-21 is excluded/u);
});

test('append-only observation writer requires a path and never replaces an existing observation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp3-r6-'));
  try {
    const output = path.join(directory, 'observation.json');
    const observation = { recordKind: 'SOURCE_ONLY' };
    assert.throws(() => writeAppendOnlyObservation('', observation), /explicit output path/u);
    assert.equal(writeAppendOnlyObservation(output, observation), output);
    const originalBytes = fs.readFileSync(output);
    assert.throws(() => writeAppendOnlyObservation(output, { recordKind: 'OVERWRITE' }), /already exists|EEXIST/u);
    assert.deepEqual(fs.readFileSync(output), originalBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
