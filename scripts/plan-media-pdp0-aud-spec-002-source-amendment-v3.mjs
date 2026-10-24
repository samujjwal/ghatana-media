#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002SourceAmendmentV3} from './lib/media-pdp0-aud-spec-002-source-amendment-v3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  trust: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  v2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  v2Postimage: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  v2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
};
const readBytes = ref => fs.readFileSync(path.join(root, ref));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'media.pdp0.aud-spec-002-source-amendment-candidate.v3',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'artifactKind', 'auditId', 'previousReviewedCandidateRef', 'previousReviewedCandidateSha256', 'previousReviewedPostimageSha256', 'sourceBindings', 'componentPostimageSha256', 'candidatePostimageSha256', 'conditionalOutputCorrection', 'unresolvedOwnerTrustBranch', 'exactSourceAmendmentRef', 'exactTargetPostimages', 'exactFileTargets', 'blockers', 'canonicalApply', 'effects'],
  properties: {
    schemaVersion: {const: 'media.pdp0.aud-spec-002-source-amendment-candidate.v3'},
    artifactKind: {const: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE'},
    auditId: {const: 'AUD-SPEC-002'},
    previousReviewedCandidateRef: {const: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`},
    previousReviewedCandidateSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    previousReviewedPostimageSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    sourceBindings: {type: 'object', additionalProperties: false, required: ['crosswalkSha256', 'auditSha256', 'capabilitiesSha256', 'requirementsSha256', 'capabilityLeafReviewSha256'], properties: Object.fromEntries(['crosswalkSha256', 'auditSha256', 'capabilitiesSha256', 'requirementsSha256', 'capabilityLeafReviewSha256'].map(key => [key, {type: 'string', pattern: '^[a-f0-9]{64}$'}]))},
    componentPostimageSha256: {type: 'object', additionalProperties: false, required: ['capabilityYaml', 'requirementsYaml', 'crosswalkJson', 'sourceAmendmentJson'], properties: Object.fromEntries(['capabilityYaml', 'requirementsYaml', 'crosswalkJson', 'sourceAmendmentJson'].map(key => [key, {type: 'string', pattern: '^[a-f0-9]{64}$'}]))},
    candidatePostimageSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    conditionalOutputCorrection: {const: 'SUPPORTED_MIGRATION_ONLY; ordinary compilation retains its existing required graph/project-plan output; AC-14 emits no migration candidate.'},
    unresolvedOwnerTrustBranch: {type: 'object', required: ['status', 'outputArtifactType', 'selector', 'capabilityRef', 'exactOwnerCapabilityAdjudicationSelector', 'observedOwnerCapabilityAdjudicationRecordCount', 'currentTrustReconstructionRecordCount', 'noRecordInvented'], additionalProperties: false, properties: {status: {const: 'UNRESOLVED_OWNER_CAPABILITY_ADJUDICATION_REQUIRED'}, outputArtifactType: {const: 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff'}, selector: {type: 'string', minLength: 1}, capabilityRef: {const: 'media.recipe.specification.compile'}, exactOwnerCapabilityAdjudicationSelector: {type: 'string', minLength: 1}, observedOwnerCapabilityAdjudicationRecordCount: {const: 0}, currentTrustReconstructionRecordCount: {const: 0}, noRecordInvented: {const: true}}},
    exactSourceAmendmentRef: {const: `${folder}/AUD-SPEC-002-source-amendment-postimage.v3.json`},
    exactTargetPostimages: {type: 'object', additionalProperties: false, required: ['capabilityYaml', 'requirementsYaml', 'crosswalkJson'], properties: Object.fromEntries(['capabilityYaml', 'requirementsYaml', 'crosswalkJson'].map(key => [key, {type: 'string', pattern: '^[a-f0-9]{64}$'}]))},
    exactFileTargets: {type: 'array', minItems: 3, maxItems: 3, items: {type: 'object', additionalProperties: false, required: ['targetRef', 'preimageSha256', 'recordId'], properties: {targetRef: {type: 'string'}, preimageSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'}, recordId: {type: 'string'}}}},
    blockers: {type: 'array', minItems: 4, items: {type: 'string'}}, canonicalApply: {const: 'NOT_PERFORMED'},
    effects: {type: 'object', additionalProperties: false, required: ['canonicalSourceWrite', 'sourceStatus', 'applicability', 'independentAcceptance', 'nativeClosure', 'runtimeAdmission'], properties: {canonicalSourceWrite: {const: 'NOT_PERFORMED'}, sourceStatus: {const: 'UNCHANGED'}, applicability: {const: 'UNCHANGED'}, independentAcceptance: {const: 'NOT_CLAIMED'}, nativeClosure: {const: 'NOT_CLAIMED'}, runtimeAdmission: {const: 'NOT_ADMITTED'}}},
  },
};

function writeImmutable(file, bytes) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  if (fs.existsSync(full)) {
    if (!fs.readFileSync(full).equals(bytes)) throw new Error(`immutable v3 artifact already exists with different bytes: ${file}`);
    return;
  }
  const fd = fs.openSync(full, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function prepareAudSpec002V3() {
  const bytes = {
    crosswalkBytes: readBytes(refs.crosswalk), auditBytes: readBytes(refs.audit),
    capabilitiesBytes: readBytes(refs.capabilities), requirementsBytes: readBytes(refs.requirements),
    capabilityLeafReviewBytes: readBytes(refs.trust),
    observedV2CandidateBytes: readBytes(refs.v2Candidate), observedV2SourceAmendmentBytes: readBytes(refs.v2Postimage), observedV2CrosswalkBytes: readBytes(refs.v2Crosswalk),
  };
  return {bytes, result: buildAudSpec002SourceAmendmentV3(bytes)};
}

export function writeAudSpec002V3() {
  const {bytes, result} = prepareAudSpec002V3();
  const sourceSnapshots = Object.fromEntries(Object.entries({candidate: bytes.observedV2CandidateBytes, postimage: bytes.observedV2SourceAmendmentBytes, crosswalkPostimage: bytes.observedV2CrosswalkBytes}).map(([key, value]) => [key, {sha256: sha(value), base64: value.toString('base64')}]))
  const snapshot = Buffer.from(`${JSON.stringify({schemaVersion: 'media.pdp0.aud-spec-002-unapproved-v2-regeneration-snapshot.v1', disposition: 'OBSERVED_LOCAL_REGENERATION_ONLY; NOT THE RECOVERED FROZEN V2 PREIMAGE', expectedFrozenPeerReviewedV2: result.sourceAmendment.predecessorFrozenV2, observedArtifacts: sourceSnapshots}, null, 2)}\n`);
  const outputs = new Map([
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v3.schema.json`, Buffer.from(`${JSON.stringify(schema, null, 2)}\n`)],
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v3.json`, Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`)],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v3.json`, result.sourceAmendmentBytes],
    [`${folder}/AUD-SPEC-002-capabilities-file-postimage.v3.yaml`, result.capabilityPostimage],
    [`${folder}/AUD-SPEC-002-requirements-file-postimage.v3.yaml`, result.requirementPostimage],
    [`${folder}/AUD-SPEC-002-crosswalk-postimage.v3.json`, result.crosswalkPostimage],
    [`${folder}/AUD-SPEC-002-unapproved-v2-regeneration-snapshot.v1.json`, snapshot],
  ]);
  for (const [ref, output] of outputs) writeImmutable(ref, output);
  const producerRefs = ['scripts/lib/media-pdp0-aud-spec-002-source-amendment-v3.mjs', 'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v3.mjs'];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(readBytes(ref))]));
  const filePins = Object.fromEntries([...outputs].map(([ref, output]) => [ref, sha(output)]));
  const manifest = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-v3-freeze-manifest.v1',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_REVIEW_AND_SOURCE_OWNER_DECISION',
    candidateSha256: filePins[`${folder}/AUD-SPEC-002-source-amendment-candidate.v3.json`],
    candidateSchemaSha256: filePins[`${folder}/AUD-SPEC-002-source-amendment-candidate.v3.schema.json`],
    producerPins, sourcePins: result.candidate.sourceBindings, exactArtifactPins: filePins,
    canonicalApply: 'NOT_PERFORMED',
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeImmutable(`${folder}/AUD-SPEC-002-source-amendment-v3-freeze-manifest.v1.json`, manifestBytes);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(writeAudSpec002V3(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
