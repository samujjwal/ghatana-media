import {createHash} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FOLDER = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const V6_REF = `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v6.json`;
const CURRENT_PEER_BLOCKER = 'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V7_SIX_SOURCE_POSTIMAGE_REQUIRED';
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
const clone = value => structuredClone(value);
function ensure(value, message) { if (!value) throw new Error(message); }

export function buildAudSpec002SourceAmendmentV7({v6CandidateBytes, v6CandidateSchemaBytes, v6SourceAmendmentBytes, v6SourceAmendmentSchemaBytes, v6ManifestBytes}) {
  const v6Candidate = JSON.parse(bytes(v6CandidateBytes).toString('utf8'));
  const v6Schema = JSON.parse(bytes(v6CandidateSchemaBytes).toString('utf8'));
  const v6Amendment = JSON.parse(bytes(v6SourceAmendmentBytes).toString('utf8'));
  const v6AmendmentSchema = JSON.parse(bytes(v6SourceAmendmentSchemaBytes).toString('utf8'));
  const v6Manifest = JSON.parse(bytes(v6ManifestBytes).toString('utf8'));
  ensure(v6Candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v6'
      && sha(bytes(v6CandidateBytes)) === v6Manifest.candidateSha256 && v6Candidate.canonicalApply === 'NOT_PERFORMED',
    'frozen v6 source candidate or manifest is missing/mismatched');
  ensure(v6Candidate.blockers.includes('DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V5_SIX_SOURCE_POSTIMAGE_REQUIRED'),
    'the expected stale v5 blocker literal is absent; refusing an unrelated v7 metadata successor');
  const predecessorSha256 = sha(bytes(v6CandidateBytes));
  const candidate = clone(v6Candidate);
  candidate.schemaVersion = 'media.pdp0.aud-spec-002-source-amendment-candidate.v7';
  candidate.predecessorCandidateRef = V6_REF;
  candidate.predecessorCandidateSha256 = predecessorSha256;
  candidate.blockers = candidate.blockers.map(value => value === 'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V5_SIX_SOURCE_POSTIMAGE_REQUIRED' ? CURRENT_PEER_BLOCKER : value);
  ensure(candidate.blockers.includes(CURRENT_PEER_BLOCKER) && !candidate.blockers.some(value => value.includes('EXACT_V5_SIX_SOURCE')),
    'v7 blockers do not identify the current exact postimage peer review');
  const candidateSchema = clone(v6Schema);
  candidateSchema.$id = 'media.pdp0.aud-spec-002-source-amendment-candidate.v7';
  candidateSchema.properties.schemaVersion.const = 'media.pdp0.aud-spec-002-source-amendment-candidate.v7';
  candidateSchema.properties.predecessorCandidateRef.const = V6_REF;

  const sourceAmendment = clone(v6Amendment);
  delete sourceAmendment.predecessorV5;
  sourceAmendment.predecessorV6 = {ref: V6_REF, sha256: predecessorSha256, immutable: true};
  sourceAmendment.schemaVersion = 'media.pdp0.aud-spec-002-source-amendment-postimage.v7';
  const sourceAmendmentSchema = clone(v6AmendmentSchema);
  sourceAmendmentSchema.$id = 'media.pdp0.aud-spec-002-source-amendment-postimage.v7';
  sourceAmendmentSchema.properties.schemaVersion.const = 'media.pdp0.aud-spec-002-source-amendment-postimage.v7';
  sourceAmendmentSchema.required = sourceAmendmentSchema.required.map(key => key === 'predecessorV5' ? 'predecessorV6' : key);
  const predecessorSchema = sourceAmendmentSchema.properties.predecessorV5;
  ensure(predecessorSchema, 'frozen v6 source amendment schema lacks predecessorV5');
  delete sourceAmendmentSchema.properties.predecessorV5;
  sourceAmendmentSchema.properties.predecessorV6 = {...predecessorSchema, properties: {...predecessorSchema.properties, ref: {const: V6_REF}}};
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment,null,2)}\n`);
  const components = {...candidate.postimageSha256, sourceAmendmentJson: sha(sourceAmendmentBytes)};
  candidate.candidatePostimageSha256 = sha(Buffer.from(JSON.stringify(components)));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate,null,2)}\n`);
  return {candidate,candidateBytes,candidateSchema,sourceAmendment,sourceAmendmentBytes,sourceAmendmentSchema,
    predecessorV6Sha256:predecessorSha256, targetRows:clone(v6Candidate.exactFileTargets), v6Manifest};
}

export function validateAudSpec002V7Metadata(candidate, sourceAmendment) {
  ensure(candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v7'
    && candidate.blockers.includes(CURRENT_PEER_BLOCKER), 'v7 must require peer review of the exact current v7 postimage');
  ensure(sourceAmendment.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-postimage.v7'
    && sourceAmendment.predecessorV6?.immutable === true && sourceAmendment.authorityBoundary?.technicalPeer === 'PENDING',
  'v7 source amendment must bind the immutable v6 predecessor and keep peer review pending');
  ensure(candidate.canonicalApply === 'NOT_PERFORMED' && candidate.effects?.sourceWrite === 'NOT_PERFORMED'
    && candidate.effects?.phaseStatus === 'UNCHANGED' && candidate.effects?.sourceCurrentness === 'NOT_CLAIMED',
  'v7 metadata successor must not promote source or phase state');
  return true;
}
