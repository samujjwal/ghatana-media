import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
const leafReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const journeyCatalog = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
const profileSemantics = readYaml(".product-experience/pdp-0-product-truth/profile-semantics.yaml");
const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const migrationDelta = JSON.parse(readFileSync(resolve(root, "docs/migration/current-master-plan-claim-dispositions.json"), "utf8"));
const migrationGap = readYaml(".product-experience/gaps.yaml").gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS");

function walkRefs(value, path = "$") {
  if (Array.isArray(value)) return value.flatMap((item, index) => walkRefs(item, `${path}[${index}]`));
  if (typeof value === "string") return [{ path, value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    return walkRefs(item, `${path}.${key}`);
  });
}

test("P0 input inspection, simulation, trust, and mission rules have no PDP-1 contract prerequisites", () => {
  const inputInspection = requirements.ownerDefinedInputInspectionRules[0];
  const simulation = requirements.ownerDefinedSimulationScopeRules[0];
  const trust = requirements.ownerDefinedLeafTrustReconstructionPolicy;
  const mission = requirements.ownerDefinedProductMissionCapabilityMaps[0];

  assert.deepEqual(inputInspection.sourceRefs, [
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities",
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy",
  ]);
  assert.ok(inputInspection.requiredFacts.includes("capabilityIntentId"));
  assert.match(inputInspection.downstreamHandoff, /PDP-1 binds the stable capability intent/u);

  assert.ok(simulation.requiredFacts.includes("capabilityIntentId"));
  assert.ok(simulation.requiredFacts.includes("semanticInputsAndOutputs"));
  assert.doesNotMatch(simulation.requiredFacts.join(" "), /operation|wire|solverIdentity|version/u);
  assert.match(simulation.downstreamHandoff, /PDP-1 binds the P0 simulation family/u);

  assert.match(trust.appliesTo, /stable capability intent ID[\s\S]*P0 semantic input\/output shapes/u);
  assert.ok(trust.requiredLeafBindings.includes("P0 semantic input and output shapes"));
  assert.ok(!trust.requiredLeafBindings.some((binding) => /operation contract|wire schema|PDP-1/iu.test(binding)));
  assert.match(trust.downstreamHandoff, /back-bound to the stable P0 capability intent/u);

  assert.ok(mission.governedMediaRequires.every((ref) => ref.startsWith(".product-experience/pdp-0-product-truth/")));
  assert.match(mission.downstreamHandoff, /PDP-1 maps each P0 capability intent/u);

  for (const row of [inputInspection, simulation, trust, mission]) {
    const refs = walkRefs(row);
    assert.ok(refs.every(({ value }) => !/pdp-1-domain-data|operationContractRef|requestSchemaRef|responseSchemaRef|privacy\.yaml/iu.test(value)),
      `${row.id} contains a live downstream contract reference`);
  }
  assert.equal(requirements.authority, "prospective-Phase-0-definition; not accepted Product Truth");
});

test("P0 requirement families resolve every leaf to exact request, profile, bounds, and support semantics", () => {
  const rule = requirements.ownerDefinedOperationRequestBoundsRules?.find(
    ({ id }) => id === "media.requirement.operation-request-bounds.v1",
  );
  assert.ok(rule, "P0-B requires one owner-defined requirement-to-leaf request rule");
  assert.match(rule.application, /capabilityIds identify the exact leaves/u);
  assert.match(rule.requestContract, /exact leaf ownerDefinition is authoritative/u);
  assert.match(rule.requestContract, /absent defaults are not inferred/u);
  assert.match(rule.boundsAndUnits, /finite bound, explicit unit, accountable authority, source/u);
  assert.match(rule.unknownDisposition, /NOT_ADMITTED/u);
  assert.match(rule.nonDefaultPolicy, /A default or fallback is permitted only when explicitly defined/u);
  assert.match(rule.supportStateSeparation, /never means implemented, licensed, qualified, or available/u);
  assert.match(rule.sourceAuthority, /capabilities\.yaml owns exact leaf operation\/request semantics/u);
  assert.doesNotMatch(rule.sourceAuthority, /pdp-1-domain-data|operations\.yaml/u);
  assert.match(rule.status, /runtime enforcement, qualification, implementation, license admission, availability/u);

  assert.equal(requirements.requirements.length, 38);
  assert.equal(capabilities.capabilities.length, 462);
  const requirementLeafIds = requirements.requirements.flatMap(({ capabilityIds }) => capabilityIds);
  assert.equal(requirementLeafIds.length, 462);
  assert.equal(new Set(requirementLeafIds).size, 462, "requirement groups must not overlap or duplicate leaf identities");
  assert.deepEqual([...requirementLeafIds].sort(), capabilities.capabilities.map(({ id }) => id).sort(),
    "all 462 capability leaves must be covered by the 38 exact requirement families");
  assert.match(rule.boundsAndUnits, /boundedInvocationAdmission/u);
  assert.match(profileSemantics.boundedInvocationAdmission.rules.join(" "), /UNKNOWN applicability[\s\S]*NOT_ADMITTED/u);
});

