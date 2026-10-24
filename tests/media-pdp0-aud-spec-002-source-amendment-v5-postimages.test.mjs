import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const read = ref => fs.readFileSync(path.join(root, ref), 'utf8');
const yaml = createRequire('/Users/samujjwal/Development/ghatana-tools/package.json')('yaml');

test('v5 capability postimage preserves ordinary compile and keeps migration output conditional', () => {
  const document = yaml.parse(read(`${folder}/AUD-SPEC-002-capabilities-file-postimage.v5.yaml`));
  const capability = document.capabilities.find(row => row.id === 'media.recipe.specification.compile');
  assert.ok(capability);
  assert.equal(capability.scopeStatus, 'TARGET');
  assert.equal(capability.ownerDefinition.successOutputs.find(row => row.artifactType === 'normalized-semantic-graph-and-reviewable-project-plan-candidate').requiredOnSuccess, true);
  assert.equal(capability.ownerDefinition.successOutputs.find(row => row.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff').requiredOnSuccess, false);
  const migrationSelector = capability.ownerDefinition.successOutputs.find(row => row.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  assert.equal(migrationSelector.requiredWhenSelector.includes('compilerContract=EXACT_VERSIONED'), false, 'v5 peer finding: compiler contract selector is missing and v6 must repair it');
});

test('v5 requirement postimage contains ordinary, supported-migration, and unsupported-migration criteria', () => {
  const document = yaml.parse(read(`${folder}/AUD-SPEC-002-requirements-file-postimage.v5.yaml`));
  const requirement = document.requirements.find(row => row.id === 'MEDIA-REQ-CAP-RECIPE-TEMPLATE');
  assert.ok(requirement);
  const ids = new Set(requirement.acceptanceCases.map(row => row.id));
  for (const id of ['MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15', 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16', 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17']) assert.ok(ids.has(id), id);
  assert.match(requirement.acceptanceCases.find(row => row.id.endsWith('AC-15')).then, /do not require or emit a migration candidate/u);
  assert.match(requirement.acceptanceCases.find(row => row.id.endsWith('AC-16')).then, /required reviewable version-bound migration candidate/u);
  assert.match(requirement.acceptanceCases.find(row => row.id.endsWith('AC-17')).then, /UNKNOWN\/UNSUPPORTED/u);
});

test('v5 crosswalk binds AUD-SPEC-002 to PXD-226 and retains the exact audit identity', () => {
  const document = JSON.parse(read(`${folder}/AUD-SPEC-002-crosswalk-postimage.v5.json`));
  const rows = document.rows.filter(row => row.auditId === 'AUD-SPEC-002');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].pdp0EvidenceRefs.includes('.product-experience/decision-log.md#PXD-226'));
  assert.equal(rows[0].sourceText, 'Production-specific schema validation and migrations');
  assert.equal(rows[0].sourceAcceptanceText, 'Compiling the same specification twice produces equivalent normalized semantic graphs and stable fingerprints; invalid or unauthorized inputs create no effects.');
});

test('v5 capability review adds one separate current row without changing the historic 462 rows', () => {
  const document = yaml.parse(read(`${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v5.yaml`));
  assert.equal(document.ownerCapabilityLeafAdjudication.records.length, 462);
  assert.equal(document.ownerTrustReconstructionDispositions.records.length, 462);
  assert.equal(document.currentVersionExtensionOwnerAndTrust.ownerAdjudications.length, 1);
  assert.equal(document.currentVersionExtensionOwnerAndTrust.trustReconstructionDispositions.length, 1);
  assert.equal(document.currentVersionExtensionOwnerAndTrust.qualityApplicability.status, 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW');
  assert.equal(document.currentVersionExtensionOwnerAndTrust.downstreamPdp1.historicalCapabilityOperationCount, 462);
  const trustBranch = document.currentVersionExtensionOwnerAndTrust.trustReconstructionDispositions[0].outputBranches.find(row => row.outputArtifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  assert.equal(trustBranch.when.includes('compilerContract=EXACT_VERSIONED'), false, 'v5 peer finding: trust branch selector is missing and v6 must repair it');
});

test('v5 campaign extension postimage partitions 462 base plus one current and six future', () => {
  const document = yaml.parse(read(`${folder}/AUD-SPEC-002-campaign-extensions-postimage.v5.yaml`));
  const population = document.currentDefinitionPopulation;
  assert.equal(population.versionDisposition.historicalCanonicalCapabilityLeaves, 462);
  assert.equal(population.versionDisposition.currentVersionCapabilityLeaves, 463);
  assert.equal(population.versionDisposition.futureVersionProposalCapabilityLeaves, 6);
  assert.equal(population.versionDisposition.totalSourceCapabilityDefinitions, 469);
  assert.deepEqual(population.versionDisposition.currentVersionExtensionCapabilityIds, ['media.recipe.specification.compile']);
  assert.equal(population.versionDisposition.futureVersionProposals.length, 6);
  assert.equal(population.records.length, 7);
  assert.equal(population.ownerAdjudications, 462);
});

test('v5 decision-log postimage records the exact source-only decision and does not claim acceptance', () => {
  const text = read(`${folder}/AUD-SPEC-002-decision-log-postimage.v5.md`);
  const start = text.indexOf('### PXD-226 —');
  assert.ok(start >= 0);
  const section = text.slice(start);
  assert.match(section, /Supersede PXD-220 only for `media\.recipe\.specification\.compile`/u);
  assert.match(section, /Quality applicability is UNKNOWN/u);
  assert.match(section, /Canonical source apply remains pending exact review and authorization/u);
  assert.match(section, /independent acceptance and native proof are not claimed/u);
});
