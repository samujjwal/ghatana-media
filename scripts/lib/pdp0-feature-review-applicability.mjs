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
export function resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities, capabilityCrosswalk, channels, operationContracts, sourceDocuments, reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText, reviewedOperationReferenceCorrectionArtifact, reviewedOperationReferenceCorrectionArtifactText }) {
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
  if (!Array.isArray(operationContracts) || !unique(operationContracts.map(({ id }) => id))) fail("operation contract IDs must be unique");
  if (applicability.coverageDimensions !== 15 || applicability.requirementTypeCount !== 38 || applicability.leafCount !== 462) fail("declared census differs from source populations");
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
  const operationCorrectionSha256 = "c8ccf42f82e7567b5316cb0bfb047030b5f18d0a39a40fb8f0fd885302508d50";
  const operationCorrection = reviewedOperationReferenceCorrectionArtifact;
  const operationExpected = new Map([
    [".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.capability-binding.media-artifact-import", [
      ["canonicalSourceContractRefs", "0"], ["canonicalWireSchemaRefs", "0"],
    ]],
    [".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.capability-binding.media-speech-transcription-file", [
      ["canonicalSourceContractRefs", "0"], ["canonicalWireSchemaRefs", "0"],
    ]],
  ]);
  if (typeof reviewedOperationReferenceCorrectionArtifactText === "string"
      && createHash("sha256").update(reviewedOperationReferenceCorrectionArtifactText).digest("hex") === operationCorrectionSha256
      && operationCorrection?.schemaVersion === "media.pdp38.feature-review-referent-correction.v1"
      && operationCorrection?.decisionRef === ".product-experience/decision-log.md#PXD-103"
      && operationCorrection?.baseArtifactRef === "docs/implementation/verification/pdp-38/feature-review-45-clause-material-review.json"
      && operationCorrection?.baseArtifactSha256 === expectedArtifactSha256
      && operationCorrection?.records?.length === 2) {
    for (const record of operationCorrection.records) {
      const expectedPaths = operationExpected.get(record.sourceRef);
      const current = resolveSelector(record.sourceRef, sourceDocuments);
      const currentHash = current === undefined ? null : createHash("sha256").update(JSON.stringify(current)).digest("hex");
      const reverted = current === undefined ? null : structuredClone(current);
      const samePaths = expectedPaths && Array.isArray(record.reviewedReferenceChanges)
        && JSON.stringify(record.reviewedReferenceChanges.map(({ path }) => path)) === JSON.stringify(expectedPaths);
      if (record.reviewStatus !== "APPROVED_EXACT_REFERENCE_ONLY_CORRECTION"
          || record.identity !== current?.id
          || currentHash !== record.currentContentSha256
          || !samePaths) continue;
      let valid = true;
      for (const change of record.reviewedReferenceChanges) {
        let target = reverted;
        for (const part of change.path.slice(0, -1)) target = target?.[part];
        const leaf = change.path.at(-1);
        if (!target || target[leaf] !== change.current) { valid = false; break; }
        target[leaf] = change.prior;
      }
      const priorHash = valid && createHash("sha256").update(JSON.stringify(reverted)).digest("hex");
      if (priorHash === record.priorContentSha256) approvedCorrection.set(record.sourceRef, record);
    }
  }
  const reviewedClauses = new Map(reviewedMaterialArtifact.records.map((record) => [record.clauseId, record]));
  const expectedSelectors = {
    requirementTypes: ".product-experience/pdp-0-product-truth/requirements.yaml#requirements",
    familyMembership: ".product-experience/pdp-0-product-truth/capabilities.yaml#families",
    leafOperationProfileBoundsChannel: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records",
    canonicalCapabilityOperation: ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records",
  };
  for (const [key, value] of Object.entries(expectedSelectors)) if (applicability.sourceContractSelectors?.[key] !== value) fail(`source selector ${key} is stale`);

  const requirementIds = requirementRows.map(({ id }) => id);
  const requirementsById = new Map(requirementRows.map((row) => [row.id, row]));
  const capabilitiesById = new Map(capabilityRows.map((row) => [row.id, row]));
  const familyByRequirement = new Map(families.map((row) => [row.requirementId, row]));
  const operationsById = new Map(operationContracts.map((row) => [row.id, row]));
  const activeChannelIds = new Set(channels.map(({ id }) => id));
  const expectedCanonicalAuthorityRefs = [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/effectBoundary",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/duplicateEffectPrevention",
  ];
  const resolvedDimensions = new Map();

  for (const dimension of dimensions) {
    if (!dimension.id?.startsWith("media.feature-review-dimension.") || dimension.scopeStatus !== "OWNER_DEFINED_APPLICABILITY_ONLY") fail("dimension has invalid identity or status");
    const expectedClauseFingerprint = REVIEW_CLAUSE_FINGERPRINTS[dimension.id];
    const actualClauseFingerprint = createHash("sha256").update(JSON.stringify(dimension.reviewClauseContracts ?? [])).digest("hex");
    if (!expectedClauseFingerprint || actualClauseFingerprint !== expectedClauseFingerprint) fail(`${dimension.id} review clause semantics differ from the reviewed exact contract`);
    if (!nonblank(dimension.scopeRationale) || !Array.isArray(dimension.dimensionEvidenceRefs) || dimension.dimensionEvidenceRefs.length === 0
      || !unique(dimension.dimensionEvidenceRefs) || dimension.dimensionEvidenceRefs.some((ref) => !resolveSelector(ref, sourceDocuments))) fail(`${dimension.id} lacks resolving exact dimension evidence selectors`);
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
        || clause.sourceRefs.some((ref) => !resolveSelector(ref, sourceDocuments) || /#(?:objects|records|components|rules|variants|decisions|stateMachines|metricDefinitions|qualityDimensions)$/u.test(ref))) fail(`${dimension.id} has an unresolved or collection-level review clause`);
      const reviewed = reviewedClauses.get(clause.id);
      if (!reviewed || reviewed.dimensionId !== dimension.id
        || reviewed.clauseFingerprint !== createHash("sha256").update(JSON.stringify(clause)).digest("hex")
        || reviewed.reviewStatus !== "COORDINATOR_REVIEWED_BOUNDED_DEFINITION_CONTRACT"
        || JSON.stringify(reviewed.referents.map(({ sourceRef }) => sourceRef)) !== JSON.stringify(clause.sourceRefs)) {
        fail(`${dimension.id}/${clause.id} differs from its exact PXD-098 reviewed source clause/referent set`);
      }
      for (const referent of reviewed.referents) {
        const resolved = resolveSelector(referent.sourceRef, sourceDocuments);
        const resolvedFingerprint = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
        const resolvedIdentity = resolved?.id ?? resolved?.machineId ?? null;
        const resolvedHash = resolved === undefined ? null : createHash("sha256").update(resolvedFingerprint).digest("hex");
        const correction = approvedCorrection.get(referent.sourceRef);
        const matchesApprovedCorrection = Boolean(correction
          && resolvedHash === correction.currentContentSha256
          && referent.identity === correction.identity
          && referent.contentSha256 === correction.priorContentSha256);
        if (resolved === undefined
          || (resolvedHash !== referent.contentSha256 && !matchesApprovedCorrection)
          || resolvedIdentity !== referent.identity) {
          fail(`${dimension.id}/${clause.id} reviewed referent content changed: ${referent.sourceRef}`);
        }
      }
      for (const ref of clause.sourceRefs) clauseSources.add(ref);
    }
    if (JSON.stringify(dimension.reviewClauseRefs) !== JSON.stringify(clauseIds)
      || JSON.stringify(dimension.dimensionEvidenceRefs) !== JSON.stringify([...clauseSources])) fail(`${dimension.id} review clauses do not enumerate the exact subclause evidence set`);
    if (!dimension.leafContractBinding || dimension.leafContractBinding.leafCollectionRef !== ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records"
      || dimension.leafContractBinding.operationCollectionRef !== ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records"
      || dimension.leafContractBinding.requirementField !== "requirementRefs"
      || dimension.leafContractBinding.operationField !== "operationContractRef"
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
        || binding.operationCollectionRef !== dimension.leafContractBinding.operationCollectionRef
        || !resolveSelector(binding.leafCollectionRef, sourceDocuments)
        || !resolveSelector(binding.operationCollectionRef, sourceDocuments)
        || JSON.stringify(binding.dimensionEvidenceRefs) !== JSON.stringify(dimension.dimensionEvidenceRefs)
        || JSON.stringify(binding.coveredClauseRefs) !== JSON.stringify(dimension.reviewClauseRefs)
        || binding.contractCoverageRule !== "Every leaf in this exact requirement family covers every reviewClauseRef for this dimension through its exact owner operation/profile/bounds/channel binding.") fail(`${dimension.id}/${requirementRef} has a stale exact contract selector or omitted semantic subclause`);
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
    const operationPrefix = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=";
    if (typeof row.operationContractRef !== "string" || !row.operationContractRef.startsWith(operationPrefix)) fail(`${row.capabilityRef} has a malformed operation contract selector`);
    const operationId = row.operationContractRef.slice(operationPrefix.length);
    const operation = resolveSelector(row.operationContractRef, sourceDocuments);
    if (operation !== operationsById.get(operationId)) fail(`${row.capabilityRef} operation selector does not resolve to its exact actual record`);
    if (!operation || operation.capabilityRef !== row.capabilityRef) fail(`${row.capabilityRef} operation binding resolves to an unrelated or missing valid contract`);
    const expectedCapabilitySourceRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${row.capabilityRef}`;
    if (row.capabilitySourceRef !== expectedCapabilitySourceRef
      || resolveSelector(row.capabilitySourceRef, sourceDocuments) !== capability) {
      fail(`${row.capabilityRef} capability source selector is not its exact catalog record`);
    }
    const expectedRowAuthorityRefs = row.capabilityRef.startsWith("media.stream.")
      ? [...expectedCanonicalAuthorityRefs, ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary/consentRevocation"]
      : expectedCanonicalAuthorityRefs;
    if (JSON.stringify(row.canonicalAuthorityRefs) !== JSON.stringify(expectedRowAuthorityRefs)
      || row.canonicalAuthorityRefs.some((ref) => !resolveSelector(ref, sourceDocuments))) {
      fail(`${row.capabilityRef} canonical authority selectors are not the exact owner identity/effect boundaries`);
    }
    const expectedChannelApplicabilityRef = `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${row.id}/channelApplicability`;
    if (capability.ownerDefinition?.channelApplicabilityRef !== expectedChannelApplicabilityRef
      || resolveSelector(capability.ownerDefinition.channelApplicabilityRef, sourceDocuments) !== row.channelApplicability) {
      fail(`${row.capabilityRef} owner channel reference does not resolve to its exact current per-leaf decisions`);
    }
    if (JSON.stringify(capability.ownerDefinition?.canonicalAuthorityRefs) !== JSON.stringify(expectedRowAuthorityRefs)
      || capability.ownerDefinition.canonicalAuthorityRefs.some((ref) => !resolveSelector(ref, sourceDocuments))) {
      fail(`${row.capabilityRef} catalog owner authority selectors differ from the exact PDP-1 authority tuple`);
    }
    if (row.profileRef !== capability.ownerDefinition?.familyProfileRef || operation.familyProfileRef !== row.profileRef) fail(`${row.capabilityRef} profile binding mismatch`);
    if (row.boundsRef !== capability.ownerDefinition?.boundsRef || operation.boundsRef !== row.boundsRef) fail(`${row.capabilityRef} bounds binding mismatch`);
    const ownerOperationRef = capability.ownerDefinition?.operationContractRef;
    if (ownerOperationRef) {
      const ownerOperation = resolveSelector(ownerOperationRef, sourceDocuments);
      const directOwnerBinding = ownerOperation?.id === operation.id;
      const delegatedOwnerBinding = ownerOperation && capability.ownerDefinition.operationRefs?.includes(ownerOperation.id)
        && (operation.operationRefs ?? []).includes(ownerOperation.id);
      if (!ownerOperation || (!directOwnerBinding && !delegatedOwnerBinding)) fail(`${row.capabilityRef} owner operation selector does not resolve to its exact declared operation or binding target`);
    }
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
    bindings.set(row.capabilityRef, { requirementRef, profileRef: row.profileRef, boundsRef: row.boundsRef, operationId, dimensionDisposition });
  }
  return bindings;
}
