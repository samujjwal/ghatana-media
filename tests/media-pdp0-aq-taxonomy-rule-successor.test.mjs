import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMediaPdp0AqTaxonomyRuleSuccessor} from '../scripts/prepare-media-pdp0-aq-taxonomy-rule-successor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AQ taxonomy successor proposes evidence-backed Q classifications under guarded create-only CAS inputs', () => {
  const result = buildMediaPdp0AqTaxonomyRuleSuccessor({repositoryRoot: root});
  const postimage = result.outputFiles['docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/aq-taxonomy-rule-source-postimage.v2.json'];
  const cas = result.outputFiles['docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/aq-taxonomy-rule-minimal-cas-successor-input.v2.json'];

  assert.equal(postimage.state, 'PROSPECTIVE_ROOT_TECHNICAL_RECOMMENDATION; NOT_CANONICALLY_APPLIED');
  assert.equal(postimage.affectedRows.length, 6);
  assert.deepEqual(postimage.ruleApplicability.sourceOrderIndexes, [59, 60, 61, 62, 63, 64]);
  assert.equal(postimage.ruleApplicability.automaticPropagationOutsideListedRows, false);
  assert.deepEqual(postimage.affectedRows.map(row => row.sourceOrderIndex), [59, 60, 61, 62, 63, 64]);
  assert.ok(postimage.affectedRows.every(row => row.preferredTechnicalRecommendation.primaryClusterId === 'Q'
    && row.preferredTechnicalRecommendation.relatedClusterIds.length === 0));
  assert.equal(postimage.invariantChecks.capabilityDefinitionsChanged, 0);
  assert.equal(postimage.invariantChecks.requirementDefinitionsChanged, 0);
  assert.equal(postimage.invariantChecks.pxd216ReviewedRowsChanged, 0);
  assert.equal(postimage.preservedDenominators.aqRows, 154);
  assert.equal(postimage.preservedDenominators.capabilityRecords, 469);
  assert.equal(postimage.preservedDenominators.pxd216ReviewedRows, 20);
  assert.equal(postimage.preservedDenominators.phaseCells, 216);
  assert.equal(postimage.preservedDenominators.surfaceIdentities, 54);
  assert.equal(postimage.preservedDenominators.auditRows, 501);

  assert.equal(cas.inputKind, 'NON_MUTATING_MINIMAL_CREATE_ONLY_CAS_INPUT');
  assert.equal(cas.target.expectedTargetState, 'ABSENT; CREATE_ONLY');
  assert.equal(cas.canonicalApply, 'NONE');
  assert.equal(cas.applyAuthorization, 'NOT_PROVIDED');
  assert.equal(cas.exactChangeSet.length, 6);
  assert.equal(cas.compareAndSwapGuards.statusSha256.expected,
    '6e92932ba4173c6dea7e3dcee0c1d44a44ae90245804d363c0d22c2f28028b7c');
  assert.equal(cas.compareAndSwapGuards.crosswalkSha256.expected,
    '02c61f7b0193ccd1900ffcae84f7a4c95fb00e800d9d86a9ce1ea65cae79b5b4');
  assert.equal(cas.effects.canonicalWrite, 'NOT_PERFORMED');

  for (const [ref, value] of Object.entries(result.outputFiles)) {
    const target = path.join(root, ref);
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, 'utf8'), `${JSON.stringify(value, null, 2)}\n`);
    assert.equal(result.outputHashes[ref], createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex'));
  }
});
