import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {fingerprint, fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const {parse} = require('yaml');
const artifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-semantic-route-successor-pxd211.json';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const aqPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.join(root, file));
const parsedSources = new Map();

function resolveTarget(ref) {
  const [file, fragment = ''] = ref.split('#', 2);
  if (!parsedSources.has(file)) parsedSources.set(file, parse(read(file).toString('utf8')));
  let value = parsedSources.get(file);
  const segments = fragment.replace(/^\//u, '').split('/').filter(Boolean);
  for (const segment of segments) {
    const selector = segment.match(/^@([^=]+)=(.*)$/u);
    if (selector) {
      assert.ok(Array.isArray(value), `${ref}: selector ${segment} must select an array`);
      value = value.find(entry => String(entry[selector[1]]) === selector[2]);
      assert.ok(value, `${ref}: selector ${segment} resolves`);
    } else if (/^\d+$/u.test(segment) && Array.isArray(value)) {
      value = value[Number(segment)];
    } else {
      value = value?.[segment];
    }
    assert.notEqual(value, undefined, `${ref}: segment ${segment} resolves`);
  }
  return value;
}

test('PXD-211 retains its recorded PDP-0 source cut as immutable historical evidence', () => {
  const artifact = JSON.parse(read(artifactPath).toString('utf8'));
  const decisionLog = read('.product-experience/decision-log.md').toString('utf8');
  assert.equal(artifact.schemaVersion, 'media.pdp0.current-semantic-route-successor.v1');
  assert.equal(artifact.decisionRef, '.product-experience/decision-log.md#PXD-211');
  assert.equal(artifact.denominators.auditRows, 501);
  assert.equal(artifact.denominators.changedAuditRows, 29);
  assert.equal(artifact.currentSourcePinsStatus, 'CURRENT_SOURCE_PINS_VERIFIED_NO_ACCEPTANCE_EFFECT');
  assert.equal(artifact.denominators.changedClaimRoutes, 3);
  assert.ok(Object.keys(artifact.sourceFingerprints).length > 0);
  assert.deepEqual(artifact.sourceFingerprints['.product-experience/decision-log.md#PXD-211-section'], fingerprintPxdDecisionSection(decisionLog, 'PXD-211'));
  for (const [sourcePath, sourceSha] of Object.entries(artifact.sourceFingerprints)) {
    if (sourcePath.endsWith('-section')) continue;
    assert.match(sourceSha, /^[a-f0-9]{64}$/u, `${sourcePath} immutable historical source fingerprint`);
  }
  assert.equal(artifact.authority.phaseScope, 'PDP-0');
  for (const key of ['ownerApproval', 'independentAcceptance', 'implementation', 'qualification', 'closure', 'delivery']) {
    assert.match(artifact.authority[key], /NOT_|none/u, `${key} is not claimed`);
  }
  assert.equal(artifact.authority.acceptanceEffect, 'none');
});

test('PXD-211 migration successor routes resolve exact current selectors and preserve old route evidence', () => {
  const artifact = JSON.parse(read(artifactPath).toString('utf8'));
  const successor = parse(read('.product-experience/pdp-0-product-truth/migration-semantics-review.yaml').toString('utf8'))
    .pdp38ClaimReconciliation.pxd211CurrentRouteSuccessors;
  const review = successor.records;
  assert.equal(successor.decisionRef, '.product-experience/decision-log.md#PXD-211');
  const migrationReview = parse(read('.product-experience/pdp-0-product-truth/migration-semantics-review.yaml').toString('utf8'));
  const overlayClaim = migrationReview.pdp38ClaimReconciliation.records.flatMap(item => item.claims ?? [])
    .flatMap(claim => claim.disposition === 'DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS' ? claim.subclaims : [claim])
    .find(claim => claim.claimId === 'MPSEM-0172-C002');
  const claimRecords = artifact.records.filter(row => row.claimId);
  assert.equal(claimRecords.length, 3);
  const expected = new Map([
    ['MPSEM-0172-C002', '.product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedCapabilityNamingRules/@id=media.requirement.capability-identities-name-media-semantics.v1'],
    ['MPSEM-0278-C001', '.product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/6'],
    ['MPSEM-0311-C004', '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.job.submit/ownerDefinition/idempotencyExpiryContract'],
  ]);
  for (const record of claimRecords) {
    const route = expected.get(record.claimId);
    assert.ok(route, `${record.claimId} is in the bounded successor`);
    assert.equal(record.current.targetRef ?? record.current.pdp0TargetRef, route);
    const value = resolveTarget(route);
    assert.ok(value, `${record.claimId} current target resolves`);
    assert.match(record.current.targetValueSha256 ?? record.current.pdp0TargetSha256, /^[a-f0-9]{64}$/u,
      `${record.claimId} retains its exact PXD-211 selector projection fingerprint`);
    const yamlRecord = review.find(row => row.claimId === record.claimId);
    assert.ok(yamlRecord, `${record.claimId} migration route record`);
    assert.equal(yamlRecord.targetRef, route);
    assert.equal(yamlRecord.targetRef, route);
    assert.ok(yamlRecord.historicalTargetRef || yamlRecord.historicalRouteRef, `${record.claimId} historical locator retained`);
  }
  const c002 = review.find(row => row.claimId === 'MPSEM-0172-C002');
  assert.equal(overlayClaim.targetRef, c002.targetRef, 'active claim row follows the PXD-211 current route');
  assert.equal(overlayClaim.currentRouteSuccessorRef,
    '.product-experience/pdp-0-product-truth/migration-semantics-review.yaml#/pdp38ClaimReconciliation/pxd211CurrentRouteSuccessors/records/@claimId=MPSEM-0172-C002');
  assert.equal(c002.semanticReview, 'COORDINATOR_SOURCE_ROUTE_REVIEW');
  assert.equal(c002.historicalTargetRef, artifact.records.find(row => row.claimId === 'MPSEM-0172-C002').predecessor.historicalTargetRef);
  assert.match(c002.historicalTargetValueSha256, /^[a-f0-9]{64}$/u, 'latest historical source observation pin is retained');
  assert.match(artifact.records.find(row => row.claimId === 'MPSEM-0172-C002').predecessor.historicalTargetValueSha256,
    /^[a-f0-9]{64}$/u, 'original former-outcome value pin is retained');
  assert.equal(artifact.records.find(row => row.claimId === 'MPSEM-0172-C002').predecessor.pxd210SelectedTargetSha256,
    '294d3ce2a0f3510eb38a7e4811e50ee7a4546199dcd6f86feaffc6b574406c51');
  assert.deepEqual(c002.coveredFields, ['semanticIdentity', 'separation', 'aliasing']);
  const c001 = review.find(row => row.claimId === 'MPSEM-0278-C001');
  assert.match(c001.historicalTargetRef, /decisionRules\/5$/u);
  const c004 = review.find(row => row.claimId === 'MPSEM-0311-C004');
  assert.match(c004.pdp1HandoffRequirement, /duration and storage, lookup, and expiry/u);
  assert.match(c004.artifactExpiryMeaningRemainsSeparate, /states\/@id=EXPIRED\/meaning$/u);
  assert.equal(c004.ownerApproval, 'NOT_CLAIMED');
});

test('PXD-211 audit successors remain an immutable historical cut while later source rows retain exact text', () => {
  const artifact = JSON.parse(read(artifactPath).toString('utf8'));
  const crosswalk = JSON.parse(read(crosswalkPath).toString('utf8'));
  const aq = JSON.parse(read(aqPath).toString('utf8'));
  const source = JSON.parse(read('docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json').toString('utf8'));
  const originalRows = new Map([...source.originalAudit.inventory.map(row => [row.audit_id, {text: row.capability, acceptance: row.acceptance_family}]), ...source.thirdPassAdditions.map(row => [row.audit_id, {text: row.capability, acceptance: row.acceptance}])]);
  const rows = new Map(crosswalk.rows.map(row => [row.auditId, row]));
  const expected = new Map([
    ['AUD-ASSET-003', ['media.project.organize', 'MEDIA-REQ-CAP-PROJECT-AC-05']],
    ['AUD-ASSET-004', ['media.artifact.search', 'MEDIA-REQ-CAP-ARTIFACT-AC-06']],
    ['AUD-ASSET-006', ['media.project.organize', 'MEDIA-REQ-CAP-PROJECT-AC-06']],
    ['AUD-ASSET-012', ['media.artifact.import', 'MEDIA-REQ-CAP-ARTIFACT-AC-08', 'media.deliver.subtitles', 'MEDIA-REQ-CAP-DELIVER-AC-04']],
    ['AUD-TTS-012', ['media.speech.synthesis.text-to-speech', 'MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-07']],
    ['AUD-TTS-021', ['media.master.audio.creative-effect.apply', 'MEDIA-REQ-CAP-MASTER-AUDIO-AC-04']],
    ['AUD-DSP-003', ['media.compose.multitrack-timeline', 'MEDIA-REQ-CAP-COMPOSE-AC-04', 'MEDIA-REQ-CAP-MASTER-AUDIO-AC-03']],
    ['AUD-DSP-014', ['media.compose.multitrack-timeline', 'MEDIA-REQ-CAP-COMPOSE-AC-05']],
    ['AUD-DSP-016', ['media.master.audio.stereo-width', 'MEDIA-REQ-CAP-MASTER-AUDIO-AC-05']],
    ['AUD-DSP-018', ['media.stream.recording.integrate', 'MEDIA-REQ-CAP-STREAM-AC-04', 'MEDIA-REQ-CAP-COMPOSE-AC-08']],
    ['AUD-MUSIC-003', ['media.audio.analysis.detect.beat-onset', 'MEDIA-REQ-CAP-AUDIO-ANALYSIS-AC-03']],
    ['AUD-VISION-006', ['media.compose.safe-area', 'MEDIA-REQ-CAP-COMPOSE-AC-06']],
    ['AUD-VISION-013', ['media.artifact.search', 'MEDIA-REQ-CAP-ARTIFACT-AC-07']],
    ['AUD-VISION-017', ['media.quality.rank', 'MEDIA-REQ-CAP-QUALITY-AC-10']],
    ['AUD-MOTION-007', ['media.compose.reusable-composition', 'MEDIA-REQ-CAP-COMPOSE-AC-07']],
    ['AUD-MOTION-008', ['media.animation.material', 'MEDIA-REQ-CAP-ANIMATION-AC-04']],
    ['AUD-DIRECT-005', ['media.artifact.search', 'MEDIA-REQ-CAP-ARTIFACT-AC-09']],
    ['AUD-DIRECT-017', ['media.quality.rank', 'MEDIA-REQ-CAP-QUALITY-AC-11']],
    ['AUD-SOCIAL-006', ['media.quality.rank', 'MEDIA-REQ-CAP-QUALITY-AC-10', 'MEDIA-REQ-CAP-ARTIFACT-AC-09']],
    ['AUD-SOCIAL-009', ['media.multimodal.describe', 'media.multimodal.summarize', 'MEDIA-REQ-CAP-MULTIMODAL-AC-03']],
    ['AUD-EDIT-013', ['media.edit.retime-slow-motion-speed-ramp', 'MEDIA-REQ-CAP-EDIT-AC-03']],
    ['AUD-GEN-014', ['media.generate.video.text-to-video', 'media.generate.audio.text-to-audio', 'MEDIA-REQ-CAP-GENERATE-VIDEO-AC-08', 'MEDIA-REQ-CAP-RIGHTS-AC-08']],
    ['AUD-GEN-015', ['AUD-GEN-015', 'MEDIA-REQ-CAP-GENERATE-VIDEO-AC-09', 'MEDIA-REQ-CAP-RIGHTS-AC-08', 'MEDIA-REQ-CAP-RIGHTS-AC-04']],
    ['AUD-GEN-026', ['media.generate.video.video-to-video', 'MEDIA-REQ-CAP-GENERATE-VIDEO-AC-07', 'MEDIA-REQ-CAP-RIGHTS-AC-04']],
    ['AUD-GEN-028', ['media.generate.video.shot-condition', 'MEDIA-REQ-CAP-GENERATE-VIDEO-AC-06']],
    ['AUD-CAP-026', ['media.quality.video.video.assess-frame-artifacts', 'MEDIA-REC-P0-AC-046', 'time-units-fidelity.yaml#conversionRequirements']],
    ['AUD-VISION-016', ['media.vision.estimate.face-landmarks', 'MEDIA-REQ-CAP-RIGHTS-AC-06']],
    ['AUD-INTER-008', ['media.deliver.transcripts', 'MEDIA-REQ-CAP-DELIVER-AC-04', 'media.multimodal.summarize', 'MEDIA-REQ-CAP-MULTIMODAL-AC-03']],
    ['AUD-CROSS3-003', ['media.channel.agent', 'media.surface.agent-tools', 'media.project.composition.update']],
  ]);
  assert.equal(crosswalk.rows.length, 501);
  assert.equal(aq.denominators.sourceAuditRows, 501);
  const auditRecords = artifact.records.filter(row => row.auditId);
  assert.equal(auditRecords.length, 29);
  for (const [auditId, needles] of expected) {
    const row = rows.get(auditId);
    const record = auditRecords.find(item => item.auditId === auditId);
    assert.ok(row && record, `${auditId} crosswalk and successor rows exist`);
    const original = originalRows.get(auditId);
    assert.ok(original, `${auditId} source exists`);
    assert.equal(row.sourceText, original.text, `${auditId} source text is verbatim`);
    assert.equal(row.sourceAcceptanceText, original.acceptance, `${auditId} acceptance provenance is verbatim`);
    assert.equal(record.sourceText, row.sourceText);
    assert.equal(record.sourceAcceptanceText, row.sourceAcceptanceText);
    assert.equal(record.sourceAcceptanceTextSha256, sha(Buffer.from(row.sourceAcceptanceText)));
    assert.deepEqual(record.predecessor.evidenceRefs, row.historicalPxd210EvidenceRefs, `${auditId} historical refs retained`);
    assert.equal(record.predecessor.phaseLocalRationale, row.historicalPxd210PhaseLocalRationale, `${auditId} historical rationale retained`);
    if (auditId === 'AUD-TTS-012') {
      assert.deepEqual(record.current.evidenceRefs, [
        '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.speech.synthesis.text-to-speech',
        '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-07',
      ], 'PXD-211 current evidence remains available as historical evidence');
      assert.equal(row.currentSuccessorDecisionRef, '.product-experience/decision-log.md#PXD-213');
      assert.equal(row.pdp0AcceptanceCoverage.decisionRef, '.product-experience/decision-log.md#PXD-213');
    } else {
      assert.deepEqual(record.current.evidenceRefs, row.pdp0EvidenceRefs, `${auditId} current evidence refs`);
      assert.equal(row.currentSuccessorDecisionRef, '.product-experience/decision-log.md#PXD-211');
      assert.equal(row.pdp0AcceptanceCoverage.decisionRef, '.product-experience/decision-log.md#PXD-211');
    }
    for (const needle of needles) assert.ok(record.current.evidenceRefs.some(ref => ref.includes(needle)), `${auditId} PXD-211 evidence binds ${needle}`);
    assert.equal(row.pdp0AcceptanceCoverage.sourceAcceptanceText, row.sourceAcceptanceText);
    assert.equal(record.current.sourceAcceptanceTextPreservedVerbatim, true);
    assert.equal(row.ownerApproval, 'NOT_CLAIMED');
    assert.equal(record.status, 'CURRENT_SOURCE_PINS_VERIFIED_NO_ACCEPTANCE_EFFECT');
    assert.ok(record.current.targetProjections.every(({targetRef, targetValueSha256}) =>
      record.current.evidenceRefs.includes(targetRef) && /^[a-f0-9]{64}$/u.test(targetValueSha256)),
    `${auditId} preserves exact PXD-211 target projections as history`);
    for (const ref of row.pdp0EvidenceRefs) assert.ok(resolveTarget(ref), `${auditId} exact evidence selector resolves: ${ref}`);
  }
  assert.match(artifact.sourceFingerprints[crosswalkPath], /^[a-f0-9]{64}$/u, 'PXD-211 retains its historical crosswalk pin');
  assert.match(artifact.sourceFingerprints[aqPath], /^[a-f0-9]{64}$/u, 'PXD-211 retains its historical AQ pin');
  assert.match(aq.sourceBaseline.inputs[crosswalkPath], /^[a-f0-9]{64}$/u, 'AQ retains its historical crosswalk pin');
  assert.equal(aq.rows.length, 501);
});
