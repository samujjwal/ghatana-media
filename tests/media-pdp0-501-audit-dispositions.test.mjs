import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {validatePdp0AuditDispositions} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
function workingCopy() {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  // Mutations test validation behavior against the exact present checkout. This does not write the ledger.
  for (const file of Object.keys(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256)) {
    ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
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

test('current crosswalk source pins and qualified scientific claim handoff validate without refreshing the ledger in memory', () => {
  const result = validatePdp0AuditDispositions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.total, 501);
  assert.equal(result.stats.dispositionCounts.BLOCKED_EXTERNAL_OWNER_DECISION, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  const decisionLog = '.product-experience/decision-log.md';
  const currentPin = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, decisionLog))).digest('hex');
  assert.equal(ledger.coordinatorReview.decisionRef, 'PXD-191');
  assert.equal(ledger.coordinatorReview.priorDecisionRef, 'PXD-190');
  assert.equal(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[decisionLog], currentPin);
  assert.equal(ledger.coordinatorReview.ownerApproval, 'NOT_CLAIMED');
  const historical = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-186');
  assert.equal(historical.priorDecisionRef, 'PXD-185');
  assert.equal(historical.sourceFingerprints[decisionLog], '7553a5002c6de27fe160ae584996c7fd983422399703999409e75960485f547e');
  const previousCurrent = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-190');
  assert.equal(previousCurrent.priorDecisionRef, 'PXD-186');
  assert.equal(previousCurrent.sourceFingerprints[decisionLog], '4c91f4058b9848c6fda562a35d76f5d687bd060ff671299f8377aae668f81eea');
  assert.match(ledger.coordinatorReview.note, /PXD-190, PXD-189, PXD-188 and earlier decisions and source pins remain historical/iu);
  assert.match(ledger.coordinatorReview.note, /all row dispositions, meaning, denominator, owner-scope proposals, and phase handoffs remain unchanged/iu);
  assert.match(ledger.coordinatorReview.note, /owner.*NOT_CLAIMED|No owner.*claimed/iu);
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
