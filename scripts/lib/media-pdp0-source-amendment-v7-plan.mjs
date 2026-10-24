import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV7} from './media-pdp0-aud-spec-002-source-amendment-v7.mjs';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const V7_CANDIDATE = `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.json`;
const V7_CANDIDATE_SCHEMA = `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`;
const V7_POSTIMAGE = `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.json`;
const V7_POSTIMAGE_SCHEMA = `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`;
const V7_MANIFEST = `${OBS}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`;
const V7_PEER = `${OBS}/AUD-SPEC-002-source-amendment-independent-peer.v7.json`;
const V7_OWNER_DECISION = `${OBS}/AUD-SPEC-002-source-owner-decision.v7.json`;
const V7_APPLY_AUTHORIZATION = `${OBS}/AUD-SPEC-002-source-amendment-apply-authorization.v7.json`;
const V7_DECISION_SCHEMA = `${OBS}/AUD-SPEC-002-source-owner-decision.v7.schema.json`;
const V7_APPLY_AUTH_SCHEMA = `${OBS}/AUD-SPEC-002-source-amendment-apply-authorization.v7.schema.json`;
const V7_PLAN_SCHEMA = `${OBS}/AUD-SPEC-002-source-amendment-cas-plan.v7.schema.json`;
const DECISION_REF = '.product-experience/decision-log.md#PXD-226';
const SOURCE_OWNER_ID = 'agent:thread:01a169b7-6b81-71b0-89c7-19ae122dc16e';
const PEER_ID = 'agent:thread:01a16a35-bbcf-74d2-ac99-1ed74c29c3c9';
const TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
]);
const V6 = Object.freeze({
  candidate: `${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.json`,
  candidateSchema: `${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`,
  postimage: `${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.json`,
  postimageSchema: `${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`,
  manifest: `${OBS}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`,
});
const TARGET_POSTIMAGES = Object.freeze({
  [TARGETS[0]]: `${OBS}/AUD-SPEC-002-capabilities-file-postimage.v6.yaml`,
  [TARGETS[1]]: `${OBS}/AUD-SPEC-002-requirements-file-postimage.v6.yaml`,
  [TARGETS[2]]: `${OBS}/AUD-SPEC-002-crosswalk-postimage.v6.json`,
  [TARGETS[3]]: `${OBS}/AUD-SPEC-002-capability-leaf-review-postimage.v6.yaml`,
  [TARGETS[4]]: `${OBS}/AUD-SPEC-002-campaign-extensions-postimage.v6.yaml`,
  [TARGETS[5]]: `${OBS}/AUD-SPEC-002-decision-log-postimage.v6.md`,
});
const PRODUCERS = Object.freeze([
  'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v7.mjs',
  'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v7.mjs',
  'tests/media-pdp0-aud-spec-002-source-amendment-v7.test.mjs',
  'scripts/lib/media-pdp0-aud-spec-002-source-amendment-v6.mjs',
  'scripts/plan-media-pdp0-aud-spec-002-source-amendment-v6.mjs',
  'tests/media-pdp0-aud-spec-002-source-amendment-v6.test.mjs',
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const shaPattern = /^[a-f0-9]{64}$/u;

export function createV7SourceOwnerDecisionSchema({sourceBindings, targetPostimages, manifestSha256, peerSha256} = {}) {
  const sourcePropertyNames=['rootDecisionSha256','capabilitiesSha256','requirementsSha256','crosswalkSha256','capabilityLeafReviewSha256','campaignExtensionsSha256','applicationsChannelsSha256','auditSha256','decisionLogSha256'];
  const sourceProperties=Object.fromEntries(sourcePropertyNames.map(key=>[key,sourceBindings?.[key]?{const:sourceBindings[key]}:{type:'string',pattern:'^[a-f0-9]{64}$'}]));
  const targetProperties = Object.fromEntries(TARGETS.map(ref => [ref, targetPostimages?.[ref] ? {const:targetPostimages[ref]} : {type:'string',pattern:'^[a-f0-9]{64}$'}]));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'media.pdp0.source-amendment-owner-decision.v7',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','decisionKind','candidateRef','candidateSha256','candidatePostimageSha256','freezeManifestRef','freezeManifestSha256','sourceBindings','targetPostimages','decisionRef','decisionSectionSha256','sourceOwner','technicalPeerReviewRef','technicalPeerReviewSha256','disposition','authorityBoundary'],
    properties: {
      schemaVersion: {const: 'media.pdp0.source-amendment-owner-decision.v7'}, decisionKind: {const: 'EXACT_PDP0_SOURCE_AMENDMENT'},
      candidateRef: {const: V7_CANDIDATE}, candidateSha256: {const: 'c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc'},
      candidatePostimageSha256: {const: 'd1e0b9b8cea7e7f23aa339fd4a12cde29fc9d14b52e821e8a00f8f113fb8d187'},
      freezeManifestRef: {const: V7_MANIFEST}, freezeManifestSha256: manifestSha256?{const:manifestSha256}:{type: 'string', pattern: '^[a-f0-9]{64}$'},
      sourceBindings: {type: 'object', additionalProperties: false, required: sourcePropertyNames, properties: sourceProperties},
      targetPostimages: {type:'object',additionalProperties:false,required:TARGETS,properties:targetProperties},
      decisionRef: {const: DECISION_REF}, decisionSectionSha256: {type:'string',pattern:'^[a-f0-9]{64}$'},
      sourceOwner: {type:'object',additionalProperties:false,required:['identity','role'],properties:{identity:{const:SOURCE_OWNER_ID},role:{const:'PDP0_SOURCE_OWNER'}}},
      technicalPeerReviewRef: {const: V7_PEER}, technicalPeerReviewSha256: peerSha256?{const:peerSha256}:{type:'string',pattern:'^[a-f0-9]{64}$'},
      disposition: {const:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY'},
      authorityBoundary: {type:'object',additionalProperties:false,required:['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'],properties:{ownerApproval:{const:'NOT_CLAIMED'},independentAcceptance:{const:'NOT_CLAIMED'},phaseStatusEffect:{const:'NONE'},runtimeAdmission:{const:'NOT_ADMITTED'},nativeClosure:{const:'NOT_CLAIMED'}}},
    },
  };
}

export function createV7ApplyAuthorizationSchema() {
  return {
    $schema:'https://json-schema.org/draft/2020-12/schema',$id:'media.pdp0.source-amendment-apply-authorization.v7',
    type:'object',additionalProperties:false,
    required:['schemaVersion','effect','authorizationId','candidateRef','candidateSha256','candidatePostimageSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','technicalPeerReviewRef','technicalPeerReviewSha256','decisionRef','decisionSectionSha256','targetPostimages','currentRootGrant','authorityBoundary'],
    properties:{
      schemaVersion:{const:'media.pdp0.source-amendment-apply-authorization.v7'},effect:{const:'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT_V7'},authorizationId:{type:'string',minLength:1},
      candidateRef:{const:V7_CANDIDATE},candidateSha256:{const:'c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc'},candidatePostimageSha256:{const:'d1e0b9b8cea7e7f23aa339fd4a12cde29fc9d14b52e821e8a00f8f113fb8d187'},
      sourceOwnerDecisionRef:{const:V7_OWNER_DECISION},sourceOwnerDecisionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},technicalPeerReviewRef:{const:V7_PEER},technicalPeerReviewSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
      decisionRef:{const:DECISION_REF},decisionSectionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},targetPostimages:{type:'object',additionalProperties:false,required:TARGETS,properties:Object.fromEntries(TARGETS.map(ref=>[ref,{type:'string',pattern:'^[a-f0-9]{64}$'}]))},
      currentRootGrant:{type:'object',additionalProperties:false,required:['grantId','status','issuerIdentity','candidateSha256','candidatePostimageSha256','sourceOwnerDecisionSha256','technicalPeerReviewSha256','decisionRef','decisionSectionSha256','targetPostimages'],properties:{grantId:{type:'string',minLength:1},status:{const:'CURRENT'},issuerIdentity:{const:SOURCE_OWNER_ID},candidateSha256:{const:'c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc'},candidatePostimageSha256:{const:'d1e0b9b8cea7e7f23aa339fd4a12cde29fc9d14b52e821e8a00f8f113fb8d187'},sourceOwnerDecisionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},technicalPeerReviewSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},decisionRef:{const:DECISION_REF},decisionSectionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},targetPostimages:{type:'object',additionalProperties:false,required:TARGETS,properties:Object.fromEntries(TARGETS.map(ref=>[ref,{type:'string',pattern:'^[a-f0-9]{64}$'}]))}}},
      authorityBoundary:{type:'object',additionalProperties:false,required:['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'],properties:{ownerApproval:{const:'NOT_CLAIMED'},independentAcceptance:{const:'NOT_CLAIMED'},phaseStatusEffect:{const:'NONE'},runtimeAdmission:{const:'NOT_ADMITTED'},nativeClosure:{const:'NOT_CLAIMED'}}},
    },
  };
}

