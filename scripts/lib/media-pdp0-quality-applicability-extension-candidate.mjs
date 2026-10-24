import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {deriveQualityApplicabilityExtension, serializeQualityPolicyExtensionPostimage, validateQualityApplicabilityPopulation,
  QUALITY_PATH, CAPABILITY_POSTIMAGE_REF, CAMPAIGN_POSTIMAGE_REF} from './media-pdp0-quality-applicability-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const CHOICE = '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json';
const CHOICE_LOCAL = path.resolve(ROOT, CHOICE);
const OPTIONS = `${OBS}/AUD-SPEC-002-quality-applicability-options.v1.json`;
const CAPABILITIES = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const QUALITY_REVIEW = 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json';
const V6_MANIFEST = `${OBS}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`;
const TARGET = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(ROOT, ref));
const immutable = (ref, bytes) => {
  const filename = path.join(ROOT, ref);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  if (fs.existsSync(filename)) {
    if (!fs.readFileSync(filename).equals(bytes)) throw new Error(`refusing to overwrite frozen quality extension artifact: ${ref}`);
    return;
  }
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

export function prepareQualityApplicabilityExtensionCandidate({readSource = read} = {}) {
  const inputs = {
    qualityPolicyBytes: readSource(QUALITY_PATH), capabilityPostimageBytes: readSource(CAPABILITY_POSTIMAGE_REF),
    campaignPostimageBytes: readSource(CAMPAIGN_POSTIMAGE_REF), rootChoiceBytes: fs.readFileSync(CHOICE_LOCAL),
    qualityOptionsBytes: readSource(OPTIONS), currentCapabilitiesBytes: readSource(CAPABILITIES),
    pxd225Bytes: readSource(QUALITY_REVIEW), v6ManifestBytes: readSource(V6_MANIFEST),
  };
  const result = deriveQualityApplicabilityExtension(inputs);
  const postimageBytes = serializeQualityPolicyExtensionPostimage(inputs.qualityPolicyBytes, result.extension);
  const postimagePolicy = requireYaml(postimageBytes);
  const population = validateQualityApplicabilityPopulation(postimagePolicy);
  const postimageRef = `${OBS}/AUD-SPEC-002-quality-policy-extension-postimage.v1.yaml`;
  const candidate = {
    schemaVersion: 'media.pdp0.quality-applicability-extension-candidate.v1',
    artifactKind: 'SOURCE_OWNER_QUALITY_APPLICABILITY_EXTENSION_POSTIMAGE_CANDIDATE',
    status: 'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_SOURCE_OWNER_APPLY',
    sourceChoiceRef: CHOICE, sourceChoiceSha256: sha(inputs.rootChoiceBytes),
    capabilityRef: result.row.capabilityRef,
    sourcePins: result.sourcePins,
    population: {historicalBaseRows: population.historicalRows, currentExtensionRows: population.currentExtensionRows.length,
      currentRows: population.currentRowsCount, futureExtensionRows: population.futureRows,
      totalDefinitionExtensions: 7, totalSourceCapabilityDefinitions: 469,
      historicalDimensionDispositions: 462 * 6, historicalMetricDispositions: 462 * 16,
      currentDimensionDispositions: 463 * 6, currentMetricDispositions: 463 * 16},
    extensionSection: result.extension,
    exactTarget: {targetRef: TARGET, preimageSha256: sha(inputs.qualityPolicyBytes), postimageRef, postimageSha256: sha(postimageBytes)},
    sourceMeaning: {dimensions: result.row.dimensionApplicability, metricStatusCounts: {NOT_APPLICABLE: 16},
      measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED', thresholds: 'NONE_DEFINED_OR_ADDED'},
    authority: {sourceOwnerDecision: 'TECHNICAL_SOURCE_CHOICE_RECORDED; MEDIA_SOURCE_ADOPTION_PENDING',
      distinctTechnicalPeerReview: 'PENDING', independentAcceptance: 'NOT_CLAIMED', nativeProof: 'NOT_CLAIMED'},
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', sourceCurrentness: 'NOT_CLAIMED', phaseStatus: 'UNCHANGED',
      measurement: 'NOT_EVALUATED', qualification: 'NOT_EVALUATED', runtimeAdmission: 'NOT_ADMITTED'},
  };
  const schema = makeSchema();
  return {candidate, schema, postimageBytes, postimageRef, postimagePolicy, inputs};
}

function requireYaml(bytes) {
  return createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'))('yaml').parse(Buffer.from(bytes).toString('utf8'));
}

function makeSchema() {
  return {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'media.pdp0.quality-applicability-extension-candidate.v1',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactKind','status','sourceChoiceRef','sourceChoiceSha256','capabilityRef','sourcePins','population','extensionSection','exactTarget','sourceMeaning','authority','effects'],
    properties: {
      schemaVersion: {const: 'media.pdp0.quality-applicability-extension-candidate.v1'},
      artifactKind: {const: 'SOURCE_OWNER_QUALITY_APPLICABILITY_EXTENSION_POSTIMAGE_CANDIDATE'},
      status: {const: 'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_SOURCE_OWNER_APPLY'},
      sourceChoiceRef: {type: 'string', minLength: 1}, sourceChoiceSha256: {type: 'string', pattern: '^[a-f0-9]{64}$'},
      capabilityRef: {const: 'media.recipe.specification.compile'},
      sourcePins: {type: 'object', minProperties: 8, additionalProperties: {type: 'string', pattern: '^[a-f0-9]{64}$'}},
      population: {type: 'object', additionalProperties: false, required: ['historicalBaseRows','currentExtensionRows','currentRows','futureExtensionRows','totalDefinitionExtensions','totalSourceCapabilityDefinitions','historicalDimensionDispositions','historicalMetricDispositions','currentDimensionDispositions','currentMetricDispositions'],
        properties: {historicalBaseRows:{const:462},currentExtensionRows:{const:1},currentRows:{const:463},futureExtensionRows:{const:6},totalDefinitionExtensions:{const:7},totalSourceCapabilityDefinitions:{const:469},historicalDimensionDispositions:{const:2772},historicalMetricDispositions:{const:7392},currentDimensionDispositions:{const:2778},currentMetricDispositions:{const:7408}}},
      extensionSection: {type: 'object', required: ['schemaVersion','status','historicalBaseRows','currentExtensionRows','currentPopulationRows','futureExtensionRows','totalSourceCapabilityDefinitions','records'], properties: {schemaVersion:{const:'media.pdp0.quality-applicability-extension.v1'},status:{const:'SOURCE_DERIVED_DEFINITION_CANDIDATE_PENDING_MEDIA_SOURCE_ADOPTION'},historicalBaseRows:{const:462},currentExtensionRows:{const:1},currentPopulationRows:{const:463},futureExtensionRows:{const:6},totalSourceCapabilityDefinitions:{const:469},records:{type:'array',minItems:1,maxItems:1}},additionalProperties:true},
      exactTarget: {type: 'object', additionalProperties: false, required: ['targetRef','preimageSha256','postimageRef','postimageSha256'], properties: {targetRef:{const:'.product-experience/pdp-0-product-truth/quality-policy.yaml'},preimageSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},postimageRef:{type:'string',minLength:1},postimageSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}},
      sourceMeaning: {type:'object',required:['dimensions','metricStatusCounts','measurementState','qualificationState','thresholds'],properties:{dimensions:{type:'object'},metricStatusCounts:{type:'object',properties:{NOT_APPLICABLE:{const:16}}},measurementState:{const:'NOT_EVALUATED'},qualificationState:{const:'NOT_EVALUATED'},thresholds:{const:'NONE_DEFINED_OR_ADDED'}},additionalProperties:false},
      authority: {type:'object',properties:{sourceOwnerDecision:{const:'TECHNICAL_SOURCE_CHOICE_RECORDED; MEDIA_SOURCE_ADOPTION_PENDING'},distinctTechnicalPeerReview:{const:'PENDING'},independentAcceptance:{const:'NOT_CLAIMED'},nativeProof:{const:'NOT_CLAIMED'}},additionalProperties:false},
      effects: {type:'object',properties:{canonicalSourceWrite:{const:'NOT_PERFORMED'},sourceCurrentness:{const:'NOT_CLAIMED'},phaseStatus:{const:'UNCHANGED'},measurement:{const:'NOT_EVALUATED'},qualification:{const:'NOT_EVALUATED'},runtimeAdmission:{const:'NOT_ADMITTED'}},additionalProperties:false},
    }};
}