test("requirement groups expose current leaf-channel scope while keeping exact views downstream", () => {
  const reviewByCapability = new Map(leafReview.ownerCapabilityLeafAdjudication.records
    .map((row) => [row.capabilityRef, row]));
  assert.equal(reviewByCapability.size, capabilities.capabilities.length);

  for (const requirement of requirements.requirements) {
    assert.match(requirement.downstreamMappings.viewsAndChannels,
      /exact-leaf-channel-applicability-bound-in-capability-leaf-review\.yaml/u,
      `${requirement.id} must reference the resolved exact-leaf channel decision`);
    assert.match(requirement.downstreamMappings.viewsAndChannels,
      /exact-screen\/action-bindings-pending-P0-009/u,
      `${requirement.id} must keep screen/action binding pending`);
    for (const capabilityRef of requirement.capabilityIds) {
      const row = reviewByCapability.get(capabilityRef);
      assert.ok(row, `${requirement.id} capability ${capabilityRef} has a leaf applicability record`);
      assert.equal(row.channelApplicability.length, 11, `${capabilityRef} has one disposition for every channel`);
      assert.equal(new Set(row.channelApplicability.map(({ channelRef }) => channelRef)).size, 11,
        `${capabilityRef} has no duplicate channel dispositions`);
    }
  }
});

