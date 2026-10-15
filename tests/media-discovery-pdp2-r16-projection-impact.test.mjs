import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const impactPath = 'docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json';
const receiptPath = 'docs/implementation/observations/media-discovery-pdp2-exit-r16.json';
const projectionPath = '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json';
const designLanguagePath = '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md';
const sha256 = (relativePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('PDP-2 R16 projection impact is exact, source-bound, and keeps all authority boundaries closed', () => {
  const impact = readJson(impactPath);
  const r16 = readJson(receiptPath);

  assert.equal(impact.schemaVersion, 'media.discovery-pdp2-projection-impact.v1');
  assert.equal(impact.recordId, 'MEDIA-DISCOVERY-PDP2-R16-PROJECTION-IMPACT-2026-10-14-R1');
  assert.equal(impact.campaign.stage, 'DISCOVERY');
  assert.equal(impact.campaign.phase, 'PDP-2');

  assert.equal(r16.observationId, 'MEDIA-PDP2-CURRENTNESS-R16');
  assert.equal(impact.predecessor.observationRef, receiptPath);
  assert.equal(impact.predecessor.observationId, r16.observationId);
  assert.equal(impact.predecessor.receiptSha256, 'sha256:b4f02281caad96c2de36c66138d500a7d4ab3d0faebeb5b07f6600e414e42f84');
  assert.equal(sha256(receiptPath), impact.predecessor.receiptSha256);

  assert.equal(impact.sourceDeltas.length, 1);
  const [projection] = impact.sourceDeltas;
  assert.equal(projection.path, projectionPath);
  assert.equal(projection.predecessorSha256, 'sha256:612760df546543582d5b6a867e3086bc6f1b21c5ba745367fbe3dd88b27f0979');
  assert.equal(projection.observedSha256, 'sha256:e7c3f762eb95d3ea6e5111fe24266406010de05abb20f05b6e310f2b9a80bd4c');
  assert.equal(sha256(projectionPath), projection.observedSha256);
  assert.equal(projection.classification, 'PDP2_GENERATED_PROJECTION_REFRESH_NO_MEANING_CHANGE');
  assert.equal(projection.meaningChange, 'NO_PDP2_MEANING_CHANGE');
  assert.deepEqual(projection.meaningIdsChanged, []);
  assert.equal(projection.requiresFreshCurrentness, true);

  assert.deepEqual(impact.reviewedInputs, [{
    path: designLanguagePath,
    sha256: 'sha256:76287b8d49b3aff679b1d5cf4b26352544bfdc9eee5a7dee86d75f14f7d59753',
    status: 'UNCHANGED',
    selector: 'PDP-2 design-language input to the generated experience-language candidate',
  }]);
  assert.equal(sha256(designLanguagePath), impact.reviewedInputs[0].sha256);
  assert.equal(impact.decision.pdp2MeaningDisposition, 'NO_PDP2_MEANING_CHANGE');
  assert.equal(impact.decision.requiresFreshCurrentness, true);

  assert.equal(impact.authority.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(impact.authority.independentReview, 'NOT_CLAIMED');
  assert.equal(impact.decision.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(impact.decision.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(impact.decision.nativeLifecycleClosure, 'NOT_ENTERED');
  assert.equal(impact.decision.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(impact.decision.delivery, 'BLOCKED');
  assert.equal(impact.decision.release, 'NOT_AUTHORIZED');
  assert.equal(impact.authority.nativeLifecycleReceiptProvided, false);
});
