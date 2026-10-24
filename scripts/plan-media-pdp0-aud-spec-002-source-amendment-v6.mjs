#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002SourceAmendmentV6} from './lib/media-pdp0-aud-spec-002-source-amendment-v6.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const writeImmutable = (ref, content) => {
  const full = path.join(root, ref);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  if (fs.existsSync(full)) {
    if (!fs.readFileSync(full).equals(content)) throw new Error(`refusing to overwrite frozen v6 artifact: ${ref}`);
    return;
  }
  const fd = fs.openSync(full, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
const v5Refs = {
  candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v5.json`,
  candidateSchema: `${folder}/AUD-SPEC-002-source-amendment-candidate.v5.schema.json`,
  source: `${folder}/AUD-SPEC-002-source-amendment-postimage.v5.json`,
  sourceSchema: `${folder}/AUD-SPEC-002-source-amendment-postimage.v5.schema.json`,
  manifest: `${folder}/AUD-SPEC-002-source-amendment-v5-freeze-manifest.v1.json`,
  caps: `${folder}/AUD-SPEC-002-capabilities-file-postimage.v5.yaml`,
  requirements: `${folder}/AUD-SPEC-002-requirements-file-postimage.v5.yaml`,
  crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v5.json`,
  review: `${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v5.yaml`,
  campaigns: `${folder}/AUD-SPEC-002-campaign-extensions-postimage.v5.yaml`,
  log: `${folder}/AUD-SPEC-002-decision-log-postimage.v5.md`,
};

export function prepareAudSpec002V6() {
  const frozenManifest = JSON.parse(read(v5Refs.manifest).toString('utf8'));
  const v5CandidateBytes = read(v5Refs.candidate);
  const v5Candidate = JSON.parse(v5CandidateBytes.toString('utf8'));
  if (sha(v5CandidateBytes) !== frozenManifest.candidateSha256) throw new Error('frozen v5 candidate does not match its original freeze manifest');
  for (const [ref, expectedSha] of Object.entries(frozenManifest.exactArtifactPins ?? {})) {
    const full = path.join(root, ref);
    if (!fs.existsSync(full) || sha(read(ref)) !== expectedSha) throw new Error(`frozen v5 artifact differs from its original manifest: ${ref}`);
  }
  const built = buildAudSpec002SourceAmendmentV6({
    v5CandidateBytes, v5CandidateSchemaBytes: read(v5Refs.candidateSchema), v5SourceAmendmentBytes: read(v5Refs.source),
    v5SourceAmendmentSchemaBytes: read(v5Refs.sourceSchema), v5ManifestBytes: read(v5Refs.manifest),
    v5Postimages: {
      '.product-experience/pdp-0-product-truth/capabilities.yaml': read(v5Refs.caps),
      '.product-experience/pdp-0-product-truth/requirements.yaml': read(v5Refs.requirements),
      'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': read(v5Refs.crosswalk),
      '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': read(v5Refs.review),
      '.product-experience/pdp-0-product-truth/campaign-extensions.yaml': read(v5Refs.campaigns),
      '.product-experience/decision-log.md': read(v5Refs.log),
    },
  });
  const candidateSchemaBytes = Buffer.from(`${JSON.stringify(built.candidateSchema, null, 2)}\n`);
  const sourceSchemaBytes = Buffer.from(`${JSON.stringify(built.sourceAmendmentSchema, null, 2)}\n`);
  const producerRefs = [
    'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v6.mjs',
    'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v6.mjs',
    'tests/media-pdp0-aud-spec-002-source-amendment-v6.test.mjs',
    'tests/media-pdp0-aud-spec-002-source-amendment-v5-postimages.test.mjs',
  ];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(read(ref))]));
  const postimageKeys = ['capabilitiesYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml','campaignExtensionsYaml','decisionLogMarkdown'];
  const targetRefs = built.candidate.exactFileTargets.map(row => row.targetRef);
  const targetPathByKey = Object.fromEntries(postimageKeys.map((key,index) => [key,targetRefs[index]]));
  const postimagesByKey = Object.fromEntries(postimageKeys.map(key => [key,sha(built.postimages[targetPathByKey[key]])]));
  const outputs = new Map([
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`, candidateSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`, sourceSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.json`, built.candidateBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.json`, built.sourceAmendmentBytes],
    [`${folder}/AUD-SPEC-002-capabilities-file-postimage.v6.yaml`, built.postimages[targetRefs[0]]],
    [`${folder}/AUD-SPEC-002-requirements-file-postimage.v6.yaml`, built.postimages[targetRefs[1]]],
    [`${folder}/AUD-SPEC-002-crosswalk-postimage.v6.json`, built.postimages[targetRefs[2]]],
    [`${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v6.yaml`, built.postimages[targetRefs[3]]],
    [`${folder}/AUD-SPEC-002-campaign-extensions-postimage.v6.yaml`, built.postimages[targetRefs[4]]],
    [`${folder}/AUD-SPEC-002-decision-log-postimage.v6.md`, built.postimages[targetRefs[5]]],
  ]);
  const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');
  const ajv = new Ajv2020({strict: true});
  if (!ajv.compile(built.candidateSchema)(built.candidate)) throw new Error('v6 candidate does not pass its schema');
  if (!ajv.compile(built.sourceAmendmentSchema)(built.sourceAmendment)) throw new Error('v6 postimage does not pass its schema');
  const exactArtifactPins = Object.fromEntries([...outputs].map(([ref, content]) => [ref, sha(content)]));
  const manifest = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-v6-freeze-manifest.v1',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_ROOT_SOURCE_OWNER_REVIEW',
    predecessorV5: {candidateRef: v5Refs.candidate, candidateSha256: sha(v5CandidateBytes), freezeManifestRef: v5Refs.manifest, freezeManifestSha256: sha(read(v5Refs.manifest))},
    candidateSha256: sha(built.candidateBytes), candidatePostimageSha256: built.candidate.candidatePostimageSha256,
    candidateSchemaSha256: sha(candidateSchemaBytes), sourceAmendmentSha256: sha(built.sourceAmendmentBytes),
    sourceAmendmentSchemaSha256: sha(sourceSchemaBytes), sourcePins: built.sourcePins, postimagesByKey,
    exactArtifactPins, producerPins, targetPostimages: built.targetRows, canonicalApply: 'NOT_PERFORMED',
    semanticSuccessor: {
      defectsFromV5: ['CAPABILITY_SUCCESS_OUTPUT_AND_TRUST_BRANCH_SELECTORS_OMITTED_REQUIRED_EXACT_COMPILER_CONTRACT_VERSION', 'AUD_SPEC_002_CROSSWALK_RATIONALE_CONTRADICTED_ADDITIVE_TYPED_EXTENSION_OWNER_AND_TRUST_ROWS'],
      corrections: ['BIND_COMPILER_CONTRACT_EXACT_VERSIONED_IN_ALL_CURRENT_MIGRATION_VARIANT_SELECTORS', 'RECONCILE_CROSSWALK_RATIONALE_TO_SEPARATE_EXTENSION_ROWS_WITHOUT_ACCEPTANCE_OR_CREDENTIAL_CLAIM'],
      noPopulationOrScopeChange: true,
    },
    boundary: {currentVersion: '462_HISTORICAL_BASE_PLUS_ONE_CURRENT_COMPILE_EXTENSION', futureExtensions: 6,
      qualityApplicability: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_REVIEW', pdp1Handoff: 'HISTORICAL_462_ONLY', phaseStatus: 'UNCHANGED',
      independentAcceptance: 'NOT_CLAIMED', nativeProof: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED'},
  };
  return {outputs, manifest, manifestBytes: Buffer.from(`${JSON.stringify(manifest,null,2)}\n`)};
}

export function writeAudSpec002V6({check = false} = {}) {
  const {outputs, manifest, manifestBytes} = prepareAudSpec002V6();
  const all = new Map([...outputs, [`${folder}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`, manifestBytes]]);
  if (check) {
    for (const [ref, content] of all) if (!fs.existsSync(path.join(root,ref)) || !read(ref).equals(content)) throw new Error(`frozen v6 artifact differs from current sources: ${ref}`);
  } else for (const [ref, content] of all) writeImmutable(ref, content);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(writeAudSpec002V6({check: process.argv.includes('--check')}),null,2)}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
