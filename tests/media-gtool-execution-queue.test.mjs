import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveMediaGtoolExecutionQueue } from '../scripts/lib/media-gtool-execution-queue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => {
  const bytes = fs.readFileSync(path.join(root, relativePath), 'utf8');
  return { bytes, value: JSON.parse(bytes) };
};
const queueFile = 'docs/implementation/MEDIA-GTOOL-EXECUTION-QUEUE.v2.json';
const dispositionFile = 'docs/implementation/MEDIA-GTOOL-OWNER-EXECUTION-DISPOSITIONS.v1.json';
const inventoryFile = 'docs/implementation/MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json';
const f00ObservationFile = 'docs/implementation/evidence/media-gtool-campaign/media-build-f00-t01-source-material-topology-observation-20261023T105424Z.v1.json';
const executionAuthorizationFile = 'config/closure/media-product-definition/owner-execution-authorization.v1.json';

function inputs() {
  return {
    queue: read(queueFile),
    dispositions: read(dispositionFile),
    inventory: read(inventoryFile),
    observation: read(f00ObservationFile),
    executionAuthorization: read(executionAuthorizationFile),
  };
}

function derive(input) {
  return deriveMediaGtoolExecutionQueue(
    input.queue.value,
    input.dispositions.value,
    input.dispositions.bytes,
    input.inventory.value,
    input.inventory.bytes,
    input.observation.value,
    input.observation.bytes,
    input.executionAuthorization.value,
    input.executionAuthorization.bytes,
  );
}

