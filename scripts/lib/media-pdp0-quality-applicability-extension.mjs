import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'))('yaml');
export const QUALITY_EXTENSION_ID = 'media.recipe.specification.compile';
export const QUALITY_PATH = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
export const CAPABILITY_POSTIMAGE_REF = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-capabilities-file-postimage.v6.yaml';
export const CAMPAIGN_POSTIMAGE_REF = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-campaign-extensions-postimage.v6.yaml';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parseYaml = bytes => yaml.parse(Buffer.from(bytes).toString('utf8'));
const fail = message => { throw new Error(message); };

export function deriveQualityApplicabilityExtension({qualityPolicyBytes, capabilityPostimageBytes, campaignPostimageBytes, rootChoiceBytes, qualityOptionsBytes,
  currentCapabilitiesBytes, pxd225Bytes, v6ManifestBytes}) {
  const policy = parseYaml(qualityPolicyBytes);
  const capDoc = parseYaml(capabilityPostimageBytes);
  const campaign = parseYaml(campaignPostimageBytes);
  const rootChoice = JSON.parse(Buffer.from(rootChoiceBytes).toString('utf8'));
  const options = JSON.parse(Buffer.from(qualityOptionsBytes).toString('utf8'));
  const crosswalk = policy.ownerQualityApplicabilityCrosswalk;
  const current = campaign.currentDefinitionPopulation;
  const version = current?.versionDisposition;
  if (!crosswalk || crosswalk.records?.length !== 462 || crosswalk.population?.capabilityLeaves !== 462) fail('historical quality crosswalk must remain exactly 462 rows');
  if (policy.ownerQualityApplicabilityCrosswalkExtensions !== undefined) fail('refusing to duplicate or overwrite an existing quality extension source section');
  if (rootChoice.schemaVersion !== 'gtool.critical.technical-source-owner-choice.v1'
      || rootChoice.decision !== 'SELECT_SOURCE_DERIVED_TECHNICAL_APPLICABILITY_OPTION'
      || rootChoice.selectedOptionId !== 'APPLY_EXISTING_EXACT_TYPED_APPLICABILITY_RULES'
      || rootChoice.scope?.capabilityRef !== QUALITY_EXTENSION_ID
      || rootChoice.scope?.historicalQualityReviewRowsPreserved !== 462
      || rootChoice.scope?.candidateCurrentPopulation !== 463) fail('root source choice is not the exact source-derived 462+1 extension choice');
  const option = options.options?.find(row => row.optionId === rootChoice.selectedOptionId);
  if (!option || options.schemaVersion !== 'media.pdp0.aud-spec-002-quality-applicability-options.v1'
      || options.status !== 'PENDING_EXPLICIT_ROOT_TECHNICAL_SOURCE_OWNER_CHOICE') fail('pinned options record does not match the selected root choice');
  const sourcePairs = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': currentCapabilitiesBytes,
    [QUALITY_PATH]: qualityPolicyBytes,
    'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json': pxd225Bytes,
    'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json': v6ManifestBytes,
    [CAPABILITY_POSTIMAGE_REF]: capabilityPostimageBytes,
  };
  for (const [ref, sourceBytes] of Object.entries(sourcePairs)) {
    if (!sourceBytes || rootChoice.sourcePins?.[ref] !== sha(sourceBytes) || options.sourcePins?.[ref] !== sha(sourceBytes)) fail(`root choice/options source pin is stale or missing: ${ref}`);
  }
  if (rootChoice.input?.path !== 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-applicability-options.v1.json'
      || rootChoice.input?.sha256 !== sha(qualityOptionsBytes)) fail('root decision does not bind the exact quality applicability options artifact');
  const capability = capDoc.capabilities?.find(row => row.id === QUALITY_EXTENSION_ID);
  if (!capability) fail('exact compile capability is missing from the v6 postimage');
  const future = version?.futureVersionProposals ?? [];
  const extensionIds = version?.currentVersionExtensionCapabilityIds ?? [];
  if (current.historicalCapabilityLeavesPreserved !== 462 || current.ownerAdjudications !== 462
      || version.historicalCanonicalCapabilityLeaves !== 462 || version.currentVersionCapabilityLeaves !== 463
      || version.futureVersionProposalCapabilityLeaves !== 6 || version.totalSourceCapabilityDefinitions !== 469
      || extensionIds.length !== 1 || extensionIds[0] !== QUALITY_EXTENSION_ID || future.length !== 6
      || future.some(row => row.capabilityId === QUALITY_EXTENSION_ID)) fail('campaign postimage does not partition 462 historical + 1 current + 6 future definitions');

  const approved = option.dimensions;
  const metrics = option.metrics;
  const dims = policy.qualityDimensions ?? [];
  const metricDefs = policy.metricDefinitions ?? [];
  if (dims.length !== 6 || metrics.length !== 16 || approved.length !== 6 || metricDefs.length !== 16) fail('quality policy and selected choice must cover six dimensions and sixteen metrics');
  const dimById = new Map(approved.map(row => [row.criterionId, row]));
  const metricById = new Map(metrics.map(row => [row.criterionId, row]));
  if (dims.some(({id}) => !dimById.has(id)) || metricDefs.some(({id}) => !metricById.has(id))) fail('selected choice omits or invents a quality criterion');
  const choiceDims = rootChoice.selectedDefinition?.dimensions ?? [];
  const choiceMetrics = rootChoice.selectedDefinition?.metrics ?? [];
  if (choiceDims.length !== 6 || choiceMetrics.length !== 16) fail('root choice does not bind all selected quality rules');
  const sourceSignals = new Map((crosswalk.modalityEvidenceRegistry ?? []).map(row => [row.artifactType, row]));
  const capTypes = [...(capability.inputArtifactTypes ?? []), ...(capability.outputArtifactTypes ?? [])];
  const typedMediaSubjects = capTypes.filter(type => sourceSignals.get(type)?.subjectRole === 'MEDIA_SUBJECT');
  if (typedMediaSubjects.length !== 0) fail('selected quality choice is stale: compile capability now contains an exact media-signal subject');
  const authority = capability.ownerDefinition?.guards?.authorityRefs ?? [];
  const preconditions = capability.ownerDefinition?.guards?.preconditions ?? [];
  const hasAuthorityScope = authority.length > 0 || preconditions.some(text => /authority|rights|consent|policy/u.test(text));
  if (!hasAuthorityScope) fail('selected quality choice is stale: compile capability no longer declares explicit authority scope');

  const dimensionApplicability = {};
  for (const {id} of dims) {
    const choice = dimById.get(id);
    const root = choiceDims.find(row => row.criterionId === id);
    if (!root || root.status !== choice.status || root.sourceRuleRef !== choice.sourceRuleRef) fail(`root choice dimension binding mismatch: ${id}`);
    const expectedRule = crosswalk.dimensionApplicabilityRules?.[id];
    if (!expectedRule || JSON.stringify(root.sourceRule) !== JSON.stringify(expectedRule)) fail(`dimension rule changed after root choice: ${id}`);
    dimensionApplicability[id] = choice.status;
  }
  const metricApplicability = {};
  for (const {id} of metricDefs) {
    const choice = metricById.get(id);
    const root = choiceMetrics.find(row => row.criterionId === id);
    const rule = crosswalk.metricModalityRules?.[id];
    if (!root || !rule || JSON.stringify(root.sourceRule) !== JSON.stringify(rule)
        || root.status !== choice.status || root.status !== 'NOT_APPLICABLE'
        || root.reason !== 'NO_EXACT_MEDIA_SUBJECT_IN_REQUIRED_DIRECTION') fail(`metric rule or selected applicability changed: ${id}`);
    const directionTypes = rule.direction === 'OUTPUT' ? capability.outputArtifactTypes
      : rule.direction === 'INPUT' ? capability.inputArtifactTypes : capTypes;
    const matched = directionTypes.filter(type => sourceSignals.get(type)?.subjectRole === 'MEDIA_SUBJECT'
      && (sourceSignals.get(type)?.modalities ?? []).some(modality => rule.modalities?.includes(modality)));
    if (matched.length || (root.matchedSubjectArtifactTypes ?? []).length) fail(`metric selector matched an unmodeled media subject: ${id}`);
    metricApplicability[id] = {status: 'NOT_APPLICABLE', reasonCode: 'NO_EXACT_MEDIA_SUBJECT_IN_REQUIRED_DIRECTION',
      measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED',
      conditionalPredicates: rule.condition ? [rule.condition] : [], subjectInputArtifactTypes: [], subjectOutputArtifactTypes: [],
      requiredReferenceArtifactTypes: rule.referenceTypes ?? []};
  }
  if (Object.values(dimensionApplicability).filter(value => value === 'APPLICABLE').join(',') !== 'APPLICABLE'
      || dimensionApplicability['QUALITY-DIM-RIGHTS-SAFETY'] !== 'APPLICABLE'
      || Object.entries(dimensionApplicability).some(([id,value]) => id !== 'QUALITY-DIM-RIGHTS-SAFETY' && value !== 'NOT_APPLICABLE')) {
    fail('source-derived dimension partition differs from the selected six-rule decision');
  }
  const row = {id: 'media.quality-applicability-extension.media-recipe-specification-compile.v1', capabilityRef: QUALITY_EXTENSION_ID,
    applicableModalities: [], dimensionApplicability, metricApplicability,
    measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED', acceptanceEffect: 'none'};
  const extension = {schemaVersion: 'media.pdp0.quality-applicability-extension.v1',
    status: 'SOURCE_DERIVED_DEFINITION_CANDIDATE_PENDING_MEDIA_SOURCE_ADOPTION',
    sourceChoiceRef: '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
    sourceChoiceSha256: sha(rootChoiceBytes), historicalBaseRows: 462, currentExtensionRows: 1,
    currentPopulationRows: 463, futureExtensionRows: 6, totalDefinitionExtensions: 7, totalSourceCapabilityDefinitions: 469,
    futureCapabilityRefs: future.map(item => item.capabilityId), dimensionCount: 6, metricCount: 16,
    measurementState: 'NOT_EVALUATED', qualificationState: 'NOT_EVALUATED', acceptanceEffect: 'none', records: [row]};
  return {policy, extension, row, sourceFacts: {capability, campaignCurrentPopulation: current, rootChoice, options},
    sourcePins: {qualityPolicySha256: sha(qualityPolicyBytes), capabilityPostimageSha256: sha(capabilityPostimageBytes),
      campaignPostimageSha256: sha(campaignPostimageBytes), currentCapabilitiesSha256: sha(currentCapabilitiesBytes), pxd225Sha256: sha(pxd225Bytes),
      v6ManifestSha256: sha(v6ManifestBytes), rootChoiceSha256: sha(rootChoiceBytes), qualityOptionsSha256: sha(qualityOptionsBytes)}};
}

