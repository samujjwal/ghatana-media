import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {currentPdp0PhaseScopedSourceFingerprints, validatePdp0AuditDispositions} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
function workingCopy() {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  // Mutations test validation behavior against the exact present checkout. This does not write the ledger.
  for (const file of Object.keys(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256)) {
    ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  const phaseScoped = currentPdp0PhaseScopedSourceFingerprints(ledger.coordinatorReview.decisionRef);
  ledger.sourceBaseline.phaseScopedSourceFingerprintsSha256 = phaseScoped;
  ledger.coordinatorReview.phaseScopedSourceFingerprintsSha256 = phaseScoped;
  return ledger;
}
function errorsFor(ledger, stopAfterFirstError = true) { return validatePdp0AuditDispositions({crosswalk: ledger, stopAfterFirstError}).errors; }

test('all 428 original and 73 focused IDs round-trip to authoritative source text and acceptance', () => {
  const ledger = workingCopy();
  const audit = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json'), 'utf8'));
  const source = new Map([
    ...audit.originalAudit.inventory.map(row => [row.audit_id, {partition:'originalAudit', text:row.capability, acceptance:row.acceptance_family}]),
    ...audit.thirdPassAdditions.map(row => [row.audit_id, {partition:'focusedAudit', text:row.capability, acceptance:row.acceptance}]),
  ]);
  assert.equal(source.size, 501);
  assert.equal(ledger.rows.length, 501);
  for (const row of ledger.rows) {
    const sourceRow = source.get(row.auditId);
    assert.ok(sourceRow, `unexpected audit ID ${row.auditId}`);
    assert.equal(row.sourcePartition, sourceRow.partition, `${row.auditId} partition`);
    assert.equal(row.sourceText, sourceRow.text, `${row.auditId} source text`);
    assert.equal(row.sourceAcceptanceText, sourceRow.acceptance, `${row.auditId} acceptance text`);
  }
});


test('rights acceptance cases reject denied and revoked states for AC-03 through AC-05', () => {
  const requirements = parseYaml(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/requirements.yaml'), 'utf8'));
  const rights = requirements.requirements.find(row => row.id === 'MEDIA-REQ-CAP-RIGHTS');
  const cases = new Map((rights?.acceptanceCases ?? []).map(row => [row.id, row]));
  for (const suffix of ['03', '04', '05']) {
    const clause = cases.get(`MEDIA-REQ-CAP-RIGHTS-AC-${suffix}`);
    assert.ok(clause, `missing rights AC-${suffix}`);
    assert.match(clause.then, /denied/i, `AC-${suffix} must cover DENIED`);
    assert.match(clause.then, /revoked/i, `AC-${suffix} must cover REVOKED`);
  }
});

test('AUD-SIM3-009 binds every enumerated specialized model family separately', () => {
  const row = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8')).rows.find(item => item.auditId === 'AUD-SIM3-009');
  for (const model of ['rigid-body','soft-body','cloth','rope','particle','fluid','smoke','fire','collision','constraint','vehicle','crowd','agent','human-motion','procedural-world','camera-experiment','lighting-experiment','educational-demo','scientific-demo','robotics','kinematics','synthetic-data']) {
    assert.ok(row?.pdp0EvidenceRefs?.includes(`.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.${model}`), `missing exact simulation model ${model}`);
    assert.ok(row?.phaseLocalRationale?.includes(`media.simulation.${model}`), `missing exact model rationale ${model}`);
  }
  for (const suffix of ['01', '02']) {
    assert.ok(row?.pdp0EvidenceRefs?.includes(`.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-${suffix}`), `missing family/fallback acceptance case ${suffix}`);
  }
});

test('all 501 source-proposed owners resolve to current PDP-0 definition scopes only', () => {
  const ledger = workingCopy();
  const result = validatePdp0AuditDispositions({crosswalk:ledger});
  assert.deepEqual(result.errors, []);
  const counts = Object.fromEntries([...new Set(ledger.rows.map(row => row.ownerSurfaceProposal))]
    .map(surfaceId => [surfaceId, ledger.rows.filter(row => row.ownerSurfaceProposal === surfaceId).length]));
  assert.deepEqual(counts, {
    'media.surface.recorder-orchestrator':104,
    'media.surface.capture-adapters':28,
    'media.surface.production-studio':346,
    'media.surface.interactive-demo-player':23,
  });
  for (const row of ledger.rows) {
    assert.equal(row.definitionScopeBinding.status,'DEFINITION_SCOPE_ONLY');
    assert.equal(row.definitionScopeBinding.ownerApproval,'NOT_CLAIMED');
    assert.equal(row.definitionScopeBinding.runtimeAdmission,'NOT_CLAIMED');
  }
  const changed = workingCopy();
  changed.rows[0].ownerSurfaceProposal = 'media.surface.web';
  assert.ok(errorsFor(changed,false).some(error => /preserve the exact source owner-surface proposal/u.test(error)));
});

test('feature-specific audit gaps bind their exact current PDP-0 cases', () => {
  const ledger = workingCopy();
  const refs = [
    ['AUD-SPEC-013','MEDIA-REQ-CAP-DELIVER-AC-03'],
    ['AUD-SPEC-019','MEDIA-REQ-CAP-QUALITY-AC-09'],
    ['AUD-SPEC-020','MEDIA-REQ-CAP-RULES-AC-01'],
    ['AUD-TTS-011','MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-06'],
    ['AUD-TTS-013','MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-07'],
    ['AUD-DUB-002','MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-06'],
  ];
  for (const [auditId,caseId] of refs) {
    const row=ledger.rows.find(item=>item.auditId===auditId);
    assert.ok(row.pdp0EvidenceRefs.some(ref=>ref.includes(`/@id=${caseId}`)),`${auditId} exact case`);
  }
  const missing = workingCopy();
  missing.rows.find(item=>item.auditId==='AUD-SPEC-013').pdp0EvidenceRefs = [];
  assert.ok(errorsFor(missing,false).some(error=>/AUD-SPEC-013 must bind its exact feature-specific PDP-0 acceptance case/u.test(error)));
});

test('four audited feature rows bind exact PDP-0 meanings and phase-owned handoffs', () => {
  const ledger = workingCopy();
  const byId = id => ledger.rows.find(row => row.auditId === id);
  const phases = id => new Set((byId(id)?.laterPhaseHandoffs ?? []).map(handoff => handoff.phase));
  const spec013 = byId('AUD-SPEC-013');
  assert.ok(phases('AUD-SPEC-013').has('PDP-2') && phases('AUD-SPEC-013').has('PDP-3'));
  assert.match(spec013.laterPhaseHandoffs.find(h => h.phase === 'PDP-2').scope, /variant selection.*preview/i);
  assert.match(spec013.laterPhaseHandoffs.find(h => h.phase === 'PDP-3').scope, /complete.*variant.*deliver/i);

  const spec019 = byId('AUD-SPEC-019');
  assert.ok(spec019.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-quality-rank.v1'));
  assert.ok(spec019.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.quality.rank'));
  assert.ok(phases('AUD-SPEC-019').has('PDP-2') && phases('AUD-SPEC-019').has('PDP-3'));
  assert.match(spec019.laterPhaseHandoffs.find(h => h.phase === 'PDP-3').scope, /compare\/select\/reselect.*unknown/i);

  const spec020 = byId('AUD-SPEC-020');
  const extension = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/';
  for (const suffix of ['capabilityDefinition','requirementDefinition','requirementDefinition/acceptanceCases/@id=MEDIA-REQ-CAP-RULES-AC-01','compileAcceptance','validationCoverage','validationCoverage/compileEquivalenceAndFingerprint']) {
    assert.ok(spec020.pdp0EvidenceRefs.includes(extension + suffix), `missing exact campaign extension binding ${suffix}`);
  }
  assert.ok(!spec020.pdp0EvidenceRefs.some(ref => ref.includes('MEDIA-REQ-CAP-PROFILE-AC-03')));
  assert.deepEqual([...phases('AUD-SPEC-020')].sort(), ['PDP-1','PDP-2','PDP-3']);

  const dub = byId('AUD-DUB-002');
  assert.deepEqual([...phases('AUD-DUB-002')].sort(), ['PDP-1','PDP-2','PDP-3']);
  assert.match(dub.laterPhaseHandoffs.find(h => h.phase === 'PDP-2').scope, /selection controls/i);
  assert.match(dub.laterPhaseHandoffs.find(h => h.phase === 'PDP-3').scope, /complete translation journey/i);

  const droppedCompile = workingCopy();
  droppedCompile.rows.find(row => row.auditId === 'AUD-SPEC-020').pdp0EvidenceRefs = spec020.pdp0EvidenceRefs.filter(ref => !ref.endsWith('/compileAcceptance'));
  assert.ok(errorsFor(droppedCompile, false).some(error => /AUD-SPEC-020 must bind campaign-extensions proposal/u.test(error)));
  const badQualityTrust = workingCopy();
  badQualityTrust.rows.find(row => row.auditId === 'AUD-SPEC-019').pdp0EvidenceRefs = spec019.pdp0EvidenceRefs.filter(ref => !ref.includes('media-capability-adjudication-quality-rank.v1'));
  assert.ok(errorsFor(badQualityTrust, false).some(error => /AUD-SPEC-019 must bind the exact media\.quality\.rank trust record/u.test(error)));
});

test('AUD-EDIT-007 scopes solo evidence to AC-080 and retains lock/effects-bypass at PDP-1', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-EDIT-007');
  assert.ok(row.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.animation.editing.track.solo'));
  assert.ok(row.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#recorderStudioProfile/acceptanceClauses/@id=MEDIA-REC-P0-AC-080'));
  assert.match(row.phaseLocalRationale, /does not define track lock or effects bypass/i);
  assert.equal(row.disposition, 'BOUND_EXISTING');
  assert.equal(row.laterPhaseHandoffs.ownerPhase, 'PDP-1');
  assert.match(row.laterPhaseHandoffs.gap, /track-lock-and-effects-bypass-operation-semantics/);
  assert.deepEqual(errorsFor(ledger), []);
});

test('embedded sandbox, redaction, and editable interchange rows bind their exact P0 boundaries', () => {
  const ledger = workingCopy();
  for (const [auditId,needle] of [
    ['AUD-INTER-005','MEDIA-DECL-P0-AC-061'],
    ['AUD-TRUST-016','MEDIA-DECL-P0-AC-057'],
    ['AUD-ANIM3-016','media.animation.output.output.exchange-package'],
  ]) {
    const row=ledger.rows.find(item=>item.auditId===auditId);
    assert.ok(row.pdp0EvidenceRefs.some(ref=>ref.includes(needle)),`${auditId} ${needle}`);
  }
});

test('AUD-MUSIC-014 binds checkpoint rights and use scope without claiming similarity clearance', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-MUSIC-014');
  const checkpointCase = '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-GENERATE-AUDIO/acceptanceCases/@id=MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05';
  const unknownLicenseCase = '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-GENERATE-AUDIO/acceptanceCases/@id=MEDIA-REQ-CAP-GENERATE-AUDIO-AC-02';
  const permittedUseCase = '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-02';
  assert.ok(row.pdp0EvidenceRefs.includes(checkpointCase));
  assert.ok(row.pdp0EvidenceRefs.includes(unknownLicenseCase));
  assert.ok(row.pdp0EvidenceRefs.includes(permittedUseCase));
  assert.ok(row.pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.generate.audio.music'));
  assert.ok(row.pdp0EvidenceRefs.some(ref => ref.endsWith('MEDIA-REQ-CAP-QUALITY-AC-14')));
  assert.ok(!row.pdp0EvidenceRefs.some(ref => ref.includes('MEDIA-REQ-CAP-QUALITY-AC-05')));
  assert.equal(row.independentQcDispositionResolution.currentSourceReviewRef, '.product-experience/decision-log.md#PXD-196');
  assert.deepEqual([...row.independentQcDispositionResolution.currentSourceEvidenceRefs].sort(), [...row.pdp0EvidenceRefs].sort());
  assert.equal(row.independentQcDispositionResolution.ownerApproval, 'NOT_CLAIMED');
  assert.match(row.phaseLocalRationale, /noncommercial weights for commercial use/i);
  assert.match(row.phaseLocalRationale, /similarity observation is not legal judgment or clearance/i);
  assert.deepEqual(errorsFor(ledger), []);

  const weakened = workingCopy();
  const weakenedRow = weakened.rows.find(item => item.auditId === 'AUD-MUSIC-014');
  weakenedRow.pdp0EvidenceRefs = weakenedRow.pdp0EvidenceRefs.filter(ref => ref !== checkpointCase);
  weakenedRow.pdp0EvidenceRefs.push('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-QUALITY/acceptanceCases/@id=MEDIA-REQ-CAP-QUALITY-AC-05');
  assert.ok(errorsFor(weakened, false).some(error => /AUD-MUSIC-014 must bind exact checkpoint license/u.test(error)));
});

test('AUD-ASSET-009 binds governed asset search and derived indexes rather than import semantics', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-ASSET-009');
  const licenseFilterCase = '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-ARTIFACT/acceptanceCases/@id=MEDIA-REQ-CAP-ARTIFACT-AC-05';
  assert.ok(row.pdp0EvidenceRefs.includes(licenseFilterCase));
  assert.ok(row.pdp0EvidenceRefs.some(ref => ref.endsWith('/@id=media.artifact.search')));
  assert.ok(row.pdp0EvidenceRefs.some(ref => ref.endsWith('/@id=media.artifact.derive')));
  assert.ok(row.pdp0EvidenceRefs.some(ref => ref.endsWith('/@id=media.artifact.retain')));
  assert.ok(!row.pdp0EvidenceRefs.some(ref => ref.includes('media.artifact.import')));
  assert.equal(row.decisionRef.id, 'PXD-196');
  assert.match(row.phaseLocalRationale, /only an exact immutable asset version.*current authoritative rights\/license evidence expressly permitting the declared intended-use scope is eligible/i);
  assert.match(row.phaseLocalRationale, /unknown or review-required rather than an empty eligible result/i);
  assert.match(row.phaseLocalRationale, /does not interpret license terms.*legal clearance.*external-catalog search/i);
  assert.deepEqual(errorsFor(ledger), []);

  const wrongSelector = workingCopy();
  const wrongRow = wrongSelector.rows.find(item => item.auditId === 'AUD-ASSET-009');
  wrongRow.pdp0EvidenceRefs = wrongRow.pdp0EvidenceRefs.map(ref => ref.replace('media.artifact.search', 'media.artifact.import'));
  assert.ok(errorsFor(wrongSelector, false).some(error => /AUD-ASSET-009 must bind the exact license\/use-scope candidate filter/u.test(error)));

  const missingFilter = workingCopy();
  missingFilter.rows.find(item => item.auditId === 'AUD-ASSET-009').pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => ref !== licenseFilterCase);
  assert.ok(errorsFor(missingFilter, false).some(error => /AUD-ASSET-009 must bind the exact license\/use-scope candidate filter/u.test(error)));
});

test('AUD-ASSET-012 binds exact caption import observation and separate subtitle delivery', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-ASSET-012');
  const expectedEvidence = [
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.artifact.import',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-ARTIFACT/acceptanceCases/@id=MEDIA-REQ-CAP-ARTIFACT-AC-08',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.deliver.subtitles',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-DELIVER/acceptanceCases/@id=MEDIA-REQ-CAP-DELIVER-AC-04',
  ];
  assert.equal(row.sourceText, 'Sidecar and embedded caption import/export');
  assert.equal(row.sourceAcceptanceText, 'Assets reopen by immutable version and hash; thumbnails and searchable indexes are derived under purpose/tenant controls, not duplicate sources.');
  assert.equal(row.disposition, 'BOUND_EXISTING');
  assert.deepEqual(row.pdp0EvidenceRefs, expectedEvidence);
  assert.deepEqual(row.pdp0ContextRefs, []);
  assert.equal(row.decisionRef.id, 'PXD-209');
  assert.equal(row.decisionRef.ownerApproval, 'NOT_CLAIMED');
  assert.equal(row.ownerApproval, 'NOT_CLAIMED');
  assert.equal(row.independentQcRef, null);
  assert.match(row.phaseLocalRationale, /optional caption-track observation only when an authorized sidecar or embedded track is explicitly requested.*exact immutable imported source version/u);
  assert.match(row.phaseLocalRationale, /does not alter source media.*does not establish caption correctness.*does not register (?:or replace|\/replace) a canonical artifact/u);
  assert.match(row.phaseLocalRationale, /separately authorized subtitle-delivery outcome.*destination submission, acceptance and finality distinct/u);
  assert.match(row.phaseLocalRationale, /sourceAcceptanceText.*preserved verbatim as provenance/u);
  assert.match(row.phaseLocalRationale, /No parser\/format support, implementation, qualification, owner acceptance, or independent acceptance is claimed/u);
  assert.equal(row.laterPhaseHandoffs.ownerPhase, 'PDP-2/PDP-3');
  assert.match(row.laterPhaseHandoffs.gap, /PDP-1 owns typed import-observation and subtitle-delivery operation\/domain contracts.*PDP-2 owns accessible interface grammar.*PDP-3 owns/u);
  assert.equal(row.laterPhaseHandoffs.status, 'SEPARATE_HANDOFF_NOT_A_PDP0_TASK');
  assert.deepEqual(errorsFor(ledger), []);

});

test('current PXD-216 crosswalk source pins preserve PXD-215 predecessor and prior audit history', () => {
  const result = validatePdp0AuditDispositions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.total, 501);
  assert.equal(result.stats.dispositionCounts.BLOCKED_EXTERNAL_OWNER_DECISION, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  const decisionLog = '.product-experience/decision-log.md';
  assert.equal(ledger.coordinatorReview.decisionRef, 'PXD-216');
  assert.equal(ledger.coordinatorReview.priorDecisionRef, 'PXD-215');
  const historicalPxd215 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-215');
  assert.ok(historicalPxd215, 'PXD-215 remains in review history as the non-accepting predecessor');
  assert.equal(historicalPxd215.priorDecisionRef, 'PXD-214');
  assert.equal(historicalPxd215.ownerApproval, 'NOT_CLAIMED');
  assert.equal(historicalPxd215.acceptanceEffect, 'none');
  const historicalPxd214 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-214');
  assert.ok(historicalPxd214, 'PXD-214 remains in review history');
  assert.equal(historicalPxd214.priorDecisionRef, 'PXD-213');
  const historicalPxd213 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-213');
  assert.ok(historicalPxd213, 'PXD-213 remains in review history');
  assert.equal(historicalPxd213.priorDecisionRef, 'PXD-212');
  const expectedPhasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-216');
  assert.deepEqual(ledger.sourceBaseline.phaseScopedSourceFingerprintsSha256, expectedPhasePins);
  assert.deepEqual(ledger.coordinatorReview.sourceFingerprints, expectedPhasePins);
  for (const broadFilePin of [decisionLog, '.product-experience/source-manifest.yaml', 'docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json']) {
    assert.equal(Object.hasOwn(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256, broadFilePin), false, `${broadFilePin} is represented by its PDP-0 projection`);
  }
  const priorCurrent = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-205');
  assert.ok(priorCurrent, 'PXD-205 remains in review history');
  assert.equal(priorCurrent.priorDecisionRef, 'PXD-204');
  const pxd206 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-206');
  assert.ok(pxd206, 'PXD-206 remains in review history');
  assert.equal(pxd206.priorDecisionRef, 'PXD-205');
  const pxd192 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-192');
  assert.ok(pxd192, 'PXD-192 remains in review history');
  assert.equal(pxd192.priorDecisionRef, 'PXD-191');
  assert.equal(ledger.coordinatorReview.ownerApproval, 'NOT_CLAIMED');
  const historical = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-186');
  assert.equal(historical.priorDecisionRef, 'PXD-185');
  assert.equal(historical.sourceFingerprints[decisionLog], '7553a5002c6de27fe160ae584996c7fd983422399703999409e75960485f547e');
  const previousCurrent = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-190');
  assert.equal(previousCurrent.priorDecisionRef, 'PXD-186');
  assert.equal(previousCurrent.sourceFingerprints[decisionLog], '4c91f4058b9848c6fda562a35d76f5d687bd060ff671299f8377aae668f81eea');
  const historicalPxd207 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-207');
  assert.ok(historicalPxd207, 'PXD-207 remains an immutable predecessor in review history');
  assert.equal(historicalPxd207.priorDecisionRef, 'PXD-206');
  assert.match(historicalPxd207.note, /PXD-207 records exact owner-decided channel\/surface applicability for seven definition extensions/u);
  assert.match(historicalPxd207.note, /PXD-207 adopts the current PDP-0 meanings for the five PXD-206 leaf type differences/u);
  assert.match(ledger.coordinatorReview.note, /497 canonical definition joins, 2 separately labeled coordinator-authored proposal joins, 2 POST_PDP_IMPLEMENTATION_ONLY handoffs, and zero missing PDP-0 joins/u);
  assert.match(ledger.coordinatorReview.note, /No runtime, implementation, qualification, closure, or Delivery readiness is claimed/u);
  assert.match(ledger.coordinatorReview.note, /imported voice-cloning acceptance mismatch remains provenance-only under PXD-172/u);
  assert.doesNotMatch(ledger.coordinatorReview.note, /measures and qualification remain NOT_EVALUATED/u);
  assert.match(ledger.coordinatorReview.note, /imported voice-cloning acceptance mismatch remains provenance-only under PXD-172/u);
  assert.deepEqual(ledger.unresolvedPdp0Ids, []);
  assert.deepEqual(ledger.externalOwnerBlockers, []);
  assert.equal(ledger.coordinatorReview.ownerApproval, 'NOT_CLAIMED');
  for (const auditId of ['AUD-TTS-012', 'AUD-TTS-014', 'AUD-DUB-003']) {
    const row = ledger.rows.find(item => item.auditId === auditId);
    assert.equal(row.currentSuccessorDecisionRef, '.product-experience/decision-log.md#PXD-213');
    assert.equal(row.ownerApproval, 'NOT_CLAIMED');
  }
  const stereoWidth = ledger.rows.find(item => item.auditId === 'AUD-DSP-016');
  assert.match(stereoWidth.phaseLocalRationale, /explicit channel-layout handling/u);
  assert.equal(stereoWidth.currentSuccessorDecisionRef, '.product-experience/decision-log.md#PXD-211');
  assert.match(stereoWidth.historicalPxd210PhaseLocalRationale, /delivery-target-channel-layout-and-loudness-context/u);
  assert.match(stereoWidth.historicalPxd210PhaseLocalRationale, /under delegated decision PXD-207/u);
  const creativeEffects = ledger.rows.find(item => item.auditId === 'AUD-DSP-007');
  assert.equal(creativeEffects.disposition, 'BOUND_EXISTING');
  assert.deepEqual(creativeEffects.pdp0EvidenceRefs, [
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.master.audio.creative-effect.apply',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-MASTER-AUDIO/acceptanceCases/@id=MEDIA-REQ-CAP-MASTER-AUDIO-AC-03',
  ]);
  assert.ok(creativeEffects.pdp0ContextRefs.includes('.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=media.master.audio.creative-effect.apply'));
  assert.equal(creativeEffects.independentQcDispositionResolution.currentSourceReviewRef, '.product-experience/decision-log.md#PXD-207');
  assert.equal(creativeEffects.independentAcceptance, 'NOT_CLAIMED');
  assert.match(creativeEffects.phaseLocalRationale, /local source-preserving derived-audio candidate/u);
  assert.match(creativeEffects.phaseLocalRationale, /media.channel.web/u);
  assert.equal(creativeEffects.ownerApproval, 'NOT_CLAIMED');
});

test('a stale PDP-0 projection pin fails independently of the exact-file source map', () => {
  const ledger = workingCopy();
  ledger.sourceBaseline.phaseScopedSourceFingerprintsSha256['.product-experience/source-manifest.yaml#PDP-0-projection'] = '0'.repeat(64);
  assert.ok(errorsFor(ledger, false).some(error => /stale PDP-0 phase-scoped fingerprint/u.test(error)));
});

test('AUD-SIM3-010 fails if exact stochastic acceptance evidence is removed', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-SIM3-010');
  row.pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => !ref.includes('MEDIA-DECL-P0-AC-034'));
  row.independentQcDispositionResolution.currentSourceEvidenceRefs = [...row.pdp0EvidenceRefs];
  assert.ok(errorsFor(ledger).some(error => /AUD-SIM3-010 must cite exact current AC-03, AC-023, AC-024, AC-034/.test(error)));
});