export function createV7CasPlanSchema() {
  const props = {
    schemaVersion:{const:'media.pdp0.source-amendment-cas-plan.six-file.v1'},
    planKind:{const:'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN'},
    planDisposition:{enum:['BLOCKED_AWAITING_EXACT_V7_OWNER_PEER_AND_CURRENT_ROOT_GRANT','READY_EXACT_V7_CUT_WITH_CURRENT_ROOT_GRANT_NO_WRITE_PERFORMED']},
    candidateRef:{const:V7_CANDIDATE}, candidateSchemaVersion:{const:'media.pdp0.aud-spec-002-source-amendment-candidate.v7'},
    candidateSha256:{const:'c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc'},
    candidatePostimageSha256:{const:'d1e0b9b8cea7e7f23aa339fd4a12cde29fc9d14b52e821e8a00f8f113fb8d187'},
    sourceOwnerDecisionRef:{const:V7_OWNER_DECISION}, sourceOwnerDecisionSha256:{anyOf:[{type:'string',pattern:'^[a-f0-9]{64}$'},{type:'null'}]},
    technicalPeerReviewRef:{const:V7_PEER}, technicalPeerReviewSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
    applyAuthorizationRef:{const:V7_APPLY_AUTHORIZATION}, applyAuthorizationSha256:{anyOf:[{type:'string',pattern:'^[a-f0-9]{64}$'},{type:'null'}]},
    decisionRef:{const:DECISION_REF}, decisionSectionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
    sourceOwnerIdentity:{const:SOURCE_OWNER_ID}, sourceOwnerRole:{const:'PDP0_SOURCE_OWNER'}, peerIdentity:{const:PEER_ID},
    rootGrantRef:{const:V7_APPLY_AUTHORIZATION}, rootGrantCurrent:{type:'boolean'}, blockers:{type:'array',items:{type:'string'}},
    requiredSourceOwnerDecisionSchemaRef:{const:V7_DECISION_SCHEMA},requiredApplyAuthorizationSchemaRef:{const:V7_APPLY_AUTH_SCHEMA},
    journalRef:{type:'string',minLength:1},effects:{type:'object',additionalProperties:false,required:['canonicalWrite','sourceStatus','phaseStatus','independentAcceptance','nativeClosure'],properties:{canonicalWrite:{const:'NOT_PERFORMED'},sourceStatus:{const:'UNCHANGED'},phaseStatus:{const:'UNCHANGED'},independentAcceptance:{const:'NOT_CLAIMED'},nativeClosure:{const:'NOT_CLAIMED'}}},
    targets:{type:'array',minItems:6,maxItems:6,items:{type:'object',additionalProperties:false,
      required:['targetRef','expectedPreimageSha256','expectedPostimageSha256','immutablePreimageRef'],
      properties:{targetRef:{enum:TARGETS},expectedPreimageSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
        expectedPostimageSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},immutablePreimageRef:{type:'string',minLength:1}}}},
    authorityBoundary:{type:'object',additionalProperties:false,required:['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'],
      properties:{ownerApproval:{const:'NOT_CLAIMED'},independentAcceptance:{const:'NOT_CLAIMED'},phaseStatusEffect:{const:'NONE'},runtimeAdmission:{const:'NOT_ADMITTED'},nativeClosure:{const:'NOT_CLAIMED'}}},
  };
  return {$schema:'https://json-schema.org/draft/2020-12/schema',$id:'media.pdp0.source-amendment-cas-plan.v7',type:'object',additionalProperties:false,
    required:Object.keys(props),properties:props};
}

