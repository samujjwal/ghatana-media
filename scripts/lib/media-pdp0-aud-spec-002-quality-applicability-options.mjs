import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MEDIA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = createRequire(path.resolve(MEDIA_ROOT, '../ghatana-tools/package.json'))('yaml');
const CAPABILITY = 'media.recipe.specification.compile';
const CAP_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const QUALITY_PATH = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const REVIEW_PATH = 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json';
const V6_MANIFEST_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json';
const V6_POSTIMAGE_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-capabilities-file-postimage.v6.yaml';

function parseJson(bytes) { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
function parseYaml(bytes) { return yaml.parse(Buffer.from(bytes).toString('utf8')); }

export function buildAudSpec002QualityApplicabilityOptions({capabilityBytes, qualityPolicyBytes, pxd225Bytes, v6ManifestBytes, v6CapabilityPostimageBytes}) {
  const capabilityDoc = parseYaml(v6CapabilityPostimageBytes);
  const policy = parseYaml(qualityPolicyBytes);
  const pxd225 = parseJson(pxd225Bytes);
  const v6Manifest = parseJson(v6ManifestBytes);
  const capability = capabilityDoc.capabilities.find(row => row.id === CAPABILITY);
  if (!capability) throw new Error('v6 proposal does not contain the exact compile capability');
  const outputTypes = capability.outputArtifactTypes ?? [];
  const inputTypes = capability.inputArtifactTypes ?? [];
  const metrics = policy.metricDefinitions ?? [];
  const dimensions = policy.qualityDimensions ?? [];
  const crosswalk = policy.ownerQualityApplicabilityCrosswalk;
  const currentQuality = pxd225.latestCurrentnessRefresh?.reviewedPopulation;
  const modalityByType = new Map((crosswalk.modalityEvidenceRegistry ?? []).map(row => [row.artifactType, row]));
  const typedSignals = [...inputTypes, ...outputTypes].filter(type => modalityByType.get(type)?.subjectRole === 'MEDIA_SUBJECT');
  const typedModalities = [...new Set(typedSignals.flatMap(type => modalityByType.get(type)?.modalities ?? []))].sort();
  const intentInputs = inputTypes.filter(type => (crosswalk.ownerApplicabilityRules?.typedIntentEvidenceRefs ?? []).includes(type));
  const explicitAuthorityScope = (capability.ownerDefinition?.guards?.authorityRefs ?? []).length > 0
    || (capability.ownerDefinition?.guards?.preconditions ?? []).some(text => /authority|rights|consent|policy/u.test(text));
  const isSimulationFamily = capability.familyId === 'media.simulation';
  const dimensionRules = crosswalk.dimensionApplicabilityRules;
  const derivedDimensions = dimensions.map(({id}) => {
    let status; let reason;
    if (id === 'QUALITY-DIM-STRUCTURAL-VALIDITY' || id === 'QUALITY-DIM-PERCEPTUAL') {
      status = typedSignals.length ? 'APPLICABLE' : 'NOT_APPLICABLE';
      reason = typedSignals.length ? 'EXACT_MEDIA_SIGNAL_SUBJECT_TYPE_PRESENT' : 'NO_EXACT_MEDIA_SIGNAL_SUBJECT_TYPE_IN_CAPABILITY_INPUTS_OR_OUTPUTS';
    } else if (id === 'QUALITY-DIM-INTENT-FIDELITY') {
      status = typedSignals.length && intentInputs.length ? 'APPLICABLE' : 'NOT_APPLICABLE';
      reason = status === 'APPLICABLE' ? 'TYPED_INTENT_AND_MEDIA_SIGNAL_OUTPUT_PRESENT' : 'NO_TYPED_INTENT_TARGET_AND_MEDIA_SIGNAL_OUTPUT_PAIR';
    } else if (id === 'QUALITY-DIM-DOMAIN-SCIENTIFIC') {
      status = isSimulationFamily ? 'APPLICABLE' : 'NOT_APPLICABLE';
      reason = isSimulationFamily ? 'SIMULATION_CAPABILITY_FAMILY_AND_IO_PRESENT' : 'CAPABILITY_FAMILY_IS_NOT_MEDIA_SIMULATION';
    } else if (id === 'QUALITY-DIM-RIGHTS-SAFETY') {
      status = typedSignals.length || explicitAuthorityScope ? 'APPLICABLE' : 'NOT_APPLICABLE';
      reason = typedSignals.length ? 'TYPED_MEDIA_SUBJECT_PRESENT' : explicitAuthorityScope ? 'EXACT_CAPABILITY_AUTHORITY_SCOPE_PRESENT' : 'NO_TYPED_MEDIA_SUBJECT_OR_EXPLICIT_AUTHORITY_SCOPE';
    } else if (id === 'QUALITY-DIM-DELIVERY-COMPATIBILITY') {
      const deliveryTypes = crosswalk.ownerApplicabilityRules?.deliveryTargetOutputTypeRefs ?? [];
      const present = outputTypes.some(type => deliveryTypes.includes(type)) || typedModalities.length > 0;
      status = present ? 'APPLICABLE' : 'NOT_APPLICABLE';
      reason = present ? 'TYPED_MEDIA_OUTPUT_OR_DELIVERY_PACKAGE_PRESENT' : 'NO_TYPED_MEDIA_OUTPUT_MODALITY_OR_DELIVERY_PACKAGE';
    } else throw new Error(`unrecognized quality dimension requires an explicit source-owner decision: ${id}`);
    return {criterionId: id, status, reason, sourceRuleRef: `${QUALITY_PATH}#ownerQualityApplicabilityCrosswalk/dimensionApplicabilityRules/${id}`, sourceRule: dimensionRules[id]};
  });
  const derivedMetrics = metrics.map(({id}) => {
    const rule = crosswalk.metricModalityRules?.[id];
    if (!rule) throw new Error(`metric lacks an exact source modality rule: ${id}`);
    const directionTypes = rule.direction === 'OUTPUT' ? outputTypes : rule.direction === 'INPUT' ? inputTypes : [...inputTypes, ...outputTypes];
    const matchingTypes = directionTypes.filter(type => modalityByType.get(type)?.subjectRole === 'MEDIA_SUBJECT'
      && (modalityByType.get(type)?.modalities ?? []).some(modality => rule.modalities?.includes(modality)));
    return {criterionId: id, status: matchingTypes.length ? 'APPLICABLE' : 'NOT_APPLICABLE',
      reason: matchingTypes.length ? 'EXACT_TYPED_MEDIA_SUBJECT_IN_REQUIRED_DIRECTION' : 'NO_EXACT_MEDIA_SUBJECT_IN_REQUIRED_DIRECTION',
      sourceRuleRef: `${QUALITY_PATH}#ownerQualityApplicabilityCrosswalk/metricModalityRules/${id}`,
      sourceRule: rule, matchedSubjectArtifactTypes: matchingTypes};
  });
  const pins = {
    [CAP_PATH]: sha(capabilityBytes), [QUALITY_PATH]: sha(qualityPolicyBytes), [REVIEW_PATH]: sha(pxd225Bytes),
    [V6_MANIFEST_PATH]: sha(v6ManifestBytes), [V6_POSTIMAGE_PATH]: sha(v6CapabilityPostimageBytes),
  };
  const options = {
    schemaVersion: 'media.pdp0.aud-spec-002-quality-applicability-options.v1',
    artifactKind: 'SOURCE_BOUND_OWNER_DECISION_OPTIONS_NOT_APPLICABILITY_DISPOSITION',
    status: 'PENDING_EXPLICIT_ROOT_TECHNICAL_SOURCE_OWNER_CHOICE',
    authorIdentity: 'agent:/root/phase_io', authorRole: 'DELEGATED_TECHNICAL_SOURCE_AUTHOR_NOT_EXTERNAL_QUALITY_SPECIALIST',
    sourcePins: pins,
    predecessorQualityReview: {ref: REVIEW_PATH, status: 'HISTORICAL_CURRENTNESS_REVIEW_FOR_462_ROWS_ONLY', currentRows: currentQuality?.capabilityRows,
      excludedExtensions: currentQuality?.definitionExtensionsExcluded, acceptance: 'NOT_CLAIMED', measurement: currentQuality?.measurementState, qualification: currentQuality?.qualificationState},
    proposedSubject: {capabilityRef: CAPABILITY, familyRef: capability.familyId, inputArtifactTypes: inputTypes, outputArtifactTypes: outputTypes,
      typedMediaSignalInputOrOutputRefs: typedSignals, typedModalities, intentTargetInputs: intentInputs, explicitAuthorityScope,
      qualityPolicyPopulation: crosswalk.population, dimensionCount: dimensions.length, metricCount: metrics.length},
    options: [
      {optionId: 'APPLY_EXISTING_EXACT_TYPED_APPLICABILITY_RULES', disposition: 'PROPOSED_NOT_SELECTED',
        dimensions: derivedDimensions, metrics: derivedMetrics,
        inheritedObligations: ['QUALITY_POLICY_ASSESSMENT_CONTRACT', 'EXACT_SUBJECT_VERSION_AND_METHOD_IDENTITY_WHEN_MEASURED', 'UNKNOWN_OR_STALE_EVIDENCE_REMAINS_NOT_EVALUATED', 'NO_CROSS_DIMENSION_TOTAL_SCORE'],
        newObligations: [], thresholds: 'NONE_DEFINED_OR_ADDED', measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED',
        basis: 'Apply only the existing exact typed artifact/modality applicability predicates; do not equate source applicability with measured quality or qualification.'},
      {optionId: 'RETAIN_ALL_EXTENSION_QUALITY_APPLICABILITY_UNKNOWN', disposition: 'PRESERVES_UNKNOWN; DOES_NOT_COMPLETE_THIS_DEFINITION_ITEM',
        dimensions: dimensions.map(({id}) => ({criterionId: id, status: 'UNKNOWN', reason: 'NO_EXPLICIT_OWNER_DISPOSITION_FOR_THIS_EXTENSION'})),
        metrics: metrics.map(({id}) => ({criterionId: id, status: 'UNKNOWN', reason: 'NO_EXPLICIT_OWNER_DISPOSITION_FOR_THIS_EXTENSION'})),
        inheritedObligations: [], newObligations: ['SOURCE_OWNER_MUST_DEFINE_EXPLICIT_APPLICABILITY_FOR_ALL_SIX_DIMENSIONS_AND_SIXTEEN_METRICS'],
        thresholds: 'NONE_DEFINED_OR_ADDED', measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED',
        basis: 'Fail closed and preserve the unresolved source-definition task until an owner disposition is recorded.'},
    ],
    unresolvedDecisions: ['ROOT_MUST_SELECT_APPLICABILITY_OPTION', 'NO_EXISTING_NUMERIC_QUALITY_THRESHOLDS_OR_METRICS_MAY_BE_INVENTED', 'NO_MEASUREMENT_OR_QUALIFICATION_RESULT_IS_AUTHORIZED_BY_THIS_RECORD'],
    boundaries: {qualityReviewPopulationCurrent: 462, candidateCurrentCapabilityPopulation: 463, historicalQualityReviewReusableForExtension: false,
      ownerAcceptance: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', measurement: 'NOT_EVALUATED', qualification: 'NOT_EVALUATED', runtimeAdmission: 'NOT_ADMITTED'},
  };
  const schema = makeSchema(dimensions.map(row => row.id), metrics.map(row => row.id));
  return {options, schema, pins, capability, dimensions, metrics};
}

function makeSchema(dimensionIds, metricIds) {
  const criterion = ids => ({type: 'array', minItems: ids.length, maxItems: ids.length, items: {type: 'object', required: ['criterionId','status','reason'], properties: {criterionId: {enum: ids}, status: {enum: ['APPLICABLE','NOT_APPLICABLE','UNKNOWN']}, reason: {type:'string',minLength:1}}, additionalProperties: true}});
  return {$schema:'https://json-schema.org/draft/2020-12/schema', $id:'media.pdp0.aud-spec-002-quality-applicability-options.v1', type:'object', additionalProperties:false,
    required:['schemaVersion','artifactKind','status','authorIdentity','authorRole','sourcePins','predecessorQualityReview','proposedSubject','options','unresolvedDecisions','boundaries'],
    properties:{schemaVersion:{const:'media.pdp0.aud-spec-002-quality-applicability-options.v1'},artifactKind:{const:'SOURCE_BOUND_OWNER_DECISION_OPTIONS_NOT_APPLICABILITY_DISPOSITION'},status:{const:'PENDING_EXPLICIT_ROOT_TECHNICAL_SOURCE_OWNER_CHOICE'},
      authorIdentity:{const:'agent:/root/phase_io'},authorRole:{const:'DELEGATED_TECHNICAL_SOURCE_AUTHOR_NOT_EXTERNAL_QUALITY_SPECIALIST'},sourcePins:{type:'object',minProperties:5,additionalProperties:{type:'string',pattern:'^[a-f0-9]{64}$'}},
      predecessorQualityReview:{type:'object',required:['ref','status','currentRows','excludedExtensions','acceptance','measurement','qualification'],properties:{ref:{const:REVIEW_PATH},status:{const:'HISTORICAL_CURRENTNESS_REVIEW_FOR_462_ROWS_ONLY'},currentRows:{const:462},excludedExtensions:{const:7},acceptance:{const:'NOT_CLAIMED'},measurement:{const:'NOT_EVALUATED'},qualification:{const:'NOT_EVALUATED'}},additionalProperties:true},proposedSubject:{type:'object',required:['capabilityRef','inputArtifactTypes','outputArtifactTypes','typedMediaSignalInputOrOutputRefs','typedModalities','qualityPolicyPopulation','dimensionCount','metricCount'],properties:{capabilityRef:{const:CAPABILITY},inputArtifactTypes:{type:'array'},outputArtifactTypes:{type:'array'},typedMediaSignalInputOrOutputRefs:{type:'array'},typedModalities:{type:'array'},qualityPolicyPopulation:{type:'object'},dimensionCount:{const:6},metricCount:{const:16}},additionalProperties:true},
      options:{type:'array',minItems:2,maxItems:2,items:{type:'object',required:['optionId','disposition','dimensions','metrics','thresholds','measurementState','qualificationState'],properties:{optionId:{enum:['APPLY_EXISTING_EXACT_TYPED_APPLICABILITY_RULES','RETAIN_ALL_EXTENSION_QUALITY_APPLICABILITY_UNKNOWN']},disposition:{type:'string'},dimensions:criterion(dimensionIds),metrics:criterion(metricIds),thresholds:{const:'NONE_DEFINED_OR_ADDED'},measurementState:{const:'NOT_EVALUATED'},qualificationState:{const:'NOT_EVALUATED'}},additionalProperties:true}},
      unresolvedDecisions:{type:'array',minItems:1,items:{type:'string'}},boundaries:{type:'object',required:['qualityReviewPopulationCurrent','candidateCurrentCapabilityPopulation','historicalQualityReviewReusableForExtension','ownerAcceptance','independentAcceptance','measurement','qualification','runtimeAdmission'],properties:{qualityReviewPopulationCurrent:{const:462},candidateCurrentCapabilityPopulation:{const:463},historicalQualityReviewReusableForExtension:{const:false},ownerAcceptance:{const:'NOT_CLAIMED'},independentAcceptance:{const:'NOT_CLAIMED'},measurement:{const:'NOT_EVALUATED'},qualification:{const:'NOT_EVALUATED'},runtimeAdmission:{const:'NOT_ADMITTED'}},additionalProperties:true}},
  };
}
