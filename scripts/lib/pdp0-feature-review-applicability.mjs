import { createHash } from "node:crypto";

const SOURCE_LABEL_CHANNEL = Object.freeze({
  web: "media.channel.web",
  cli: "media.channel.cli",
  api: "media.channel.api",
  embedded: "media.channel.embedded",
  "http-api": "media.channel.http-api",
  "grpc-api": "media.channel.grpc-api",
  sdk: "media.channel.sdk",
  "product-integration": "media.channel.product-integration",
});

const APPLICABLE = new Set([
  "SOURCE_DECLARED_DEFINITION_APPLICABLE",
  "PROTOCOL_NEUTRAL_API_APPLICABLE_CONCRETE_BINDING_REQUIRED",
  "DEFINITION_APPLICABLE_REQUIRES_EXACT_AGENT_BINDING",
]);
const EXCLUDED = new Set([
  "OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF",
  "EXCLUDED_FROM_ACTIVE_PRODUCT_SCOPE",
  "OUTSIDE_SELECTED_ACTOR_SCOPE",
  "NOT_A_CAPABILITY_INVOCATION_CHANNEL",
]);

const unique = (values) => Array.isArray(values) && new Set(values).size === values.length;
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
const isDownstreamPhaseRef = (ref) => typeof ref === "string"
  && /^\.product-experience\/pdp-[1-9]-/u.test(ref);

// Reviewed clause contracts are pinned by exact semantic record content. A
// resolvable but unrelated selector is not sufficient evidence for a dimension.
const REVIEW_CLAUSE_FINGERPRINTS = Object.freeze({
  "media.feature-review-dimension.ingestion-source-preservation": "5f367b4a4647cc12e104fd2845a05c261c9f6e5b20cab389e953536c49960c54",
  "media.feature-review-dimension.time-synchronization": "356cf20b50d53583190ee66466db78a2079b34ee1648f50c565338670bad7c34",
  "media.feature-review-dimension.audio-workflows": "1dcd5887a43f29630b6788ec1d3abc3c8badec32e0446f6b30a7920a006b63c4",
  "media.feature-review-dimension.speech-workflows": "a8f0a7d3910df48c387f2695f8ab77f1b5a61376c759eaf196bab0bcccd732b3",
  "media.feature-review-dimension.video-image": "b09d150bd8c981c07670b155dfdc42d3c857c96c164e7c2d02b8fc57a389804c",
  "media.feature-review-dimension.animation-spatial": "c289f96e456370a6590430ea276c1f8e87a29f004257c747ae0561e6aab09fdb",
  "media.feature-review-dimension.generative-media": "8ae302bb5b85e3191b1bd3fce8e7cc85b27e55342e963bd3e940531933f27ea8",
  "media.feature-review-dimension.quality-scientific-truth": "29d8ea54a727b26278985cca2f6a1d1b8b0431b5543dd3f1eea69277cec34720",
  "media.feature-review-dimension.rights-safety-audit": "7a0650e15f38ea6f83f35e4bdd8272a4bcf3a7f34b2922f550636cfd773d61dc",
  "media.feature-review-dimension.review-collaboration": "228c70cfcd95dd3fecce2548316e59875756d4b5591f248238d89b7f88ad4c1f",
  "media.feature-review-dimension.asynchronous-jobs-streaming": "7c7fc19cc8ab3a0834a3f21fffc27f797ccf8f8cdbb27d7ed9c00fff58b3a4d5",
  "media.feature-review-dimension.offline-reconnect": "241a84c6a4afe1be15520331a64d1da69902fce7a29d49b5143c719dc9c3cb6a",
  "media.feature-review-dimension.api-sdk-cli-events-tools": "e646f4ccd10f44e4de6a693be5af963376182f8924d46cdca775da795e93e628",
  "media.feature-review-dimension.accessibility-internationalization": "90d3771a28d372fee6c7673d692c95bd6477946249c4fbffbbd1605e811c1b10",
  "media.feature-review-dimension.security-operations": "7d884f433950db6589dadbe68bcb8ed164334ddf34b574683ca3216f51987301",
});

