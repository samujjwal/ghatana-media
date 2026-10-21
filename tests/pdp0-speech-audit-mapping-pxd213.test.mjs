import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {currentPdp0PhaseScopedSourceFingerprints} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const {parse} = require('yaml');
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const decisionPath = '.product-experience/decision-log.md';
const read = file => fs.readFileSync(path.join(root, file));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function resolve(ref) {
  const [file, fragment = ''] = ref.split('#', 2);
  const raw = read(file).toString('utf8');
  let value = /\.ya?ml$/iu.test(file) ? parse(raw) : JSON.parse(raw);
  for (const token of fragment.replace(/^\//u, '').split('/').filter(Boolean)) {
    const selector = token.match(/^@([^=]+)=(.*)$/u);
    if (selector) {
      assert.ok(Array.isArray(value), `${ref}: ${token} selects an array`);
      value = value.find(entry => String(entry[selector[1]]) === selector[2]);
    } else if (/^\d+$/u.test(token) && Array.isArray(value)) {
      value = value[Number(token)];
    } else {
      value = value?.[token];
    }
    assert.notEqual(value, undefined, `${ref}: ${token} resolves`);
  }
  return value;
}

const cap = id => `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`;
const ac = (family, id) => `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${family}/acceptanceCases/@id=${family}-${id}`;
const decisionRef = `${decisionPath}#PXD-213`;

test('PXD-213 speech and dubbing joins remain exact historical row decisions under current PXD-216 review', () => {
  const ledger = JSON.parse(read(crosswalkPath).toString('utf8'));
  const rows = new Map(ledger.rows.map(row => [row.auditId, row]));
  const expected = new Map([
    ['AUD-TTS-012', [
      cap('media.speech.synthesis.text-to-speech'),
      cap('media.speech.synthesis.speaker.condition'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-02'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-07'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-08'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-09'),
    ]],
    ['AUD-TTS-014', [
      cap('media.speech.synthesis.speaker.condition'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-02'),
      '.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/intents/@id=media.intent.create',
      '.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/outcomes/@id=media.goal.finished-asset',
      '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-speech-synthesis-speaker-condition.v1',
    ]],
    ['AUD-DUB-003', [
      cap('media.speech.synthesis.dub'),
      cap('media.speech.synthesis.speaker.condition'),
      '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS',
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-02'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-08'),
      ac('MEDIA-REQ-CAP-SPEECH-SYNTHESIS', 'AC-09'),
      ac('MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION', 'AC-06'),
      '.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/intents/@id=media.intent.create',
      '.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/outcomes/@id=media.goal.finished-asset',
      '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-speech-synthesis-speaker-condition.v1',
    ]],
  ]);
  assert.equal(ledger.rows.length, 501);
  assert.deepEqual(ledger.dispositionCounts, {BOUND_EXISTING: 499, PDP0_MEANING_CHANGE_REQUIRED: 0, EXPLICIT_NOT_APPLICABLE: 0, POST_PDP_IMPLEMENTATION_ONLY: 2, BLOCKED_EXTERNAL_OWNER_DECISION: 0});
  assert.equal(ledger.coordinatorReview.decisionRef, 'PXD-216');
  assert.equal(ledger.coordinatorReview.priorDecisionRef, 'PXD-215');
  assert.equal(ledger.coordinatorReview.ownerApproval, 'NOT_CLAIMED');
  const historicalPxd213 = ledger.coordinatorReview.reviewHistory.find(review => review.decisionRef === 'PXD-213');
  assert.ok(historicalPxd213, 'PXD-213 remains in source review history');
  assert.equal(historicalPxd213.priorDecisionRef, 'PXD-212');
  const pins = currentPdp0PhaseScopedSourceFingerprints('PXD-216');
  assert.deepEqual(ledger.coordinatorReview.sourceFingerprints, pins);
  assert.deepEqual(ledger.sourceBaseline.phaseScopedSourceFingerprintsSha256, pins);
  assert.deepEqual(ledger.coordinatorReview.phaseScopedSourceFingerprintsSha256, pins);
  assert.equal(ledger.sourceBaseline.phaseScopedSourceFingerprintsSha256[`${decisionPath}#PXD-216-section`], pins[`${decisionPath}#PXD-216-section`]);
  for (const [auditId, refs] of expected) {
    const row = rows.get(auditId);
    assert.ok(row, `${auditId} exists in the full denominator`);
    assert.equal(row.currentSuccessorDecisionRef, decisionRef);
    assert.equal(row.pdp0AcceptanceCoverage.decisionRef, decisionRef);
    assert.deepEqual(row.pdp0EvidenceRefs, refs, `${auditId} selector set is exact`);
    for (const ref of refs) assert.ok(resolve(ref), `${auditId} source selector resolves: ${ref}`);
    assert.equal(row.ownerApproval, 'NOT_CLAIMED');
    assert.equal(row.pdp0AcceptanceCoverage.sourceAcceptanceText, row.sourceAcceptanceText);
  }
  const tts012 = rows.get('AUD-TTS-012');
  assert.match(tts012.phaseLocalRationale, /AC-08/u);
  assert.match(tts012.phaseLocalRationale, /AC-09/u);
  assert.match(tts012.phaseLocalRationale, /does not claim perceptual distinction/u);
  assert.match(tts012.pdp0AcceptanceCoverage.uncoveredClauseDisposition, /does not establish perceptual distinction/u);
  assert.ok(tts012.laterPhaseHandoffs.some(item => item.ownerPhase === 'BUILD/qualification'));
  const tts014 = rows.get('AUD-TTS-014');
  assert.match(tts014.phaseLocalRationale, /Locale-specific casting rules.*PDP-1/u);
  assert.equal(tts014.laterPhaseHandoffs.ownerPhase, 'PDP-1');
  const dub003 = rows.get('AUD-DUB-003');
  assert.match(dub003.phaseLocalRationale, /AC-06.*does not establish exported audio\/video synchronization/u);
  const dubQualification = dub003.laterPhaseHandoffs.find(item => item.ownerPhase === 'BUILD/qualification');
  assert.ok(dubQualification);
  assert.match(dubQualification.gap, /After PDP-1 defines measurable synchronization criteria and identity-control semantics.*PDP-2\/PDP-3 define their interface and journey review/u);
  assert.match(dubQualification.gap, /current PDP-0 references are not a verification oracle/u);
  assert.match(dub003.pdp0AcceptanceCoverage.uncoveredClauseDisposition, /does not establish audio\/video export synchronization/u);
  const decisionLog = read(decisionPath).toString('utf8');
  assert.match(decisionLog, /### PXD-213 — Restore exact speech and dubbing audit joins/u);
  assert.match(decisionLog, /No audible distinction, successful synchronization/u);
});

test('current PXD-216 crosswalk source baseline retains the PXD-213 audit test and source inputs', () => {
  const ledger = JSON.parse(read(crosswalkPath).toString('utf8'));
  const pins = ledger.sourceBaseline.workingTreeSourceFingerprintsSha256;
  assert.equal(pins['tests/pdp0-speech-audit-mapping-pxd213.test.mjs'], sha(read('tests/pdp0-speech-audit-mapping-pxd213.test.mjs')));
  assert.equal(pins['tests/media-pdp0-501-audit-dispositions.test.mjs'], sha(read('tests/media-pdp0-501-audit-dispositions.test.mjs')));
  assert.equal(pins['tests/pdp0-current-semantic-route-successor-pxd211.test.mjs'], sha(read('tests/pdp0-current-semantic-route-successor-pxd211.test.mjs')));
});
