import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareQualityExtensionSourceCandidateV2} from '../scripts/lib/media-pdp0-quality-extension-source-candidate-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const refs = {
  v7Log: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-decision-log-postimage.v6.md',
  v7Manifest: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json',
  quality: '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  qualityPostimage: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-policy-extension-postimage.v1.yaml',
};
const read = ref => fs.readFileSync(path.join(root, ref));
const qualityReadback = JSON.parse(read('docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-quality2target-actual-root-source-readback-2026-10-23.json'));
const qualityPreimageRef = qualityReadback.result.targets.find(row => row.targetRef === refs.quality).immutablePreimageRef;
const fixtureRead = ref => ref === refs.quality ? read(qualityPreimageRef) : read(ref);
const prepareFixture = override => prepareQualityExtensionSourceCandidateV2({readSource: ref => override?.(ref) ?? fixtureRead(ref)});

test('v2 source candidate proposes exact PXD-227 plus quality policy as an ordered two-target successor', () => {
  const result = prepareFixture();
  const {candidate} = result;
  assert.deepEqual(candidate.targetOrder, ['.product-experience/decision-log.md', refs.quality]);
  assert.deepEqual(candidate.targets.map(row => row.targetRef), candidate.targetOrder);
  assert.equal(candidate.targets[0].preimageSha256, sha(result.v7DecisionLogBytes));
  assert.equal(candidate.targets[1].preimageSha256, sha(result.qualityBaselineBytes));
  assert.equal(candidate.targets[1].postimageSha256, sha(result.qualityPostimageBytes));
  assert.notEqual(sha(result.qualityV1PostimageBytes), candidate.targets[1].postimageSha256);
  assert.match(result.qualityPostimageBytes.toString('utf8'), /status: SOURCE_OWNER_DEFINED_NOT_YET_CURRENT/u);
  assert.match(result.decisionLogPostimageBytes.toString('utf8'), /^### PXD-227/mu);
  assert.match(result.decisionLogPostimageBytes.toString('utf8'), /supersedes only PXD-226's statement that quality applicability is unknown/u);
  assert.match(result.decisionLogPostimageBytes.toString('utf8'), /462 existing owner-quality rows byte-for-byte and in order/u);
  assert.equal((result.decisionLogPostimageBytes.toString('utf8').match(/^### PXD-226\b/gmu) ?? []).length, 1);
  assert.equal(candidate.predecessor.predecessorQualityUnknownPreservedInV7, true);
  assert.equal(candidate.population.historicalRowsPreserved, 462);
  assert.equal(candidate.population.currentRows, 463);
  assert.equal(candidate.population.futureExtensionRows, 6);
  assert.equal(candidate.effects.canonicalApply, 'NOT_PERFORMED');
});

test('v2 candidate output validates against its exact JSON schema', () => {
  const result = prepareFixture();
  const Ajv2020 = require('ajv/dist/2020');
  const validate = new Ajv2020({strict:true}).compile(result.schema);
  assert.equal(validate(result.candidate), true);
  const corrupted = structuredClone(result.candidate);
  corrupted.targets.pop();
  assert.equal(validate(corrupted), false);
});

test('V7 decision-log input is a hard predecessor; no amendment overwrites or duplicate PXD-227', () => {
  const original = prepareFixture();
  assert.throws(() => prepareFixture(ref => ref === refs.v7Log
    ? Buffer.from('not the exact V7 decision-log postimage') : undefined), /exact V7 decision-log postimage/u);
  const duplicateSection = Buffer.concat([original.v7DecisionLogBytes, Buffer.from('\n\n### PXD-227 — existing\n')]);
  assert.throws(() => prepareFixture(ref => ref === refs.v7Log ? duplicateSection : undefined), /exact V7 decision-log postimage/u);
});

test('quality preimage drift and altered peer/source pins fail closed', () => {
  assert.throws(() => prepareFixture(ref => ref === refs.quality
    ? Buffer.from('changed quality source') : undefined), /quality extension preimage\/postimage differs/u);
  const peerRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json';
  assert.throws(() => prepareFixture(ref => ref === peerRef ? Buffer.from('{}') : undefined), /corrected independent peer record/u);
});

