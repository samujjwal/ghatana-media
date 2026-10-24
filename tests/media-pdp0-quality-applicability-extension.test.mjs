import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareQualityApplicabilityExtensionCandidate} from '../scripts/lib/media-pdp0-quality-applicability-extension-candidate.mjs';
import {deriveQualityApplicabilityExtension, validateQualityApplicabilityPopulation} from '../scripts/lib/media-pdp0-quality-applicability-extension.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generated = prepareQualityApplicabilityExtensionCandidate();
const policyWithExtension = generated.postimagePolicy;

test('source-derived extension adds exactly one current row while preserving 462 historical rows and six future IDs', () => {
  const crosswalk = policyWithExtension.ownerQualityApplicabilityCrosswalk;
  const extension = policyWithExtension.ownerQualityApplicabilityCrosswalkExtensions;
  assert.equal(crosswalk.records.length, 462);
  assert.equal(crosswalk.population.capabilityLeaves, 462);
  assert.equal(extension.records.length, 1);
  assert.equal(extension.records[0].capabilityRef, 'media.recipe.specification.compile');
  assert.equal(extension.historicalBaseRows + extension.currentExtensionRows, extension.currentPopulationRows);
  assert.equal(extension.currentPopulationRows, 463);
  assert.equal(extension.futureExtensionRows, 6);
  assert.equal(extension.futureCapabilityRefs.length, 6);
  assert.equal(new Set(extension.futureCapabilityRefs).size, 6);
  assert.ok(!extension.futureCapabilityRefs.includes(extension.records[0].capabilityRef));
  assert.deepEqual(validateQualityApplicabilityPopulation(policyWithExtension), {
    baseRows: crosswalk.records, currentExtensionRows: extension.records,
    currentRows: [...crosswalk.records, ...extension.records], historicalRows: 462, currentRowsCount: 463, futureRows: 6,
  });
});

test('the chosen six dimensions and sixteen metrics are represented without measurement or qualification claims', () => {
  const row = policyWithExtension.ownerQualityApplicabilityCrosswalkExtensions.records[0];
  assert.equal(Object.keys(row.dimensionApplicability).length, 6);
  assert.equal(row.dimensionApplicability['QUALITY-DIM-RIGHTS-SAFETY'], 'APPLICABLE');
  for (const [id, status] of Object.entries(row.dimensionApplicability)) {
    if (id !== 'QUALITY-DIM-RIGHTS-SAFETY') assert.equal(status, 'NOT_APPLICABLE');
  }
  assert.equal(Object.keys(row.metricApplicability).length, 16);
  for (const metric of Object.values(row.metricApplicability)) {
    assert.equal(metric.status, 'NOT_APPLICABLE');
    assert.equal(metric.measurementState, 'NOT_EVALUATED');
    assert.equal(metric.qualificationState, 'NOT_EVALUATED');
    assert.deepEqual(metric.subjectInputArtifactTypes, []);
    assert.deepEqual(metric.subjectOutputArtifactTypes, []);
  }
  assert.equal(row.measurementState, 'NOT_EVALUATED');
  assert.equal(row.qualificationState, 'NOT_EVALUATED');
});

test('historical-only source remains a 462 row view, not silently promoted to 463', () => {
  const historicalOnly = structuredClone(policyWithExtension);
  delete historicalOnly.ownerQualityApplicabilityCrosswalkExtensions;
  const result = validateQualityApplicabilityPopulation(historicalOnly);
  assert.equal(result.currentRowsCount, 462);
  assert.equal(result.futureRows, 7);
});

test('validator rejects duplicate historical identity and contradictory extension population', () => {
  const duplicate = structuredClone(policyWithExtension);
  duplicate.ownerQualityApplicabilityCrosswalk.records[0].capabilityRef = 'media.recipe.specification.compile';
  assert.throws(() => validateQualityApplicabilityPopulation(duplicate), /duplicate a historical quality row/u);
  const contradiction = structuredClone(policyWithExtension);
  contradiction.ownerQualityApplicabilityCrosswalkExtensions.currentPopulationRows = 462;
  assert.throws(() => validateQualityApplicabilityPopulation(contradiction), /typed population/u);
});

test('validator rejects missing metric dispositions and invented applicability or quality state', () => {
  for (const mutate of [
    ext => { delete ext.records[0].metricApplicability['QUALITY-METRIC-IMAGE-DEFECTS']; },
    ext => { ext.records[0].metricApplicability['QUALITY-METRIC-IMAGE-DEFECTS'].status = 'APPLICABLE'; },
    ext => { ext.records[0].dimensionApplicability['QUALITY-DIM-RIGHTS-SAFETY'] = 'NOT_APPLICABLE'; },
    ext => { ext.records[0].measurementState = 'MEASURED'; },
    ext => { ext.futureCapabilityRefs.pop(); },
  ]) {
    const mutated = structuredClone(policyWithExtension);
    mutate(mutated.ownerQualityApplicabilityCrosswalkExtensions);
    assert.throws(() => validateQualityApplicabilityPopulation(mutated), /typed population/u);
  }
});

test('source derivation fails closed if the root choice or one of its source pins is stale', () => {
  const quality = fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/quality-policy.yaml'));
  const capability = fs.readFileSync(path.join(root, 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-capabilities-file-postimage.v6.yaml'));
  const campaign = fs.readFileSync(path.join(root, 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-campaign-extensions-postimage.v6.yaml'));
  const rootChoice = fs.readFileSync(path.resolve(root, '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json'));
  const options = fs.readFileSync(path.join(root, 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-applicability-options.v1.json'));
  const currentCapabilities = fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/capabilities.yaml'));
  const pxd225 = fs.readFileSync(path.join(root, 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json'));
  const v6Manifest = fs.readFileSync(path.join(root, 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json'));
  const input = {qualityPolicyBytes:quality,capabilityPostimageBytes:capability,campaignPostimageBytes:campaign,rootChoiceBytes:rootChoice,
    qualityOptionsBytes:options,currentCapabilitiesBytes:currentCapabilities,pxd225Bytes:pxd225,v6ManifestBytes:v6Manifest};
  assert.doesNotThrow(() => deriveQualityApplicabilityExtension(input));
  const decision = JSON.parse(rootChoice);
  const firstPin = Object.keys(decision.sourcePins)[0];
  const forged = Buffer.from(JSON.stringify({...decision,sourcePins:{...decision.sourcePins,[firstPin]:'0'.repeat(64)}}));
  assert.throws(() => deriveQualityApplicabilityExtension({...input,rootChoiceBytes:forged}), /source pin is stale/u);
});