export function writeQualityApplicabilityExtensionCandidate({check = false} = {}) {
  const result = prepareQualityApplicabilityExtensionCandidate();
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const schemaBytes = Buffer.from(`${JSON.stringify(result.schema, null, 2)}\n`);
  const require = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'));
  const Ajv2020 = require('ajv/dist/2020');
  const ajv = new Ajv2020({strict: true});
  if (!ajv.compile(result.schema)(result.candidate)) throw new Error('quality applicability candidate fails its schema');
  const producerRefs = ['scripts/lib/media-pdp0-quality-applicability-extension.mjs','scripts/lib/media-pdp0-quality-applicability-extension-candidate.mjs',
    'scripts/plan-media-pdp0-quality-applicability-extension.mjs','tests/media-pdp0-quality-applicability-extension.test.mjs'];
  const producerPins = Object.fromEntries(producerRefs.map(ref => [ref, sha(read(ref))]));
  const candidateRef = `${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`;
  const schemaRef = `${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.schema.json`;
  const manifest = {schemaVersion:'media.pdp0.quality-applicability-extension-freeze-manifest.v1',status:'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_SOURCE_OWNER_APPLY',
    candidateRef,candidateSha256:sha(candidateBytes),schemaRef,schemaSha256:sha(schemaBytes),postimageRef:result.postimageRef,
    postimageSha256:sha(result.postimageBytes),targetPreimageSha256:result.candidate.exactTarget.preimageSha256,
    sourcePins:result.candidate.sourcePins,producerPins,canonicalApply:'NOT_PERFORMED',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED'};
  const manifestRef = `${OBS}/AUD-SPEC-002-quality-applicability-extension-freeze-manifest.v1.json`;
  const outputs = [[candidateRef,candidateBytes],[schemaRef,schemaBytes],[result.postimageRef,result.postimageBytes],[manifestRef,Buffer.from(`${JSON.stringify(manifest,null,2)}\n`)]];
  if (check) {
    for (const [ref, content] of outputs) if (!fs.existsSync(path.join(ROOT,ref)) || !read(ref).equals(content)) throw new Error(`frozen quality applicability artifact is stale: ${ref}`);
  } else for (const [ref, content] of outputs) immutable(ref, content);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(writeQualityApplicabilityExtensionCandidate({check:process.argv.includes('--check')}),null,2)}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
