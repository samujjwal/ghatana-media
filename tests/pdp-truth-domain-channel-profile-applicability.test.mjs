import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolvePdp0FeatureReviewApplicability } from "../scripts/lib/pdp0-feature-review-applicability.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const reviewedMaterialArtifactText = readFileSync(resolve(root, "docs/implementation/verification/pdp-38/feature-review-45-clause-material-review.json"), "utf8");
const reviewedMaterialArtifact = JSON.parse(reviewedMaterialArtifactText);
const reviewedReferenceCorrectionArtifactText = readFileSync(resolve(root, "docs/implementation/verification/pdp-38/feature-review-45-clause-reference-correction.json"), "utf8");
const reviewedReferenceCorrectionArtifact = JSON.parse(reviewedReferenceCorrectionArtifactText);
const qualityMetricObservationPaths = [
  "docs/implementation/verification/pdp-38/feature-review-quality-current-source-observation.json",
  "docs/implementation/verification/pdp-38/feature-review-audio-defects-current-source-observation.json",
  "docs/implementation/verification/pdp-38/feature-review-audio-naturalness-current-source-observation.json",
];
const qualityMetricObservations = qualityMetricObservationPaths.map((path) => {
  const text = readFileSync(resolve(root, path), "utf8");
  return { text, artifact: JSON.parse(text) };
});
const qualityPolicySourceText = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/quality-policy.yaml"), "utf8");
const qualityCurrentSourceReviewPath = "docs/implementation/verification/pdp-38/p0-quality-current-source-review.json";
const qualityCurrentSourceReviewText = readFileSync(resolve(root, qualityCurrentSourceReviewPath), "utf8");
const qualityCurrentSourceReview = JSON.parse(qualityCurrentSourceReviewText);
const qualificationPolicyObservationPath = "docs/implementation/verification/pdp-38/feature-review-qualification-policy-current-source-observation.json";
const qualificationPolicyObservationText = readFileSync(resolve(root, qualificationPolicyObservationPath), "utf8");
const qualificationPolicyObservation = JSON.parse(qualificationPolicyObservationText);
const qualificationPolicySourceText = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/qualification-policy.yaml"), "utf8");
const animationRelationshipObservationPath = "docs/implementation/verification/pdp-38/feature-review-animation-property-owner-current-source-observation.json";
const animationRelationshipObservationText = readFileSync(resolve(root, animationRelationshipObservationPath), "utf8");
const animationRelationshipObservation = JSON.parse(animationRelationshipObservationText);
const textToImageObservationPath = "docs/implementation/verification/pdp-38/feature-review-current-source-observation.json";
const textToImageObservationText = readFileSync(resolve(root, textToImageObservationPath), "utf8");
const textToImageObservation = JSON.parse(textToImageObservationText);
const capabilitiesSourceText = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8");
const capabilityIntentOwnerBindingObservationPath = "docs/implementation/verification/pdp-38/p0-capability-intent-owner-binding-current-source-observation.json";
const capabilityIntentOwnerBindingObservationText = readFileSync(resolve(root, capabilityIntentOwnerBindingObservationPath), "utf8");
const capabilityIntentOwnerBindingObservation = JSON.parse(capabilityIntentOwnerBindingObservationText);
const capabilitySemanticReviewPath = "docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json";
const capabilitySemanticReviewText = readFileSync(resolve(root, capabilitySemanticReviewPath), "utf8");
const capabilitySemanticReview = JSON.parse(capabilitySemanticReviewText);
const policyAuthorityObservationPath = "docs/implementation/verification/pdp-38/feature-review-policy-authority-current-source-observation.json";
const policyAuthorityObservationText = readFileSync(resolve(root, policyAuthorityObservationPath), "utf8");
const policyAuthorityObservation = JSON.parse(policyAuthorityObservationText);
const policyAuthoritySourceText = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/policy-authority-model.yaml"), "utf8");
const cliChannelObservationPath = "docs/implementation/verification/pdp-38/feature-review-cli-channel-current-source-observation.json";
const cliChannelObservationText = readFileSync(resolve(root, cliChannelObservationPath), "utf8");
const cliChannelObservation = JSON.parse(cliChannelObservationText);
const applicationsChannelsSourceText = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/applications-channels.yaml"), "utf8");
const resolveWithReviewedArtifact = (args) => resolvePdp0FeatureReviewApplicability({
  reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText,
  qualityMetricObservations, qualityPolicySourceText, qualityCurrentSourceReview, qualityCurrentSourceReviewText,
  qualificationPolicyObservation, qualificationPolicyObservationText, qualificationPolicySourceText,
  animationRelationshipObservation,
  animationRelationshipObservationText,
  textToImageObservation, textToImageObservationText, capabilitiesSourceText,
  capabilityIntentOwnerBindingObservation, capabilityIntentOwnerBindingObservationText,
  capabilitySemanticReview, capabilitySemanticReviewText,
  policyAuthorityObservation, policyAuthorityObservationText, policyAuthoritySourceText,
  cliChannelObservation, cliChannelObservationText, applicationsChannelsSourceText, ...args });
