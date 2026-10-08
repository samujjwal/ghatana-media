import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const { validateProductDefinition } = require(resolve(root, "../ghatana-tools/libs/product-development/product-definition/dist/index.js"));
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("PDP-0 ProductDefinition candidate is schema and public-validator conformant while retaining open mapping decisions", () => {
  const projection = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  assert.equal(projection.projectionStatus, "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT");
  validateProductDefinition(projection.candidateModel);
  assert.equal(projection.validation.schemaValid, true);
  assert.equal(projection.validation.publicValidatorPassed, true);
  assert.equal(projection.acceptance, "NOT_CLAIMED");
  assert.match(projection.candidateMappingReview.ownerDecisionStatus, /PENDING/u);
  assert.ok(projection.candidateMappingReview.omittedCollections.timestamps.includes("No source authority"));
  assert.ok(projection.candidateMappingReview.omittedCollections.journeys.includes("multiple actors"));
  assert.ok(projection.candidateMappingReview.omittedCollections.userIntents.includes("All 19 intents"));
  assert.equal(projection.candidateModel.capabilities.length, 462);
  assert.equal(projection.candidateModel.requirements.length, 52);
  assert.equal(projection.candidateModel.userIntents.length, 0, "priority and primary actor are not inferred");
  assert.equal(projection.candidateModel.nonGoals.length, 0, "scope authority exclusions are not reclassified as product non-goals");
  const functionalRequirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements;
  assert.ok(functionalRequirements.some((item) => item.traceToIntentIds.length > 0), "the source intent traces remain available for crosswalk resolution");
  assert.ok(projection.candidateModel.requirements.every((item) => item.traceToIntentIds.length === 0), "unresolved userIntent targets are not emitted as dangling refs");
  assert.equal(projection.candidateModel.actors.find(({ id }) => id === "media.external-provider").kind, "external-service");
  assert.equal(projection.candidateModel.policies.length, 9, "explicit fail-closed enforcement points map to strict product policies");
  assert.equal(projection.fieldMappingBlockers.length, 12);
  assert.equal(Object.keys(projection.candidateFieldSources).length, 22);
  assert.ok(projection.fieldMappingBlockers.every((item) => !/ACCEPTED|CLOSED/u.test(item.status)));
  assert.match(projection.candidateMappingReview.fieldDispositions.policies.status, /DIRECT_FAIL_CLOSED_ENFORCEMENT_MAPPING/u);
  assert.match(projection.candidateMappingReview.fieldDispositions.capabilities.status, /DIRECT_SOURCE_MAPPING/u);
  assert.match(projection.candidateMappingReview.fieldDispositions.requirements.status, /INTENT_TARGETS_UNRESOLVED/u);
});