test('AUD-CLONE-012 imported acceptance mismatch cannot broaden QUALITY-AC-06 evidence', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-CLONE-012');
  assert.equal(row.pdp0CapabilityScopeDisposition, 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY');
  assert.ok(row.pdp0ContextRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.quality.inspect'));
  assert.match(row.phaseLocalRationale, /no watermark-specific capability claim/i);
  assert.match(row.phaseLocalRationale, /stripping or removal/i);
  assert.deepEqual(errorsFor(ledger), []);

  const missingFamilyCapability = workingCopy();
  missingFamilyCapability.rows.find(item => item.auditId === 'AUD-CLONE-012').pdp0ContextRefs = [];
  assert.ok(errorsFor(missingFamilyCapability, false).some(error => /AUD-CLONE-012 must remain scoped only to QUALITY-AC-06/u.test(error)));

  row.pdp0EvidenceRefs.push('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-03');
  assert.ok(errorsFor(ledger, false).some(error => /AUD-CLONE-012 must remain scoped only to QUALITY-AC-06/.test(error)));

  const provenance = workingCopy();
  provenance.coordinatorReview.note = 'Imported text is product evidence.';
  assert.ok(errorsFor(provenance, false).some(error => /AUD-CLONE-012 must remain scoped only to QUALITY-AC-06/.test(error)));

  const mapping = workingCopy();
  mapping.resolvedCandidateMappings['AUD-CLONE-012'].push('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-03');
  assert.ok(errorsFor(mapping, false).some(error => /AUD-CLONE-012 must remain scoped only to QUALITY-AC-06/.test(error)));
});

test('AUD-ANIM3-010 requires AC-061 gesture/trigger semantics and rejects AC-010 substitution', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-ANIM3-010');
  row.pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => !ref.includes('MEDIA-DECL-P0-AC-061'));
  assert.ok(errorsFor(ledger, false).some(error => /AUD-ANIM3-010 must bind the exact gesture\/trigger map/.test(error)));

  const constraintOnly = workingCopy();
  const constraintRow = constraintOnly.rows.find(item => item.auditId === 'AUD-ANIM3-010');
  constraintRow.pdp0EvidenceRefs = ['.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-010'];
  assert.ok(errorsFor(constraintOnly, false).some(error => /AUD-ANIM3-010 must bind the exact gesture\/trigger map/.test(error)));
});

