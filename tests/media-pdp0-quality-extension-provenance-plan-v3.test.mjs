import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {planQualityExtensionProvenanceV3} from '../scripts/lib/media-pdp0-quality-extension-provenance-plan-v3.mjs';
import {planQualityExtensionSourceAdoptionV2} from '../scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const baseRead = ref => ref.startsWith('ghatana-lifecycle:')
  ? fs.readFileSync(path.resolve(root, '..', 'ghatana-lifecycle', ref.slice('ghatana-lifecycle:'.length)))
  : read(ref);

test('quality provenance planner rejects the prior peer proof after the isolated fixture repair changes its pinned test bytes', () => {
  assert.throws(() => planQualityExtensionProvenanceV3(),
    /does not bind the current adapter and focused test bytes/u);
});

test('quality provenance planner fails closed when current adapter bytes drift from the reviewed successor', () => {
  const changed = new Map([['scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs', Buffer.from('changed adapter')]]);
  assert.throws(() => planQualityExtensionProvenanceV3({readSource: ref => changed.get(ref) ?? baseRead(ref)}),
    /does not bind the current adapter and focused test bytes/u);
});

test('quality provenance planner fails closed when either exact postimage is missing or altered', () => {
  const successor = JSON.parse(read('docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v3.json'));
  const changed = new Map([[successor.targetPostimages[0].postimageRef, Buffer.from('changed postimage')]]);
  assert.throws(() => planQualityExtensionProvenanceV3({readSource: ref => changed.get(ref) ?? baseRead(ref)}), /candidate postimage is stale/u);
});

test('quality provenance planner rejects a modified v1 freeze rather than treating it as current history', () => {
  const freezeRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json';
  const changed = new Map([[freezeRef, Buffer.from(JSON.stringify({schemaVersion:'tampered'}))]]);
  assert.throws(() => planQualityExtensionProvenanceV3({readSource: ref => changed.get(ref) ?? baseRead(ref)}),
    /does not bind the immutable predecessor freeze/u);
});

test('isolated pre-apply fixture reports absent owner decision and authorization without reading live authority', () => {
  const qualityReadback = JSON.parse(read('docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-quality2target-actual-root-source-readback-2026-10-23.json'));
  const qualityPolicyPreimage = qualityReadback.result.targets.find(row => row.targetRef === '.product-experience/pdp-0-product-truth/quality-policy.yaml').immutablePreimageRef;
  const fixtureOverrides = new Map([
    ['.product-experience/decision-log.md', read('docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-decision-log-postimage.v6.md')],
    ['.product-experience/pdp-0-product-truth/quality-policy.yaml', read(qualityPolicyPreimage)],
  ]);
  const absentAuthority = new Set([
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-apply-authorization.v2.json',
  ]);
  const readFixtureSource = ref => {
    if (absentAuthority.has(ref)) {
      const error = new Error(`isolated fixture authority record absent: ${ref}`);
      error.code = 'ENOENT';
      throw error;
    }
    return fixtureOverrides.get(ref) ?? baseRead(ref);
  };
  const {plan} = planQualityExtensionSourceAdoptionV2({readSource:readFixtureSource});
  assert.equal(plan.v7Predecessor.state, 'EXACT_CURRENT_READBACK');
  assert.deepEqual(plan.blockers, ['ROOT_SOURCE_OWNER_DECISION_REQUIRED','EXACT_TWO_TARGET_APPLY_AUTHORIZATION_REQUIRED']);
  assert.equal(plan.authorityBoundary.canonicalApply, 'NOT_PERFORMED');
});