export function validateQualityApplicabilityPopulation(policy) {
  const base = policy.ownerQualityApplicabilityCrosswalk?.records ?? [];
  const declaredBase = policy.ownerQualityApplicabilityCrosswalk?.population?.capabilityLeaves;
  const ext = policy.ownerQualityApplicabilityCrosswalkExtensions;
  if (base.length !== 462 || declaredBase !== 462 || new Set(base.map(row => row.capabilityRef)).size !== 462) fail('historical quality applicability cohort must remain 462 unique records');
  if (!ext) return {baseRows: base, currentExtensionRows: [], currentRows: base, historicalRows: 462, currentRowsCount: 462, futureRows: 7};
  const row = ext.records?.length === 1 ? ext.records[0] : undefined;
  if (ext.schemaVersion !== 'media.pdp0.quality-applicability-extension.v1' || !row
      || ext.historicalBaseRows !== 462 || ext.currentExtensionRows !== 1 || ext.currentPopulationRows !== 463
      || ext.futureExtensionRows !== 6 || ext.totalDefinitionExtensions !== 7 || ext.totalSourceCapabilityDefinitions !== 469
      || ext.futureCapabilityRefs?.length !== 6 || ext.futureCapabilityRefs.includes(row.capabilityRef)
      || row.capabilityRef !== QUALITY_EXTENSION_ID || row.measurementState !== 'NOT_EVALUATED'
      || row.qualificationState !== 'NOT_EVALUATED' || row.acceptanceEffect !== 'none'
      || Object.keys(row.dimensionApplicability ?? {}).length !== 6 || Object.keys(row.metricApplicability ?? {}).length !== 16
      || new Set(ext.futureCapabilityRefs).size !== 6
      || ext.futureCapabilityRefs.some(ref => typeof ref !== 'string' || ref.trim() === '')
      || row.dimensionApplicability['QUALITY-DIM-RIGHTS-SAFETY'] !== 'APPLICABLE'
      || Object.entries(row.dimensionApplicability).some(([id,status]) => id !== 'QUALITY-DIM-RIGHTS-SAFETY' && status !== 'NOT_APPLICABLE')
      || Object.values(row.metricApplicability).some(item => item.status !== 'NOT_APPLICABLE' || item.measurementState !== 'NOT_EVALUATED' || item.qualificationState !== 'NOT_EVALUATED')) fail('current extension quality row violates its typed population or applicability contract');
  if (base.some(item => item.capabilityRef === row.capabilityRef)) fail('current extension must not overwrite or duplicate a historical quality row');
  return {baseRows: base, currentExtensionRows: ext.records, currentRows: [...base, ...ext.records], historicalRows: 462, currentRowsCount: 463, futureRows: 6};
}

export function serializeQualityPolicyExtensionPostimage(qualityPolicyBytes, extension) {
  const policy = parseYaml(qualityPolicyBytes);
  if (policy.ownerQualityApplicabilityCrosswalkExtensions !== undefined) fail('refusing to replace an existing quality applicability extension');
  const text = Buffer.from(qualityPolicyBytes).toString('utf8');
  const yamlText = yaml.stringify({ownerQualityApplicabilityCrosswalkExtensions: extension}, {lineWidth: 0});
  const postimage = Buffer.from(`${text.endsWith('\n') ? text : `${text}\n`}\n${yamlText}`);
  validateQualityApplicabilityPopulation(parseYaml(postimage));
  return postimage;
}