const capabilities = read(".product-experience/pdp-0-product-truth/capabilities.yaml");
const review = read(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const channelSource = read(".product-experience/pdp-0-product-truth/applications-channels.yaml");
const requirements = read(".product-experience/pdp-0-product-truth/requirements.yaml");
const channels = [...channelSource.channels, ...channelSource.ownerDefinedChannels.records];
const channelIds = new Set(channels.map(({ id }) => id));
const sourceLabels = {
  web: "media.channel.web",
  cli: "media.channel.cli",
  api: "media.channel.api",
  embedded: "media.channel.embedded",
  "http-api": "media.channel.http-api",
  "grpc-api": "media.channel.grpc-api",
  sdk: "media.channel.sdk",
  "product-integration": "media.channel.product-integration",
};
const applicable = new Set(channelSource.ownerLeafApplicabilityRules.profileApplicabilityContract.applicableChannelDispositions);
const notApplicable = new Set(channelSource.ownerLeafApplicabilityRules.profileApplicabilityContract.notApplicableChannelDispositions);
const capabilityById = new Map(capabilities.capabilities.map((capability) => [capability.id, capability]));

function sourceLabelBindingsAreExact(leaf, capability) {
  return capability.supportedChannels.every((label) => {
    const channelRef = sourceLabels[label];
    const row = leaf.channelApplicability.find((candidate) => candidate.channelRef === channelRef);
    return Boolean(row && row.disposition === "SOURCE_DECLARED_DEFINITION_APPLICABLE" && row.sourceLabel === label);
  });
}

function assertExactDimensionPartition(dimensions, requirementIds) {
  assert.equal(dimensions.length, 15);
  assert.equal(new Set(dimensions.map(({ id }) => id)).size, 15);
  for (const dimension of dimensions) {
    const applied = dimension.applicableRequirementRefs;
    const excluded = dimension.notApplicableRequirementRefs;
    assert.equal(applied.length + excluded.length, requirementIds.length, `${dimension.id} has a complete partition`);
    assert.equal(new Set([...applied, ...excluded]).size, requirementIds.length, `${dimension.id} has no duplicate or overlapping type decision`);
    assert.deepEqual(new Set([...applied, ...excluded]), new Set(requirementIds), `${dimension.id} names only the exact requirement population`);
  }
}

test("all 462 leaves have exact profile-channel applicability or a source-backed exclusion", () => {
  const crosswalk = review.ownerCapabilityLeafAdjudication;
  const profileRule = channelSource.ownerLeafApplicabilityRules.profileApplicabilityContract;
  assert.equal(crosswalk.exactLeafCount, 462);
  assert.equal(crosswalk.uniqueLeafCount, 462);
  assert.equal(crosswalk.channelCount, channels.length);
  assert.equal(channels.length, 11);
  assert.equal(crosswalk.records.length, 462);
  assert.equal(new Set(crosswalk.records.map(({ capabilityRef }) => capabilityRef)).size, 462);
  assert.equal(profileRule.id, "media.channel-profile-applicability.v1");
  assert.equal(profileRule.sourceCrosswalkRef, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records");
  assert.equal(profileRule.channelAdmission, "NOT_ADMITTED");
  assert.equal(profileRule.implementationState, "UNKNOWN");
  assert.equal(profileRule.qualificationState, "NOT_EVALUATED");
  assert.match(profileRule.unresolvedProfileSemantics, /not a concrete versioned profile instance/u);

  for (const leaf of crosswalk.records) {
    const capability = capabilityById.get(leaf.capabilityRef);
    assert.ok(capability, `${leaf.capabilityRef} resolves to exact catalog leaf`);
    assert.equal(sourceLabelBindingsAreExact(leaf, capability), true, `${leaf.capabilityRef} preserves every direct channel label`);
    assert.ok(typeof leaf.profileRef === "string" && leaf.profileRef.startsWith("media.capability-profile."), `${leaf.capabilityRef} has exact family profile ref`);
    assert.equal(leaf.profileRef, capability.ownerDefinition?.familyProfileRef, `${leaf.capabilityRef} does not substitute its profile`);
    const rows = leaf.channelApplicability;
    assert.equal(rows.length, channels.length, `${leaf.capabilityRef} has one decision per channel`);
    assert.deepEqual(new Set(rows.map(({ channelRef }) => channelRef)), channelIds, `${leaf.capabilityRef} covers the exact active channel union`);
    for (const row of rows) {
      assert.ok(row.ruleRef in channelSource.ownerLeafApplicabilityRules.rules, `${leaf.capabilityRef}/${row.channelRef} resolves exact decision rule`);
      assert.equal(row.executionAdmission, "NOT_ADMITTED", `${leaf.capabilityRef}/${row.channelRef} is not execution-admitted`);
      if (applicable.has(row.disposition)) {
        assert.ok(leaf.profileRef, `${leaf.capabilityRef}/${row.channelRef} uses the exact family profile`);
      } else {
        assert.ok(notApplicable.has(row.disposition), `${leaf.capabilityRef}/${row.channelRef} has explicit non-applicable disposition`);
        assert.equal(row.sourceLabel, null, `${leaf.capabilityRef}/${row.channelRef} cannot erase an applicable source label`);
      }
    }
    for (const label of capability.supportedChannels) {
      const channelRef = sourceLabels[label];
      assert.ok(channelRef, `${leaf.capabilityRef} source label ${label} resolves exactly`);
      const row = rows.find((candidate) => candidate.channelRef === channelRef);
      assert.equal(row.disposition, "SOURCE_DECLARED_DEFINITION_APPLICABLE", `${leaf.capabilityRef}/${label} preserves direct source applicability`);
      assert.equal(row.sourceLabel, label, `${leaf.capabilityRef}/${label} preserves the exact label`);
    }
    for (const row of rows.filter(({ disposition }) => disposition === "SOURCE_DECLARED_DEFINITION_APPLICABLE")) {
      assert.ok(Object.hasOwn(sourceLabels, row.sourceLabel), `${leaf.capabilityRef}/${row.channelRef} is backed by a source channel label`);
      assert.equal(sourceLabels[row.sourceLabel], row.channelRef, `${leaf.capabilityRef}/${row.channelRef} source label is not fabricated`);
    }
    const event = rows.find(({ channelRef }) => channelRef === "media.channel.event");
    assert.equal(event.disposition, "NOT_A_CAPABILITY_INVOCATION_CHANNEL");
    assert.equal(event.ruleRef, "EVENTS_ARE_VERSIONED_NOTIFICATIONS_NOT_COMMAND_TRANSPORT");
    const desktop = rows.find(({ channelRef }) => channelRef === "media.channel.legacy-desktop");
    assert.equal(desktop.disposition, "EXCLUDED_FROM_ACTIVE_PRODUCT_SCOPE");
    assert.equal(desktop.ruleRef, "ARCHIVED_DESKTOP_SOURCE_ONLY");
    const agent = rows.find(({ channelRef }) => channelRef === "media.channel.agent");
    const agentScope = capability.actorRoles.includes("automation-agent") || capability.supportedChannels.includes("product-integration");
    assert.equal(agent.disposition === "DEFINITION_APPLICABLE_REQUIRES_EXACT_AGENT_BINDING", agentScope,
      `${leaf.capabilityRef} Agent applicability follows its exact actor/interface scope`);
  }
  const sourceLeaf = crosswalk.records.find((leaf) => capabilityById.get(leaf.capabilityRef).supportedChannels.includes("web"));
  const sourceCapability = capabilityById.get(sourceLeaf.capabilityRef);
  const forgedExclusion = structuredClone(sourceLeaf);
  const web = forgedExclusion.channelApplicability.find(({ channelRef }) => channelRef === "media.channel.web");
  web.disposition = "OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF";
  web.sourceLabel = null;
  assert.equal(sourceLabelBindingsAreExact(forgedExclusion, sourceCapability), false,
    "a source-declared channel cannot be rewritten as an owner exclusion");
  const substitutedProfile = structuredClone(sourceLeaf);
  substitutedProfile.profileRef = "media.capability-profile.foreign-family";
  assert.notEqual(substitutedProfile.profileRef, sourceCapability.ownerDefinition?.familyProfileRef,
    "profile selection cannot drift from the exact capability owner binding");
});

test("channel rules keep protocol and product-interaction semantics separate", () => {
  const rules = channelSource.ownerLeafApplicabilityRules;
  assert.match(rules.rules.API_ALIAS_DOES_NOT_ASSERT_HTTP_GRPC_OR_SDK_EQUIVALENCE, /no transport equivalence/u);
  assert.match(rules.rules.AGENT_ROLE_OR_EXPLICIT_PRODUCT_INTEGRATION, /exact per-action tool binding/u);
  assert.match(rules.profileApplicabilityContract.conditionalRules.PROTOCOL_NEUTRAL_API_APPLICABLE_CONCRETE_BINDING_REQUIRED, /not admitted/u);
  assert.match(rules.profileApplicabilityContract.conditionalRules.DEFINITION_APPLICABLE_REQUIRES_EXACT_AGENT_BINDING, /host authorization remain required/u);
});

test("15 review dimensions resolve every requirement type and all 462 exact leaf joins", () => {
  const applicability = channelSource.ownerFeatureReviewApplicability;
  const dimensionRows = applicability.dimensions;
  const requirementIds = requirements.requirements.map(({ id }) => id);
  const requirementById = new Map(requirements.requirements.map((requirement) => [requirement.id, requirement]));
  const familyByRequirement = new Map(capabilities.families.map((family) => [family.requirementId, family]));
  const leaves = review.ownerCapabilityLeafAdjudication.records;
  const evidencePaths = [...new Set(dimensionRows.flatMap(({ dimensionEvidenceRefs }) => dimensionEvidenceRefs.map((ref) => ref.split("#")[0])))].filter((path) =>
    path.startsWith(".product-experience/pdp-0-product-truth/"));
  const sourceDocuments = Object.fromEntries(evidencePaths.map((path) => [path, read(path)]));
  Object.assign(sourceDocuments, {
    ".product-experience/pdp-0-product-truth/requirements.yaml": requirements,
    ".product-experience/pdp-0-product-truth/capabilities.yaml": capabilities,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml": review,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml": read(".product-experience/pdp-0-product-truth/journey-catalog.yaml"),
  });

  assert.equal(applicability.id, "media.feature-review-applicability.v1");
  assert.equal(channelSource.dependencies["p0-003"].status, "PDP-0_CAPABILITY_INTENT_AND_CHANNEL_APPLICABILITY_RESOLVED");
  assert.match(channelSource.dependencies["p0-003"].effect, /PDP-1 per-operation support mappings are downstream/u);
  assert.equal(applicability.coverageDimensions, 15);
  assert.equal(applicability.requirementTypeCount, 38);
  assert.equal(applicability.leafCount, 462);
  assert.equal(dimensionRows.length, 15);
  assert.equal(new Set(dimensionRows.map(({ id }) => id)).size, 15);
  assert.equal(new Set(requirementIds).size, 38);
  assert.equal(leaves.length, 462);
  assert.match(applicability.joinRule, /sole requirementRef/u);
  assertExactDimensionPartition(dimensionRows, requirementIds);
  const exactResolved = resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments });
  assert.equal(exactResolved.size, 462);
  assert.equal(Object.keys(sourceDocuments).every((path) => path.startsWith(".product-experience/pdp-0-product-truth/")), true,
    "the P0 applicability resolver loads only P0 source documents for its baseline result");
  const withoutDownstreamMappings = structuredClone(applicability);
  for (const dimension of withoutDownstreamMappings.dimensions) {
    for (const binding of dimension.applicableRequirementBindings) {
      delete binding.operationCollectionRef;
      delete binding.contractCoverageRule;
    }
  }
  assert.equal(resolveWithReviewedArtifact({ applicability: withoutDownstreamMappings, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }).size, 462,
  "P0 applicability remains complete when downstream operation and legacy coverage mappings are absent");
  const changedPdp1Relationship = { ...sourceDocuments,
    ".product-experience/pdp-1-domain-data/relationships.yaml": {
      relationships: [{ id: "media.rel.animation-property-owner", description: "Changed downstream P1 observation context" }],
    } };
  assert.equal(resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments: changedPdp1Relationship }).size, 462,
  "P0 applicability is unchanged when downstream P1 relationship evidence changes");
  assert.equal(sourceDocuments[".product-experience/pdp-1-domain-data/operations.yaml"], undefined,
    "the PDP-0 15×38/462 applicability result does not load PDP-1 operation contracts or wire schemas");
  const authorityBoundary = applicability.authorityBoundary;
  assert.equal(authorityBoundary.activePdp0Join.identity, "capabilityIntentId");
  assert.equal(authorityBoundary.activePdp0Join.p1OperationRequired, false);
  assert.ok(authorityBoundary.activePdp0Join.activeEvidenceFields.includes("applicableRequirementBindings[].capabilityRefs"));
  assert.equal(authorityBoundary.downstreamNonGatingOperationContext.gatingForPdp0, false);
  assert.ok(authorityBoundary.downstreamNonGatingOperationContext.retainedFields.includes("dimensions[].sourceRefs"));
  assert.match(applicability.joinRule, /exact capabilityIntentId/u);
  assert.doesNotMatch(applicability.joinRule, /source operation binding/u);
  assert.ok(authorityBoundary.downstreamNonGatingOperationContext.retainedFields.includes(
    "dimensions[].applicableRequirementBindings[].operationCollectionRef"));
  assert.ok(authorityBoundary.activePdp0Join.semanticFields.inputShapes.some((ref) => ref.endsWith("/ownerDefinition/typedInputSlots")));
  assert.ok(authorityBoundary.activePdp0Join.semanticFields.outputShapes.some((ref) => ref.endsWith("/ownerDefinition/successOutputs")));
  assert.ok(dimensionRows.some((dimension) => dimension.applicableRequirementBindings.some(({ operationCollectionRef }) =>
    operationCollectionRef === ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records")),
  "legacy operation references remain available as explicitly non-gating downstream context");
  const operationSubstituted = structuredClone(applicability);
  operationSubstituted.dimensions[0].applicableRequirementBindings[0].capabilityRefs[0] = "media.operation.capability.media-artifact-ingest";
  assert.throws(() => resolveWithReviewedArtifact({ applicability: operationSubstituted, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  /stale exact P0 selector/u,
  "a downstream operation ID cannot substitute for the exact P0 capabilityIntentId join");
  const p1OnlyEvidence = structuredClone(applicability);
  p1OnlyEvidence.authorityBoundary.activePdp0Join.activeEvidenceFields = [
    "dimensions[].applicableRequirementBindings[].operationCollectionRef",
  ];
  assert.throws(() => resolveWithReviewedArtifact({ applicability: p1OnlyEvidence, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  /active dimensions must share/u,
  "a PDP-1-only evidence set cannot satisfy the active P0 identity join");
  const changedP0Result = structuredClone(applicability);
  changedP0Result.authorityBoundary.activePdp0Join.semanticFields.outputShapes = [
    ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas",
  ];
  assert.throws(() => resolveWithReviewedArtifact({ applicability: changedP0Result, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  /active applicability join/u,
  "a P0 output-meaning change invalidates applicability even when operation mappings are absent");

  for (const dimension of dimensionRows) {
    assert.ok(dimension.id.startsWith("media.feature-review-dimension."));
    assert.equal(dimension.scopeStatus, "OWNER_DEFINED_APPLICABILITY_ONLY");
    assert.equal(dimension.measurementAndQualification, "NOT_EVALUATED");
    assert.equal(dimension.channelAdmission, "NOT_ADMITTED");
    assert.ok(dimension.scopeRationale.trim().length > 60);
    assert.ok(dimension.sourceRefs.length > 0);
    for (const sourcePath of dimension.sourceRefs) {
      if (/^\.product-experience\/pdp-[1-9]-/u.test(sourcePath)) {
        assert.equal(authorityBoundary.downstreamNonGatingOperationContext.gatingForPdp0, false,
          `${dimension.id} PDP-1 source remains retained non-gating context: ${sourcePath}`);
      } else {
        assert.ok(readFileSync(resolve(root, sourcePath), "utf8").length > 0, `${dimension.id} P0 source resolves: ${sourcePath}`);
      }
    }
    assert.equal(dimension.applicableRequirementRefs.length + dimension.notApplicableRequirementRefs.length, 38);
    assert.equal(new Set([...dimension.applicableRequirementRefs, ...dimension.notApplicableRequirementRefs]).size, 38);
    assert.deepEqual(new Set([...dimension.applicableRequirementRefs, ...dimension.notApplicableRequirementRefs]), new Set(requirementIds));
    for (const id of dimension.applicableRequirementRefs) assert.ok(requirementById.has(id), `${dimension.id} applies to exact requirement ${id}`);
    for (const id of dimension.notApplicableRequirementRefs) assert.ok(requirementById.has(id), `${dimension.id} exclusion resolves exact requirement ${id}`);
  }

  const requirementDimensionCounts = new Map(requirementIds.map((id) => [id, 0]));
  const channelSet = new Set(channels.map(({ id }) => id));
  for (const leaf of leaves) {
    const capability = capabilityById.get(leaf.capabilityRef);
    assert.ok(capability, `leaf resolves exact capability ${leaf.capabilityRef}`);
    const owner = capability.ownerDefinition;
    assert.ok(owner, `${leaf.capabilityRef} has a P0 capability intent`);
    assert.ok(capability.outcome?.trim(), `${leaf.capabilityRef} defines its intent outcome`);
    assert.ok(capability.actorRoles.length > 0, `${leaf.capabilityRef} defines applicable actors`);
    assert.ok(capability.inputArtifactTypes.length >= owner.typedInputSlots.length,
      `${leaf.capabilityRef} defines the typed input artifact meanings represented by its P0 slots`);
    assert.ok(capability.outputArtifactTypes.length > 0, `${leaf.capabilityRef} defines its output meaning`);
    assert.deepEqual(owner.successOutputs.map(({ artifactType }) => artifactType), capability.outputArtifactTypes,
      `${leaf.capabilityRef} P0 output artifact identity is exact`);
    assert.ok(owner.successOutputs.every(({ requiredOnSuccess }) => typeof requiredOnSuccess === "boolean"),
      `${leaf.capabilityRef} P0 output success requiredness is explicit`);
    assert.ok(owner.typedInputSlots.every(({ sourceType, cardinality, required }) => sourceType && cardinality && typeof required === "boolean"),
      `${leaf.capabilityRef} P0 input slot types, cardinalities and requiredness are explicit`);
    assert.ok(owner.parameterSchema && owner.parameterSchema.type === "object" && owner.parameterSchema.additionalProperties === false,
      `${leaf.capabilityRef} parameter meaning is a closed P0 request shape`);
    for (const forbidden of ["operationRefs", "operationKind", "operationContractRef", "canonicalAuthorityRefs", "stateModelRefs"]) {
      assert.equal(Object.hasOwn(owner, forbidden), false, `${leaf.capabilityRef} P0 intent does not depend on PDP-1 ${forbidden}`);
    }
    assert.equal(JSON.stringify(owner).includes("payloadSchemaRef"), false,
      `${leaf.capabilityRef} P0 intent does not require PDP-1 wire payload schemas`);
    assert.equal(leaf.requirementRefs.length, 1, `${leaf.capabilityRef} has one canonical requirement type`);
    const requirementRef = leaf.requirementRefs[0];
    assert.ok(requirementById.has(requirementRef), `${leaf.capabilityRef} requirement resolves`);
    assert.deepEqual(capability.requirementIds, [requirementRef], `${leaf.capabilityRef} source requirement join is exact`);
    const family = familyByRequirement.get(requirementRef);
    assert.ok(family, `${leaf.capabilityRef} requirement resolves its family`);
    assert.ok(family.capabilityIds.includes(leaf.capabilityRef), `${leaf.capabilityRef} is in its exact requirement family`);
    requirementDimensionCounts.set(requirementRef, requirementDimensionCounts.get(requirementRef) + 1);

    const familyProfile = capability.ownerDefinition?.familyProfileRef;
    assert.equal(leaf.profileRef, familyProfile, `${leaf.capabilityRef} uses its exact P0 profile applicability`);
    assert.equal(leaf.boundsRef, capability.ownerDefinition?.boundsRef, `${leaf.capabilityRef} retains its exact P0 bounded-applicability reference`);
    assert.equal(leaf.channelApplicability.length, channelSet.size, `${leaf.capabilityRef} has one exact row per active channel`);
    assert.deepEqual(new Set(leaf.channelApplicability.map(({ channelRef }) => channelRef)), channelSet,
      `${leaf.capabilityRef} has no missing, duplicated, stale, or invented channel`);
    assert.equal(leaf.channelApplicability.some(({ channelRef }) => channelRef === "media.channel.gui"), false,
      `${leaf.capabilityRef} does not invent an unregistered GUI channel`);

    const dimensionDecisions = dimensionRows.map((dimension) => {
      const applies = dimension.applicableRequirementRefs.includes(requirementRef);
      const excludes = dimension.notApplicableRequirementRefs.includes(requirementRef);
      assert.notEqual(applies, excludes, `${leaf.capabilityRef}/${dimension.id}} has exactly one disposition`);
      return applies ? "APPLICABLE_REVIEW_SCOPE" : "NOT_APPLICABLE_TO_THIS_REVIEW_DIMENSION";
    });
    assert.equal(dimensionDecisions.length, 15, `${leaf.capabilityRef} resolves all 15 review dimensions`);
  }
  for (const [requirementRef, count] of requirementDimensionCounts) {
    assert.equal(count, requirementById.get(requirementRef).capabilityIds.length, `${requirementRef} accounts for every family leaf`);
  }

  const alteredDimension = structuredClone(dimensionRows[0]);
  alteredDimension.notApplicableRequirementRefs.pop();
  assert.throws(() => assertExactDimensionPartition([alteredDimension, ...dimensionRows.slice(1)], requirementIds),
    "a missing dimension/type pair is rejected by the exact partition invariant");
  const missingDimensionPair = structuredClone(applicability);
  missingDimensionPair.dimensions[0].notApplicableRequirementDecisions.pop();
  missingDimensionPair.dimensions[0].notApplicableRequirementRefs.pop();
  assert.throws(() => resolveWithReviewedArtifact({ applicability: missingDimensionPair, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  "the real join resolver rejects a missing dimension/type pair");
  const staleEvidence = structuredClone(applicability);
  staleEvidence.dimensions[0].dimensionEvidenceRefs[0] = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.capability.missing";
  assert.throws(() => resolveWithReviewedArtifact({ applicability: staleEvidence, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  "the real join resolver rejects a stale or missing dimension contract selector");
  const validButWrongClause = structuredClone(applicability);
  const substitutedDimension = validButWrongClause.dimensions[0];
  substitutedDimension.reviewClauseContracts[0].sourceRefs[0] = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.create";
  substitutedDimension.dimensionEvidenceRefs = [...new Set(substitutedDimension.reviewClauseContracts.flatMap(({ sourceRefs }) => sourceRefs))];
  assert.ok(sourceDocuments[".product-experience/pdp-0-product-truth/capabilities.yaml"].capabilities
    .some(({ id }) => id === "media.project.create"),
    "the adversarial replacement is a real, resolvable P0 source record");
  assert.throws(() => resolveWithReviewedArtifact({ applicability: validButWrongClause, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  "the real join resolver rejects a valid but semantically unrelated dimension contract selector");
  const changedReviewedSource = { ...sourceDocuments };
  changedReviewedSource[".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"] = structuredClone(sourceDocuments[".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"]);
  const reviewedArtifactRecord = changedReviewedSource[".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"].ownerCapabilityLeafAdjudication.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
  reviewedArtifactRecord.capabilityRef = "media.operation.capability.media-artifact-ingest";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments: changedReviewedSource }),
  "the production join rejects a changed P0 capability identity behind the active source selector");
  const alteredReviewArtifactText = reviewedMaterialArtifactText.replace("PXD-098", "PXD-099");
  assert.throws(() => resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments,
    reviewedMaterialArtifact, reviewedMaterialArtifactText: alteredReviewArtifactText,
    reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText,
    qualityMetricObservations, qualityPolicySourceText, qualityCurrentSourceReview, qualityCurrentSourceReviewText,
    qualificationPolicyObservation, qualificationPolicyObservationText, qualificationPolicySourceText,
    animationRelationshipObservation,
    animationRelationshipObservationText,
    textToImageObservation, textToImageObservationText, capabilitiesSourceText,
    capabilityIntentOwnerBindingObservation, capabilityIntentOwnerBindingObservationText,
    capabilitySemanticReview, capabilitySemanticReviewText,
    policyAuthorityObservation, policyAuthorityObservationText, policyAuthoritySourceText,
    cliChannelObservation, cliChannelObservationText, applicationsChannelsSourceText }),
  "the production join rejects an altered or unreviewed approval artifact");
  assert.equal(resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments,
    reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact,
    reviewedReferenceCorrectionArtifactText: reviewedReferenceCorrectionArtifactText.replace("PXD-101", "PXD-099"),
    qualityMetricObservations, qualityPolicySourceText, qualityCurrentSourceReview, qualityCurrentSourceReviewText,
    qualificationPolicyObservation, qualificationPolicyObservationText, qualificationPolicySourceText,
    animationRelationshipObservation,
    animationRelationshipObservationText,
    textToImageObservation, textToImageObservationText, capabilitiesSourceText,
    capabilityIntentOwnerBindingObservation, capabilityIntentOwnerBindingObservationText,
    capabilitySemanticReview, capabilitySemanticReviewText,
    policyAuthorityObservation, policyAuthorityObservationText, policyAuthoritySourceText,
    cliChannelObservation, cliChannelObservationText, applicationsChannelsSourceText }).size, 462,
  "current source bytes are directly pinned; a changed supplemental correction artifact cannot alter the exact resolved population");
  const modifiedCorrectedLeaf = structuredClone(capabilities);
  const correctedLeaf = modifiedCorrectedLeaf.capabilities.find(({ id }) => id === "media.generate.image.text-to-image");
  correctedLeaf.ownerDefinition.familyProfileRef = "media.capability-profile.foreign-current-edit";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities: modifiedCorrectedLeaf,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels,
    sourceDocuments: { ...sourceDocuments, ".product-experience/pdp-0-product-truth/capabilities.yaml": modifiedCorrectedLeaf } }),
  "the exact reference-only correction does not authorize any unrelated current field change");
  const unreasonedExclusion = structuredClone(applicability);
  unreasonedExclusion.dimensions[0].notApplicableRequirementDecisions[0].reason = "";
  assert.throws(() => resolveWithReviewedArtifact({ applicability: unreasonedExclusion, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments }),
  "the real join resolver rejects an exclusion without its exact owner rationale");
  const duplicateDimension = structuredClone(dimensionRows[0]);
  duplicateDimension.notApplicableRequirementRefs[0] = duplicateDimension.applicableRequirementRefs[0];
  assert.throws(() => assertExactDimensionPartition([duplicateDimension, ...dimensionRows.slice(1)], requirementIds),
    "overlapping applicability and exclusion is rejected");
  const alteredLeaf = structuredClone(leaves[0]);
  alteredLeaf.requirementRefs = [dimensionRows[0].applicableRequirementRefs.find((id) => id !== alteredLeaf.requirementRefs[0])];
  assert.notDeepEqual(capabilityById.get(alteredLeaf.capabilityRef).requirementIds, alteredLeaf.requirementRefs,
    "a different valid requirement type cannot be substituted for the exact leaf family");
  const wrongValidType = structuredClone(review.ownerCapabilityLeafAdjudication);
  wrongValidType.records[0].requirementRefs = alteredLeaf.requirementRefs;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: wrongValidType, channels, sourceDocuments }),
  "the real resolver rejects a wrong but existing requirement type");
  const foreignChannelSelector = structuredClone(capabilities);
  foreignChannelSelector.capabilities[0].ownerDefinition.channelApplicabilityRef = review.ownerCapabilityLeafAdjudication.records[1].id
    ? `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${review.ownerCapabilityLeafAdjudication.records[1].id}/channelApplicability`
    : "";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities: foreignChannelSelector,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels,
    sourceDocuments: { ...sourceDocuments, ".product-experience/pdp-0-product-truth/capabilities.yaml": foreignChannelSelector } }),
  "the real resolver rejects a valid but foreign per-leaf channel selector");
  const foreignCapabilitySource = structuredClone(review.ownerCapabilityLeafAdjudication);
  foreignCapabilitySource.records[0].capabilitySourceRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${capabilities.capabilities[1].id}`;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: foreignCapabilitySource, channels, sourceDocuments }),
  "the real resolver rejects a valid but foreign capability source selector");
  const wrongProfile = structuredClone(review.ownerCapabilityLeafAdjudication);
  const foreignProfileCapability = capabilities.capabilities.find(({ id }) => capabilityById.get(id).ownerDefinition?.familyProfileRef !== capabilityById.get(leaves[0].capabilityRef).ownerDefinition?.familyProfileRef);
  wrongProfile.records[0].profileRef = capabilityById.get(foreignProfileCapability.id).ownerDefinition.familyProfileRef;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: wrongProfile, channels, sourceDocuments }),
  "the real resolver rejects a different valid family profile");
  const inventedChannel = structuredClone(leaves[0]);
  inventedChannel.channelApplicability[0].channelRef = "media.channel.gui";
  assert.notDeepEqual(new Set(inventedChannel.channelApplicability.map(({ channelRef }) => channelRef)), channelSet,
    "an invented GUI channel fails exact active-union resolution");
  const guiChannel = structuredClone(review.ownerCapabilityLeafAdjudication);
  guiChannel.records[0].channelApplicability[0].channelRef = "media.channel.gui";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: guiChannel, channels, sourceDocuments }),
  "the real resolver rejects a fabricated GUI channel");
});

test("PXD-098 qualification-policy observation is exact and rejects stale or forged evidence", () => {
  const sourceDocuments = Object.fromEntries(channelSource.ownerFeatureReviewApplicability.dimensions.flatMap(({ dimensionEvidenceRefs }) => dimensionEvidenceRefs)
    .map((ref) => ref.split("#")[0]).filter((path) => path.startsWith(".product-experience/pdp-0-product-truth/")).filter((path, index, paths) => paths.indexOf(path) === index)
    .map((path) => [path, read(path)]));
  Object.assign(sourceDocuments, { ".product-experience/pdp-0-product-truth/requirements.yaml": requirements,
    ".product-experience/pdp-0-product-truth/capabilities.yaml": capabilities,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml": review });
  const args = { applicability: channelSource.ownerFeatureReviewApplicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, sourceDocuments };
  const staleText = qualificationPolicyObservationText.replace("e6ac071ed2fc0a1ee8e3906fd831516bd71fb9aadbb14ff58f7139bcff26eb48", "c71df52fa9ef472a9ba1353fc97ae5b4762f3d772c3f140ebc7e3feef563b791");
  assert.throws(() => resolveWithReviewedArtifact({ ...args, qualificationPolicyObservationText: staleText }), /qualification decisionRules/u);
  const forged = structuredClone(qualificationPolicyObservation);
  forged.record.changedPaths[0].current = "unverified substituted rule";
  assert.throws(() => resolveWithReviewedArtifact({ ...args, qualificationPolicyObservation: forged }), /qualification decisionRules/u);
});
