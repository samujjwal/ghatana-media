import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {validateQualityApplicabilityPopulation} from './media-pdp0-quality-applicability-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'));
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const DECISION_LOG = '.product-experience/decision-log.md';
const QUALITY_POLICY = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const V7_POSTIMAGE_REF = `${OBS}/AUD-SPEC-002-decision-log-postimage.v6.md`;
const QUALITY_POSTIMAGE_REF = `${OBS}/AUD-SPEC-002-quality-policy-extension-postimage.v1.yaml`;
const QUALITY_POSTIMAGE_V2_REF = `${OBS}/AUD-SPEC-002-quality-policy-extension-postimage.v2.yaml`;
const V7_MANIFEST_REF = `${OBS}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`;
const PEER_REF = `${OBS}/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`;
const CANDIDATE_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.json`;
const SCHEMA_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.schema.json`;
const DECISION_SECTION_REF = `${OBS}/AUD-SPEC-002-quality-extension-pxd227-section-candidate.v1.md`;
const DECISION_POSTIMAGE_REF = `${OBS}/AUD-SPEC-002-quality-extension-decision-log-postimage.v2.md`;
const FREEZE_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json`;
const ROOT_CHOICE_REF = '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json';
const V7_TARGETS = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  `${OBS}/pdp0-501-disposition-crosswalk.json`,
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml', DECISION_LOG,
];
const TARGET_REFS = [DECISION_LOG, QUALITY_POLICY];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = ref => fs.readFileSync(path.join(ROOT, ref));
const yaml = require('yaml');
const fail = message => { throw new Error(message); };

function proposedPxd227Section({rootChoiceSha256, peerSha256, qualityCandidateSha256, qualityPostimageSha256}) {
  return `### PXD-227 — Extend compile quality applicability from the exact source rules\n\n` +
`**Predecessor:** PXD-226 remains the historical decision for the schema-migration source extension. This section supersedes only PXD-226's statement that quality applicability is unknown for media.recipe.specification.compile; it does not change the rest of PXD-226 or any historical quality row.\n\n` +
`**Source basis:** Use the source-derived technical choice ${ROOT_CHOICE_REF} (SHA-256 ${rootChoiceSha256}). The prior technical review ${PEER_REF} (SHA-256 ${peerSha256}) evaluated the V7 source candidate and V1 quality extension ${CANDIDATE_REF} (SHA-256 ${qualityCandidateSha256}). This source successor updates only the extension record's lifecycle status and adds this decision section; it requires its own distinct technical review before adoption. Its exact quality-policy postimage is ${QUALITY_POSTIMAGE_V2_REF} (SHA-256 ${qualityPostimageSha256}).\n\n` +
`**Applicability:** Add one source-owned current quality-applicability extension row for media.recipe.specification.compile. Preserve all 462 existing owner-quality rows byte-for-byte and in order; the extension yields 463 current rows and retains six future-version proposals. Rights/safety is applicable. The other five quality dimensions and all sixteen metrics are not applicable under the selected exact typed rules.\n\n` +
`**Limits:** This applicability decision defines no measurement method, threshold, qualification, acceptance, runtime admission, or phase-status change. Measurement and qualification remain not evaluated; acceptance effect is none. It does not alter PDP-1 or any later phase.\n\n` +
`**Effect:** If adopted, this section and the exact quality-policy extension are source-definition changes only. Canonical source apply remains pending a distinct source-owner decision, exact apply authorization, and the repository's guarded two-target CAS. Independent acceptance and native proof are not claimed.\n`;
}

