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
    'samujjwal/ghatana-media@dd82099af004917fb04662e9ccc9b2d84b7cec7a');
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

test('prior BMP-only results do not certify newer pushed PNG or production broker acceptance', () => {
  const latest = plan.activeExecutionReadback;
  assert.deepEqual(latest.verifiedObservationFromUser.visionStubOci, { passed: 4, total: 4 });
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.passed, 3);
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.positiveCodec, 'BMP');
  assert.equal(latest.verifiedObservationFromUser.visionRealFfmpeg.pngPositive, 'NOT_VERIFIED');
  assert.equal(latest.verifiedObservationFromUser.delegatedCgroup.skipped, 1);
  assert.ok(latest.verifiedObservationFromUser.noAcceptedRowsPromoted);
  assert.ok(Object.values(latest.gateStates).every((gate) => gate.wholeRowAcceptance === 'NOT_ACCEPTED'));
  assert.match(latest.gateStates.G06.nextAction, /nonce across daemon restart/);
  assert.match(latest.gateStates.G06.nextAction, /strict codec AST/);
  assert.match(latest.gateStates.G02.observedGap, /STT authenticated source-bound ingress/);
  assert.match(latest.gateStates.G03.observedGap, /Real STT provider ADMITTED transcript/);
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


test('post-pulse 992 task selection preserves all 36 original unfinished IDs and no invented successes', () => {
  const pulse = plan.latestPulseReview;
  assert.equal(pulse.reportedLocalHead, '992f77e1');
  assert.equal(pulse.localShasGitHubAccessible, true);
  assert.equal(pulse.remoteBaselineAtReview, 'fea2aae5d7d144fb7993e69c3075f669fd70c7f9');
  assert.equal(pulse.reportedCommits.length, 7);
  assert.equal(pulse.taskStatusAccounting.originalTotal, 58);
  assert.equal(pulse.taskStatusAccounting.promotedByThisUpdate, 0);
  const selected = pulse.lanes.flatMap((lane) => lane.tasks);
  assert.equal(pulse.lanes.length, 6);
  assert.equal(selected.length, 36);
  assert.equal(new Set(selected).size, 36);
  assert.deepEqual(selected.sort(), original.rows.map((row) => row.id).sort());
  assert.ok(plan.remainingTasks.every((task) => task.taskAccepted === false
    && task.qualifiedResult === null
    && task.pulse992Selection?.actionAuthority === 'ORIGINAL_R8_WHOLE_ROW'
    && task.pulse992Selection?.reportedProgressNotWholeRowAcceptance === true));
});

test('post-pulse model quality failure cannot promote tiny or relax registered thresholds', () => {
  const results = plan.latestPulseReview.reportedOutcomes.fleurs;
  assert.equal(results.totalReportedClips, 380);
  assert.equal(results.decoderCapEmptyPredictions, 89);
  assert.equal(results.allReferenceThresholdsMet, false);
  assert.equal(results.manifestVerifiedByThisReview, false);
  assert.match(results.candidateDisposition, /REVIEW_ONLY_FAILED/);
  const reference = plan.approvedReferenceQualificationProfiles.stt.qualityGateProvisional;
  assert.deepEqual(Object.fromEntries(Object.entries(results.locales)
    .map(([locale, result]) => [locale, result.limit])),
  { eng: reference.enUsWerMax, hin: reference.hiInWerMax, npi: reference.neNpWerMax });
  assert.ok(Object.values(results.locales).every((row) =>
    row.pass === false && row.wer > row.limit && row.upper95 > row.limit));
  assert.match(results.accountingRisk, /372/);
  assert.match(pulseText(), /fresh blinded, speaker-disjoint promotion holdout/);
  function pulseText() {
    return readFileSync(resolve(root, 'docs/implementation/MEDIA-WAVE2-ACTIVE-EXECUTION.md'), 'utf8');
  }
});


