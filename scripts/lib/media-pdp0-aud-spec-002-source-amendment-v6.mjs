import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FOLDER = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const CAPABILITY_ID = 'media.recipe.specification.compile';
const CROSSWALK_PATH = `${FOLDER}/pdp0-501-disposition-crosswalk.json`;
const REVIEW_PATH = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const CAP_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const COMPILER = ';compilerContract=EXACT_VERSIONED';
const VARIANT = 'resultKind=SUPPORTED_VERSION_BOUND_SCHEMA_MIGRATION_CANDIDATE_AND_SEMANTIC_DIFF;originRelation=SOURCE_DERIVED;epistemicDisposition=SOURCE_DERIVED_TRANSFORMATION;migrationIntent=SCHEMA_MIGRATION;sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED';
const REQUIRED = 'migrationIntent=SCHEMA_MIGRATION;sourceSpecification=EXACT_VERSIONED;sourceSchema=EXACT_VERSIONED;targetSchema=EXACT_VERSIONED;transformation=EXACT_DECLARED;transformationSupport=SUPPORTED';

function ensure(condition, message) { if (!condition) throw new Error(message); }
function replaceExactly(text, before, after, expectedCount, label) {
  const count = text.split(before).length - 1;
  ensure(count === expectedCount, `${label}: expected ${expectedCount} occurrence(s), found ${count}`);
  return text.split(before).join(after);
}
function bytes(value) { return Buffer.isBuffer(value) ? value : Buffer.from(value); }
function clone(value) { return structuredClone(value); }

function addCompilerContractToCapability(text) {
  let output = text;
  output = replaceExactly(output, `requiredWhenSelector: ${REQUIRED}`, `requiredWhenSelector: ${REQUIRED}${COMPILER}`, 1, 'capability requiredWhenSelector');
  output = replaceExactly(output, `selector: ${VARIANT}`, `selector: ${VARIANT}${COMPILER}`, 1, 'capability result variant selector');
  return output;
}

function addCompilerContractToTrust(text) {
  let output = text;
  output = replaceExactly(output, `when: ${VARIANT}`, `when: ${VARIANT}${COMPILER}`, 1, 'trust outcome selector');
  const outer = `when: outputArtifactType=reviewable-version-bound-schema-migration-candidate-and-semantic-diff;${VARIANT}`;
  output = replaceExactly(output, outer, `${outer}${COMPILER}`, 1, 'trust output branch selector');
  return output;
}

function correctCrosswalk(text) {
  const before = 'Matching trust reconstruction remains unresolved because no exact owner capability adjudication record exists; no owner mapping is invented.';
  const after = 'This candidate carries separate typed owner-adjudication and trust-reconstruction rows for the current compile extension outside the immutable historical 462-row arrays. Those source-definition rows do not assert independent acceptance, external credential or issuer trust, quality applicability, or runtime admission.';
  return replaceExactly(text, before, after, 1, 'AUD-SPEC-002 crosswalk trust rationale');
}

const yaml = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ghatana-tools/package.json'))('yaml');