test("P0-H intent-fit review binds exact family intents and closes project review meaning", () => {
  const requirementById = new Map(requirements.requirements.map((record) => [record.id, record]));
  const reviewedState = "media-owner-reviewed-fit-to-canonical-P0-002-intents; independent-P0-010-acceptance-pending";
  const reviewedIntentRefs = {
    "MEDIA-REQ-CAP-ARTIFACT": [
      "media.intent.create", "media.intent.understand", "media.intent.edit", "media.intent.improve",
      "media.intent.deliver", "media.intent.manage-artifact-lifecycle",
    ],
    "MEDIA-REQ-CAP-JOB": [
      "media.intent.create", "media.intent.understand", "media.intent.improve", "media.intent.edit",
      "media.intent.animate", "media.intent.simulate", "media.intent.deliver", "media.intent.resolve-job",
    ],
    "MEDIA-REQ-CAP-STREAM": [
      "media.intent.create", "media.intent.understand", "media.intent.deliver", "media.intent.recover-live-session",
    ],
    "MEDIA-REQ-CAP-PROFILE": ["media.intent.choose-eligible-processing-option"],
    "MEDIA-REQ-CAP-CAPABILITY": ["media.intent.check-processing-options"],
    "MEDIA-REQ-CAP-HEALTH": ["media.intent.check-processing-readiness"],
    "MEDIA-REQ-CAP-RIGHTS": ["media.intent.deliver", "media.intent.review-rights-and-consent"],
    "MEDIA-REQ-CAP-PROVENANCE": [
      "media.intent.understand", "media.intent.improve", "media.intent.deliver",
      "media.intent.inspect-provenance", "media.intent.manage-artifact-lifecycle",
    ],
    "MEDIA-REQ-CAP-PROJECT": [
      "media.intent.create", "media.intent.edit", "media.intent.review-exact-version", "media.intent.restore-project",
    ],
  };

  for (const [requirementId, expectedIntentRefs] of Object.entries(reviewedIntentRefs)) {
    const requirement = requirementById.get(requirementId);
    assert.ok(requirement, `${requirementId} remains a source requirement`);
    assert.deepEqual(requirement.traceToIntentIds, expectedIntentRefs,
      `${requirementId} retains exactly the reviewed family intent fit`);
    assert.equal(requirement.intentTraceState, reviewedState,
      `${requirementId} records Media-owner fit review, separate from P0-010 acceptance`);
    assert.deepEqual(requirement.unresolvedIntentTraceDispositions, []);
  }

  const project = requirementById.get("MEDIA-REQ-CAP-PROJECT");
  assert.deepEqual(project.traceToIntentIds, [
    "media.intent.create", "media.intent.edit", "media.intent.review-exact-version", "media.intent.restore-project",
  ]);
  assert.equal(project.intentTraceState,
    "media-owner-reviewed-fit-to-canonical-P0-002-intents; independent-P0-010-acceptance-pending");
  assert.deepEqual(project.unresolvedIntentTraceDispositions, []);
  const projectReviewLeaf = capabilities.capabilities.find(({ id }) => id === "media.project.review");
  assert.deepEqual(projectReviewLeaf.intentRefs, ["media.intent.review-exact-version"]);
  assert.deepEqual(projectReviewLeaf.outcomeRefs, ["media.goal.review-trustworthy-output"]);
  assert.deepEqual(projectReviewLeaf.journeyRefs, ["J-21"]);
  assert.ok(projectReviewLeaf.requiredAuthority.includes(
    "current-assigned-review-authority-for-exact-version-scope-purpose",
  ));
  assert.ok(projectReviewLeaf.ownerDefinition.guards.authorityRefs.includes(
    "current-assigned-review-authority-for-exact-version-scope-purpose",
  ));
  assert.match(projectReviewLeaf.outcome, /exact immutable project version/u);
  assert.match(projectReviewLeaf.outcome, /comment, approval, rejection, or request for changes/u);
  assert.match(projectReviewLeaf.outcome, /current assigned reviewer authority/u);
  assert.match(projectReviewLeaf.outcome, /explicit scope and expiry disposition/u);
  assert.match(projectReviewLeaf.outcome, /does not mutate the reviewed version/u);
  const reviewParameters = projectReviewLeaf.ownerDefinition.parameterSchema;
  assert.deepEqual(reviewParameters.required, ["reviewPurpose", "reviewScope", "reviewAction"]);
  assert.equal(reviewParameters.properties.reviewPurpose.minLength, 1);
  assert.equal(reviewParameters.properties.reviewPurpose.maxLength, undefined,
    "the source defines a declared purpose but no product-level maximum length");
  assert.deepEqual(reviewParameters.properties.reviewScope.items.enum,
    ["quality", "rights", "provenance", "approval"]);
  assert.deepEqual(reviewParameters.properties.reviewAction.enum,
    ["comment", "approve", "reject", "request-changes"]);
  assert.deepEqual(projectReviewLeaf.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType),
    ["user-intent", "versioned-project"], "the versioned project input carries the exact immutable target");
  assert.match(projectReviewLeaf.ownerDefinition.semanticOutcomeContract.unknownDisposition,
    /current assigned authority.*expiry disposition/iu);
  assert.ok(projectReviewLeaf.ownerDefinition.semanticOutcomeContract.sourceRefs.includes(
    ".product-experience/pdp-0-product-truth/intent-resolutions.yaml#/intents/@id=media.intent.review-exact-version",
  ));
  assert.ok(projectReviewLeaf.ownerDefinition.semanticOutcomeContract.sourceRefs.includes(
    ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml#/actors/@id=media.reviewer",
  ));
  assert.ok(projectReviewLeaf.ownerDefinition.semanticOutcomeContract.sourceRefs.includes(
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-21",
  ));
  assert.equal(projectReviewLeaf.ownerDefinition.effect.semanticOutcome, projectReviewLeaf.outcome);
  const reviewJourney = journeyCatalog.journeys.find(({ id }) => id === "J-21");
  assert.ok(reviewJourney.intentRefs.includes("media.intent.review-exact-version"));
  const reviewedLeaf = leafReview.leaves.find(({ id }) => id === "media.project.review");
  assert.deepEqual(reviewedLeaf.intentRefs, ["media.intent.review-exact-version"]);
  assert.deepEqual(reviewedLeaf.journeyRefs, ["J-21"]);
  assert.deepEqual(reviewedLeaf.intentRefs, projectReviewLeaf.intentRefs);
  assert.deepEqual(reviewedLeaf.journeyRefs, projectReviewLeaf.journeyRefs);
  const reviewTrust = leafReview.ownerTrustReconstructionDispositions.records
    .find(({ capabilityRef }) => capabilityRef === "media.project.review");
  assert.match(reviewTrust.outputBranches[0].outcomes[0].meaning, /exact immutable project version/u);
  assert.match(reviewTrust.outputBranches[0].outcomes[0].meaning, /scope and expiry disposition/u);
  assert.match(reviewTrust.unknownPolicy, /review purpose\/scope\/action\/evidence or expiry disposition/u);

  assert.throws(() => assert.deepEqual(
    reviewedIntentRefs["MEDIA-REQ-CAP-STREAM"].filter((id) => id !== "media.intent.deliver"),
    reviewedIntentRefs["MEDIA-REQ-CAP-STREAM"],
  ), /deep-equal/u, "a stream trace missing delivery intent is rejected");
  assert.throws(() => assert.deepEqual(
    reviewedIntentRefs["MEDIA-REQ-CAP-PROVENANCE"].filter((id) => id !== "media.intent.manage-artifact-lifecycle"),
    reviewedIntentRefs["MEDIA-REQ-CAP-PROVENANCE"],
  ), /deep-equal/u, "a provenance trace missing lifecycle intent is rejected");
});

