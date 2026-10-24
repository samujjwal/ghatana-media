import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV6, validateAudSpec002V6Postimages} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v6.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const require = createRequire('/Users/samujjwal/Development/ghatana-tools/package.json');
const yaml = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const read = ref => fs.readFileSync(path.join(root, ref));
const sha = content => createHash('sha256').update(content).digest('hex');
const paths = {
  candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v5.json`,
  candidateSchema: `${folder}/AUD-SPEC-002-source-amendment-candidate.v5.schema.json`,
  source: `${folder}/AUD-SPEC-002-source-amendment-postimage.v5.json`,
  sourceSchema: `${folder}/AUD-SPEC-002-source-amendment-postimage.v5.schema.json`,
  manifest: `${folder}/AUD-SPEC-002-source-amendment-v5-freeze-manifest.v1.json`,
  cap: `${folder}/AUD-SPEC-002-capabilities-file-postimage.v5.yaml`,
  req: `${folder}/AUD-SPEC-002-requirements-file-postimage.v5.yaml`,
  crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v5.json`,
  review: `${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v5.yaml`,
  campaign: `${folder}/AUD-SPEC-002-campaign-extensions-postimage.v5.yaml`,
  log: `${folder}/AUD-SPEC-002-decision-log-postimage.v5.md`,
};
const inputs = () => ({v5CandidateBytes: read(paths.candidate), v5CandidateSchemaBytes: read(paths.candidateSchema),
  v5SourceAmendmentBytes: read(paths.source), v5SourceAmendmentSchemaBytes: read(paths.sourceSchema), v5ManifestBytes: read(paths.manifest),
  v5Postimages: {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': read(paths.cap),
    '.product-experience/pdp-0-product-truth/requirements.yaml': read(paths.req),
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': read(paths.crosswalk),
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': read(paths.review),
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml': read(paths.campaign),
    '.product-experience/decision-log.md': read(paths.log),
  }});
const result = buildAudSpec002SourceAmendmentV6(inputs());
const capPath = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const reviewPath = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';

test('v6 binds compiler-contract version in both capability success selectors', () => {
  const document = yaml.parse(result.postimages[capPath].toString('utf8'));
  const capability = document.capabilities.find(row => row.id === 'media.recipe.specification.compile');
  const migration = capability.ownerDefinition.successOutputs.find(row => row.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  assert.ok(migration.requiredWhenSelector.endsWith(';compilerContract=EXACT_VERSIONED'));
  assert.equal(migration.resultVariants[0].selector, `${migration.resultVariants[0].selector.split(';compilerContract=')[0]};compilerContract=EXACT_VERSIONED`);
  assert.ok(migration.requiredWhenSelector.includes('transformationSupport=SUPPORTED;compilerContract=EXACT_VERSIONED'));
});

test('v6 binds compiler-contract version in both typed trust reconstruction branch selectors', () => {
  const document = yaml.parse(result.postimages[reviewPath].toString('utf8'));
  const trust = document.currentVersionExtensionOwnerAndTrust.trustReconstructionDispositions[0];
  const branch = trust.outputBranches.find(row => row.outputArtifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  assert.ok(branch.when.endsWith(';compilerContract=EXACT_VERSIONED'));
  assert.ok(branch.outcomes[0].when.endsWith(';compilerContract=EXACT_VERSIONED'));
  for (const selector of [branch.when, branch.outcomes[0].when]) assert.equal(selector.includes('compilerContract=EXACT_VERSIONED'), true);
});

test('v6 crosswalk rationale agrees with the additive typed extension rows and preserves trust boundaries', () => {
  const document = JSON.parse(result.postimages[crosswalkPath].toString('utf8'));
  const row = document.rows.find(item => item.auditId === 'AUD-SPEC-002');
  assert.match(row.phaseLocalRationale, /separate typed owner-adjudication and trust-reconstruction rows/u);
  assert.doesNotMatch(row.phaseLocalRationale, /no exact owner capability adjudication record exists/u);
  assert.match(row.phaseLocalRationale, /do not assert independent acceptance/u);
  assert.match(row.phaseLocalRationale, /quality applicability remains UNKNOWN/iu);
});

test('v6 keeps the six target postimages and historic 462-row arrays intact while adding only selector and rationale corrections', () => {
  const beforeReview = yaml.parse(read(paths.review).toString('utf8'));
  const afterReview = yaml.parse(result.postimages[reviewPath].toString('utf8'));
  assert.equal(afterReview.ownerCapabilityLeafAdjudication.records.length, 462);
  assert.equal(afterReview.ownerTrustReconstructionDispositions.records.length, 462);
  assert.equal(afterReview.currentVersionExtensionOwnerAndTrust.ownerAdjudications.length, 1);
  assert.equal(afterReview.currentVersionExtensionOwnerAndTrust.trustReconstructionDispositions.length, 1);
  assert.equal(beforeReview.ownerCapabilityLeafAdjudication.records.length, afterReview.ownerCapabilityLeafAdjudication.records.length);
  assert.equal(beforeReview.ownerTrustReconstructionDispositions.records.length, afterReview.ownerTrustReconstructionDispositions.records.length);
  assert.equal(result.targetRows.length, 6);
  assert.equal(result.candidate.population.historicalBase, 462);
  assert.equal(result.candidate.population.currentVersionTotal, 463);
  assert.equal(result.candidate.population.futureProposals, 6);
  assert.equal(result.candidate.canonicalApply, 'NOT_PERFORMED');
  assert.deepEqual(validateAudSpec002V6Postimages(result.postimages).validated,
    ['capabilities.yaml', 'requirements.yaml', 'crosswalk.json', 'capability-leaf-review.yaml', 'campaign-extensions.yaml', 'decision-log.md']);
});

test('v6 JSON schemas validate all candidate records and exact postimage hashes', () => {
  const ajv = new Ajv2020({strict: true});
  const candidateValidator = ajv.compile(result.candidateSchema);
  const sourceValidator = ajv.compile(result.sourceAmendmentSchema);
  assert.equal(candidateValidator(result.candidate), true, JSON.stringify(candidateValidator.errors));
  assert.equal(sourceValidator(result.sourceAmendment), true, JSON.stringify(sourceValidator.errors));
  for (const row of result.candidate.exactFileTargets) assert.equal(row.postimageSha256, sha(result.postimages[row.targetRef]));
  const missingCompiler = Buffer.from(result.postimages[capPath].toString('utf8').replace(';compilerContract=EXACT_VERSIONED', ''));
  assert.notEqual(sha(missingCompiler), result.candidate.exactFileTargets.find(row => row.targetRef === capPath).postimageSha256);
  const tampered = {...result.postimages, [capPath]: missingCompiler};
  assert.throws(() => validateAudSpec002V6Postimages(tampered), /compiler contract/u);
  const staleCrosswalk = {...result.postimages, [crosswalkPath]: Buffer.from(result.postimages[crosswalkPath].toString('utf8').replace('separate typed owner-adjudication and trust-reconstruction rows', 'no exact owner capability adjudication record exists'))};
  assert.throws(() => validateAudSpec002V6Postimages(staleCrosswalk), /crosswalk rationale/u);
  assert.equal(result.candidate.exactFileTargets.length, 6);
});
