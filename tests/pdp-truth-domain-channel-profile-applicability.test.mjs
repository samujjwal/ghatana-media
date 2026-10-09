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
const reviewedOperationReferenceCorrectionArtifactText = readFileSync(resolve(root, "docs/implementation/verification/pdp-38/feature-review-operation-reference-correction.json"), "utf8");
const reviewedOperationReferenceCorrectionArtifact = JSON.parse(reviewedOperationReferenceCorrectionArtifactText);
const resolveWithReviewedArtifact = (args) => resolvePdp0FeatureReviewApplicability({ ...args,
  reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText,
  reviewedOperationReferenceCorrectionArtifact, reviewedOperationReferenceCorrectionArtifactText });
const capabilities = read(".product-experience/pdp-0-product-truth/capabilities.yaml");
const review = read(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const channelSource = read(".product-experience/pdp-0-product-truth/applications-channels.yaml");
const requirements = read(".product-experience/pdp-0-product-truth/requirements.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
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
  const operationById = new Map(operations.capabilityOperationContracts.records.map((record) => [record.id, record]));
  const leaves = review.ownerCapabilityLeafAdjudication.records;
  const operationContracts = operations.capabilityOperationContracts.records;
  const evidencePaths = [...new Set(dimensionRows.flatMap(({ dimensionEvidenceRefs }) => dimensionEvidenceRefs.map((ref) => ref.split("#")[0])))];
  const sourceDocuments = Object.fromEntries(evidencePaths.map((path) => [path, read(path)]));
  Object.assign(sourceDocuments, {
    ".product-experience/pdp-0-product-truth/requirements.yaml": requirements,
    ".product-experience/pdp-0-product-truth/capabilities.yaml": capabilities,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml": review,
    ".product-experience/pdp-1-domain-data/operations.yaml": operations,
    ".product-experience/pdp-1-domain-data/authority.yaml": read(".product-experience/pdp-1-domain-data/authority.yaml"),
    ".product-experience/pdp-1-domain-data/privacy.yaml": read(".product-experience/pdp-1-domain-data/privacy.yaml"),
  });

  assert.equal(applicability.id, "media.feature-review-applicability.v1");
  assert.equal(applicability.coverageDimensions, 15);
  assert.equal(applicability.requirementTypeCount, 38);
  assert.equal(applicability.leafCount, 462);
  assert.equal(dimensionRows.length, 15);
  assert.equal(new Set(dimensionRows.map(({ id }) => id)).size, 15);
  assert.equal(new Set(requirementIds).size, 38);
  assert.equal(leaves.length, 462);
  assert.match(applicability.joinRule, /exact sole requirementRef/u);
  assertExactDimensionPartition(dimensionRows, requirementIds);
  const exactResolved = resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments });
  assert.equal(exactResolved.size, 462);

  for (const dimension of dimensionRows) {
    assert.ok(dimension.id.startsWith("media.feature-review-dimension."));
    assert.equal(dimension.scopeStatus, "OWNER_DEFINED_APPLICABILITY_ONLY");
    assert.equal(dimension.measurementAndQualification, "NOT_EVALUATED");
    assert.equal(dimension.channelAdmission, "NOT_ADMITTED");
    assert.ok(dimension.scopeRationale.trim().length > 60);
    assert.ok(dimension.sourceRefs.length > 0);
    for (const sourcePath of dimension.sourceRefs) {
      assert.ok(readFileSync(resolve(root, sourcePath), "utf8").length > 0, `${dimension.id} source resolves: ${sourcePath}`);
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
    assert.equal(leaf.requirementRefs.length, 1, `${leaf.capabilityRef} has one canonical requirement type`);
    const requirementRef = leaf.requirementRefs[0];
    assert.ok(requirementById.has(requirementRef), `${leaf.capabilityRef} requirement resolves`);
    assert.deepEqual(capability.requirementIds, [requirementRef], `${leaf.capabilityRef} source requirement join is exact`);
    const family = familyByRequirement.get(requirementRef);
    assert.ok(family, `${leaf.capabilityRef} requirement resolves its family`);
    assert.ok(family.capabilityIds.includes(leaf.capabilityRef), `${leaf.capabilityRef} is in its exact requirement family`);
    requirementDimensionCounts.set(requirementRef, requirementDimensionCounts.get(requirementRef) + 1);

    const familyProfile = capability.ownerDefinition?.familyProfileRef;
    assert.equal(leaf.profileRef, familyProfile, `${leaf.capabilityRef} uses its exact selected family profile`);
    assert.equal(capability.ownerDefinition?.boundsRef, leaf.boundsRef, `${leaf.capabilityRef} uses the same exact bounds binding`);
    const suffix = leaf.operationContractRef.split("#capabilityOperationContracts/records/@id=")[1];
    assert.ok(suffix, `${leaf.capabilityRef} operation selector is in the canonical contract collection`);
    const operation = operationById.get(suffix);
    assert.ok(operation, `${leaf.capabilityRef} operation contract resolves exact ID ${suffix}`);
    assert.equal(operation.capabilityRef, leaf.capabilityRef, `${leaf.capabilityRef} cannot substitute another valid leaf contract`);
    assert.equal(operation.familyProfileRef, familyProfile, `${leaf.capabilityRef} operation/profile binding agrees`);
    assert.equal(operation.boundsRef, leaf.boundsRef, `${leaf.capabilityRef} operation/bounds binding agrees`);
    assert.equal(operationContracts.filter(({ id }) => id === suffix).length, 1, `${leaf.capabilityRef} contract ID is unique`);
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
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments }),
  "the real join resolver rejects a missing dimension/type pair");
  const staleEvidence = structuredClone(applicability);
  staleEvidence.dimensions[0].dimensionEvidenceRefs[0] = ".product-experience/pdp-1-domain-data/domain-objects.yaml#objects/@id=missing-object";
  assert.throws(() => resolveWithReviewedArtifact({ applicability: staleEvidence, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments }),
  "the real join resolver rejects a stale or missing dimension contract selector");
  const validButWrongClause = structuredClone(applicability);
  const substitutedDimension = validButWrongClause.dimensions[0];
  substitutedDimension.reviewClauseContracts[0].sourceRefs[0] = ".product-experience/pdp-1-domain-data/domain-objects.yaml#objects/@id=media.domain.upload-session";
  substitutedDimension.dimensionEvidenceRefs = [...new Set(substitutedDimension.reviewClauseContracts.flatMap(({ sourceRefs }) => sourceRefs))];
  assert.ok(sourceDocuments[".product-experience/pdp-1-domain-data/domain-objects.yaml"].objects
    .some(({ id }) => id === "media.domain.upload-session"),
    "the adversarial replacement is a real, resolvable source record");
  assert.throws(() => resolveWithReviewedArtifact({ applicability: validButWrongClause, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments }),
  "the real join resolver rejects a valid but semantically unrelated dimension contract selector");
  const changedReviewedSource = { ...sourceDocuments };
  changedReviewedSource[".product-experience/pdp-1-domain-data/domain-objects.yaml"] = structuredClone(sourceDocuments[".product-experience/pdp-1-domain-data/domain-objects.yaml"]);
  const reviewedArtifactRecord = changedReviewedSource[".product-experience/pdp-1-domain-data/domain-objects.yaml"].objects.find(({ id }) => id === "media.domain.artifact");
  reviewedArtifactRecord.identity = "tenant-only-invalid-identity";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments: changedReviewedSource }),
  "the production join rejects changed content behind a still-resolving reviewed source selector");
  const alteredReviewArtifactText = reviewedMaterialArtifactText.replace("PXD-098", "PXD-099");
  assert.throws(() => resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments,
    reviewedMaterialArtifact, reviewedMaterialArtifactText: alteredReviewArtifactText,
    reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText,
    reviewedOperationReferenceCorrectionArtifact, reviewedOperationReferenceCorrectionArtifactText }),
  "the production join rejects an altered or unreviewed approval artifact");
  assert.throws(() => resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments,
    reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact,
    reviewedReferenceCorrectionArtifactText: reviewedReferenceCorrectionArtifactText.replace("PXD-101", "PXD-099"),
    reviewedOperationReferenceCorrectionArtifact, reviewedOperationReferenceCorrectionArtifactText }),
  "a changed supplemental correction artifact cannot authorize current source bytes");
  assert.throws(() => resolvePdp0FeatureReviewApplicability({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments,
    reviewedMaterialArtifact, reviewedMaterialArtifactText, reviewedReferenceCorrectionArtifact, reviewedReferenceCorrectionArtifactText,
    reviewedOperationReferenceCorrectionArtifact,
    reviewedOperationReferenceCorrectionArtifactText: reviewedOperationReferenceCorrectionArtifactText.replace("PXD-103", "PXD-099") }),
  "the operation-reference correction is accepted only with its exact reviewed artifact bytes");
  const modifiedCorrectedLeaf = structuredClone(capabilities);
  const correctedLeaf = modifiedCorrectedLeaf.capabilities.find(({ id }) => id === "media.generate.image.text-to-image");
  correctedLeaf.ownerDefinition.familyProfileRef = "media.capability-profile.foreign-current-edit";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities: modifiedCorrectedLeaf,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts,
    sourceDocuments: { ...sourceDocuments, ".product-experience/pdp-0-product-truth/capabilities.yaml": modifiedCorrectedLeaf } }),
  "the exact reference-only correction does not authorize any unrelated current field change");
  const unreasonedExclusion = structuredClone(applicability);
  unreasonedExclusion.dimensions[0].notApplicableRequirementDecisions[0].reason = "";
  assert.throws(() => resolveWithReviewedArtifact({ applicability: unreasonedExclusion, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments }),
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
    capabilityCrosswalk: wrongValidType, channels, operationContracts, sourceDocuments }),
  "the real resolver rejects a wrong but existing requirement type");
  const foreignOperationRef = structuredClone(review.ownerCapabilityLeafAdjudication);
  foreignOperationRef.records[0].operationContractRef = leaves[1].operationContractRef;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: foreignOperationRef, channels, operationContracts, sourceDocuments }),
  "the real resolver rejects a different valid actual operation selector");
  const foreignOwnerOperation = structuredClone(capabilities);
  foreignOwnerOperation.capabilities[0].ownerDefinition.operationContractRef = capabilities.capabilities[1].ownerDefinition.operationContractRef;
  const ownerOperationDocuments = { ...sourceDocuments, ".product-experience/pdp-0-product-truth/capabilities.yaml": foreignOwnerOperation };
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities: foreignOwnerOperation,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts, sourceDocuments: ownerOperationDocuments }),
  "the real resolver rejects a valid but foreign owner-operation selector");
  const foreignChannelSelector = structuredClone(capabilities);
  foreignChannelSelector.capabilities[0].ownerDefinition.channelApplicabilityRef = review.ownerCapabilityLeafAdjudication.records[1].id
    ? `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@id=${review.ownerCapabilityLeafAdjudication.records[1].id}/channelApplicability`
    : "";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities: foreignChannelSelector,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts,
    sourceDocuments: { ...sourceDocuments, ".product-experience/pdp-0-product-truth/capabilities.yaml": foreignChannelSelector } }),
  "the real resolver rejects a valid but foreign per-leaf channel selector");
  const foreignCapabilitySource = structuredClone(review.ownerCapabilityLeafAdjudication);
  foreignCapabilitySource.records[0].capabilitySourceRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${capabilities.capabilities[1].id}`;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: foreignCapabilitySource, channels, operationContracts, sourceDocuments }),
  "the real resolver rejects a valid but foreign capability source selector");
  const alteredContract = structuredClone(operationById.get(leaves[0].operationContractRef.split("#capabilityOperationContracts/records/@id=")[1]));
  alteredContract.capabilityRef = leaves[1].capabilityRef;
  assert.notEqual(alteredContract.capabilityRef, leaves[0].capabilityRef,
    "an existing but unrelated canonical operation contract is not a valid join");
  const wrongValidContract = structuredClone(operations.capabilityOperationContracts.records);
  const wrongContractIndex = wrongValidContract.findIndex(({ id }) => id === leaves[0].operationContractRef.split("#capabilityOperationContracts/records/@id=")[1]);
  wrongValidContract[wrongContractIndex].capabilityRef = leaves[1].capabilityRef;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: review.ownerCapabilityLeafAdjudication, channels, operationContracts: wrongValidContract, sourceDocuments }),
  "the real resolver rejects a different valid operation contract attached to the wrong leaf");
  const wrongProfile = structuredClone(review.ownerCapabilityLeafAdjudication);
  const foreignProfileCapability = capabilities.capabilities.find(({ id }) => capabilityById.get(id).ownerDefinition?.familyProfileRef !== capabilityById.get(leaves[0].capabilityRef).ownerDefinition?.familyProfileRef);
  wrongProfile.records[0].profileRef = capabilityById.get(foreignProfileCapability.id).ownerDefinition.familyProfileRef;
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: wrongProfile, channels, operationContracts, sourceDocuments }),
  "the real resolver rejects a different valid family profile");
  const inventedChannel = structuredClone(leaves[0]);
  inventedChannel.channelApplicability[0].channelRef = "media.channel.gui";
  assert.notDeepEqual(new Set(inventedChannel.channelApplicability.map(({ channelRef }) => channelRef)), channelSet,
    "an invented GUI channel fails exact active-union resolution");
  const guiChannel = structuredClone(review.ownerCapabilityLeafAdjudication);
  guiChannel.records[0].channelApplicability[0].channelRef = "media.channel.gui";
  assert.throws(() => resolveWithReviewedArtifact({ applicability, requirements, capabilities,
    capabilityCrosswalk: guiChannel, channels, operationContracts, sourceDocuments }),
  "the real resolver rejects a fabricated GUI channel");
});
