import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

const requirements = parse(fs.readFileSync('.product-experience/pdp-0-product-truth/requirements.yaml', 'utf8'));
const capabilities = parse(fs.readFileSync('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8'));
const requirement = requirements.requirements.find(({ id }) => id === 'MEDIA-REQ-CAP-ARTIFACT');
const acceptanceCase = requirement?.acceptanceCases?.find(({ id }) => id === 'MEDIA-REQ-CAP-ARTIFACT-AC-05');
const search = capabilities.capabilities.find(({ id }) => id === 'media.artifact.search');
const parameters = search?.ownerDefinition?.parameterSchema;
const rightsIntent = parameters?.conditionalSemantics?.find(({ when }) => when === 'searchIntent=LICENSE_ELIGIBLE_ASSET_CANDIDATES');
const rightsOutput = search?.ownerDefinition?.successOutputs?.[0]?.optionalSemanticObservations?.find(({ id }) => id === 'licenseEligibleAssetCandidates');

test('P0 asset search filters exact rights-permitted immutable versions and reports unresolved candidates as unknown', () => {
  assert.ok(acceptanceCase, 'asset-search rights acceptance case exists');
  assert.match(acceptanceCase.given, /explicitly declared intended-use scope/i);
  assert.match(acceptanceCase.then, /preserve the exact asset version/i);
  assert.match(acceptanceCase.then, /current authoritative per-version rights and license evidence/i);
  assert.match(acceptanceCase.then, /UNKNOWN or review-required rather than as an empty eligible result/i);
  assert.match(acceptanceCase.rejection, /treating this filter as legal clearance/i);
  assert.ok(rightsIntent, 'asset-search intent is declared');
  assert.equal(rightsIntent.requires, 'declaredIntendedUseScope');
  assert.match(rightsIntent.meaning, /only exact immutable asset versions/i);
  assert.match(rightsIntent.meaning, /unresolved evidence is UNKNOWN or review-required, never eligible/i);
  assert.deepEqual(Object.keys(rightsOutput.fields).sort(), [
    'declaredIntendedUseScopeRef', 'rightsLicenseDispositionRef', 'sourceArtifactVersionRef',
  ]);
  assert.match(rightsOutput.constraints.join(' '), /Unknown, missing, denied, expired, revoked, restricted, incompatible, or unresolved evidence is not eligible/i);
  assert.equal(search.ownerDefinition.nonSuccessOutputs.UNKNOWN_OUTCOME[0].artifactType,
    'rights-filtered-asset-search-unknown-or-review-required');
  assert.equal(search.ownerDefinition.availability.executionAdmission, 'NOT_ADMITTED');
});

test('P0 bounded asset search retains page and continuation limits with the rights filter', () => {
  assert.equal(search.ownerDefinition.boundsRef, 'media.capability-bounds.media-artifact-search');
  assert.ok(parameters.required.includes('pageSize'));
  assert.deepEqual(parameters.properties.pageSize, { type: 'integer', minimum: 1, maximum: 100 });
  assert.deepEqual(parameters.properties.pageToken, {
    type: 'optional-opaque-continuation-token', maxLength: 512,
  });
  assert.equal(parameters.properties.declaredIntendedUseScope.type,
    'optional-actor-declared-purpose-and-use-scope-reference');
  assert.equal(rightsIntent.requires, 'declaredIntendedUseScope');
});