function contained(root, ref) {
  const lifecycle = ref.startsWith('ghatana-lifecycle:');
  const base = lifecycle ? path.resolve(root, '..', 'ghatana-lifecycle') : root;
  const suffix = lifecycle ? ref.slice('ghatana-lifecycle:'.length) : ref;
  const absolute = path.resolve(base, suffix);
  const rel = path.relative(base, absolute);
  if (!suffix || path.isAbsolute(suffix) || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`source ref escapes its repository root: ${ref}`);
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`source ref contains a symlink: ${ref}`);
    if (current !== absolute && !stat.isDirectory()) throw new Error(`source parent is not a directory: ${ref}`);
  }
  if (!fs.lstatSync(absolute).isFile()) throw new Error(`source ref is not a regular file: ${ref}`);
  return absolute;
}

function readRef(root, ref) { return fs.readFileSync(contained(root, ref)); }
function json(bytes, label) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${label} is not valid JSON`); } }
function sourceOwnerDecisionValid({decision, decisionText, candidate, candidateSha256, manifestBytes, peer, peerSha256, targetMap, decisionSectionSha256, validate}) {
  if (!validate(decision)) return false;
  return decision.schemaVersion === 'media.pdp0.source-amendment-owner-decision.v7'
    && decision.decisionKind === 'EXACT_PDP0_SOURCE_AMENDMENT' && decision.candidateRef === V7_CANDIDATE
    && decision.candidateSha256 === candidateSha256 && decision.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && decision.freezeManifestRef === V7_MANIFEST && decision.freezeManifestSha256 === sha(manifestBytes)
    && same(decision.sourceBindings, candidate.sourceBindings) && same(decision.targetPostimages, targetMap)
    && decision.decisionRef === DECISION_REF && decision.decisionSectionSha256 === decisionSectionSha256
    && decision.sourceOwner?.identity === SOURCE_OWNER_ID && decision.sourceOwner?.role === 'PDP0_SOURCE_OWNER'
    && decision.technicalPeerReviewRef === V7_PEER && decision.technicalPeerReviewSha256 === peerSha256
    && peer.reviewer?.identity === PEER_ID && decision.disposition === 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY'
    && decisionText.length > 0;
}

function peerReviewValid(peer, candidate, candidateSha256, manifest, manifestSha256, targetMap, root) {
  const origin = peer.sourceOrigin;
  if (!origin || origin.identity !== PEER_ID || origin.identityBasis !== 'Explicit user-provided identity correction in the active coordination thread; not a cryptographic identity proof.') return false;
  try {
    if (sha(readRef(root, origin.correctedSuccessorRef)) !== origin.correctedSuccessorSha256) return false;
    if (sha(readRef(root, origin.priorReviewRecordRef)) !== origin.priorReviewRecordSha256) return false;
  } catch { return false; }
  return peer.schemaVersion === 'media.pdp0.source-amendment-independent-peer.v7'
    && peer.fixedPeerRef === V7_PEER && peer.candidateRef === V7_CANDIDATE && peer.candidateSha256 === candidateSha256
    && peer.candidatePostimageSha256 === candidate.candidatePostimageSha256 && peer.freezeManifestRef === V7_MANIFEST
    && peer.freezeManifestSha256 === manifestSha256 && peer.disposition === 'TECHNICAL_APPROVE_EXACT_CANDIDATE_ONLY'
    && peer.reviewer?.identity === PEER_ID && peer.reviewer?.role === 'DISTINCT_TECHNICAL_PEER'
    && peer.reviewer?.independentOfCandidateAuthor === true && peer.reviewer?.independentHumanReviewer === false
    && peer.reviewer?.credentialedAttestation === false && same(peer.targetPostimages, targetMap)
    && same(peer.sourceBindings, candidate.sourceBindings) && Array.isArray(peer.semanticFindings) && peer.semanticFindings.length === 0
    && peer.reviewBinding?.exactCutSha256?.v7Candidate === candidateSha256
    && peer.reviewBinding?.exactCutSha256?.v7Manifest === manifestSha256;
}

function authorizationValid(auth, candidate, candidateSha256, ownerSha256, peerSha256, targetMap, decisionSectionSha256, validate) {
  if (!validate(auth)) return false;
  return auth.schemaVersion === 'media.pdp0.source-amendment-apply-authorization.v7'
    && auth.effect === 'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT_V7'
    && auth.authorizationId === `MEDIA-AUD-SPEC-002-V7-APPLY-${candidateSha256.slice(0, 12)}`
    && auth.candidateRef === V7_CANDIDATE && auth.candidateSha256 === candidateSha256
    && auth.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && auth.sourceOwnerDecisionRef === V7_OWNER_DECISION && auth.sourceOwnerDecisionSha256 === ownerSha256
    && auth.technicalPeerReviewRef === V7_PEER && auth.technicalPeerReviewSha256 === peerSha256
    && auth.decisionRef === DECISION_REF && auth.decisionSectionSha256 === decisionSectionSha256
    && same(auth.targetPostimages, targetMap)
    && auth.currentRootGrant?.status === 'CURRENT' && auth.currentRootGrant.issuerIdentity === SOURCE_OWNER_ID
    && auth.currentRootGrant.candidateSha256 === candidateSha256
    && auth.currentRootGrant.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && auth.currentRootGrant.sourceOwnerDecisionSha256 === ownerSha256
    && auth.currentRootGrant.technicalPeerReviewSha256 === peerSha256
    && auth.currentRootGrant.decisionRef === DECISION_REF
    && auth.currentRootGrant.decisionSectionSha256 === decisionSectionSha256
    && same(auth.currentRootGrant.targetPostimages, targetMap);
}

/** Rebuilds a v7 owner plan from exact fixed files. It never accepts a caller-supplied plan or writes canonical sources. */
export function prepareMediaPdp0SourceAmendmentV7CasPlan({root = REPO_ROOT} = {}) {
  const rootPath = fs.realpathSync(path.resolve(root));
  if (!fs.lstatSync(rootPath).isDirectory()) throw new Error('Media repository root must resolve to a directory');
  const read = ref => readRef(rootPath, ref);
  const blocker = [];
  const manifestBytes = read(V7_MANIFEST), manifest = json(manifestBytes, 'v7 freeze manifest');
  const candidateBytes = read(V7_CANDIDATE), candidate = json(candidateBytes, 'v7 candidate');
  const candidateSchemaBytes = read(V7_CANDIDATE_SCHEMA), candidateSchema = json(candidateSchemaBytes, 'v7 candidate schema');
  const amendmentBytes = read(V7_POSTIMAGE), amendment = json(amendmentBytes, 'v7 amendment');
  const amendmentSchemaBytes = read(V7_POSTIMAGE_SCHEMA), amendmentSchema = json(amendmentSchemaBytes, 'v7 amendment schema');
  const v6Bytes = Object.fromEntries(Object.entries(V6).map(([key, ref]) => [key, read(ref)]));
  const built = buildAudSpec002SourceAmendmentV7({v6CandidateBytes:v6Bytes.candidate,v6CandidateSchemaBytes:v6Bytes.candidateSchema,v6SourceAmendmentBytes:v6Bytes.postimage,v6SourceAmendmentSchemaBytes:v6Bytes.postimageSchema,v6ManifestBytes:v6Bytes.manifest});
  const rebuiltCandidateSchema = Buffer.from(`${JSON.stringify(built.candidateSchema,null,2)}\n`);
  const rebuiltAmendmentSchema = Buffer.from(`${JSON.stringify(built.sourceAmendmentSchema,null,2)}\n`);
  if (!candidateBytes.equals(built.candidateBytes) || !candidateSchemaBytes.equals(rebuiltCandidateSchema)
      || !amendmentBytes.equals(built.sourceAmendmentBytes) || !amendmentSchemaBytes.equals(rebuiltAmendmentSchema)) {
    throw new Error('frozen v7 candidate or schema differs from reconstruction from its exact v6 predecessor');
  }
  const Ajv2020 = createRequire(path.resolve(REPO_ROOT,'../ghatana-tools/package.json'))('ajv/dist/2020');
  const ajv = new Ajv2020({strict:true});
  if (!ajv.compile(candidateSchema)(candidate) || !ajv.compile(amendmentSchema)(amendment)) throw new Error('frozen v7 artifacts fail their schemas');
  if (manifest.schemaVersion !== 'media.pdp0.aud-spec-002-source-amendment-v7-freeze-manifest.v1'
      || manifest.status !== 'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_ROOT_SOURCE_OWNER_REVIEW'
      || manifest.canonicalApply !== 'NOT_PERFORMED'
      || manifest.candidateSha256 !== sha(candidateBytes) || manifest.candidatePostimageSha256 !== candidate.candidatePostimageSha256
      || manifest.candidateSchemaSha256 !== sha(candidateSchemaBytes) || manifest.sourceAmendmentSha256 !== sha(amendmentBytes)
      || manifest.sourceAmendmentSchemaSha256 !== sha(amendmentSchemaBytes)
      || manifest.predecessorV6?.candidateSha256 !== sha(v6Bytes.candidate) || manifest.predecessorV6?.manifestSha256 !== sha(v6Bytes.manifest)) {
    throw new Error('v7 freeze manifest does not bind the exact frozen candidate, schemas, amendment, and v6 predecessor');
  }
  for (const [ref, expected] of Object.entries(manifest.producerPins ?? {})) if (sha(read(ref)) !== expected) throw new Error(`v7 producer pin is stale: ${ref}`);
  if (sha(read(manifest.reconciliationRef)) !== manifest.reconciliationSha256) throw new Error('v7 metadata reconciliation pin is stale');

  const sourceRefs = {
    rootDecisionSha256: candidate.rootDecisionRef,
    capabilitiesSha256: TARGETS[0], requirementsSha256: TARGETS[1], crosswalkSha256: TARGETS[2],
    capabilityLeafReviewSha256: TARGETS[3], campaignExtensionsSha256: TARGETS[4],
    applicationsChannelsSha256: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
    auditSha256: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
    decisionLogSha256: TARGETS[5],
  };
  for (const [key, ref] of Object.entries(sourceRefs)) {
    const bytes = read(ref);
    if (candidate.sourceBindings?.[key] !== sha(bytes)) throw new Error(`v7 candidate source binding is stale: ${key}`);
  }

  const targetMap = {};
  const targets = TARGETS.map((targetRef, index) => {
    const manifestTarget = manifest.targetPostimages?.[index];
    const expectedPostimageRef = TARGET_POSTIMAGES[targetRef];
    const preimageBytes = read(targetRef);
    const postimageRefRow = manifest.postimageArtifactRefs?.find(row => row.ref === expectedPostimageRef);
    if (!manifestTarget || manifestTarget.targetRef !== targetRef || !postimageRefRow) throw new Error(`v7 target binding is incomplete: ${targetRef}`);
    const postimageBytes = read(expectedPostimageRef);
    if (sha(preimageBytes) !== manifestTarget.preimageSha256 || sha(preimageBytes) !== candidate.exactFileTargets[index].preimageSha256
        || sha(postimageBytes) !== manifestTarget.postimageSha256 || sha(postimageBytes) !== postimageRefRow.sha256
        || sha(postimageBytes) !== candidate.exactFileTargets[index].postimageSha256) throw new Error(`v7 target preimage/postimage pin mismatch: ${targetRef}`);
    targetMap[targetRef] = sha(postimageBytes);
    return {targetRef,expectedPreimageSha256:sha(preimageBytes),expectedPostimageSha256:sha(postimageBytes),preimageBytes,postimageBytes,
      immutablePreimageRef:`${OBS}/source-amendment-preimages/${sha(candidateBytes)}/${index}-${path.basename(targetRef)}`};
  });
  if (TARGETS.some(ref => !targetMap[ref]) || !same(Object.keys(targetMap), TARGETS)) throw new Error('v7 target map is not the exact six-source set');
  const decisionSectionSha256 = fingerprintPxdDecisionSection(targets[5].postimageBytes.toString('utf8'), 'PXD-226').sha256;

  const peerBytes = read(V7_PEER); const peerSha256 = sha(peerBytes); const peer = json(peerBytes, 'v7 independent peer record');
  if (!peerReviewValid(peer,candidate,sha(candidateBytes),manifest,sha(manifestBytes),targetMap,rootPath)) blocker.push('EXACT_V7_DISTINCT_PEER_REVIEW_REQUIRED_OR_STALE');
  const decisionPath = path.resolve(rootPath,V7_OWNER_DECISION);
  let decisionBytes=null,decision=null;
  if (!fs.existsSync(decisionPath)) blocker.push('EXACT_V7_SOURCE_OWNER_DECISION_REQUIRED');
  else {
    decisionBytes=read(V7_OWNER_DECISION);decision=json(decisionBytes,'v7 source-owner decision');
    if (!sourceOwnerDecisionValid({decision,decisionText:decisionBytes.toString('utf8'),candidate,candidateSha256:sha(candidateBytes),manifestBytes,peer,peerSha256,targetMap,decisionSectionSha256,validate:validateDecisionSchema})) blocker.push('EXACT_V7_SOURCE_OWNER_DECISION_INVALID_OR_STALE');
  }
  const decisionSha256=decisionBytes?sha(decisionBytes):null;
  const authPath=path.resolve(rootPath,V7_APPLY_AUTHORIZATION);
  let authBytes=null,auth=null;
  if (!fs.existsSync(authPath)) blocker.push('CURRENT_EXACT_V7_ROOT_GRANT_REQUIRED');
  else {
    authBytes=read(V7_APPLY_AUTHORIZATION);auth=json(authBytes,'v7 apply authorization');
    if (!decisionSha256 || !authorizationValid(auth,candidate,sha(candidateBytes),decisionSha256,peerSha256,targetMap,decisionSectionSha256,validateAuthorizationSchema)) blocker.push('CURRENT_EXACT_V7_ROOT_GRANT_INVALID_OR_STALE');
  }
  const plan={schemaVersion:'media.pdp0.source-amendment-cas-plan.six-file.v1',planKind:'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN',
    planDisposition:blocker.length?'BLOCKED_AWAITING_EXACT_V7_OWNER_PEER_AND_CURRENT_ROOT_GRANT':'READY_EXACT_V7_CUT_WITH_CURRENT_ROOT_GRANT_NO_WRITE_PERFORMED',
    candidateRef:V7_CANDIDATE,candidateSchemaVersion:candidate.schemaVersion,candidateSha256:sha(candidateBytes),candidatePostimageSha256:candidate.candidatePostimageSha256,
    sourceOwnerDecisionRef:V7_OWNER_DECISION,sourceOwnerDecisionSha256:decisionSha256,technicalPeerReviewRef:V7_PEER,technicalPeerReviewSha256:peerSha256,
    applyAuthorizationRef:V7_APPLY_AUTHORIZATION,applyAuthorizationSha256:authBytes?sha(authBytes):null,decisionRef:DECISION_REF,decisionSectionSha256,
    sourceOwnerIdentity:SOURCE_OWNER_ID,sourceOwnerRole:'PDP0_SOURCE_OWNER',peerIdentity:PEER_ID,
    rootGrantRef:V7_APPLY_AUTHORIZATION,rootGrantCurrent:Boolean(authBytes&&!blocker.includes('CURRENT_EXACT_V7_ROOT_GRANT_INVALID_OR_STALE')),
    blockers:blocker,targets:targets.map(({targetRef,expectedPreimageSha256,expectedPostimageSha256,immutablePreimageRef})=>({targetRef,expectedPreimageSha256,expectedPostimageSha256,immutablePreimageRef})),
    authorityBoundary:{ownerApproval:'NOT_CLAIMED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',runtimeAdmission:'NOT_ADMITTED',nativeClosure:'NOT_CLAIMED'},
    requiredSourceOwnerDecisionSchemaRef:V7_DECISION_SCHEMA,requiredApplyAuthorizationSchemaRef:V7_APPLY_AUTH_SCHEMA,
    journalRef:`${OBS}/source-amendment-journals/${sha(candidateBytes)}.json`,effects:{canonicalWrite:'NOT_PERFORMED',sourceStatus:'UNCHANGED',phaseStatus:'UNCHANGED',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'}};
  const planSchema=createV7CasPlanSchema();
  const validatePlan=ajv.compile(planSchema);
  if (!validatePlan(plan)) throw new Error(`generated v7 CAS plan fails schema: ${ajv.errorsText(validatePlan.errors)}`);
  return {plan,targets,candidate,manifest,peer,decision,authorization:auth,planSchema};
}

function validateDecisionSchema(decision) {
  const schema=createV7SourceOwnerDecisionSchema();
  schema.properties.targetPostimages.properties=Object.fromEntries(TARGETS.map(ref=>[ref,{type:'string',pattern:'^[a-f0-9]{64}$'}]));
  return new (createRequire(path.resolve(REPO_ROOT,'../ghatana-tools/package.json'))('ajv/dist/2020'))({strict:true}).compile(schema)(decision);
}
function validateAuthorizationSchema(auth) {
  return new (createRequire(path.resolve(REPO_ROOT,'../ghatana-tools/package.json'))('ajv/dist/2020'))({strict:true}).compile(createV7ApplyAuthorizationSchema())(auth);
}

export const v7SourceAmendmentRefs=Object.freeze({candidate:V7_CANDIDATE,manifest:V7_MANIFEST,peer:V7_PEER,ownerDecision:V7_OWNER_DECISION,applyAuthorization:V7_APPLY_AUTHORIZATION,decisionSchema:V7_DECISION_SCHEMA,applyAuthorizationSchema:V7_APPLY_AUTH_SCHEMA,planSchema:V7_PLAN_SCHEMA,targets:TARGETS});
