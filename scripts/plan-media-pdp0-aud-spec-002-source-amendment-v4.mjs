#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002SourceAmendmentV4} from './lib/media-pdp0-aud-spec-002-source-amendment-v4.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const writeImmutable = (ref, bytes) => {
  const full = path.join(root, ref);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  if (fs.existsSync(full)) {
    if (!fs.readFileSync(full).equals(bytes)) throw new Error(`refusing to overwrite frozen v4 artifact: ${ref}`);
    return;
  }
  const fd = fs.openSync(full, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};

export const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  capabilityLeafReview: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  applicationsChannels: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  decisionLog: '.product-experience/decision-log.md',
  v2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  v2Postimage: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  v2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
};

export function prepareAudSpec002V4() {
  const inputs = {
    crosswalkBytes: read(refs.crosswalk), auditBytes: read(refs.audit), capabilitiesBytes: read(refs.capabilities),
    requirementsBytes: read(refs.requirements), capabilityLeafReviewBytes: read(refs.capabilityLeafReview),
    applicationsChannelsBytes: read(refs.applicationsChannels), decisionLogBytes: read(refs.decisionLog),
    observedV2CandidateBytes: read(refs.v2Candidate), observedV2SourceAmendmentBytes: read(refs.v2Postimage), observedV2CrosswalkBytes: read(refs.v2Crosswalk),
  };
  const result = buildAudSpec002SourceAmendmentV4(inputs);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const candidateSchemaBytes = Buffer.from(`${JSON.stringify(result.schema, null, 2)}\n`);
  const sourceAmendmentSchemaBytes = Buffer.from(`${JSON.stringify(result.sourceAmendmentSchema, null, 2)}\n`);
  const candidateSha256 = sha(candidateBytes);
  const targetPostimages = result.candidate.exactFileTargets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256}));
  const rootDecisionTemplate = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-root-decision-template.v4',
    artifactKind: 'PENDING_SOURCE_OWNER_DECISION_TEMPLATE_NOT_AN_APPROVAL',
    status: 'PENDING_DISTINCT_PEER_REVIEW_AND_ROOT_TECHNICAL_SOURCE_OWNER_DECISION',
    candidateRef: `${folder}/AUD-SPEC-002-source-amendment-candidate.v4.json`,
    candidateSha256,
    candidatePostimageSha256: result.candidate.candidatePostimageSha256,
    candidateSchemaRef: `${folder}/AUD-SPEC-002-source-amendment-candidate.v4.schema.json`,
    candidateSchemaSha256: sha(candidateSchemaBytes),
    sourceAmendmentRef: `${folder}/AUD-SPEC-002-source-amendment-postimage.v4.json`,
    sourceAmendmentSha256: sha(result.sourceAmendmentBytes),
    sourceAmendmentSchemaRef: `${folder}/AUD-SPEC-002-source-amendment-postimage.v4.schema.json`,
    sourceAmendmentSchemaSha256: sha(sourceAmendmentSchemaBytes),
    sourceBindings: result.candidate.sourceBindings,
    exactTargetPostimages: targetPostimages,
    proposalMeaning: {
      ordinaryCompile: 'Retains the existing graph/project-plan candidate and emits no migration candidate when no migration is requested.',
      supportedMigration: 'Adds a separate version-bound schema-migration candidate and semantic diff only for the exact supported migration input predicate; original source is preserved and no migration is applied.',
      unsupportedOrUnknown: 'Keeps unsupported, lossy, ambiguous, stale, or unknown migration inputs UNKNOWN/UNSUPPORTED with no migration candidate.',
      selector: result.candidate.resultVariantSelector,
    },
    historicalBoundary: {historicOwnerAdjudications: 462, historicTrustRecords: 462, additiveProposedRows: 1, currentProposedTotal: 463},
    technicalSourceOwnerDecision: {status: 'PENDING', decisionRef: null, identity: null, role: null, decision: null},
    distinctTechnicalPeerReview: {status: 'PENDING', reviewRef: `${folder}/AUD-SPEC-002-source-amendment-independent-peer.v4.json`, identity: null, reviewedCandidateSha256: null, reviewedPostimageSha256: null},
    canonicalApply: 'NOT_PERFORMED',
    authorityBoundary: {independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeProof: 'NOT_CLAIMED', trustedIssuerOrCredentialRegistration: 'NOT_REQUESTED'},
  };
  const rootDecisionTemplateBytes = Buffer.from(`${JSON.stringify(rootDecisionTemplate, null, 2)}\n`);
  const producerRefs = [
    'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v3.mjs',
    'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v4.mjs',
    'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v4-apply.mjs',
    'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v4.mjs',
    'tests/media-pdp0-aud-spec-002-source-amendment-v4.test.mjs',
  ];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(read(ref))]));
  const files = new Map([
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v4.schema.json`, candidateSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v4.schema.json`, sourceAmendmentSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v4.json`, candidateBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v4.json`, result.sourceAmendmentBytes],
    [`${folder}/AUD-SPEC-002-capabilities-file-postimage.v4.yaml`, result.postimages[refs.capabilities]],
    [`${folder}/AUD-SPEC-002-requirements-file-postimage.v4.yaml`, result.postimages[refs.requirements]],
    [`${folder}/AUD-SPEC-002-crosswalk-postimage.v4.json`, result.postimages[refs.crosswalk]],
    [`${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v4.yaml`, result.postimages[refs.capabilityLeafReview]],
    [`${folder}/AUD-SPEC-002-source-amendment-root-decision.v4.json`, rootDecisionTemplateBytes],
  ]);
  const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');
  const ajv = new Ajv2020({strict: true});
  if (!ajv.compile(result.schema)(result.candidate)) throw new Error('v4 candidate does not pass its frozen candidate schema');
  if (!ajv.compile(result.sourceAmendmentSchema)(result.sourceAmendment)) throw new Error('v4 postimage does not pass its frozen source-amendment schema');
  const artifactPins = Object.fromEntries([...files].map(([ref, bytes]) => [ref, sha(bytes)]));
  const manifest = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-v4-freeze-manifest.v1',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_PEER_REVIEW_AND_ROOT_SOURCE_OWNER_DECISION',
    candidateSha256, candidatePostimageSha256: result.candidate.candidatePostimageSha256,
    candidateSchemaSha256: sha(candidateSchemaBytes), sourceAmendmentSha256: sha(result.sourceAmendmentBytes),
    sourceAmendmentSchemaSha256: sha(sourceAmendmentSchemaBytes), sourcePins: result.candidate.sourceBindings,
    exactArtifactPins: artifactPins, producerPins,
    targetPostimages, canonicalApply: 'NOT_PERFORMED',
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {files, manifest, manifestBytes};
}

export function writeAudSpec002V4({check = false} = {}) {
  const {files, manifest, manifestBytes} = prepareAudSpec002V4();
  const manifestRef = `${folder}/AUD-SPEC-002-source-amendment-v4-freeze-manifest.v1.json`;
  const all = new Map([...files, [manifestRef, manifestBytes]]);
  if (check) {
    for (const [ref, bytes] of all) {
      const full = path.join(root, ref);
      if (!fs.existsSync(full) || !fs.readFileSync(full).equals(bytes)) throw new Error(`frozen v4 artifact differs from current sources: ${ref}`);
    }
  } else {
    for (const [ref, bytes] of all) writeImmutable(ref, bytes);
  }
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = writeAudSpec002V4({check: process.argv.includes('--check')});
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