test('AUD-SIM3-018 requires JOB-AC-03 partial-result and authoritative finality semantics', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-SIM3-018');
  row.pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => !ref.includes('MEDIA-REQ-CAP-JOB-AC-03'));
  assert.ok(errorsFor(ledger, false).some(error => /AUD-SIM3-018 must bind partial-result and authoritative finality semantics/.test(error)));

  const oldMeaning = workingCopy();
  const oldMeaningRow = oldMeaning.rows.find(item => item.auditId === 'AUD-SIM3-018');
  oldMeaningRow.pdp0EvidenceRefs.push('.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-039');
  assert.ok(errorsFor(oldMeaning, false).some(error => /AUD-SIM3-018 must bind partial-result and authoritative finality semantics/.test(error)));
});

test('AUD-EDU3-012 requires the fail-closed compatibility boundary in AC-040', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-EDU3-012');
  row.pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => !ref.includes('MEDIA-DECL-P0-AC-040'));
  assert.ok(errorsFor(ledger, false).some(error => /AUD-EDU3-012 must bind AC-040 fail-closed compatibility boundaries/.test(error)));
});

test('the four reconciled audit rows cite their exact PXD-174 source review', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-ANIM3-010');
  row.decisionRef.path = '.product-experience/decision-log.md#PXD-172';
  assert.ok(errorsFor(ledger, false).some(error => /AUD-ANIM3-010 must cite the exact PXD-174 row-level source review reference/.test(error)));
});