test('projects the current source bridge census and preserves all 19 owner tasks as open', () => {
  const input = inputs();
  const derived = derive(input);
  assert.equal(derived.tasks.length, 19);
  assert.ok(derived.tasks.every(task => task.status === 'OPEN_TECHNICAL_WORK'));
  assert.ok(derived.tasks.every(task => task.completionClaim === 'NOT_COMPLETE'));
  assert.deepEqual(derived.tasks.map(task => task.taskId), input.dispositions.value.tasks.map(task => task.taskId));
  assert.equal(derived.source.ownerDispositionsBlobSha, input.queue.value.source.ownerDispositionsBlobSha);
  assert.equal(derived.campaign.sourceTraceIdentities, input.inventory.value.census.traceIdentityCount);
  assert.equal(derived.bridge.sourceBridgeEdgeCount, input.inventory.value.census.sourceBridgeEdgeCount);
  assert.equal(derived.bridge.unresolvedSourceBlockerCount, input.inventory.value.census.unresolvedSourceBlockerCount);
  assert.equal(derived.bridge.sourceBridgeStatus, input.inventory.value.sourceBridgeStatus);
  assert.equal(derived.bridge.sourceBridgeRef, input.inventory.value.sourceBridge);
  assert.equal(derived.bridge.blockerInventoryRef, inventoryFile);
  assert.equal(derived.bridge.blockerInventoryDigest, `sha256:${crypto.createHash('sha256').update(input.inventory.bytes).digest('hex')}`);
  assert.equal(derived.bridge.taskCompletionStatus, 'NOT_EVALUATED');
  assert.equal(derived.bridge.proofStatus, 'NOT_VERIFIED');
  assert.equal(derived.statusAxes.sourceDevelopment, 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT');
  assert.equal(derived.statusAxes.planReady, 'NOT_PROVEN');
  assert.equal(derived.statusAxes.nativeClosure, 'NOT_PROVEN');
  assert.equal(derived.executionAuthorization.ref, executionAuthorizationFile);
  assert.equal(derived.executionAuthorization.decisionId, 'MEDIA-GTOOL-CLOSURE-EXECUTION-2026-10-22');
  assert.equal(derived.executionAuthorization.ownerDecisionRevision, 3);
  assert.match(derived.executionAuthorization.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(derived.executionAuthorization.trustedAdmission, 'NOT_ISSUED');
  assert.equal(derived.executionAuthorization.nativeReceipts, 0);
  assert.equal(derived.executionAuthorization.deliveryAuthorization, false);
  assert.equal(derived.executionAuthorization.boundary, 'OWNER_SCOPE_ONLY_NOT_TRUSTED_ADMISSION_NATIVE_CLOSURE_BUILD_COMPLETION_OR_DELIVERY');
  assert.deepEqual(derived.bridge.remainingExactOperationIds, []);
  assert.deepEqual(derived.bridge.unresolvedRelations, []);
  assert.deepEqual(derived.bridge.unresolvedHandoffSelectors, []);
  const g0 = derived.waves.find(wave => wave.id === 'G0');
  assert.equal(g0.status, 'SOURCE_READBACK_OBSERVED');
  assert.equal(g0.sourceReadback.status, 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT');
  assert.equal(g0.sourceReadback.sourceIdentities, 54);
  assert.equal(g0.sourceReadback.phaseCells, 216);
  assert.equal(g0.sourceReadback.remainingDefinitionTasks, 0);
  assert.match(g0.sourceReadback.observationDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(g0.sourceReadback.authority, 'READ_ONLY_OBSERVATION_NOT_STAGE_TRANSITION_OR_CLOSURE');
  const g1 = derived.waves.find(wave => wave.id === 'G1');
  assert.equal(g1.status, 'OPEN_TECHNICAL_WORK');
  assert.equal(g1.sourceReadback.status, 'SOURCE_RELATIONS_CURRENT');
  assert.equal(g1.sourceReadback.traceIdentityCount, 3186);
  assert.equal(g1.sourceReadback.sourceBridgeEdgeCount, 8667);
  assert.equal(g1.sourceReadback.inventoryRef, inventoryFile);
  assert.equal(g1.sourceReadback.inventoryDigest, derived.bridge.blockerInventoryDigest);
  assert.equal(g1.sourceReadback.sourceBridgeRef, input.inventory.value.sourceBridge);
  assert.equal(g1.sourceReadback.unresolvedSourceBlockerCount, 0);
  assert.equal(g1.sourceReadback.p1OperationMissingReferenceCount, 0);
  assert.equal(g1.sourceReadback.unresolvedCrossLayerRelationCount, 0);
  assert.equal(g1.sourceReadback.unresolvedHandoffSelectorCount, 0);
  assert.equal(g1.sourceReadback.taskCompletionStatus, 'NOT_EVALUATED');
  assert.equal(g1.sourceReadback.proofStatus, 'NOT_VERIFIED');
  assert.equal(g1.sourceReadback.authority, 'SOURCE_RELATION_CENSUS_NOT_TASK_ACCEPTANCE_OR_PROOF');
  assert.match(g1.input, /F00\.T02 acceptance artifacts/u);
  assert.ok(derived.tasks.every(task => task.status === 'OPEN_TECHNICAL_WORK'));
  assert.equal(derived.tasks.length, 19);
});

test('fails closed when the authorization is missing, stale, or grants beyond revision 3 scope', () => {
  const input = inputs();
  assert.throws(() => deriveMediaGtoolExecutionQueue(
    input.queue.value, input.dispositions.value, input.dispositions.bytes,
    input.inventory.value, input.inventory.bytes, input.observation.value, input.observation.bytes,
  ), /CURRENT_OWNER_EXECUTION_AUTHORIZATION_REVISION_3_REQUIRED/);

  input.executionAuthorization.value.ownerDecisionRevision = 2;
  input.executionAuthorization.bytes = JSON.stringify(input.executionAuthorization.value);
  assert.throws(() => derive(input), /CURRENT_OWNER_EXECUTION_AUTHORIZATION_REVISION_3_REQUIRED/);

  input.executionAuthorization.value.ownerDecisionRevision = 3;
  input.executionAuthorization.value.trustedAdmission = 'ISSUED';
  input.executionAuthorization.bytes = JSON.stringify(input.executionAuthorization.value);
  assert.throws(() => derive(input), /CURRENT_OWNER_EXECUTION_AUTHORIZATION_REVISION_3_REQUIRED/);
});

test('fails closed when the execution authorization reference is not canonical', () => {
  const input = inputs();
  assert.throws(() => deriveMediaGtoolExecutionQueue(
    input.queue.value, input.dispositions.value, input.dispositions.bytes,
    input.inventory.value, input.inventory.bytes,
    input.observation.value, input.observation.bytes,
    input.executionAuthorization.value, input.executionAuthorization.bytes,
    undefined, 'config/closure/alternate-owner-authorization.json',
  ), /EXECUTION_AUTHORIZATION_REFERENCE_MUST_BE_CANONICAL/);
});

test('fails closed when the current F00.T01 G0 source observation is absent or stale', () => {
  const input = inputs();
  assert.throws(() => deriveMediaGtoolExecutionQueue(
    input.queue.value, input.dispositions.value, input.dispositions.bytes,
    input.inventory.value, input.inventory.bytes, undefined, undefined,
  ), /CURRENT_F00_T01_SOURCE_OBSERVATION_REQUIRED/);

  input.observation.value.reconciliation.status = 'STALE_SOURCE_INPUTS';
  input.observation.bytes = JSON.stringify(input.observation.value);
  assert.throws(() => derive(input), /CURRENT_F00_T01_SOURCE_OBSERVATION_REQUIRED/);
});

test('CLI rejects an absent or stale underlying G0 status even when the observation artifact exists', () => {
  const input = inputs();
  const originalG0Path = input.observation.value.sourceBaseline.g0Status.path;
  const originalG0 = JSON.parse(fs.readFileSync(originalG0Path, 'utf8'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-gtool-queue-g0-'));
  const staleG0Path = path.join(tempRoot, 'stale-g0.json');
  try {
    const absent = spawnSync(process.execPath, [
      'scripts/generate-media-gtool-execution-queue.mjs', '--check', '--g0-status', path.join(tempRoot, 'missing.json'),
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(absent.status, 0);

    originalG0.status = 'SOURCE_DEFINITION_STALE';
    fs.writeFileSync(staleG0Path, JSON.stringify(originalG0));
    const stale = spawnSync(process.execPath, [
      'scripts/generate-media-gtool-execution-queue.mjs', '--check', '--g0-status', staleG0Path,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /G0 source status is not complete\/current/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('rejects a blocker inventory whose status conflicts with its exact census', () => {
  const input = inputs();
  input.inventory.value.census.unresolvedSourceBlockerCount = 1;
  input.inventory.bytes = JSON.stringify(input.inventory.value);
  assert.throws(() => derive(input), /BLOCKER_INVENTORY_CENSUS_MUST_MATCH_EXPLICIT_ROWS_AND_STATUS/);
});

test('projects a still-incomplete source bridge without mislabeling its technical-work status', () => {
  const input = inputs();
  const inventory = input.inventory.value;
  inventory.status = 'TECHNICAL_WORK_REMAINING';
  inventory.sourceBridgeStatus = 'INCOMPLETE_SOURCE_RELATIONS';
  inventory.census.unresolvedSourceIdentityCount = 1;
  inventory.census.unresolvedSourceBlockerCount = 1;
  inventory.census.unresolvedCrossLayerRelationCount = 1;
  inventory.unresolvedCrossLayerRelations = [{ operationId: 'PDP-1:operations:media.operation.example' }];
  input.inventory.bytes = JSON.stringify(inventory);
  const derived = derive(input);
  const g1 = derived.waves.find(wave => wave.id === 'G1');
  assert.equal(derived.bridge.sourceBridgeStatus, 'INCOMPLETE_SOURCE_RELATIONS');
  assert.equal(derived.bridge.blockerInventoryStatus, 'TECHNICAL_WORK_REMAINING');
  assert.equal(derived.bridge.unresolvedSourceBlockerCount, 1);
  assert.deepEqual(derived.bridge.unresolvedRelations, ['PDP-1:operations:media.operation.example']);
  assert.equal(g1.status, 'OPEN_TECHNICAL_WORK');
  assert.equal(g1.sourceReadback.status, 'INCOMPLETE_SOURCE_RELATIONS');
  assert.equal(g1.sourceReadback.unresolvedSourceBlockerCount, 1);
  assert.equal(g1.sourceReadback.taskCompletionStatus, 'NOT_EVALUATED');
});

test('rejects completed or formally waived owner tasks instead of projecting them as accepted', () => {
  const input = inputs();
  input.dispositions.value.tasks[0].completionClaim = 'COMPLETE';
  input.dispositions.bytes = JSON.stringify(input.dispositions.value);
  assert.throws(() => derive(input), /OWNER_TASKS_MUST_REMAIN_OPEN_AND_UNWAIVED/);
});

test('rejects stale task order and denominator drift', () => {
  const reordered = inputs();
  [reordered.queue.value.tasks[0], reordered.queue.value.tasks[1]] =
    [reordered.queue.value.tasks[1], reordered.queue.value.tasks[0]];
  assert.throws(() => derive(reordered), /QUEUE_TASK_ORDER_MUST_MATCH_OWNER_DISPOSITIONS/);

  const narrowed = inputs();
  narrowed.queue.value.campaign.sourceIdentities = 53;
  assert.throws(() => derive(narrowed), /CAMPAIGN_DENOMINATOR_REQUIRED/);
});

test('rejects unknown CLI arguments without rewriting the generated queue', () => {
  const before = fs.readFileSync(path.join(root, queueFile), 'utf8');
  const result = spawnSync(process.execPath, ['scripts/generate-media-gtool-execution-queue.mjs', '--chek'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.equal(fs.readFileSync(path.join(root, queueFile), 'utf8'), before);
});