export function prepareQualityExtensionSourceCandidateV2({readSource = read} = {}) {
  const qualityBaselineBytes = readSource(QUALITY_POLICY);
  const qualityV1PostimageBytes = readSource(QUALITY_POSTIMAGE_REF);
  const v7DecisionLogBytes = readSource(V7_POSTIMAGE_REF);
  const v7ManifestBytes = readSource(V7_MANIFEST_REF);
  const peerBytes = readSource(PEER_REF);
  const rootChoiceBytes = readSource(ROOT_CHOICE_REF);
  const qualityCandidateBytes = readSource(`${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`);
  const qualityCandidate = JSON.parse(qualityCandidateBytes.toString('utf8'));
  const v7Manifest = JSON.parse(v7ManifestBytes.toString('utf8'));
  const peer = JSON.parse(peerBytes.toString('utf8'));
  const rootChoice = JSON.parse(rootChoiceBytes.toString('utf8'));
  const v7DecisionTarget = v7Manifest.targetPostimages?.find(row => row.targetRef === DECISION_LOG);
  if (!v7DecisionTarget || v7DecisionTarget.postimageSha256 !== sha(v7DecisionLogBytes)) fail('PXD-227 base must be the exact V7 decision-log postimage');
  if (v7Manifest.targetPostimages.length !== V7_TARGETS.length
      || V7_TARGETS.some(ref => !v7Manifest.targetPostimages.some(row => row.targetRef === ref))) fail('V7 manifest does not bind all six predecessor targets');
  if (peer.reviewer?.role !== 'DISTINCT_TECHNICAL_PEER' || peer.disposition !== 'TECHNICAL_APPROVE_EXACT_CANDIDATE_ONLY'
      || peer.reviewBinding?.exactCutSha256?.qualityCandidate !== sha(qualityCandidateBytes)
      || peer.reviewBinding?.exactCutSha256?.qualityPostimage !== sha(qualityV1PostimageBytes)
      || peer.reviewBinding?.exactCutSha256?.v7Manifest !== sha(v7ManifestBytes)) fail('corrected independent peer record is not bound to the exact V7 and quality inputs');
  if (rootChoice.schemaVersion !== 'gtool.critical.technical-source-owner-choice.v1'
      || rootChoice.selectedOptionId !== 'APPLY_EXISTING_EXACT_TYPED_APPLICABILITY_RULES'
      || rootChoice.scope?.capabilityRef !== 'media.recipe.specification.compile') fail('exact R01 source-owner choice is not present');
  if (sha(qualityBaselineBytes) !== qualityCandidate.exactTarget.preimageSha256
      || sha(qualityV1PostimageBytes) !== qualityCandidate.exactTarget.postimageSha256) fail('quality extension preimage/postimage differs from the frozen V1 candidate');
  const qualityPolicy = yaml.parse(qualityV1PostimageBytes.toString('utf8'));
  const basePolicy = yaml.parse(qualityBaselineBytes.toString('utf8'));
  if (JSON.stringify(qualityPolicy.ownerQualityApplicabilityCrosswalk) !== JSON.stringify(basePolicy.ownerQualityApplicabilityCrosswalk)) fail('V1 extension changed the historical 462-row quality crosswalk');
  const population = validateQualityApplicabilityPopulation(qualityPolicy);
  if (population.historicalRows !== 462 || population.currentRowsCount !== 463 || population.futureRows !== 6) fail('quality extension row accounting changed');
  const statusPattern = /(^\s*status:\s*)SOURCE_DERIVED_DEFINITION_CANDIDATE_PENDING_MEDIA_SOURCE_ADOPTION(\s*$)/mu;
  if (!statusPattern.test(qualityV1PostimageBytes.toString('utf8'))) fail('V1 quality extension candidate lifecycle status is missing or contradictory');
  const qualityPostimageBytes = Buffer.from(qualityV1PostimageBytes.toString('utf8').replace(statusPattern, '$1SOURCE_OWNER_DEFINED_NOT_YET_CURRENT$2'));
  const qualityV2Policy = yaml.parse(qualityPostimageBytes.toString('utf8'));
  const extension = qualityV2Policy.ownerQualityApplicabilityCrosswalkExtensions;
  if (extension?.status !== 'SOURCE_OWNER_DEFINED_NOT_YET_CURRENT'
      || JSON.stringify(qualityV2Policy.ownerQualityApplicabilityCrosswalk) !== JSON.stringify(basePolicy.ownerQualityApplicabilityCrosswalk)) fail('V2 quality postimage did not preserve history and carry the source-owned lifecycle status');
  const normalizedV2 = structuredClone(qualityV2Policy);
  normalizedV2.ownerQualityApplicabilityCrosswalkExtensions.status = 'SOURCE_DERIVED_DEFINITION_CANDIDATE_PENDING_MEDIA_SOURCE_ADOPTION';
  const normalizedV1 = yaml.parse(qualityV1PostimageBytes.toString('utf8'));
  if (JSON.stringify(normalizedV2) !== JSON.stringify(normalizedV1)) fail('V2 quality postimage changes fields beyond the explicit source lifecycle status');
  validateQualityExtensionSourceDefinition(qualityV2Policy);

  const decisionSectionBytes = Buffer.from(proposedPxd227Section({rootChoiceSha256: sha(rootChoiceBytes), peerSha256: sha(peerBytes),
    qualityCandidateSha256: sha(qualityCandidateBytes), qualityPostimageSha256: sha(qualityPostimageBytes)}));
  const decisionLogText = v7DecisionLogBytes.toString('utf8');
  if (/^### PXD-227\b/mu.test(decisionLogText)) fail('PXD-227 already exists; refusing to duplicate the quality decision section');
  const decisionLogPostimageBytes = Buffer.from(`${decisionLogText.trimEnd()}\n\n${decisionSectionBytes.toString('utf8')}`);
  const targets = [
    {targetRef: DECISION_LOG, preimageRef: V7_POSTIMAGE_REF, postimageRef: DECISION_POSTIMAGE_REF,
      preimageSha256: sha(v7DecisionLogBytes), postimageSha256: sha(decisionLogPostimageBytes)},
    {targetRef: QUALITY_POLICY, preimageRef: QUALITY_POLICY, postimageRef: QUALITY_POSTIMAGE_V2_REF,
      preimageSha256: sha(qualityBaselineBytes), postimageSha256: sha(qualityPostimageBytes)},
  ];
  const candidate = {
    schemaVersion: 'media.pdp0.quality-extension-source-candidate.v2',
    artifactKind: 'TWO_TARGET_PDP0_SOURCE_QUALITY_EXTENSION_CANDIDATE',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_SOURCE_ADOPTION_REVIEW_AND_ROOT_DECISION',
    candidateAuthor: {identity:'agent:/root/phase_io', role:'DELEGATED_TECHNICAL_SOURCE_AUTHOR_NOT_EXTERNAL_QUALITY_SPECIALIST'},
    predecessor: {v7CandidateRef: `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.json`,
      v7CandidateSha256: v7Manifest.candidateSha256, v7ManifestRef: V7_MANIFEST_REF, v7ManifestSha256: sha(v7ManifestBytes),
      correctedPeerRef: PEER_REF, correctedPeerSha256: sha(peerBytes), predecessorQualityUnknownPreservedInV7: true},
    sourceChoice: {ref: ROOT_CHOICE_REF, sha256: sha(rootChoiceBytes)},
    priorQualityCandidate: {ref: `${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`, sha256: sha(qualityCandidateBytes)},
    proposedDecisionSection: {decisionId: 'PXD-227', ref: DECISION_SECTION_REF, sha256: sha(decisionSectionBytes)},
    targetOrder: TARGET_REFS,
    targets,
    candidatePostimageSha256: sha(Buffer.from(JSON.stringify(targets.map(({targetRef,preimageSha256,postimageSha256}) => ({targetRef,preimageSha256,postimageSha256}))))),
    population: {historicalRowsPreserved: 462, currentExtensionRows: 1, currentRows: 463, futureExtensionRows: 6},
    sourceMeaning: {rightsSafety: 'APPLICABLE', otherFiveDimensions: 'NOT_APPLICABLE', metrics: {count: 16, status: 'NOT_APPLICABLE'},
      measurement: 'NOT_EVALUATED', qualification: 'NOT_EVALUATED', thresholds: 'NONE_DEFINED_OR_ADDED', acceptanceEffect: 'none'},
    authority: {sourceOwnerDecision: 'PENDING', technicalPeerReview: 'PENDING_FOR_THIS_EXACT_TWO_TARGET_SUCCESSOR',
      independentAcceptance: 'NOT_CLAIMED', nativeProof: 'NOT_CLAIMED'},
    effects: {canonicalApply: 'NOT_PERFORMED', sourceCurrentness: 'NOT_CLAIMED', phaseStatus: 'UNCHANGED',
      runtimeAdmission: 'NOT_ADMITTED', measurement: 'NOT_EVALUATED', qualification: 'NOT_EVALUATED'},
  };
  const schema = makeCandidateSchema();
  const Ajv2020 = require('ajv/dist/2020');
  if (!new Ajv2020({strict: true}).compile(schema)(candidate)) fail('quality source candidate v2 fails its schema');
  return {candidate, schema, decisionSectionBytes, decisionLogPostimageBytes, qualityPostimageBytes, qualityV1PostimageBytes, v7DecisionLogBytes, qualityBaselineBytes};
}

export function validateQualityExtensionSourceDefinition(policy) {
  const extension = policy?.ownerQualityApplicabilityCrosswalkExtensions;
  if (extension?.status !== 'SOURCE_OWNER_DEFINED_NOT_YET_CURRENT') fail('quality extension must be source-owner-defined and remain not-yet-current until currentness checks');
  const normalized = structuredClone(policy);
  normalized.ownerQualityApplicabilityCrosswalkExtensions.status = 'SOURCE_DERIVED_DEFINITION_CANDIDATE_PENDING_MEDIA_SOURCE_ADOPTION';
  return validateQualityApplicabilityPopulation(normalized);
}

export function makeCandidateSchema() {
  return {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'media.pdp0.quality-extension-source-candidate.v2',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactKind','status','candidateAuthor','predecessor','sourceChoice','priorQualityCandidate','proposedDecisionSection','targetOrder','targets','candidatePostimageSha256','population','sourceMeaning','authority','effects'],
    properties: {
      schemaVersion: {const:'media.pdp0.quality-extension-source-candidate.v2'},
      artifactKind: {const:'TWO_TARGET_PDP0_SOURCE_QUALITY_EXTENSION_CANDIDATE'},
      status: {const:'CANDIDATE_ONLY_PENDING_DISTINCT_SOURCE_ADOPTION_REVIEW_AND_ROOT_DECISION'},
      candidateAuthor:{type:'object',additionalProperties:false,required:['identity','role'],properties:{identity:{const:'agent:/root/phase_io'},role:{const:'DELEGATED_TECHNICAL_SOURCE_AUTHOR_NOT_EXTERNAL_QUALITY_SPECIALIST'}}},
      predecessor: {type:'object',additionalProperties:false,required:['v7CandidateRef','v7CandidateSha256','v7ManifestRef','v7ManifestSha256','correctedPeerRef','correctedPeerSha256','predecessorQualityUnknownPreservedInV7'],properties:{v7CandidateRef:{type:'string'},v7CandidateSha256:{$ref:'#/$defs/sha256'},v7ManifestRef:{type:'string'},v7ManifestSha256:{$ref:'#/$defs/sha256'},correctedPeerRef:{type:'string'},correctedPeerSha256:{$ref:'#/$defs/sha256'},predecessorQualityUnknownPreservedInV7:{const:true}}},
      sourceChoice:{type:'object',additionalProperties:false,required:['ref','sha256'],properties:{ref:{type:'string'},sha256:{$ref:'#/$defs/sha256'}}},
      priorQualityCandidate:{type:'object',additionalProperties:false,required:['ref','sha256'],properties:{ref:{type:'string'},sha256:{$ref:'#/$defs/sha256'}}},
      proposedDecisionSection:{type:'object',additionalProperties:false,required:['decisionId','ref','sha256'],properties:{decisionId:{const:'PXD-227'},ref:{type:'string'},sha256:{$ref:'#/$defs/sha256'}}},
      targetOrder:{const:TARGET_REFS},
      targets:{type:'array',minItems:2,maxItems:2,items:{type:'object',additionalProperties:false,required:['targetRef','preimageRef','postimageRef','preimageSha256','postimageSha256'],properties:{targetRef:{enum:TARGET_REFS},preimageRef:{type:'string'},postimageRef:{type:'string'},preimageSha256:{$ref:'#/$defs/sha256'},postimageSha256:{$ref:'#/$defs/sha256'}}}},
      candidatePostimageSha256:{$ref:'#/$defs/sha256'},
      population:{type:'object',additionalProperties:false,required:['historicalRowsPreserved','currentExtensionRows','currentRows','futureExtensionRows'],properties:{historicalRowsPreserved:{const:462},currentExtensionRows:{const:1},currentRows:{const:463},futureExtensionRows:{const:6}}},
      sourceMeaning:{type:'object',additionalProperties:false,required:['rightsSafety','otherFiveDimensions','metrics','measurement','qualification','thresholds','acceptanceEffect'],properties:{rightsSafety:{const:'APPLICABLE'},otherFiveDimensions:{const:'NOT_APPLICABLE'},metrics:{type:'object',additionalProperties:false,required:['count','status'],properties:{count:{const:16},status:{const:'NOT_APPLICABLE'}}},measurement:{const:'NOT_EVALUATED'},qualification:{const:'NOT_EVALUATED'},thresholds:{const:'NONE_DEFINED_OR_ADDED'},acceptanceEffect:{const:'none'}}},
      authority:{type:'object',additionalProperties:false,required:['sourceOwnerDecision','technicalPeerReview','independentAcceptance','nativeProof'],properties:{sourceOwnerDecision:{const:'PENDING'},technicalPeerReview:{const:'PENDING_FOR_THIS_EXACT_TWO_TARGET_SUCCESSOR'},independentAcceptance:{const:'NOT_CLAIMED'},nativeProof:{const:'NOT_CLAIMED'}}},
      effects:{type:'object',additionalProperties:false,required:['canonicalApply','sourceCurrentness','phaseStatus','runtimeAdmission','measurement','qualification'],properties:{canonicalApply:{const:'NOT_PERFORMED'},sourceCurrentness:{const:'NOT_CLAIMED'},phaseStatus:{const:'UNCHANGED'},runtimeAdmission:{const:'NOT_ADMITTED'},measurement:{const:'NOT_EVALUATED'},qualification:{const:'NOT_EVALUATED'}}},
    }, $defs:{sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}};
}

export function writeQualityExtensionSourceCandidateV2({check = false} = {}) {
  const result = prepareQualityExtensionSourceCandidateV2();
  const outputs = [
    [CANDIDATE_REF, Buffer.from(json(result.candidate))],
    [SCHEMA_REF, Buffer.from(json(result.schema))],
    [DECISION_SECTION_REF, result.decisionSectionBytes],
    [DECISION_POSTIMAGE_REF, result.decisionLogPostimageBytes],
    [QUALITY_POSTIMAGE_V2_REF, result.qualityPostimageBytes],
  ];
  const producerRefs = ['scripts/lib/media-pdp0-quality-extension-source-candidate-v2.mjs',
    'scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs',
    'scripts/plan-media-pdp0-quality-extension-source-adoption-v2.mjs',
    'scripts/plan-media-pdp0-quality-extension-source-candidate-v2.mjs',
    'tests/media-pdp0-quality-extension-source-candidate-v2.test.mjs',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-independent-peer.v2.schema.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision.v2.schema.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-apply-authorization.v2.schema.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-adoption-cas-plan.v2.schema.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision-proposal.v2.json',
    'tests/media-pdp0-quality-extension-source-adoption-v2.test.mjs'];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(read(ref))]));
  const freeze = {schemaVersion:'media.pdp0.quality-extension-source-candidate-v2-freeze-manifest.v1',
    status:'CANDIDATE_ONLY_PENDING_DISTINCT_SOURCE_ADOPTION_REVIEW_AND_ROOT_DECISION',candidateRef:CANDIDATE_REF,
    candidateSha256:sha(Buffer.from(json(result.candidate))),schemaRef:SCHEMA_REF,schemaSha256:sha(Buffer.from(json(result.schema))),
    targets:result.candidate.targets,producerPins,canonicalApply:'NOT_PERFORMED',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED'};
  outputs.push([FREEZE_REF, Buffer.from(json(freeze))]);
  if (check) {
    for (const [ref, bytes] of outputs) if (!fs.existsSync(path.join(ROOT,ref)) || !read(ref).equals(bytes)) fail(`quality extension source candidate is stale: ${ref}`);
  } else {
    for (const [ref, bytes] of outputs) {
      const target = path.join(ROOT,ref);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      if (fs.existsSync(target)) {
        if (!read(ref).equals(bytes)) fail(`refusing to overwrite candidate artifact: ${ref}`);
      } else {
        const fd = fs.openSync(target,'wx',0o600);
        try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
  }
  return freeze;
}