test('later-phase handoff count projection must be derived from the 501 current row assignments', () => {
  const ledger = workingCopy();
  ledger.laterPhaseHandoffs.countsByPhase.UNSPECIFIED += 1;
  assert.ok(errorsFor(ledger).some(error => /laterPhaseHandoffs.countsByPhase must equal/.test(error)));
});

test('missing and duplicate IDs fail the complete source denominator', () => {
  const missing = workingCopy();
  missing.rows.pop();
  assert.ok(errorsFor(missing).some(error => /missing crosswalk row|exactly 501 unique/.test(error)));
  const duplicate = workingCopy();
  duplicate.rows[1].auditId = duplicate.rows[0].auditId;
  assert.ok(errorsFor(duplicate).some(error => /duplicate crosswalk auditId/.test(error)));
});

test('changed source text fails exact source round-trip', () => {
  const ledger = workingCopy();
  ledger.rows[0].sourceText += ' (invented alias)';
  assert.ok(errorsFor(ledger).some(error => /sourceText does not round-trip exactly/.test(error)));
});

test('BOUND_EXISTING without exact P0 evidence fails', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.disposition === 'BOUND_EXISTING');
  row.pdp0EvidenceRefs = [];
  assert.ok(errorsFor(ledger).some(error => new RegExp(`${row.auditId}: BOUND_EXISTING requires at least one`).test(error)));
});