test("historical migration source stays provenance and cannot become current phase acceptance", () => {
  assert.match(migration.sourcePin.path, /expert-reviewed-master-plan\.md$/u);
  assert.match(migration.ownerDecisionOverlay.authorityOverlay, /migration proposal until extracted/u);
  assert.match(migration.ownerDecisionOverlay.authorityOverlay, /does not prove semantic equivalence or acceptance/u);
  assert.equal(migration.ownerDecisionOverlay.unresolvedBlockCount, 260);
  assert.equal(migration.pdp38ClaimReconciliation.currentness,
    "HISTORICAL_POPULATION_ONLY; NON_GATING_FOR_CURRENT_PDP0_03_DEVELOPMENT_EXIT");
  assert.equal(migration.pdp38ClaimReconciliation.currentDeltaDispositionRef,
    "docs/migration/current-master-plan-claim-dispositions.json");
  assert.equal(migration.pdp38ClaimReconciliation.candidateTargetPendingSemanticParityCount, 361,
    "the historical locator-only count remains preserved without gating current P0-03");
  assert.match(migration.sourceChangeLedger.reconciliationStatus, /historical inventory; non-gating for current P0-03/u);
  assert.equal(migrationDelta.claimCount, 129);
  assert.deepEqual(migrationDelta.p0MeaningOnlyInOldPlan, []);
  assert.match(migrationGap.remaining, /do not reopen the historical 260\/361 populations as a P0-03 gate/u);
  assert.match(migrationGap.impact, /does-not-block-current-P0-03-development-exit/u);
  assert.doesNotMatch(migrationGap.remaining, /P0-03 remains open/u);
  assert.equal(requirements.independentAcceptance, undefined, "historical extraction counts do not alter per-rule acceptance");
  assert.match(requirements.authority, /not accepted Product Truth/u);
});