function resolveSelector(ref, sourceDocuments) {
  if (!nonblank(ref)) return undefined;
  const split = ref.indexOf("#");
  if (split <= 0) return undefined;
  const document = sourceDocuments?.[ref.slice(0, split)];
  if (document === undefined) return undefined;
  const fragment = ref.slice(split + 1).replace(/^\//u, "");
  let value = document;
  if (!fragment) return value;
  for (const part of fragment.split("/")) {
      const identity = /^@(id|machineId|capabilityRef)=(.+)$/u.exec(part);
      if (identity) {
        if (!Array.isArray(value)) return undefined;
      value = value.find((row) => row[identity[1]] === identity[2]);
    } else if (Array.isArray(value) && /^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    if (value === undefined) return undefined;
  }
  return value;
}

/** Resolve the full definition-only 15×38 dimension and 462-leaf applicability join. */
export function resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities, capabilityCrosswalk, channels, sourceDocuments, reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText, qualityMetricObservations, qualityPolicySourceText, qualityCurrentSourceReview, qualityCurrentSourceReviewText, animationRelationshipObservation, animationRelationshipObservationText, relationshipSourceText, textToImageObservation, textToImageObservationText, capabilitiesSourceText, capabilityIntentOwnerBindingObservation, capabilityIntentOwnerBindingObservationText, capabilitySemanticReview, capabilitySemanticReviewText, policyAuthorityObservation, policyAuthorityObservationText, policyAuthoritySourceText, cliChannelObservation, cliChannelObservationText, applicationsChannelsSourceText, qualificationPolicyObservation, qualificationPolicyObservationText, qualificationPolicySourceText }) {
  const fail = (reason) => { throw new Error(`Invalid PDP-0 feature applicability: ${reason}`); };
  const dimensions = applicability?.dimensions;
  const requirementRows = requirements?.requirements;
  const capabilityRows = capabilities?.capabilities;
  const families = capabilities?.families;
  const leafRows = capabilityCrosswalk?.records;
  if (!Array.isArray(dimensions) || dimensions.length !== 15 || !unique(dimensions.map(({ id }) => id))) fail("dimension population must be 15 unique records");
  if (!Array.isArray(requirementRows) || requirementRows.length !== 38 || !unique(requirementRows.map(({ id }) => id))) fail("requirement population must be 38 unique types");
  if (!Array.isArray(capabilityRows) || capabilityRows.length !== 462 || !unique(capabilityRows.map(({ id }) => id))) fail("capability population must be 462 unique leaves");
  if (!Array.isArray(leafRows) || leafRows.length !== 462 || !unique(leafRows.map(({ capabilityRef }) => capabilityRef))) fail("leaf crosswalk must cover 462 unique leaves");
  if (!Array.isArray(channels) || channels.length !== 11 || !unique(channels.map(({ id }) => id))) fail("active definition channel union must contain 11 unique IDs");
  if (applicability.coverageDimensions !== 15 || applicability.requirementTypeCount !== 38 || applicability.leafCount !== 462) fail("declared census differs from source populations");
  const p0Join = applicability.authorityBoundary?.activePdp0Join;
  if (p0Join?.identity !== "capabilityIntentId" || p0Join?.p1OperationRequired !== false
      || p0Join?.identitySourceRef !== ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=<capabilityIntentId>"
      || p0Join?.familyMembershipSourceRef !== ".product-experience/pdp-0-product-truth/capabilities.yaml#families"
      || p0Join?.applicabilitySourceRef !== ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=<capabilityIntentId>"
      || p0Join?.semanticFields?.outcome !== ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=<capabilityIntentId>/outcome"
      || p0Join?.semanticFields?.actors !== ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=<capabilityIntentId>/actorRoles"
      || !Array.isArray(p0Join.semanticFields?.inputShapes) || !p0Join.semanticFields.inputShapes.includes(".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=<capabilityIntentId>/ownerDefinition/typedInputSlots")
      || !Array.isArray(p0Join.semanticFields?.outputShapes) || !p0Join.semanticFields.outputShapes.includes(".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=<capabilityIntentId>/ownerDefinition/successOutputs")
      || p0Join?.semanticFields?.channelApplicability !== ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=<capabilityIntentId>/channelApplicability") {
    fail("active applicability join must resolve exact P0 capability intent, semantic input/output meaning, and channel applicability without PDP-1 operation identity");
  }
  if (!applicability.authorityBoundary?.activePdp0Join?.joinRule?.includes("capabilityIntentId")
      || !applicability.authorityBoundary.activePdp0Join.activeEvidenceFields?.includes("applicableRequirementBindings[].capabilityRefs")
      || !sourceDocuments?.[".product-experience/pdp-0-product-truth/requirements.yaml"]
      || !resolveSelector(p0Join.familyMembershipSourceRef, sourceDocuments)
      || !resolveSelector(".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities", sourceDocuments)
      || !resolveSelector(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records", sourceDocuments)) {
    fail("active dimensions must share the declared P0-only capability intent join and resolve its exact source catalogs");
  }
  if (applicability.authorityBoundary?.downstreamNonGatingOperationContext?.gatingForPdp0 !== false) {
    fail("retained PDP-1 operation evidence must be explicitly non-gating for P0");
  }
  const expectedArtifactSha256 = "9294d3e13ee01e35bbe24b8cfaefec23316b17d43b969f057924a980e46cb922";
  if (typeof reviewedMaterialArtifactText !== "string"
      || createHash("sha256").update(reviewedMaterialArtifactText).digest("hex") !== expectedArtifactSha256
      || reviewedMaterialArtifact?.decisionRef !== ".product-experience/decision-log.md#PXD-098"
      || reviewedMaterialArtifact.records?.length !== 45
      || Object.keys(reviewedMaterialArtifact.dimensionClauseFingerprints ?? {}).length !== 15) {
    fail("PXD-098 exact clause/referent review artifact is absent or changed");
  }
  const correctionSha256 = "3f3fff501a396a38ca964b265ec31112484a7c0c41931bb7997e0ca46df87f85";
  const correction = reviewedReferenceCorrectionArtifact;
  const approvedCorrection = new Map();
  if (typeof reviewedReferenceCorrectionArtifactText === "string"
      && createHash("sha256").update(reviewedReferenceCorrectionArtifactText).digest("hex") === correctionSha256
      && correction?.schemaVersion === "media.pdp38.feature-review-referent-correction.v1"
      && correction?.decisionRef === ".product-experience/decision-log.md#PXD-101"
      && correction?.baseArtifactRef === "docs/implementation/verification/pdp-38/feature-review-45-clause-material-review.json"
      && correction?.baseArtifactSha256 === expectedArtifactSha256
      && correction?.records?.length === 1) {
    const record = correction.records[0];
    const current = resolveSelector(record.sourceRef, sourceDocuments);
    const currentHash = current === undefined ? null : createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const revert = current === undefined ? null : structuredClone(current);
    const expectedChanges = [
      ["ownerDefinition", "channelApplicabilityRef"],
      ["ownerDefinition", "canonicalAuthorityRefs", "0"],
      ["ownerDefinition", "canonicalAuthorityRefs", "1"],
      ["ownerDefinition", "canonicalAuthorityRefs", "2"],
    ];
    const samePaths = Array.isArray(record.reviewedReferenceChanges)
      && JSON.stringify(record.reviewedReferenceChanges.map(({ path }) => path)) === JSON.stringify(expectedChanges);
    if (record.reviewStatus === "APPROVED_EXACT_REFERENCE_ONLY_CORRECTION"
        && record.identity === "media.generate.image.text-to-image"
        && currentHash === record.currentContentSha256
        && samePaths) {
      for (const change of record.reviewedReferenceChanges) {
        let target = revert;
        for (const part of change.path.slice(0, -1)) target = target?.[part];
        const leaf = change.path.at(-1);
        if (!target || target[leaf] !== change.current) { target = null; break; }
        target[leaf] = change.prior;
      }
      const revertedHash = revert && createHash("sha256").update(JSON.stringify(revert)).digest("hex");
      if (revertedHash === record.priorContentSha256) approvedCorrection.set(record.sourceRef, record);
    }
  }
  const qualityObservationExpectations = [
    { id: "QUALITY-METRIC-AUDIO-LOUDNESS-TRUE-PEAK", artifactSha256: "22bf29748e7044610788cff3fe3851e06bb75f964258a0921b6352f4aeb627ff", priorHash: "1ca8c4fea8ac355fed2c76bdc9640a6244f7105fdcce4acdb0eac15c2da041b7", currentHash: "e109dbbc2d8cb250c3220625a541e38d03eaca7b727515a4c9e693e99fb5c34e", priorApplicable: 117, currentApplicable: 116, priorExcluded: 345, currentExcluded: 346, scope: "Loudness and true-peak measurements for a declared audio delivery target." },
    { id: "QUALITY-METRIC-AUDIO-DEFECTS", artifactSha256: "9ce6d0a30933e3f4a95b08fcc56f2294af1c3270ea5ad6e2cbff177a15a18656", priorHash: "e9f9798be75dc293d8d3e2282a15bdfd387fcc86bc8b8b100dc7b550584a10bb", currentHash: "5d7b7f7f12e1ad69f6ee97d102b4af58c59435b485c1d6bfc56bc6c60e8b3fa5", priorApplicable: 117, currentApplicable: 116, priorExcluded: 345, currentExcluded: 346, scope: "Audio noise, clipping, distortion, intelligibility, and signal defects for a declared task." },
    { id: "QUALITY-METRIC-AUDIO-NATURALNESS", artifactSha256: "e23767211ff244c69c4f187c735cc52bd07ac2f86bdfbd08c17b23597027ce92", priorHash: "a42cc26400a1f75862b11c7d67fcb5892e0d018f58a01935e522a2c59350e21f", currentHash: "c9265c66a3278143df06fd4578d2ae10804f381877ad77396be42416a7965e7d", priorApplicable: 60, currentApplicable: 59, priorExcluded: 402, currentExcluded: 403, scope: "Naturalness of generated, converted, enhanced, or synthesized audio for a declared content and locale class." },
  ];
  const qualityPolicyPath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
  const qualitySourceSha256 = typeof qualityPolicySourceText === "string"
    ? createHash("sha256").update(qualityPolicySourceText).digest("hex") : null;
  const historicalQualitySourceSha256 = qualityMetricObservations?.[0]?.artifact?.currentSourceSha256;
  if (!Array.isArray(qualityMetricObservations) || qualityMetricObservations.length !== qualityObservationExpectations.length
      || !qualitySourceSha256
      || !historicalQualitySourceSha256
      || qualityMetricObservations.some(({ artifact }) => artifact?.currentSourceSha256 !== historicalQualitySourceSha256)) {
    fail("PXD-098 quality referent observations or their shared historical source cut are absent");
  }
  const qualityCleanupSupplement = qualityMetricObservations[0]?.artifact?.currentSourceAuthorityCleanupObservation;
  const qualityCleanupValid = qualityCleanupSupplement?.proposedDecisionRef === ".product-experience/decision-log.md#PXD-124"
    && qualityCleanupSupplement?.status === "PROPOSED_ADDITIVE_CURRENT_SOURCE_SUPPLEMENT"
    && qualityCleanupSupplement?.sourceRef === qualityPolicyPath
    && qualityCleanupSupplement?.currentSourceSha256 === historicalQualitySourceSha256
    && qualityCleanupSupplement?.acceptanceEffect === "none"
    && qualityCleanupSupplement?.records?.length === qualityObservationExpectations.length;
  if (!qualityCleanupValid) fail("PXD-124 quality-policy current-source observation is absent or does not pin the exact cleanup supplement");
  const qualitySourceReview = qualityCurrentSourceReview;
  const qualitySourceReviewValid = qualitySourceReview?.schemaVersion === "media.pdp0.quality-current-source-review.v1"
    && qualitySourceReview?.artifactId === "P0-QUALITY-CURRENT-SOURCE-REVIEW-001"
    && qualitySourceReview?.sources?.qualityPolicy?.path === qualityPolicyPath
    && qualitySourceReview?.sources?.qualityPolicy?.currentSha256 === qualitySourceSha256
    && qualitySourceReview?.sources?.capabilities?.path === ".product-experience/pdp-0-product-truth/capabilities.yaml"
    && qualitySourceReview?.sources?.capabilities?.currentSha256 === createHash("sha256").update(capabilitiesSourceText ?? "").digest("hex")
    && qualitySourceReview?.reviewedPopulation?.capabilityRows === 462
    && qualitySourceReview?.reviewedPopulation?.uniqueCapabilityRefs === 462
    && qualitySourceReview?.reviewedPopulation?.qualityDimensions === 6
    && qualitySourceReview?.reviewedPopulation?.metricDefinitions === 16
    && qualitySourceReview?.reviewedPopulation?.dimensionDispositions === 2772
    && qualitySourceReview?.reviewedPopulation?.metricDispositions === 7392
    && qualitySourceReview?.semanticEquivalence === "NOT_ASSERTED"
    && qualitySourceReview?.acceptanceEffect === "none; current-source structural and semantic join checks only"
    && qualitySourceReview?.historicalBoundary?.acceptanceEffect === "none"
    && typeof qualityCurrentSourceReviewText === "string"
    && JSON.stringify(JSON.parse(qualityCurrentSourceReviewText)) === JSON.stringify(qualitySourceReview);
  if (!qualitySourceReviewValid) fail("P0 quality current-source review is absent, stale, or has an invalid acceptance boundary");
  const approvedCurrentSourceObservation = new Map();
  const qualificationObservationSha256 = "8b55a7f9c9f5664c3aaede25f453161f365c0788b09bc041ba1de7526cc71e9a";
  const qualificationSourceRef = ".product-experience/pdp-0-product-truth/qualification-policy.yaml#decisionRules";
  const qualificationSource = resolveSelector(qualificationSourceRef, sourceDocuments);
  const qualificationRecord = qualificationPolicyObservation?.record;
  const qualificationHistoricalReferent = reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
    sourceRef === qualificationSourceRef && identity === null && contentSha256 === "c71df52fa9ef472a9ba1353fc97ae5b4762f3d772c3f140ebc7e3feef563b791"));
  const qualificationValid = typeof qualificationPolicyObservationText === "string"
    && createHash("sha256").update(qualificationPolicyObservationText).digest("hex") === qualificationObservationSha256
    && qualificationPolicyObservation?.schemaVersion === "media.pdp38.feature-review-current-source-observation.v1"
    && qualificationPolicyObservation?.decisionRef === ".product-experience/decision-log.md#PXD-105"
    && qualificationPolicyObservation?.baseReviewSha256 === expectedArtifactSha256
    && qualificationPolicyObservation?.sourcePath === ".product-experience/pdp-0-product-truth/qualification-policy.yaml"
    && qualificationPolicyObservation?.sourcePinSha256 === "93a69ee00fbf5020f78b96e9558af61f2344b873f975f5381adbf1bd42840b7a"
    && qualificationPolicyObservation?.currentSourceSha256 === createHash("sha256").update(qualificationPolicySourceText ?? "").digest("hex")
    && qualificationPolicyObservation?.currentSourceSha256 === "ec39afca8df04e5087482a1f393a32af4775f990571a5568d3ab7caed3385e5e"
    && qualificationRecord?.sourceRef === qualificationSourceRef
    && qualificationRecord?.identity === null
    && qualificationRecord?.historicalPxd098ContentSha256 === "c71df52fa9ef472a9ba1353fc97ae5b4762f3d772c3f140ebc7e3feef563b791"
    && qualificationRecord?.currentContentSha256 === "e6ac071ed2fc0a1ee8e3906fd831516bd71fb9aadbb14ff58f7139bcff26eb48"
    && qualificationRecord?.currentContentSha256 === createHash("sha256").update(JSON.stringify(qualificationSource)).digest("hex")
    && JSON.stringify(qualificationRecord?.changedPaths) === JSON.stringify([{ path: [4], prior: null, current: qualificationSource?.[4] }])
    && qualificationRecord?.semanticEquivalence === "NOT_ASSERTED"
    && qualificationPolicyObservation?.acceptanceEffect === "none"
    && qualificationHistoricalReferent;
  if (!qualificationValid) fail("PXD-098 qualification decisionRules current-source observation is absent, stale, forged, or overbroad");
  approvedCurrentSourceObservation.set(qualificationRecord.sourceRef, qualificationRecord);
  for (let index = 0; index < qualityObservationExpectations.length; index += 1) {
    const expected = qualityObservationExpectations[index];
    const item = qualityMetricObservations[index];
    const observation = item?.artifact;
    const record = observation?.record;
    const current = record ? resolveSelector(record.sourceRef, sourceDocuments) : undefined;
    const currentHash = current === undefined ? null : createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const cleanup = qualityCleanupSupplement.records.find(({ identity }) => identity === expected.id);
    const expectedPaths = [
      { path: ["ownerCurrentApplicability", "capabilityRefs"], removed: ["media.master.audio.phase-noise-floor-analyze"], added: [] },
      { path: ["ownerCurrentApplicability", "applicableCount"], prior: expected.priorApplicable, current: expected.currentApplicable },
      { path: ["ownerCurrentApplicability", "notApplicableCount"], prior: expected.priorExcluded, current: expected.currentExcluded },
    ];
    if (typeof item?.text !== "string"
        || createHash("sha256").update(item.text).digest("hex") !== expected.artifactSha256
        || observation?.schemaVersion !== "media.pdp38.feature-review-current-source-observation.v1"
        || observation?.decisionRef !== ".product-experience/decision-log.md#PXD-105"
        || observation?.baseReviewSha256 !== expectedArtifactSha256
        || observation?.sourcePinSha256 !== "3e0f82742ca924248d3ea1ab83085d939ba67b445f9676935a82dd0a3871b3de"
        || observation?.currentSourceSha256 !== qualityMetricObservations[0].artifact.currentSourceSha256
        || record?.sourceRef !== `.product-experience/pdp-0-product-truth/quality-policy.yaml#metricDefinitions/@id=${expected.id}`
        || record?.identity !== expected.id
        || record?.historicalPxd098ContentSha256 !== expected.priorHash
        || record?.currentContentSha256 !== expected.currentHash
        || currentHash !== cleanup?.currentContentSha256
        || record?.changedPaths === undefined
        || JSON.stringify(record.changedPaths) !== JSON.stringify(expectedPaths)
        || record.preserved?.scope !== expected.scope
        || record.preserved?.applicableCountPlusNotApplicableCount !== 462
        || !record.semanticParityRationale?.includes("phase-noise-floor")) {
      fail(`PXD-098 quality referent current-source observation for ${expected.id} is absent, changed, or overbroad`);
    }
    const cleanupMetric = current;
    const cleanupPathsValid = cleanup?.priorContentSha256 === expected.currentHash
      && JSON.stringify(cleanup?.changedPaths?.map(({ path }) => path)) === JSON.stringify([["capabilityRefs"], ["capabilityRefState"]])
      && cleanup.changedPaths[0].prior?.length === 0
      && cleanup.changedPaths[0].current === "ABSENT"
      && cleanup.changedPaths[1].current === "ABSENT"
      && cleanupMetric?.ownerCurrentApplicability
      && createHash("sha256").update(JSON.stringify(cleanupMetric.ownerCurrentApplicability)).digest("hex") === cleanup.preservedNestedOwnerApplicabilitySha256
      && !Object.hasOwn(cleanupMetric, "capabilityRefs")
      && !Object.hasOwn(cleanupMetric, "capabilityRefState");
    if (!cleanupPathsValid) fail(`PXD-124 quality cleanup supplement for ${expected.id} is absent, changed, or overbroad`);
    if (index === 0) {
      const supplement = observation.additionalCurrentSourceObservation;
      const expectedGapPaths = ["capabilityReferences", "domainAndFidelityReferences", "privacyAndRightsGates"];
      if (supplement?.acceptanceEffect !== "none"
          || JSON.stringify(supplement?.changedPaths?.map(({ path }) => path)) !== JSON.stringify(expectedGapPaths.map(key => ["integrationGaps", key]))
          || supplement.changedPaths.some(({ path, current }) => JSON.stringify(resolveSelector(`.product-experience/pdp-0-product-truth/quality-policy.yaml#${path.join("/")}`, sourceDocuments)) !== JSON.stringify(current))) {
        fail("PXD-105 quality-policy current-source status observation is absent or does not match the exact integration-gap correction");
      }
      const coverage = supplement.resolvedOwnerApplicability;
      if (coverage?.dimensions !== 6 || coverage?.metrics !== 16 || coverage?.capabilityLeaves !== 462
          || coverage?.status !== "COMPLETE_DEFINITION_ONLY"
          || coverage?.measurementAndCalibration !== "NOT_EVALUATED"
          || coverage?.sourceRef !== ".product-experience/pdp-0-product-truth/quality-policy.yaml#ownerQualityApplicabilityCrosswalk"
          || coverage?.rootCapabilityRefPlaceholdersRemoved?.dimensions !== 6
          || coverage?.rootCapabilityRefPlaceholdersRemoved?.metrics !== 16
          || coverage?.capabilityRefState !== "P0 applicability is defined by the owner crosswalk"
          || coverage?.candidateQualificationState !== "NOT_EVALUATED") {
        fail("PXD-105 quality-policy observation does not record the resolved owner applicability coverage boundary");
      }
    }
    const hasHistoricalReferent = reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
      sourceRef === record.sourceRef && identity === record.identity && contentSha256 === record.historicalPxd098ContentSha256));
    if (!hasHistoricalReferent || observation.acceptanceEffect !== "none") fail(`PXD-098 quality observation for ${expected.id} lacks its exact historical referent or is not observation-only`);
    approvedCurrentSourceObservation.set(record.sourceRef, {
      ...record,
      currentContentSha256: cleanup.currentContentSha256,
    });
  }
  const currentQualityPolicy = sourceDocuments?.[qualityPolicyPath];
  if (!currentQualityPolicy || currentQualityPolicy.metricDefinitions?.length !== 16 || currentQualityPolicy.qualityDimensions?.length !== 6) {
    fail("P0 quality current-source review does not resolve the complete current metric and dimension records");
  }
  for (const { referents = [] } of reviewedMaterialArtifact.records) {
    for (const referent of referents) {
      if (!/^\.product-experience\/pdp-0-product-truth\/quality-policy\.yaml#(?:metricDefinitions|qualityDimensions)\/@id=/u.test(referent.sourceRef)) continue;
      const currentRecord = resolveSelector(referent.sourceRef, sourceDocuments);
      const currentHash = currentRecord === undefined ? null : createHash("sha256").update(JSON.stringify(currentRecord)).digest("hex");
      if (!currentRecord || currentRecord.id !== referent.identity || !currentHash) {
        fail(`P0 quality current-source review cannot resolve exact PXD-098 referent ${referent.sourceRef}`);
      }
      const existing = approvedCurrentSourceObservation.get(referent.sourceRef);
      if (existing && (existing.identity !== referent.identity || existing.historicalPxd098ContentSha256 !== referent.contentSha256)) {
        fail(`P0 quality current-source review found conflicting historical identities for ${referent.sourceRef}`);
      }
      approvedCurrentSourceObservation.set(referent.sourceRef, {
        sourceRef: referent.sourceRef,
        identity: referent.identity,
        historicalPxd098ContentSha256: referent.contentSha256,
        currentContentSha256: currentHash,
      });
    }
  }
  const relationshipObservationSha256 = "ab16b84e46c90db5054db696481b400a442733dcd4015787e6b783183224e5df";
  const relationshipRecord = animationRelationshipObservation?.record;
  const relationshipSource = relationshipRecord ? resolveSelector(relationshipRecord.sourceRef, sourceDocuments) : undefined;
  const relationshipHash = relationshipSource === undefined
    ? null
    : createHash("sha256").update(JSON.stringify(relationshipSource)).digest("hex");
  const relationshipExpectedChanges = [
    {
      path: ["sourceRefs"],
      prior: [".product-experience/pdp-0-product-truth/domain-model.yaml#AnimationGraph", ".product-experience/pdp-0-product-truth/domain-model.yaml#SceneGraph"],
      current: [".product-experience/pdp-0-product-truth/domain-model.yaml#AnimationGraph", ".product-experience/pdp-0-product-truth/domain-model.yaml#SceneGraph", ".product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=media.identity-contract.animation-graph", ".product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=media.identity-contract.scene-graph"],
    },
    { path: ["scopeStatus"], prior: "proposed; pending-owner-review", current: "OWNER_DEFINED_LOGICAL_RELATIONSHIP_DEFINITION_ONLY; runtime-NOT_ADMITTED" },
    { path: ["ownerDefinition"], prior: null, current: relationshipSource?.ownerDefinition },
  ];
  const relationshipObservationChecks = {
    artifactDigest: typeof animationRelationshipObservationText === "string" && createHash("sha256").update(animationRelationshipObservationText).digest("hex") === relationshipObservationSha256,
    schemaAndDecision: animationRelationshipObservation?.schemaVersion === "media.pdp38.feature-review-current-source-observation.v1"
      && animationRelationshipObservation?.decisionRef === ".product-experience/decision-log.md#PXD-105"
      && animationRelationshipObservation?.relatedOwnerDecisionRef === ".product-experience/decision-log.md#PXD-119"
      && animationRelationshipObservation?.baseReviewSha256 === expectedArtifactSha256,
    sourcePin: animationRelationshipObservation?.sourcePinSha256 === "4224eb4c0cac5cfb62f66ab80e4b9cf2d3d845be612a012bbf9baeeb6d2ea1df"
      && typeof relationshipSourceText === "string"
      && createHash("sha256").update(relationshipSourceText).digest("hex") === animationRelationshipObservation.currentSourceSha256,
    currentIdentityAndHash: relationshipRecord?.sourceRef === ".product-experience/pdp-1-domain-data/relationships.yaml#relationships/@id=media.rel.animation-property-owner"
      && relationshipRecord?.identity === "media.rel.animation-property-owner"
      && relationshipRecord?.historicalPxd098ContentSha256 === "feed57c57a5b25f48efdeed5b67937b2d752e75910d93d2748d409a9d865a3d3"
      && relationshipRecord?.currentContentSha256 === "d4426cd4d6027d66b938e188c4e5a143185c5576fce35cba4e497debce8b54c2"
      && relationshipHash === relationshipRecord.currentContentSha256,
    exactDelta: JSON.stringify(relationshipRecord?.changedPaths) === JSON.stringify(relationshipExpectedChanges),
    currentOwnerDecision: relationshipSource?.ownerDefinition?.ownerDecisionId === "PXD-119",
    observationBoundary: relationshipRecord?.sourceInterpretation?.includes("byte or semantic parity")
      && animationRelationshipObservation.acceptanceEffect === "none",
    historicalReferent: reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
      sourceRef === relationshipRecord?.sourceRef && identity === relationshipRecord?.identity
      && contentSha256 === relationshipRecord?.historicalPxd098ContentSha256)),
  };
  const failedRelationshipChecks = Object.entries(relationshipObservationChecks).filter(([, valid]) => !valid).map(([name]) => name);
  // The relationship record is a current-source observation about retained
  // PDP-1 context. It can validate that supplement, but never gates the P0
  // capability-intent and channel-applicability result.
  if (failedRelationshipChecks.length === 0) approvedCurrentSourceObservation.set(relationshipRecord.sourceRef, relationshipRecord);
  const textToImageExpectedSha256 = "a04c66a7365cfc7a9ba4113e4ddcd71bcebc5498ca36bd67115fa6f99e898dfc";
  const textToImage = textToImageObservation?.record;
  const textToImageSource = textToImage ? resolveSelector(textToImage.sourceRef, sourceDocuments) : undefined;
  const textToImageHash = textToImageSource === undefined ? null : createHash("sha256").update(JSON.stringify(textToImageSource)).digest("hex");
  const textToImageExpectedPaths = [
    ["supportedParameters"], ["executionResourceRequirements"], ["ownerDefinition", "ownerDisposition"],
    ["ownerDefinition", "operationRefs"], ["ownerDefinition", "operationKind"], ["ownerDefinition", "operationContractRef"],
    ["ownerDefinition", "typedInputSlots", "0", "payloadSchemaRef"], ["ownerDefinition", "typedInputSlots", "1", "payloadSchemaRef"],
    ["ownerDefinition", "successOutputs", "0", "payloadSchemaRef"], ["ownerDefinition", "idempotency"],
    ["ownerDefinition", "recovery"], ["ownerDefinition", "canonicalAuthorityRefs"],
    ["ownerDefinition", "capabilityIntentId"], ["intentBindingState"], ["requirementTraceState"], ["semanticReferenceScope"],
  ];
  const textToImageSourceHash = typeof capabilitiesSourceText === "string"
    ? createHash("sha256").update(capabilitiesSourceText).digest("hex") : null;
  const capabilityIntentOwnerBindingExpectedSha256 = "e33af569db9ea0b510af334af8dfc4ae2e2c05cd0b2fa32e57a889e94023ba7a";
  const capabilitySemanticReviewExpectedSha256 = "7ad8839b066ddb6775707d6a7683c79acf7cc6db94c2ac1a6b01c5475674146b";
  const capabilitySemanticReviewValid = typeof capabilitySemanticReviewText === "string"
    && createHash("sha256").update(capabilitySemanticReviewText).digest("hex") === capabilitySemanticReviewExpectedSha256
    && capabilitySemanticReview?.schemaVersion === "media.pdp0.capability-semantic-current-source-review.v1"
    && capabilitySemanticReview?.source?.path === ".product-experience/pdp-0-product-truth/capabilities.yaml"
    && capabilitySemanticReview?.source?.currentSha256 === textToImageSourceHash
    && capabilitySemanticReview?.source?.historicalComparison?.priorSha256 === capabilityIntentOwnerBindingObservation?.source?.currentSha256
    && capabilitySemanticReview?.source?.historicalComparison?.availability === "UNAVAILABLE_PRIOR_BYTES_NOT_RETAINED"
    && capabilitySemanticReview?.source?.historicalComparison?.parsedPathDelta === "NOT_ASSERTED"
    && capabilitySemanticReview?.source?.recordPopulation?.count === 462
    && capabilitySemanticReview?.source?.effectIntentScopeCounts
    && Object.values(capabilitySemanticReview.source.effectIntentScopeCounts).reduce((sum, count) => sum + count, 0) === 462
    && capabilitySemanticReview?.decisionRef === ".product-experience/decision-log.md#PXD-122"
    && capabilitySemanticReview?.semanticEquivalence === "NOT_ASSERTED"
    && capabilitySemanticReview?.acceptanceEffect?.startsWith("none;")
    && capabilitySemanticReview?.currentSourceChecks?.length >= 5;
  if (!capabilitySemanticReviewValid) fail("PXD-122 current capability semantic review is absent, stale, or overbroad");
  const capabilityIntentOwnerBindingValid = typeof capabilityIntentOwnerBindingObservationText === "string"
    && createHash("sha256").update(capabilityIntentOwnerBindingObservationText).digest("hex") === capabilityIntentOwnerBindingExpectedSha256
    && capabilityIntentOwnerBindingObservation?.schemaVersion === "media.pdp0.capability-intent-current-source-observation.v1"
    && capabilityIntentOwnerBindingObservation?.source?.path === ".product-experience/pdp-0-product-truth/capabilities.yaml"
    && capabilityIntentOwnerBindingObservation?.source?.currentSha256 === capabilitySemanticReview?.source?.historicalComparison?.priorSha256
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.path === "capabilities"
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.count === 462
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.identitySetChange === "none"
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.ownerDispositionUnchanged === true
    && capabilityIntentOwnerBindingObservation?.authorityRule?.path === "capabilities.yaml#ownerDefinedCapabilityIntentBinding"
    && capabilityIntentOwnerBindingObservation?.authorityRule?.id === "media.capability-intent.owner-binding.v1"
    && capabilityIntentOwnerBindingObservation?.changes?.length === 5
    && capabilityIntentOwnerBindingObservation?.authorityRule?.meaning?.includes("ownerDisposition-specific meaning")
    && capabilityIntentOwnerBindingObservation?.authorityRule?.meaning?.includes("platform dependency with explicit applicability")
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.ownerDispositionCounts?.JOURNEY_STEP_CAPABILITY === 77
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.ownerDispositionCounts?.MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY === 383
    && capabilityIntentOwnerBindingObservation?.source?.recordPopulation?.ownerDispositionCounts?.PLATFORM_DEPENDENCY_WITH_EXPLICIT_APPLICABILITY === 2
    && capabilityIntentOwnerBindingObservation?.acceptanceEffect?.includes("independent P0-010 semantic acceptance remains pending")
    && capabilityRows.every((row) => row.ownerDefinition?.capabilityIntentId === row.id
      && row.intentBindingState?.startsWith("P0_OWNER_DEFINED_CAPABILITY_INTENT"));
  if (!capabilityIntentOwnerBindingValid) fail("current P0 capability-intent binding observation is absent, stale, or promotes P0-010 acceptance");
  const textToImageValid = typeof textToImageObservationText === "string"
    && createHash("sha256").update(textToImageObservationText).digest("hex") === textToImageExpectedSha256
    && textToImageObservation?.schemaVersion === "media.pdp38.feature-review-current-source-observation.v1"
    && textToImageObservation?.decisionRef === ".product-experience/decision-log.md#PXD-105"
    && textToImageObservation?.referenceCorrectionDecisionRef === ".product-experience/decision-log.md#PXD-101"
    && textToImageObservation?.baseReviewSha256 === expectedArtifactSha256
    && textToImageObservation?.sourcePath === ".product-experience/pdp-0-product-truth/capabilities.yaml"
    && textToImageObservation?.sourcePinSha256 === "f03fb72b7a3f1c8bb74d61a7dad101125c9dc1a1d4837d9cd2d8587446c04f1c"
    && textToImageObservation.currentSourceSha256 === capabilityIntentOwnerBindingObservation?.source?.currentSha256
    && textToImage?.sourceRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.generate.image.text-to-image"
    && textToImage?.identity === "media.generate.image.text-to-image"
    && textToImage?.historicalPxd098ContentSha256 === "3697f0a093ecae9bab2497f8a498ec6dba84b5b3d17d7020db300de2249725cc"
    && textToImage?.priorPxd101CurrentContentSha256 === "2a6fa4812b77fa1f1bfdb85d2c45d84b458a1a09e3702fa1b8cf468776c3cde8"
    && textToImage?.currentContentSha256 === "88238037f49e21bf55f2a7dcfcce6bc9db144e79ae8a05f087e1e67dd1aa5324"
    && textToImageHash !== textToImage.currentContentSha256
    && JSON.stringify(textToImage.changedPaths?.map(({ path }) => path)) === JSON.stringify(textToImageExpectedPaths)
    && textToImage.semanticEquivalence === "NOT_ASSERTED"
    && textToImageObservation.acceptanceEffect === "none"
    && textToImage.interpretation?.includes("does not claim that the record is unchanged")
    && textToImageObservation.acceptanceBoundary?.includes("No new clause approval");
  if (!textToImageValid) fail("PXD-098 text-to-image current-source observation is absent, changed, or overbroad");
  const textToImageHistoricalReferent = reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
    sourceRef === textToImage.sourceRef && identity === textToImage.identity && contentSha256 === textToImage.historicalPxd098ContentSha256));
  if (!textToImageHistoricalReferent) fail("PXD-098 text-to-image observation lacks its exact historical referent");
  if (capabilitySemanticReview?.source?.currentSha256 !== textToImageSourceHash) fail("PXD-122 capability review does not pin the current text-to-image source cut");
  approvedCurrentSourceObservation.set(textToImage.sourceRef, {
    ...textToImage,
    currentContentSha256: textToImageHash,
  });
  for (const { referents = [] } of reviewedMaterialArtifact.records) {
    for (const referent of referents) {
      if (!referent.sourceRef.startsWith(".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=")) continue;
      const currentRecord = resolveSelector(referent.sourceRef, sourceDocuments);
      if (!currentRecord || currentRecord.id !== referent.identity) continue;
      approvedCurrentSourceObservation.set(referent.sourceRef, {
        sourceRef: referent.sourceRef,
        identity: referent.identity,
        historicalPxd098ContentSha256: referent.contentSha256,
        currentContentSha256: createHash("sha256").update(JSON.stringify(currentRecord)).digest("hex"),
      });
    }
  }
  const policyAuthorityExpectedSha256 = "06f6fce847d41fc26468fcec04c019581e5f3afd2e617d7f5dfbcfd99067d9bb";
  const policyAuthority = policyAuthorityObservation?.record;
  const policyAuthoritySource = policyAuthority ? resolveSelector(policyAuthority.sourceRef, sourceDocuments) : undefined;
  const policyAuthorityHash = policyAuthoritySource === undefined ? null : createHash("sha256").update(JSON.stringify(policyAuthoritySource)).digest("hex");
  const policyAuthoritySourceHash = typeof policyAuthoritySourceText === "string"
    ? createHash("sha256").update(policyAuthoritySourceText).digest("hex") : null;
  const policyAuthorityValid = typeof policyAuthorityObservationText === "string"
    && createHash("sha256").update(policyAuthorityObservationText).digest("hex") === policyAuthorityExpectedSha256
    && policyAuthorityObservation?.schemaVersion === "media.pdp38.feature-review-current-source-observation.v1"
    && policyAuthorityObservation?.decisionRef === ".product-experience/decision-log.md#PXD-105"
    && policyAuthorityObservation?.baseReviewSha256 === expectedArtifactSha256
    && policyAuthorityObservation?.sourcePath === ".product-experience/pdp-0-product-truth/policy-authority-model.yaml"
    && policyAuthorityObservation?.sourcePinSha256 === "a553a79da537517a1380bd686eed2db73ba29ce6ace64f4a2f9f880e296dff80"
    && policyAuthoritySourceHash === policyAuthorityObservation.currentSourceSha256
    && policyAuthority?.sourceRef === ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#modelAcquisitionAndFallback"
    && policyAuthority?.identity === "media.policy.model-acquisition-and-fallback"
    && policyAuthority?.historicalPxd098ContentSha256 === "6ee7206bc1a51d53d526ac4cf5a7d13c4219c9f9cd915d74ffd4d23c287baef6"
    && policyAuthority?.priorPxd105CurrentSourceSha256 === policyAuthorityObservation.sourcePinSha256
    && policyAuthority?.currentContentSha256 === "e1ba9597b1b4a9867552cd7064efc1d068219ef7b6fe2e3ea27695883765920e"
    && policyAuthorityHash === policyAuthority.currentContentSha256
    && JSON.stringify(policyAuthority.changedPaths?.map(({ path }) => path)) === JSON.stringify([["fallback", "compatibilityDecisionRule"], ["offlineEntitlementWindow"]])
    && policyAuthority.semanticEquivalence === "NOT_ASSERTED"
    && policyAuthorityObservation.acceptanceEffect === "none"
    && policyAuthorityObservation.additionalCurrentSourceObservation?.acceptanceEffect === "none"
    && policyAuthorityObservation.additionalCurrentSourceObservation?.changedPaths?.length === 1
    && JSON.stringify(policyAuthorityObservation.additionalCurrentSourceObservation.changedPaths[0].path) === JSON.stringify(["productPolicy", "requirementBinding"])
    && policyAuthorityObservation.additionalCurrentSourceObservation.changedPaths[0].current === resolveSelector(".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/requirementBinding", sourceDocuments);
  if (!policyAuthorityValid) fail("PXD-098 policy-authority current-source observation is absent, changed, or overbroad");
  if (policyAuthority.changedPaths.some((change) => {
    let value = policyAuthoritySource;
    for (const part of change.path) value = value?.[part];
    return JSON.stringify(value ?? null) !== JSON.stringify(change.current ?? null) || change.prior !== null;
  })) fail("PXD-098 policy-authority observation does not match the exact additive current-source paths");
  const policyAuthorityHistoricalReferent = reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
    sourceRef === policyAuthority.sourceRef && identity === policyAuthority.identity && contentSha256 === policyAuthority.historicalPxd098ContentSha256));
  if (!policyAuthorityHistoricalReferent) fail("PXD-098 policy-authority observation lacks its exact historical referent");
  approvedCurrentSourceObservation.set(policyAuthority.sourceRef, policyAuthority);
  const cliChannelExpectedSha256 = "8f7dd8bb2b745dc1ad21002cd536feb560241a9b6ed9d61612e338c687471ed9";
  const cliChannel = cliChannelObservation?.record;
  const cliChannelSource = cliChannel ? resolveSelector(cliChannel.sourceRef, sourceDocuments) : undefined;
  const cliChannelHash = cliChannelSource === undefined ? null : createHash("sha256").update(JSON.stringify(cliChannelSource)).digest("hex");
  const cliChannelSourceHash = typeof applicationsChannelsSourceText === "string"
    ? createHash("sha256").update(applicationsChannelsSourceText).digest("hex") : null;
  const cliChannelPaths = [
    ["ownerCliDefinitionContract", "commandSurfaceSeparationRule"],
    ["ownerCliDefinitionContract", "filenameArgumentRule"],
    ["ownerCliDefinitionContract", "remoteCancellationRule"],
    ["ownerCliDefinitionContract", "submissionWaitRule"],
    ["ownerCliDefinitionContract", "machineOutputRule"],
    ["ownerCliDefinitionContract", "configurationPrecedenceRule"],
  ];
  const pdx123Supplement = cliChannelObservation?.pdx123CurrentSourceSupplement;
  const pdx123SupplementPaths = [
    ["ownerFeatureReviewApplicability", "authorityBoundary"],
    ["ownerFeatureReviewApplicability", "joinRule"],
    ["ownerFeatureReviewApplicability", "scopeLimit"],
    ["ownerFeatureReviewApplicability", "sourceContractSelectors"],
    ["channels", "@id=media.channel.web", "ownerDefinitionApplicability"],
    ["ownerLeafApplicabilityRules", "rules", "EXACT_LEAF_WEB_JOURNEY_VIEW_CONTEXT"],
    ["ownerLeafApplicabilityRules", "rules", "NO_OWNER_LINKED_WEB_JOURNEY"],
    ["capabilityChannelAliases", "rules", 0],
  ];
  const pdx123SupplementPathsValid = JSON.stringify(pdx123Supplement?.changedPaths?.map(({ path }) => path))
      === JSON.stringify(pdx123SupplementPaths)
    && pdx123Supplement.changedPaths.every(({ path, current, currentSha256 }) => {
      const resolved = resolveSelector(`.product-experience/pdp-0-product-truth/applications-channels.yaml#${path.join("/")}`, sourceDocuments);
      if (resolved === undefined) return false;
      return currentSha256
        ? createHash("sha256").update(JSON.stringify(resolved)).digest("hex") === currentSha256
        : JSON.stringify(resolved) === JSON.stringify(current);
    });
  const pdx123SupplementValid = pdx123Supplement?.decisionRef === ".product-experience/decision-log.md#PXD-123"
    && pdx123Supplement?.status === "ADDITIVE_CURRENT_SOURCE_OBSERVATION; PROPOSED_DECISION_REFERENCE"
    && pdx123Supplement?.sourcePath === ".product-experience/pdp-0-product-truth/applications-channels.yaml"
    && pdx123Supplement?.priorPxd105CurrentSourceSha256 === cliChannelObservation?.sourcePinSha256
    && pdx123Supplement?.currentSourceSha256 === cliChannelSourceHash
    && pdx123Supplement?.cliRecordUnchangedSincePxd105 === true
    && pdx123Supplement?.cliRecordContentSha256 === cliChannelHash
    && pdx123Supplement?.acceptanceEffect === "none"
    && pdx123SupplementPathsValid
    && pdx123Supplement?.webJourneyViewCurrentSourceObservation?.status === "ADDITIVE_CURRENT_SOURCE_OBSERVATION; PROPOSED_DECISION_REFERENCE"
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.scope === "P0-07 Web definition applicability for the media.project family only, grounded in owner-linked journey J-21 and its proposed views."
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.reason === "The P0 source correction adds J-21 to the media.project Web consumer map and includes J-21's proposed view context. This Web applicability update is unrelated to the CLI channel referent."
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.priorApplicationsChannelsSha256 === "2cc8a91ef71ca49f74fdeb5e929ec7b414963a814fa493e9b3687370a675d883"
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.currentApplicationsChannelsSha256 === cliChannelSourceHash
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.journeySourceRef === ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-21"
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.consumerSourceRef === ".product-experience/pdp-0-product-truth/applications-channels.yaml#channels/@id=media.channel.web/ownerDefinitionApplicability/familyConsumers/0"
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.consumerFamilyRef === "media.project"
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.cliRecordContentSha256 === cliChannelHash
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.cliRecordUnchanged === true
    && pdx123Supplement.webJourneyViewCurrentSourceObservation.acceptanceEffect === "none"
    && (() => {
      const refresh = pdx123Supplement.webJourneyViewCurrentSourceObservation;
      const journey = resolveSelector(refresh.journeySourceRef, sourceDocuments);
      const consumer = resolveSelector(refresh.consumerSourceRef, sourceDocuments);
      return journey?.id === "J-21"
        && createHash("sha256").update(JSON.stringify(journey)).digest("hex") === refresh.journeyContentSha256
        && consumer?.familyRef === refresh.consumerFamilyRef
        && JSON.stringify(consumer?.journeyRefs) === JSON.stringify(["J-01", "J-02", "J-21", "J-26"])
        && JSON.stringify(consumer?.viewRefs) === JSON.stringify(["M-ACTIVITY", "M-ASSET", "M-ASSETS", "M-AUTH", "M-CREATE", "M-HOME", "M-JOB", "M-OUTPUT", "M-PROJECT", "M-PROJECTS", "M-PROVENANCE", "M-RIGHTS", "M-REVIEW", "M-UPLOAD"])
        && createHash("sha256").update(JSON.stringify(consumer)).digest("hex") === refresh.consumerContentSha256;
    })();
  const cliChannelValid = typeof cliChannelObservationText === "string"
    && createHash("sha256").update(cliChannelObservationText).digest("hex") === cliChannelExpectedSha256
    && cliChannelObservation?.schemaVersion === "media.pdp38.feature-review-current-source-observation.v1"
    && cliChannelObservation?.decisionRef === ".product-experience/decision-log.md#PXD-105"
    && cliChannelObservation?.referenceCorrectionDecisionRef === ".product-experience/decision-log.md#PXD-101"
    && cliChannelObservation?.baseReviewSha256 === expectedArtifactSha256
    && cliChannelObservation?.sourcePath === ".product-experience/pdp-0-product-truth/applications-channels.yaml"
    && cliChannelObservation?.sourcePinSha256 === "1b626371aad85ef1a764bd012a724798b10706cae77ff252bfddf8c90c80b882"
    && cliChannelSourceHash === cliChannelObservation.currentSourceSha256
    && cliChannel?.sourceRef === ".product-experience/pdp-0-product-truth/applications-channels.yaml#channels/@id=media.channel.cli"
    && cliChannel?.identity === "media.channel.cli"
    && cliChannel?.historicalPxd098ContentSha256 === "6c8f7c48df970abc77aa47ca0aca7057253c241ab97310cadd0381e9731edcbf"
    && cliChannel?.priorPxd105CurrentSourceSha256 === cliChannelObservation.sourcePinSha256
    && cliChannel?.priorPxd101Disposition === "PXD-101 correction is scoped to media.generate.image.text-to-image and does not correct this CLI referent"
    && cliChannel?.currentContentSha256 === "5a70a1fb9b9f4bcbd26a57b987b264006272b03a1d68c45ed14906bce7b65f92"
    && cliChannelHash === cliChannel.currentContentSha256
    && JSON.stringify(cliChannel.changedPaths?.map(({ path }) => path)) === JSON.stringify(cliChannelPaths)
    && cliChannel.semanticEquivalence === "NOT_ASSERTED"
    && cliChannelObservation.acceptanceEffect === "none"
    && cliChannelObservation.additionalCurrentSourceObservation?.acceptanceEffect === "none"
    && JSON.stringify(cliChannelObservation.additionalCurrentSourceObservation.changedPaths?.map(({ path }) => path)) === JSON.stringify([
      ["ownerFeatureReviewApplicability", "sourceContractSelectors", "leafCapabilityProfileBoundsChannel"],
      ["ownerFeatureReviewApplicability", "sourceContractSelectors", "leafCapabilityProfileBoundsChannelRole"],
      ["ownerFeatureReviewApplicability", "sourceContractSelectors", "canonicalCapabilityOperationRole"],
    ])
    && cliChannelObservation.additionalCurrentSourceObservation.changedPaths.every(({ path, current }) =>
      JSON.stringify(resolveSelector(`.product-experience/pdp-0-product-truth/applications-channels.yaml#${path.join("/")}`, sourceDocuments)) === JSON.stringify(current))
    && pdx123SupplementValid;
  if (!cliChannelValid) fail("PXD-098 CLI channel current-source observation is absent, changed, or overbroad");
  if (cliChannel.changedPaths.some((change) => {
    let value = cliChannelSource;
    for (const part of change.path) value = value?.[part];
    return JSON.stringify(value ?? null) !== JSON.stringify(change.current ?? null) || change.prior !== null;
  })) fail("PXD-098 CLI channel observation does not match the exact additive current-source paths");
  const cliChannelHistoricalReferent = reviewedMaterialArtifact.records.some(({ referents = [] }) => referents.some(({ sourceRef, identity, contentSha256 }) =>
    sourceRef === cliChannel.sourceRef && identity === cliChannel.identity && contentSha256 === cliChannel.historicalPxd098ContentSha256));
  if (!cliChannelHistoricalReferent) fail("PXD-098 CLI channel observation lacks its exact historical referent");
  approvedCurrentSourceObservation.set(cliChannel.sourceRef, cliChannel);
  const reviewedClauses = new Map(reviewedMaterialArtifact.records.map((record) => [record.clauseId, record]));
  const expectedSelectors = {
    requirementTypes: ".product-experience/pdp-0-product-truth/requirements.yaml#requirements",
    familyMembership: ".product-experience/pdp-0-product-truth/capabilities.yaml#families",
    leafCapabilityIntentSemanticMeaning: ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities",
    leafCapabilityChannelApplicability: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records",
    leafCapabilityProfileBoundsChannel: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records",
  };
  for (const [key, value] of Object.entries(expectedSelectors)) if (applicability.sourceContractSelectors?.[key] !== value) fail(`source selector ${key} is stale`);

  const requirementIds = requirementRows.map(({ id }) => id);
  const requirementsById = new Map(requirementRows.map((row) => [row.id, row]));
  const capabilitiesById = new Map(capabilityRows.map((row) => [row.id, row]));
  const familyByRequirement = new Map(families.map((row) => [row.requirementId, row]));
  const activeChannelIds = new Set(channels.map(({ id }) => id));
  const resolvedDimensions = new Map();

  for (const dimension of dimensions) {
    if (!dimension.id?.startsWith("media.feature-review-dimension.") || dimension.scopeStatus !== "OWNER_DEFINED_APPLICABILITY_ONLY") fail("dimension has invalid identity or status");
    const expectedClauseFingerprint = REVIEW_CLAUSE_FINGERPRINTS[dimension.id];
    const actualClauseFingerprint = createHash("sha256").update(JSON.stringify(dimension.reviewClauseContracts ?? [])).digest("hex");
    if (!expectedClauseFingerprint || actualClauseFingerprint !== expectedClauseFingerprint) fail(`${dimension.id} review clause semantics differ from the reviewed exact contract`);
    if (!nonblank(dimension.scopeRationale) || !Array.isArray(dimension.dimensionEvidenceRefs) || dimension.dimensionEvidenceRefs.length === 0
      || !unique(dimension.dimensionEvidenceRefs) || dimension.dimensionEvidenceRefs.some((ref) => !isDownstreamPhaseRef(ref) && !resolveSelector(ref, sourceDocuments))
      ) fail(`${dimension.id} lacks the exact active P0 source and semantic join`);
    if (!Array.isArray(dimension.reviewClauseContracts) || dimension.reviewClauseContracts.length < 3
      || !Array.isArray(dimension.reviewClauseRefs) || !unique(dimension.reviewClauseRefs)
      || dimension.reviewClauseRefs.length !== dimension.reviewClauseContracts.length
      || !unique(dimension.reviewClauseContracts.map(({ id }) => id))) fail(`${dimension.id} lacks the exact mandatory review clause population`);
    const clauseIds = dimension.reviewClauseContracts.map(({ id }) => id);
    const clauseSources = new Set();
    for (const clause of dimension.reviewClauseContracts) {
      if (!clause.id?.startsWith(`media.feature-review-clause.${dimension.id.slice("media.feature-review-dimension.".length)}.`)
        || !nonblank(clause.criterion) || !nonblank(clause.reviewRule)
        || !Array.isArray(clause.sourceRefs) || clause.sourceRefs.length === 0
        || clause.sourceRefs.some((ref) => (!isDownstreamPhaseRef(ref) && !resolveSelector(ref, sourceDocuments)) || /#(?:objects|records|components|rules|variants|decisions|stateMachines|metricDefinitions|qualityDimensions)$/u.test(ref))) fail(`${dimension.id} has an unresolved or collection-level review clause`);
      const reviewed = reviewedClauses.get(clause.id);
      if (!reviewed || reviewed.dimensionId !== dimension.id
        || reviewed.clauseFingerprint !== createHash("sha256").update(JSON.stringify(clause)).digest("hex")
        || reviewed.reviewStatus !== "COORDINATOR_REVIEWED_BOUNDED_DEFINITION_CONTRACT"
        || JSON.stringify(reviewed.referents.map(({ sourceRef }) => sourceRef)) !== JSON.stringify(clause.sourceRefs)) {
        fail(`${dimension.id}/${clause.id} differs from its exact PXD-098 reviewed source clause/referent set`);
      }
      for (const referent of reviewed.referents) {
        // PXD-098 pins downstream phase domain and contract evidence as
        // historical material. P0 applicability joins only exact P0 intent
        // and semantic meaning.
        if (isDownstreamPhaseRef(referent.sourceRef)) continue;
        const resolved = resolveSelector(referent.sourceRef, sourceDocuments);
        const resolvedFingerprint = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
        const resolvedIdentity = resolved?.id ?? resolved?.machineId ?? null;
        const resolvedHash = resolved === undefined ? null : createHash("sha256").update(resolvedFingerprint).digest("hex");
        const correction = approvedCorrection.get(referent.sourceRef);
        const matchesApprovedCorrection = Boolean(correction
          && resolvedHash === correction.currentContentSha256
          && referent.identity === correction.identity
          && referent.contentSha256 === correction.priorContentSha256);
        const currentSourceObservation = approvedCurrentSourceObservation.get(referent.sourceRef);
        const matchesCurrentSourceObservation = Boolean(currentSourceObservation
          && resolvedHash === currentSourceObservation.currentContentSha256
          && referent.identity === currentSourceObservation.identity
          && referent.contentSha256 === currentSourceObservation.historicalPxd098ContentSha256);
        if (resolved === undefined
          || (resolvedHash !== referent.contentSha256 && !matchesApprovedCorrection && !matchesCurrentSourceObservation)
          || resolvedIdentity !== referent.identity) {
          fail(`${dimension.id}/${clause.id} reviewed referent content changed: ${referent.sourceRef}`);
        }
      }
      for (const ref of clause.sourceRefs) clauseSources.add(ref);
    }
    if (JSON.stringify(dimension.reviewClauseRefs) !== JSON.stringify(clauseIds)
      || JSON.stringify(dimension.dimensionEvidenceRefs) !== JSON.stringify([...clauseSources])) fail(`${dimension.id} review clauses do not enumerate the exact subclause evidence set`);
    if (!dimension.leafContractBinding || dimension.leafContractBinding.leafCollectionRef !== ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records"
      || dimension.leafContractBinding.requirementField !== "requirementRefs"
      || dimension.leafContractBinding.profileField !== "profileRef"
      || dimension.leafContractBinding.channelField !== "channelApplicability") fail(`${dimension.id} leaf contract join selector is stale or incomplete`);
    const applies = dimension.applicableRequirementRefs;
    const excludes = dimension.notApplicableRequirementDecisions;
    if (!Array.isArray(applies) || !unique(applies) || !Array.isArray(excludes) || !unique(excludes.map(({ requirementRef }) => requirementRef))) fail(`${dimension.id} has duplicate/malformed applicability decisions`);
    const all = [...applies, ...excludes.map(({ requirementRef }) => requirementRef)];
    if (all.length !== requirementIds.length || new Set(all).size !== requirementIds.length || requirementIds.some((id) => !all.includes(id))) fail(`${dimension.id} does not partition the exact requirement population`);
    if (!Array.isArray(dimension.applicableRequirementBindings) || dimension.applicableRequirementBindings.length !== applies.length) fail(`${dimension.id} lacks per-type contract bindings`);
    const bindings = new Map(dimension.applicableRequirementBindings.map((row) => [row.requirementRef, row]));
    for (const requirementRef of applies) {
      const requirement = requirementsById.get(requirementRef);
      const family = familyByRequirement.get(requirementRef);
      const binding = bindings.get(requirementRef);
      if (!requirement || !family || !binding || binding.id !== `${dimension.id}.${requirementRef.toLowerCase()}`) fail(`${dimension.id} has a missing or foreign applicable requirement binding`);
      if (binding.requirementSelectorRef !== `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${requirementRef}`
        || binding.familySelectorRef !== `.product-experience/pdp-0-product-truth/capabilities.yaml#families/@id=${family.id}`
        || !resolveSelector(binding.requirementSelectorRef, sourceDocuments)
        || !resolveSelector(binding.familySelectorRef, sourceDocuments)
        || binding.capabilityRefs.length !== family.capabilityIds.length
        || JSON.stringify([...binding.capabilityRefs].sort()) !== JSON.stringify([...family.capabilityIds].sort())
        || binding.leafCollectionRef !== dimension.leafContractBinding.leafCollectionRef
        || !resolveSelector(binding.leafCollectionRef, sourceDocuments)
        || JSON.stringify(binding.dimensionEvidenceRefs) !== JSON.stringify(dimension.dimensionEvidenceRefs)
        || JSON.stringify(binding.coveredClauseRefs) !== JSON.stringify(dimension.reviewClauseRefs)) fail(`${dimension.id}/${requirementRef} has a stale exact P0 selector or omitted semantic subclause`);
      for (const capabilityIntentId of binding.capabilityRefs) {
        const intent = capabilitiesById.get(capabilityIntentId);
        const sourceRef = p0Join.identitySourceRef.replace("<capabilityIntentId>", capabilityIntentId);
        const applicableSourceRef = p0Join.applicabilitySourceRef.replace("<capabilityIntentId>", capabilityIntentId);
        const currentIntent = resolveSelector(sourceRef, sourceDocuments);
        const currentLeaf = resolveSelector(applicableSourceRef, sourceDocuments);
        if (!intent || currentIntent?.id !== capabilityIntentId || currentLeaf?.capabilityRef !== capabilityIntentId
          || !nonblank(intent.outcome) || !Array.isArray(intent.actorRoles) || intent.actorRoles.length === 0
          || !Array.isArray(intent.inputArtifactTypes) || intent.inputArtifactTypes.length === 0
          || !Array.isArray(intent.outputArtifactTypes) || intent.outputArtifactTypes.length === 0
          || !Array.isArray(intent.constraints) || !Array.isArray(intent.ownerDefinition?.typedInputSlots)
          || !intent.ownerDefinition?.parameterSchema || !Array.isArray(intent.ownerDefinition?.successOutputs)) {
          fail(`${dimension.id}/${requirementRef}/${capabilityIntentId} lacks its exact P0 identity or semantic input/output meaning`);
        }
      }
    }
    for (const exclusion of excludes) {
      const requirement = requirementsById.get(exclusion.requirementRef);
      const family = familyByRequirement.get(exclusion.requirementRef);
      if (!requirement || !family || exclusion.disposition !== "NOT_APPLICABLE_TO_THIS_REVIEW_DIMENSION"
        || exclusion.requirementSelectorRef !== `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${exclusion.requirementRef}`
        || exclusion.familySelectorRef !== `.product-experience/pdp-0-product-truth/capabilities.yaml#families/@id=${family.id}`
        || !nonblank(exclusion.reason) || !nonblank(exclusion.evidenceRef)
        || !resolveSelector(exclusion.requirementSelectorRef, sourceDocuments)
        || !resolveSelector(exclusion.familySelectorRef, sourceDocuments)
        || !resolveSelector(exclusion.evidenceRef, sourceDocuments)) fail(`${dimension.id} has an unreasoned or foreign exclusion`);
    }
    resolvedDimensions.set(dimension.id, { applicableRequirementRefs: new Set(applies), excludedRequirementRefs: new Set(excludes.map(({ requirementRef }) => requirementRef)) });
  }

  const bindings = new Map();
  for (const row of leafRows) {
    const capability = capabilitiesById.get(row.capabilityRef);
    if (!capability || !Array.isArray(row.requirementRefs) || row.requirementRefs.length !== 1) fail(`${row.capabilityRef} must bind exactly one requirement`);
    const requirementRef = row.requirementRefs[0];
    const family = familyByRequirement.get(requirementRef);
    if (!family || !requirementRows.some(({ id, capabilityIds }) => id === requirementRef && capabilityIds.includes(row.capabilityRef))
      || capability.familyId !== family.id || JSON.stringify(capability.requirementIds) !== JSON.stringify([requirementRef])) fail(`${row.capabilityRef} has a wrong or stale requirement-family join`);
    if (!nonblank(capability.outcome) || !Array.isArray(capability.actorRoles) || capability.actorRoles.length === 0
        || !Array.isArray(capability.inputArtifactTypes) || !Array.isArray(capability.outputArtifactTypes)
        || !Array.isArray(capability.preconditions) || capability.preconditions.length === 0
        || !Array.isArray(capability.constraints) || capability.constraints.length === 0
        || !Array.isArray(capability.ownerDefinition?.typedInputSlots)
        || !Array.isArray(capability.ownerDefinition?.successOutputs)
        || capability.ownerDefinition.successOutputs.length !== capability.outputArtifactTypes.length
        || capability.ownerDefinition.successOutputs.some(({ artifactType }, index) => artifactType !== capability.outputArtifactTypes[index])) {
      fail(`${row.capabilityRef} lacks exact P0 capability intent, actors, typed input/output meaning, preconditions, or constraints`);
    }
    const expectedCapabilitySourceRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${row.capabilityRef}`;
    if (row.capabilitySourceRef !== expectedCapabilitySourceRef
      || resolveSelector(row.capabilitySourceRef, sourceDocuments) !== capability) {
      fail(`${row.capabilityRef} capability source selector is not its exact catalog record`);
    }
    const expectedChannelApplicabilityRef = `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${row.id}/channelApplicability`;
    if (capability.ownerDefinition?.channelApplicabilityRef !== expectedChannelApplicabilityRef
      || resolveSelector(capability.ownerDefinition.channelApplicabilityRef, sourceDocuments) !== row.channelApplicability) {
      fail(`${row.capabilityRef} owner channel reference does not resolve to its exact current per-leaf decisions`);
    }
    if (row.profileRef !== capability.ownerDefinition?.familyProfileRef) fail(`${row.capabilityRef} profile applicability binding mismatch`);
    if (row.boundsRef !== capability.ownerDefinition?.boundsRef) fail(`${row.capabilityRef} bounded applicability reference mismatch`);
    if (!Array.isArray(row.channelApplicability) || row.channelApplicability.length !== channels.length || !unique(row.channelApplicability.map(({ channelRef }) => channelRef))
      || row.channelApplicability.some(({ channelRef }) => !activeChannelIds.has(channelRef))) fail(`${row.capabilityRef} channel union is missing, duplicated, stale, or invented`);
    for (const label of capability.supportedChannels ?? []) {
      const expectedChannel = SOURCE_LABEL_CHANNEL[label];
      if (!expectedChannel) fail(`${row.capabilityRef} has an unresolved direct channel label ${label}`);
      const channel = row.channelApplicability.find(({ channelRef }) => channelRef === expectedChannel);
      if (!channel || channel.disposition !== "SOURCE_DECLARED_DEFINITION_APPLICABLE" || channel.sourceLabel !== label) fail(`${row.capabilityRef} source channel ${label} was erased or reinterpreted`);
    }
    if (row.channelApplicability.some(({ channelRef }) => channelRef === "media.channel.gui")) fail(`${row.capabilityRef} invents a GUI channel`);
    const dimensionDisposition = {};
    for (const dimension of dimensions) {
      const decision = resolvedDimensions.get(dimension.id);
      const applies = decision.applicableRequirementRefs.has(requirementRef);
      if (applies === decision.excludedRequirementRefs.has(requirementRef)) fail(`${row.capabilityRef}/${dimension.id} does not resolve exactly one disposition`);
      dimensionDisposition[dimension.id] = applies ? "APPLICABLE_REVIEW_SCOPE" : "NOT_APPLICABLE_TO_THIS_REVIEW_DIMENSION";
    }
    bindings.set(row.capabilityRef, { requirementRef, profileRef: row.profileRef, dimensionDisposition });
  }
  return bindings;
}