test('invented audit aliases fail identity and source anchor validation', () => {
  const ledger = workingCopy();
  ledger.rows[0].auditId = 'AUD-FOCUS-SPEC-001';
  assert.ok(errorsFor(ledger).some(error => /invented or unexpected audit ID/.test(error)));
});

test('stale source fingerprints fail closed', () => {
  const ledger = workingCopy();
  const first = Object.keys(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256)[0];
  ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[first] = '0'.repeat(64);
  assert.ok(errorsFor(ledger).some(error => /stale source fingerprint/.test(error)));
});

test('a later-phase handoff cannot substitute for a PDP-0 evidence binding', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.disposition === 'BOUND_EXISTING');
  const formerEvidence = row.pdp0EvidenceRefs[0];
  row.pdp0EvidenceRefs = [];
  row.laterPhaseHandoffs = [{phase:'PDP-1', evidenceRefs:[formerEvidence]}];
  const errors = errorsFor(ledger);
  assert.ok(errors.some(error => new RegExp(`${row.auditId}: BOUND_EXISTING requires at least one`).test(error)));
});

test('AUD-OPS-007 binds the exact offline execution context selectors', () => {
  const row = workingCopy().rows.find(item => item.auditId === 'AUD-OPS-007');
  assert.ok(row, 'missing AUD-OPS-007');
  assert.equal(row.disposition, 'BOUND_EXISTING');
  assert.deepEqual(row.pdp0EvidenceRefs, [
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.capability.execution.compatibility',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-CAPABILITY',
  ]);
  assert.deepEqual(row.pdp0ContextRefs, [
    '.product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedDeploymentAvailabilityRules/@id=media.requirement.policy-and-admitted-deployment-availability.v1',
    '.product-experience/pdp-0-product-truth/profile-semantics.yaml#profileAxes/@id=PROFILE-AXIS-EXECUTION-LOCATION',
    '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#modelAcquisitionAndFallback/fallback/localOnly',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-07',
    '.product-experience/pdp-0-product-truth/information-architecture.yaml#/firstUseAndRecovery/offline',
    '.product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-23',
  ]);
});