export function validateAudSpec002V6Postimages(postimages) {
  const capability = yaml.parse(bytes(postimages[CAP_PATH]).toString('utf8')).capabilities.find(row => row.id === CAPABILITY_ID);
  const migrationOutput = capability?.ownerDefinition?.successOutputs?.find(row => row.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  ensure(migrationOutput?.requiredWhenSelector === `${REQUIRED}${COMPILER}`
      && migrationOutput.resultVariants?.length === 1 && migrationOutput.resultVariants[0].selector === `${VARIANT}${COMPILER}`,
    'current compile capability selectors must bind the exact versioned compiler contract');
  const review = yaml.parse(bytes(postimages[REVIEW_PATH]).toString('utf8'));
  ensure(review.ownerCapabilityLeafAdjudication?.records?.length === 462
      && review.ownerTrustReconstructionDispositions?.records?.length === 462,
    'the historic 462-row owner and trust arrays must remain intact');
  const trust = review.currentVersionExtensionOwnerAndTrust?.trustReconstructionDispositions?.find(row => row.capabilityRef === CAPABILITY_ID);
  const branch = trust?.outputBranches?.find(row => row.outputArtifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff');
  ensure(branch?.when === `outputArtifactType=reviewable-version-bound-schema-migration-candidate-and-semantic-diff;${VARIANT}${COMPILER}`
      && branch.outcomes?.length === 1 && branch.outcomes[0].when === `${VARIANT}${COMPILER}`,
    'current extension trust branch selectors must bind the exact versioned compiler contract');
  const crosswalk = JSON.parse(bytes(postimages[CROSSWALK_PATH]).toString('utf8'));
  const rows = crosswalk.rows.filter(row => row.auditId === 'AUD-SPEC-002');
  ensure(rows.length === 1 && rows[0].phaseLocalRationale.includes('separate typed owner-adjudication and trust-reconstruction rows')
      && !rows[0].phaseLocalRationale.includes('no exact owner capability adjudication record exists'),
    'AUD-SPEC-002 crosswalk rationale must agree with the typed current extension rows');
  return {ok: true, validated: ['capabilities.yaml', 'requirements.yaml', 'crosswalk.json', 'capability-leaf-review.yaml', 'campaign-extensions.yaml', 'decision-log.md']};
}

function updateCandidateSchema(schema, candidateSha) {
  const out = clone(schema);
  out.$id = 'media.pdp0.aud-spec-002-source-amendment-candidate.v6';
  out.properties.schemaVersion.const = 'media.pdp0.aud-spec-002-source-amendment-candidate.v6';
  out.properties.predecessorCandidateRef.const = `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v5.json`;
  return out;
}

function updateSourceAmendmentSchema(schema) {
  const out = clone(schema);
  out.$id = 'media.pdp0.aud-spec-002-source-amendment-postimage.v6';
  out.properties.schemaVersion.const = 'media.pdp0.aud-spec-002-source-amendment-postimage.v6';
  out.required = out.required.map(key => key === 'predecessorV4' ? 'predecessorV5' : key);
  const predecessor = out.properties.predecessorV4;
  ensure(predecessor, 'frozen v5 postimage schema lacks predecessorV4');
  delete out.properties.predecessorV4;
  out.properties.predecessorV5 = {...predecessor, properties: {...predecessor.properties,
    ref: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v5.json`}}};
  return out;
}

export function buildAudSpec002SourceAmendmentV6({v5CandidateBytes, v5CandidateSchemaBytes, v5SourceAmendmentBytes, v5SourceAmendmentSchemaBytes, v5Postimages, v5ManifestBytes}) {
  const v5Candidate = JSON.parse(bytes(v5CandidateBytes).toString('utf8'));
  const manifest = JSON.parse(bytes(v5ManifestBytes).toString('utf8'));
  ensure(v5Candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v5'
      && v5Candidate.auditId === 'AUD-SPEC-002' && v5Candidate.canonicalApply === 'NOT_PERFORMED'
      && sha(bytes(v5CandidateBytes)) === manifest.candidateSha256,
    'frozen v5 candidate or freeze manifest is missing/mismatched');
  const v5Pins = new Map(v5Candidate.exactFileTargets.map(row => [row.targetRef, row.postimageSha256]));
  for (const ref of [CAP_PATH, CROSSWALK_PATH, REVIEW_PATH])
    ensure(v5Postimages[ref] && v5Pins.get(ref) === sha(bytes(v5Postimages[ref])), `v5 postimage does not match frozen pin: ${ref}`);

  const postimages = Object.fromEntries(Object.entries(v5Postimages).map(([ref, content]) => [ref, bytes(content)]));
  const capText = postimages[CAP_PATH].toString('utf8');
  const capStart = capText.indexOf(`  - id: ${CAPABILITY_ID}\n`);
  const capEnd = capText.indexOf('\n  - id:', capStart + 1);
  ensure(capStart >= 0 && capEnd > capStart, 'v5 current compile capability block is missing');
  postimages[CAP_PATH] = Buffer.from(`${capText.slice(0, capStart)}${addCompilerContractToCapability(capText.slice(capStart, capEnd))}${capText.slice(capEnd)}`);

  const reviewText = postimages[REVIEW_PATH].toString('utf8');
  const marker = 'currentVersionExtensionOwnerAndTrust:\n';
  const reviewStart = reviewText.indexOf(marker);
  ensure(reviewStart >= 0, 'v5 current extension owner/trust block is missing');
  postimages[REVIEW_PATH] = Buffer.from(`${reviewText.slice(0, reviewStart)}${addCompilerContractToTrust(reviewText.slice(reviewStart))}`);
  postimages[CROSSWALK_PATH] = Buffer.from(correctCrosswalk(postimages[CROSSWALK_PATH].toString('utf8')));

  validateAudSpec002V6Postimages(postimages);

  const postimageSha256 = Object.fromEntries(v5Candidate.exactFileTargets.map(row => [row.targetRef, sha(postimages[row.targetRef])]));
  const candidateRef = `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v5.json`;
  const sourceAmendment = JSON.parse(bytes(v5SourceAmendmentBytes).toString('utf8'));
  delete sourceAmendment.predecessorV4;
  sourceAmendment.predecessorV5 = {ref: candidateRef, sha256: sha(bytes(v5CandidateBytes)), immutable: true};
  sourceAmendment.schemaVersion = 'media.pdp0.aud-spec-002-source-amendment-postimage.v6';
  sourceAmendment.postimageSha256 = Object.fromEntries(Object.entries(postimageSha256).map(([ref, value]) => [
    ref === CAP_PATH ? 'capabilitiesYaml' : ref === '.product-experience/pdp-0-product-truth/requirements.yaml' ? 'requirementsYaml'
      : ref === CROSSWALK_PATH ? 'crosswalkJson' : ref === REVIEW_PATH ? 'capabilityLeafReviewYaml'
        : ref === '.product-experience/pdp-0-product-truth/campaign-extensions.yaml' ? 'campaignExtensionsYaml' : 'decisionLogMarkdown', value,
  ]));
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const candidate = clone(v5Candidate);
  candidate.schemaVersion = 'media.pdp0.aud-spec-002-source-amendment-candidate.v6';
  candidate.predecessorCandidateRef = candidateRef;
  candidate.predecessorCandidateSha256 = sha(bytes(v5CandidateBytes));
  candidate.postimageSha256 = {...sourceAmendment.postimageSha256};
  candidate.exactFileTargets = v5Candidate.exactFileTargets.map(row => ({...row, postimageSha256: postimageSha256[row.targetRef]}));
  const components = {...candidate.postimageSha256, sourceAmendmentJson: sha(sourceAmendmentBytes)};
  candidate.candidatePostimageSha256 = sha(Buffer.from(JSON.stringify(components)));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateSchema = updateCandidateSchema(JSON.parse(bytes(v5CandidateSchemaBytes).toString('utf8')));
  const sourceAmendmentSchema = updateSourceAmendmentSchema(JSON.parse(bytes(v5SourceAmendmentSchemaBytes).toString('utf8')));

  return {candidate, candidateBytes, candidateSchema, sourceAmendment, sourceAmendmentBytes, sourceAmendmentSchema, postimages,
    predecessorV5Sha256: sha(bytes(v5CandidateBytes)), manifestV5: manifest, sourcePins: clone(v5Candidate.sourceBindings),
    targetRows: v5Candidate.exactFileTargets.map(row => ({targetRef: row.targetRef, preimageSha256: row.preimageSha256, postimageSha256: postimageSha256[row.targetRef]}))};
}

export const audSpec002V6Selector = Object.freeze({compilerContract: 'EXACT_VERSIONED', suffix: COMPILER, variant: VARIANT, required: REQUIRED});
