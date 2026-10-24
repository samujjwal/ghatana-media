#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildAudSpec002SourceAmendmentV5} from './lib/media-pdp0-aud-spec-002-source-amendment-v5.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const writeImmutable = (ref, bytes) => {
  const full = path.join(root, ref);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  if (fs.existsSync(full)) {
    if (!fs.readFileSync(full).equals(bytes)) throw new Error(`refusing to overwrite frozen v5 artifact: ${ref}`);
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
  campaignExtensions: '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  decisionLog: '.product-experience/decision-log.md',
  rootDecision: '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
  observedV2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  observedV2SourceAmendment: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  observedV2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
  observedV4Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v4.json`,
  v4FreezeManifest: `${folder}/AUD-SPEC-002-source-amendment-v4-freeze-manifest.v1.json`,
  v4SourceAmendment: `${folder}/AUD-SPEC-002-source-amendment-postimage.v4.json`,
  v4CapabilityPostimage: `${folder}/AUD-SPEC-002-capabilities-file-postimage.v4.yaml`,
  v4RequirementPostimage: `${folder}/AUD-SPEC-002-requirements-file-postimage.v4.yaml`,
  v4CrosswalkPostimage: `${folder}/AUD-SPEC-002-crosswalk-postimage.v4.json`,
  v4ReviewPostimage: `${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v4.yaml`,
};

export function prepareAudSpec002V5() {
  const result = buildAudSpec002SourceAmendmentV5({
    crosswalkBytes: read(refs.crosswalk), auditBytes: read(refs.audit), capabilitiesBytes: read(refs.capabilities),
    requirementsBytes: read(refs.requirements), capabilityLeafReviewBytes: read(refs.capabilityLeafReview),
    applicationsChannelsBytes: read(refs.applicationsChannels), campaignExtensionsBytes: read(refs.campaignExtensions),
    decisionLogBytes: read(refs.decisionLog), rootDecisionBytes: read(refs.rootDecision),
    observedV2CandidateBytes: read(refs.observedV2Candidate), observedV2SourceAmendmentBytes: read(refs.observedV2SourceAmendment),
    observedV2CrosswalkBytes: read(refs.observedV2Crosswalk), observedV4CandidateBytes: read(refs.observedV4Candidate),
    v4FreezeManifestBytes: read(refs.v4FreezeManifest), frozenV4SourceAmendmentBytes: read(refs.v4SourceAmendment),
    frozenV4PostimageBytes: {
      [refs.capabilities]: read(refs.v4CapabilityPostimage), [refs.requirements]: read(refs.v4RequirementPostimage),
      [refs.crosswalk]: read(refs.v4CrosswalkPostimage), [refs.capabilityLeafReview]: read(refs.v4ReviewPostimage),
    },
  });
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const candidateSchemaBytes = Buffer.from(`${JSON.stringify(result.candidateSchema, null, 2)}\n`);
  const sourceAmendmentSchemaBytes = Buffer.from(`${JSON.stringify(result.sourceAmendmentSchema, null, 2)}\n`);
  const targetPostimages = result.candidate.exactFileTargets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256}));
  const producerRefs = [
    'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v5.mjs',
    'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v5.mjs',
    'tests/media-pdp0-aud-spec-002-source-amendment-v5.test.mjs',
    'scripts/check-media-pdp0-surface-denominator.mjs',
    'scripts/lib/media-product-definition-residuals.mjs',
  ];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(read(ref))]));
  const files = new Map([
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v5.schema.json`, candidateSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v5.schema.json`, sourceAmendmentSchemaBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-candidate.v5.json`, candidateBytes],
    [`${folder}/AUD-SPEC-002-source-amendment-postimage.v5.json`, result.sourceAmendmentBytes],
    [`${folder}/AUD-SPEC-002-capabilities-file-postimage.v5.yaml`, result.postimages[refs.capabilities]],
    [`${folder}/AUD-SPEC-002-requirements-file-postimage.v5.yaml`, result.postimages[refs.requirements]],
    [`${folder}/AUD-SPEC-002-crosswalk-postimage.v5.json`, result.postimages[refs.crosswalk]],
    [`${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v5.yaml`, result.postimages[refs.capabilityLeafReview]],
    [`${folder}/AUD-SPEC-002-campaign-extensions-postimage.v5.yaml`, result.postimages[refs.campaignExtensions]],
    [`${folder}/AUD-SPEC-002-decision-log-postimage.v5.md`, result.postimages[refs.decisionLog]],
  ]);
  const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');
  const ajv = new Ajv2020({strict: true});
  if (!ajv.compile(result.candidateSchema)(result.candidate)) throw new Error('v5 candidate does not pass its candidate schema');
  if (!ajv.compile(result.sourceAmendmentSchema)(result.sourceAmendment)) throw new Error('v5 postimage does not pass its source-amendment schema');
  const exactArtifactPins = Object.fromEntries([...files].map(([ref, bytes]) => [ref, sha(bytes)]));
  const manifest = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-v5-freeze-manifest.v1',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_ROOT_SOURCE_OWNER_REVIEW',
    candidateSha256: sha(candidateBytes), candidatePostimageSha256: result.candidate.candidatePostimageSha256,
    candidateSchemaSha256: sha(candidateSchemaBytes), sourceAmendmentSha256: sha(result.sourceAmendmentBytes),
    sourceAmendmentSchemaSha256: sha(sourceAmendmentSchemaBytes), sourcePins: result.candidate.sourceBindings,
    exactArtifactPins, producerPins, targetPostimages, canonicalApply: 'NOT_PERFORMED',
    boundary: {currentVersion: '462_HISTORICAL_BASE_PLUS_ONE_CURRENT_COMPILE_EXTENSION', futureExtensions: 6,
      qualityApplicability: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_REVIEW', pdp1Handoff: 'HISTORICAL_462_ONLY', phaseStatus: 'UNCHANGED',
      independentAcceptance: 'NOT_CLAIMED', nativeProof: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED'},
  };
  return {files, manifest, manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)};
}

export function writeAudSpec002V5({check = false} = {}) {
  const {files, manifest, manifestBytes} = prepareAudSpec002V5();
  const all = new Map([...files, [`${folder}/AUD-SPEC-002-source-amendment-v5-freeze-manifest.v1.json`, manifestBytes]]);
  if (check) {
    for (const [ref, bytes] of all) {
      const full = path.join(root, ref);
      if (!fs.existsSync(full) || !fs.readFileSync(full).equals(bytes)) throw new Error(`frozen v5 artifact differs from current sources: ${ref}`);
    }
  } else {
    for (const [ref, bytes] of all) writeImmutable(ref, bytes);
  }
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = writeAudSpec002V5({check: process.argv.includes('--check')});
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