test("all 462 capability leaves have operation-specific inputs, outcomes, preconditions, constraints, and acceptance cases", () => {
  const source = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const leaves = source.capabilities;
  assert.equal(leaves.length, 462);
  assert.equal(new Set(leaves.map(({ id }) => id)).size, 462);
  for (const leaf of leaves) {
    assert.ok(leaf.operation, `${leaf.id} has an operation identity`);
    assert.ok(leaf.inputArtifactTypes?.length, `${leaf.id} has inputs`);
    assert.ok(leaf.outputArtifactTypes?.length, `${leaf.id} has outputs`);
    assert.ok(leaf.preconditions?.length, `${leaf.id} has preconditions`);
    assert.ok(leaf.constraints?.length, `${leaf.id} has constraints`);
    assert.ok(leaf.acceptanceCases?.length, `${leaf.id} has acceptance cases`);
    assert.ok(leaf.acceptanceCases.every((scenario) => scenario.given && scenario.when && scenario.then), `${leaf.id} has testable acceptance cases`);
    assert.ok(leaf.requiredAuthority?.length, `${leaf.id} has effect authority requirements`);
    assert.ok(leaf.qualityFidelityContract, `${leaf.id} has quality/fidelity rules`);
    assert.ok(leaf.cancellationRetryReconciliation, `${leaf.id} has recovery semantics`);
    assert.ok(leaf.executionResourceRequirements, `${leaf.id} has resource bounds to resolve`);
    assert.ok(leaf.qualificationDimensions?.length, `${leaf.id} has qualification dimensions`);
    assert.ok(leaf.explicitUnsupportedCases?.length, `${leaf.id} has explicit unsupported cases`);
  }
  const reviewed = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  assert.equal(reviewed.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(reviewed.denominatorReconciliation.leavesWithoutJourneyRefs, 385);
  assert.equal(reviewed.denominatorReconciliation.leavesWithOwnerCoverageDisposition, 79);
  assert.equal(reviewed.denominatorReconciliation.leavesWithUnresolvedApplicability, 383);
  assert.equal(reviewed.denominatorReconciliation.machineOperationDispositions, 0);
  assert.ok(reviewed.leaves.every((leaf) => leaf.coverageDecision.purposeSpecificOutcomeRefs?.length));
  assert.ok(reviewed.leaves.every((leaf) => leaf.coverageDecision.proposedInterfaceRefs?.every((ref) => leaf.coverageDecision.normativeRefs.includes(`.product-experience/pdp-0-product-truth/applications-channels.yaml#${ref}`))));
  assert.ok(reviewed.leaves.filter((leaf) => leaf.coverageDecision.disposition === "UNRESOLVED").every((leaf) => leaf.coverageDecision.proposedInterfaceRefs?.length && /not established/u.test(leaf.coverageDecision.interfaceAdmissionStatus)));
  assert.match(reviewed.status, /does-not-close|pending|best-effort/iu);
  assert.equal(reviewed.leaves.length, 462);
  const journeySource = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const knownJourneys = new Set(journeySource.journeys.map(({ id }) => id));
  const knownViews = new Set(journeySource.journeys.flatMap(({ viewRefs = [] }) => viewRefs));
  for (const leaf of reviewed.leaves) {
    assert.ok(leaf.requirementRefs.length > 0, `${leaf.id} traces to a requirement`);
    assert.ok(leaf.intentRefs.length > 0, `${leaf.id} traces to an intent`);
    for (const ref of leaf.journeyRefs) assert.ok(knownJourneys.has(ref), `${leaf.id} journey ${ref} exists`);
    for (const ref of leaf.supportingViewRefs) assert.ok(knownViews.has(ref), `${leaf.id} view ${ref} exists`);
    if (leaf.journeyRefs.length === 0 && leaf.supportingViewRefs.length === 0) {
      assert.match(leaf.journeyAndViewDisposition, /unresolved/u, `${leaf.id} keeps its missing reachability decision open`);
    } else {
      assert.ok(leaf.journeyRefs.length > 0 || leaf.supportingViewRefs.length > 0, `${leaf.id} has direct reachability references`);
    }
  }
  assert.equal(reviewed.leaves.filter(({ operation }) => operation.explicitOperationBindings.length > 0).length, 11);
  assert.equal(reviewed.leaves.filter(({ operation }) => operation.ambiguousOperationBindings.length > 0).length, 2);
  assert.equal(reviewed.leaves.filter(({ operation }) => operation.canonicalOperationDisposition.startsWith("unresolved;")).length, 449);
});

test("PDP-0 quality and NFR records retain measurement limits and unresolved specialist decisions", () => {
  const nfr = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
  const quality = readYaml(".product-experience/pdp-0-product-truth/quality-policy.yaml");
  assert.equal(nfr.requirements.length, 14);
  assert.ok(nfr.requirements.every((item) => item.owner && item.acceptance));
  assert.ok(nfr.openDecisions.length >= 3);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.ok(quality.qualityDimensions.every((item) => item.applicability && item.abstainWhen));
  assert.match(nfr.authorityStatus, /pending-P0-010/iu);
});

test("migration extraction keeps the mixed blocks and unresolved owner review visible", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 349);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 123);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.match(review.blockStructureProposalAuthority, /Proposal-only/u);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  for (const id of ["MPSEM-0178", "MPSEM-0211"]) {
    const item = review.items.find((candidate) => candidate.itemId === id);
    assert.equal(item.classification, "UNRESOLVED");
    assert.ok(item.partialClaimMappings?.length);
    assert.ok(item.partialClaimMappings.every((claim) => claim.disposition.includes("block-remains-UNRESOLVED")));
  }
  assert.match(review.systematicScope.gapState, /open/u);
});