test('pushed seven commits are explicitly accessible while runtime acceptance stays evidence-gated', () => {
  const pulse = plan.latestPulseReview;
  assert.equal(pulse.localShasGitHubAccessible, true);
  assert.equal(pulse.reportedCommits.length, 7);
  assert.equal(pulse.sourceReviewDisposition, 'PUSHED_SOURCE_CONFIRMED_FUNCTIONAL_AND_SECURITY_GAPS_STILL_OPEN');
  assert.equal(plan.activeExecutionReadback.sourceAccess, 'CONFIRMED_REMOTE_GITHUB_COMMITTED');
  assert.equal(plan.activeExecutionReadback.independentExecutionStatus, 'NOT_RUN_IN_THIS_REVIEW');
  assert.ok(pulse.blockerCorrections.some((x) => x.id === 'SRC_PUSH' && x.disposition === 'RESOLVED'));
  for (const id of ['STT_E2E_PROOF', 'BROKER_PRODUCTION_SECURITY', 'TTS_PROCESS_SECURITY', 'FLEURS_BATCH_SCORER']) {
    assert.ok(pulse.blockerCorrections.some((x) => x.id === id), id + ' is not dispositioned');
  }
  const gate = plan.activeExecutionReadback.gateStates;
  assert.match(gate.G01.observedGap, /Whisper tiny retains actual reported/);
  assert.match(gate.G12.observedGap, /Production MM executor null/);
  assert.equal(plan.latestOwnerResolution.protectedLedger.change, 0);
  assert.ok(plan.remainingTasks.every((x) => !x.taskAccepted && x.qualifiedResult === null));
});


test('single active 2026-10-29 plan preserves each of the 36 original R8 dependencies and proof criteria', () => {
  const relative = 'docs/implementation/MEDIA-WAVE2-COMPLETION-EXECUTION-2026-10-29.md';
  const markdown = readFileSync(resolve(root, relative), 'utf8');
  assert.equal(plan.currentCompletionExecution.singleActivePlan, relative);
  assert.equal(plan.currentCompletionExecution.status, 'PLAN_APPROVED_IMPLEMENTATION_INCOMPLETE');
  assert.equal(plan.currentCompletionExecution.taskRows, 36);
  assert.equal(plan.currentCompletionExecution.lastAcceptedLedger.changed, 0);
  assert.equal(plan.currentCompletionExecution.sourceReviewed,
    'dd82099af004917fb04662e9ccc9b2d84b7cec7a');
  const lines = markdown.split('\n').filter((line) =>
    /^\| (?:STT|TTS|VIS|MM|OBS)-\d{2} \|/u.test(line));
  const entries = lines.map((line) => {
    const fields = line.split('|').map((field) => field.trim());
    return { id: fields[1], lane: fields[2], deps: fields[3], action: fields[4],
      proof: fields[5] };
  });
  assert.equal(entries.length, 36);
  assert.deepEqual(entries.map((entry) => entry.id).sort(),
    original.rows.map((row) => row.id).sort());
  for (const entry of entries) {
    const previous = original.rows.find((row) => row.id === entry.id);
    const ownerTask = plan.remainingTasks.find((row) => row.taskId === entry.id);
    assert.ok(previous && ownerTask);
    assert.equal(entry.deps, previous.dependencyIds.join(', ') || '—');
    assert.equal(entry.proof, previous.independentAcceptanceProof);
    assert.equal(entry.action, ownerTask.currentCompletionStep.action);
    assert.equal(entry.lane, ownerTask.currentCompletionStep.lane);
    assert.equal(ownerTask.currentCompletionStep.acceptance, 'NOT_ACCEPTED_CURRENT_REVIEW');
  }
  assert.match(markdown, /in-memory [^\n]*Callable/u);
  assert.match(markdown, /rejects production [^\n]*VISION/u);
  assert.match(markdown, /fresh blind speaker-disjoint holdout/u);
  assert.match(markdown, /No in-memory fixture/u);
  const old = readFileSync(resolve(root,
    'docs/implementation/MEDIA-WAVE2-ACTIVE-EXECUTION.md'), 'utf8');
  assert.match(old, /EXECUTION SUPERSEDED 2026-10-29/u);
  assert.match(old, /MEDIA-WAVE2-COMPLETION-EXECUTION-2026-10-29\.md/u);
});