test('AUD-OPS-021 and AUD-CLONE-006 bind source-complete coordinator-authored PDP-0 definitions', () => {
  const ledger = workingCopy();
  const extension = parseYaml(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/campaign-extensions.yaml'), 'utf8'));
  const proposalFields = ['capabilityDefinition', 'requirementDefinition', 'intentDefinition', 'channelApplicability'];
  const expectedSourceRows = {
    'AUD-OPS-021': {
      sourceText: 'Safe install/upgrade/migration and model removal',
      sourceAcceptanceText: 'Every provider/capability is qualified per machine, checkpoint and license; a failed or missing model does not become synthetic success or unauthorized cloud fallback.',
    },
    'AUD-CLONE-006': {
      sourceText: 'Synthetic voice design without human reference',
      sourceAcceptanceText: 'A revoked or expired voice grant is denied before inference; no cloning claim appears from Piper/synthetic placeholders and rights remain attached to every output.',
    },
  };

  assert.equal(ledger.rows.length, 501);
  assert.equal(new Set(ledger.rows.map(row => row.auditId)).size, 501);
  for (const [auditId, source] of Object.entries(expectedSourceRows)) {
    const row = ledger.rows.find(item => item.auditId === auditId);
    const proposal = extension.records.find(item => item.id === auditId);
    assert.ok(row, `missing ${auditId}`);
    assert.ok(proposal, `missing campaign extension ${auditId}`);
    assert.equal(row.sourceText, source.sourceText);
    assert.equal(row.sourceAcceptanceText, source.sourceAcceptanceText);
    assert.equal(row.disposition, 'BOUND_EXISTING');
    const proposalRoot = `.product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=${auditId}`;
    const proposalAcceptanceRefs = row.pdp0EvidenceRefs.filter(ref => ref.startsWith(`${proposalRoot}/requirementDefinition/acceptanceCases/@id=`));
    const declaredAcceptanceIds = new Set(proposal.requirementDefinition.acceptanceCases.map(item => item.id));
    assert.ok(proposalAcceptanceRefs.every(ref => declaredAcceptanceIds.has(ref.slice(ref.lastIndexOf('/@id=') + '/@id='.length))), `${auditId} acceptance refs resolve to its proposal`);
    if (auditId === 'AUD-OPS-021') {
      assert.deepEqual(proposalAcceptanceRefs, proposal.requirementDefinition.acceptanceCases.map(item => `${proposalRoot}/requirementDefinition/acceptanceCases/@id=${item.id}`));
    }
    const expectedEvidenceRefs = [...proposalFields.map(field => `${proposalRoot}/${field}`), ...proposalAcceptanceRefs];
    assert.deepEqual(row.pdp0EvidenceRefs, expectedEvidenceRefs, `${auditId} exact proposal and acceptance selectors`);
    assert.deepEqual(row.pdp0ContextRefs, auditId === 'AUD-OPS-021' ? [
      '.product-experience/pdp-0-product-truth/profile-semantics.yaml#boundedInvocationAdmission',
      '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#modelAcquisitionAndFallback/fallback',
      '.product-experience/pdp-0-product-truth/reuse-decisions.yaml#notAdmittedByThisRecord',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-07',
    ] : [
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-02',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-08',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-09',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-04',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-05',
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RIGHTS/acceptanceCases/@id=MEDIA-REQ-CAP-RIGHTS-AC-11',
      '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.speech.synthesis.speaker.clone-authorized',
    ]);
    assert.equal(row.ownerApproval, 'NOT_CLAIMED');
    assert.equal(row.definitionScopeBinding.ownerApproval, 'NOT_CLAIMED');
    assert.equal(row.definitionScopeBinding.runtimeAdmission, 'NOT_CLAIMED');
    assert.match(row.phaseLocalRationale, /coordinator-authored PDP-0 (?:definition )?proposal/u);
    assert.equal(proposal.capabilityDefinition.definitionState, 'COORDINATOR_AUTHORED_PDP0_PROPOSAL; owner acceptance pending');
    assert.equal(proposal.requirementDefinition.ownerAcceptance, 'NOT_CLAIMED');
    assert.equal(proposal.ownerApproval, 'NOT_CLAIMED');
    assert.equal(proposal.requirementDefinition.priority, 'pending-owner-disposition');
    assert.match(proposal.capabilityDefinition.priorityDisposition, /source audit does not assign product priority/u);
    assert.equal(proposal.implementationState, 'UNKNOWN');
    assert.equal(proposal.qualificationState, 'NOT_EVALUATED');
    assert.equal(proposal.runtimeAvailability, 'UNKNOWN');
    assert.equal(proposal.executionAdmission, 'NOT_ADMITTED');
    assert.equal(proposal.channelApplicability.records[0].ownerApproval, 'NOT_CLAIMED');
    assert.equal(proposal.channelApplicability.records[0].implementationState, 'UNKNOWN');
    assert.equal(proposal.channelApplicability.records[0].qualificationState, 'NOT_EVALUATED');
    assert.equal(proposal.channelApplicability.records[0].runtimeAvailability, 'UNKNOWN');
    assert.equal(proposal.channelApplicability.records[0].executionAdmission, 'NOT_ADMITTED');
  }

  const packageAction = ledger.rows.find(row => row.auditId === 'AUD-OPS-021');
  assert.ok(!packageAction.pdp0EvidenceRefs.some(ref => ref.includes('media.artifact.retain')));
  assert.deepEqual(packageAction.laterPhaseHandoffs.map(handoff => handoff.phase), ['PDP-1', 'PDP-3', 'DELIVER/OPERATE']);
  assert.match(packageAction.phaseLocalRationale, /package data\/version and migration contracts.*CLI journeys/u);
  assert.match(packageAction.phaseLocalRationale, /remain NOT_ADMITTED/u);
  const packageProposal = extension.records.find(item => item.id === 'AUD-OPS-021');
  assert.match(packageProposal.capabilityDefinition.constraints.join(' '), /machine\/checkpoint.*qualification/u);
  assert.equal(packageProposal.capabilityDefinition.adoptionDecision.selectedProvider, 'NONE');
  assert.equal(packageProposal.capabilityDefinition.adoptionDecision.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(packageProposal.requirementDefinition.acceptanceCases[2].given, /machine\/checkpoint qualification/u);

  const sourceFreeVoice = ledger.rows.find(row => row.auditId === 'AUD-CLONE-006');
  assert.ok(!sourceFreeVoice.pdp0EvidenceRefs.some(ref => ref.includes('media.speech.synthesis.control.emotion-style')));
  assert.equal(sourceFreeVoice.laterPhaseHandoffs.ownerPhase, 'PDP-1');
  assert.match(sourceFreeVoice.laterPhaseHandoffs.gap, /persistent profile identity, version, provenance, and rights-evidence contracts/u);
  assert.match(sourceFreeVoice.laterPhaseHandoffs.gap, /human-source cloning.*separately rights-governed/u);
  const voiceProposal = extension.records.find(item => item.id === 'AUD-CLONE-006');
  assert.match(voiceProposal.capabilityDefinition.preconditions.join(' '), /(?:blocks|stops) inference before it starts/u);
  assert.match(voiceProposal.capabilityDefinition.designSemantics.rightsOnEveryOutput, /Every profile, sample, or other generated output/u);
  assert.match(voiceProposal.capabilityDefinition.designSemantics.placeholderSemantics, /do not prove a real inference/u);
  assert.equal(voiceProposal.capabilityDefinition.adoptionDecision.selectedModelOrCheckpoint, 'NONE');
  assert.equal(voiceProposal.capabilityDefinition.acceptanceCases.length, 7);
  assert.equal(voiceProposal.requirementDefinition.acceptanceCases.length, 6);
  const voiceSurface = voiceProposal.channelApplicability.records[0].channelApplicability[0].surfaceResolution;
  assert.deepEqual(voiceSurface.physicalSurfaceRefs, ['media.physical.libs-audio-video-ui']);
  assert.deepEqual(new Set(voiceSurface.compositeSurfaceRefs), new Set([
    'media.composition.repository-root',
    'media.composition.client-and-machine-interfaces',
    'media.composition.creation-composition-and-delivery',
  ]));
  assert.equal(voiceSurface.physicalAndCompositeApplicability, 'RESOLVED_BY_EXPLICIT_PDP0_SCOPE_DEFINITION');
  const targetErrors = errorsFor(ledger, false).filter(error => /AUD-(?:OPS-021|CLONE-006)/u.test(error));
  assert.deepEqual(targetErrors, []);
});
