import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const original = read('docs/implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json');
const plan = read('docs/implementation/MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json');

test('R10 keeps the exact original 58/36 denominator and all six real external-owner rows', () => {
  assert.deepEqual(plan.currentDenominator,
    { total:58, locallyVerified:22, partial:30, ownerExternal:6 });
  assert.equal(plan.remainingTasks.length, 36);
  assert.deepEqual(plan.remainingTasks.map((x) => x.taskId).sort(),
    original.rows.map((x) => x.id).sort());
  assert.deepEqual(plan.remainingTasks.filter((x) => x.currentDisposition === 'OWNER_EXTERNAL')
    .map((x) => x.taskId).sort(),
    ['STT-12', 'TTS-07', 'TTS-12', 'VIS-02', 'VIS-12', 'MM-12'].sort());
  assert.ok(plan.remainingTasks.every((x) => x.taskAccepted === false && x.qualifiedResult === null));
});

test('each unfinished task has executable owned gates, original dependencies and real exit proofs', () => {
  const ids = new Set(plan.implementationGates.map((x) => x.id));
  assert.equal(ids.size, 12);
  for (const task of plan.remainingTasks) {
    const prev = original.rows.find((x) => x.id === task.taskId);
    assert.ok(prev, 'missing original row ' + task.taskId);
    assert.deepEqual(task.originalDependencyIds, prev.dependencyIds);
    assert.equal(task.firstCodeAction, prev.firstUnblockingImplementation);
    assert.equal(task.independentProof, prev.independentAcceptanceProof);
    assert.ok(task.unblockingGateIds.length);
    for (const ref of task.unblockingGateIds) assert.ok(ids.has(ref), 'missing gate ' + ref);
  }
  for (const gate of plan.implementationGates) {
    assert.ok(gate.ownerRepo && gate.code.length && gate.input && gate.action && gate.pass &&
      gate.fallback && gate.engineeringDecision, 'missing concrete gate step ' + gate.id);
  }
});

test('engineering approval never implies external copyright, voice, biometric or product acceptance', () => {
  assert.equal(plan.notASecondPdpOrAdmittedProvider, true);
  assert.ok(plan.hardExternalGates.some((x) => x.includes('HUMAN_VOICE')));
  const reference = plan.approvedReferenceQualificationProfiles;
  assert.equal(reference.scope,
    'DEVELOPMENT_REFERENCE_PROFILES_ONLY_NOT_REPLACEMENT_PDP0_INTENT_OR_PRODUCTION_SLO');
  assert.equal(reference.ownerStatus,
    'ENGINEERING_APPROVED_TEST_SCOPE_AND_PROVISIONAL_THRESHOLDS; NONE_OF_THESE_VALUES_CERTIFY_RUNTIME_OR_LICENSE');
  assert.equal(reference.tts.cloning, 'NOT_ADMITTED_WITHOUT_ACTUAL_SPEAKER_CONSENT');
  assert.equal(reference.capacity.productionSlo.includes('NFR-DEC-SLO'), true);
  const rights = plan.implementationGates.find((x) => x.id === 'G11');
  assert.match(rights.engineeringDecision, /no AI\/user-delegated invented/iu);
});

test('host OCI resolution does not weaken cross-platform safety or promote VIS-03 by description', () => {
  const worker = plan.implementationGates.find((x) => x.id === 'G06');
  assert.match(worker.action, /host-only OCI supervisor/iu);
  assert.match(worker.action, /no-new-privileges/iu);
  assert.match(worker.action, /--pids-limit=32/u);
  assert.ok(plan.targetFirstRows.includes('VIS-03'));
  assert.equal(plan.remainingTasks.find((x) => x.taskId === 'VIS-03').taskAccepted, false);
  assert.deepEqual(plan.approvedReferenceQualificationProfiles.referenceEnvironment.windows, 'DEFERRED');
});


test('current source owner dispositions never silently admit a provider or task', () => {
  assert.equal(plan.latestOwnerResolution.protectedLedger.total, 58);
  assert.equal(plan.latestOwnerResolution.protectedLedger.verified, 22);
  assert.equal(plan.latestOwnerResolution.protectedLedger.partial, 30);
  assert.equal(plan.latestOwnerResolution.protectedLedger.external, 6);
  assert.equal(plan.latestOwnerResolution.protectedLedger.change, 0);
  assert.equal(plan.latestOwnerResolution.currentReviewedSource,
    'samujjwal/ghatana-media@ef823571b1dbbed2c1ea38fa291657cb04855103');
  const ownerDecisions = plan.latestOwnerResolution.decisions;
  assert.equal(ownerDecisions.length, 13);
  assert.equal(new Set(ownerDecisions.map((row) => row.id)).size, ownerDecisions.length);
  assert.ok(ownerDecisions.some((row) => row.disposition === 'EXTERNAL_EVIDENCE_NEEDED_NOT_APPROVABLE'));
  for (const row of plan.remainingTasks) {
    assert.ok(row.executionOwnership.accountableMediaRole, row.taskId + ' missing owned role');
    assert.equal(row.executionOwnership.implementationRepository, 'samujjwal/ghatana-media');
    assert.equal(row.executionOwnership.taskAcceptance, 'UNCHANGED_FULL_ORIGINAL_ROW');
    assert.equal(row.taskAccepted, false);
    assert.equal(row.qualifiedResult, null);
    assert.equal(row.executionOwnership.exogenousProofRequired,
      row.currentDisposition === 'OWNER_EXTERNAL');
  }
  assert.match(plan.remainingTasks.find((x) => x.taskId === 'VIS-09')
    .executionOwnership.platformHandoff, /Ghatana Document Intelligence/);
  assert.match(plan.remainingTasks.find((x) => x.taskId === 'MM-10')
    .executionOwnership.platformHandoff, /Ghatana Data Cloud/);
});

test('reported OCI BMP passes never certify missing PNG or a production broker', () => {
  const latest = plan.activeExecutionReadback;
  assert.deepEqual(latest.verifiedObservationFromUser.visionStubOci, { passed: 4, total: 4 });
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.passed, 3);
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.positiveCodec, 'BMP');
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.pngPositive, 'NOT_VERIFIED');
  assert.equal(latest.verifiedObservationFromUser.delegatedCgroup.skipped, 1);
  assert.ok(latest.verifiedObservationFromUser.noAcceptedRowsPromoted);
  assert.ok(Object.values(latest.gateStates).every((gate) => gate.wholeRowAcceptance === 'NOT_ACCEPTED'));
  assert.match(latest.gateStates.G06.nextAction, /PNG-capable pinned licensed codec image/);
  assert.match(latest.gateStates.G06.nextAction, /authenticated separate OCI host broker/);
  assert.match(latest.gateStates.G02.observedGap, /no actual production source-owner/);
  assert.match(latest.gateStates.G03.observedGap, /candidate fenced-attempt CAS/);
});

test('the authoritative Media privacy policy distinguishes engineering from legal admission', () => {
  const policy = readFileSync(resolve(root, 'docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md'), 'utf8');
  assert.match(policy, /## 13\. Wave 2 source-rights/);
  assert.match(policy, /APPROVED FOR ENGINEERING IMPLEMENTATION; NO PRODUCTION RIGHTS OR QUALITY GRANT/);
  assert.match(policy, /current Shared ALLOW decision/);
  assert.match(policy, /CANDIDATE/);
  assert.match(policy, /not PNG proof/);
  assert.match(policy, /original audio clip recorded by an actual human still requires/);
  assert.match(policy, /separately authenticated, least-privilege host\/CRI broker/);
});
