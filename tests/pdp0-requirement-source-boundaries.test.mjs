import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const campaignExtensionPath = ".product-experience/pdp-0-product-truth/campaign-extensions.yaml";
function resolveCampaignAnchor(anchor) {
  const prefix = `${campaignExtensionPath}#`;
  if (typeof anchor !== "string" || !anchor.startsWith(prefix)) return undefined;
  let value = campaignExtensions;
  for (const segment of anchor.slice(prefix.length).split("/").filter(Boolean)) {
    if (segment.startsWith("@id=")) {
      if (!Array.isArray(value)) return undefined;
      value = value.find((record) => record?.id === segment.slice(4));
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      value = value[segment];
    }
    if (value === undefined || value === null) return undefined;
  }
  return value;
}

const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
const leafReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const campaignExtensions = readYaml(".product-experience/pdp-0-product-truth/campaign-extensions.yaml");
const artifactIdentities = readYaml(".product-experience/artifact-identities.yaml");
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
  assert.equal(capabilities.families.length, 38);
  assert.equal(capabilities.capabilities.length, 462);
  const requirementLeafIds = requirements.requirements.flatMap(({ capabilityIds }) => capabilityIds);
  assert.equal(requirementLeafIds.length, 462);
  assert.equal(new Set(requirementLeafIds).size, 462, "requirement groups must not overlap or duplicate leaf identities");
  assert.deepEqual([...requirementLeafIds].sort(), capabilities.capabilities.map(({ id }) => id).sort(),
    "the 462 historical capability leaves must be covered by the 38 historical requirement families");
  assert.equal(requirements.requirements.some(({ id }) => id === "MEDIA-REQ-CAP-RULES"), false);
  assert.equal(capabilities.capabilities.some(({ id }) => id === "media.rules.manage"), false);
  assert.equal(goals.intents.length, 19, "the canonical intent denominator remains 19");
  assert.match(rule.boundsAndUnits, /boundedInvocationAdmission/u);
  assert.match(profileSemantics.boundedInvocationAdmission.rules.join(" "), /UNKNOWN applicability[\s\S]*NOT_ADMITTED/u);
});

test("requirement groups expose current leaf-channel scope while keeping exact views downstream", () => {
  const reviewByCapability = new Map(leafReview.ownerCapabilityLeafAdjudication.records
    .map((row) => [row.capabilityRef, row]));
  const rulesExtension = campaignExtensions.records.find(({ id }) => id === "AUD-SPEC-020");
  const proposalByCapability = new Map(rulesExtension.channelApplicability.records
    .map((row) => [row.capabilityRef, row]));
  assert.equal(reviewByCapability.size, 462, "the existing owner adjudication denominator remains unchanged");
  assert.equal(proposalByCapability.size, 1, "only the additive rules leaf has proposal-only applicability");
  assert.ok(!reviewByCapability.has("media.rules.manage"), "proposal-only applicability must not enter the owner ledger");
  const rulesProposal = proposalByCapability.get("media.rules.manage");
  assert.ok(rulesProposal);
  assert.equal(rulesProposal.ownerApproval, "NOT_CLAIMED");
  assert.equal(rulesProposal.independentAcceptance, "NOT_CLAIMED");
  assert.equal(rulesProposal.applicabilityState, "PROPOSED; owner disposition pending");
  assert.equal(rulesProposal.channelApplicability.length, 11);
  assert.deepEqual(new Set(rulesProposal.channelApplicability.map(({ channelRef }) => channelRef)), new Set([
    "media.channel.web", "media.channel.api", "media.channel.embedded", "media.channel.http-api",
    "media.channel.grpc-api", "media.channel.sdk", "media.channel.cli", "media.channel.product-integration",
    "media.channel.legacy-desktop", "media.channel.agent", "media.channel.event",
  ]));
  assert.equal(rulesProposal.channelApplicability.filter(({ disposition }) => disposition === "PROPOSED_APPLICABLE").length, 8);
  for (const channelRef of ["media.channel.legacy-desktop", "media.channel.agent", "media.channel.event"]) {
    assert.match(rulesProposal.channelApplicability.find(({ channelRef: ref }) => ref === channelRef).disposition, /^NOT_APPLICABLE_/u);
    assert.ok(rulesProposal.channelApplicability.find(({ channelRef: ref }) => ref === channelRef).rationale);
  }
  assert.equal(rulesProposal.implementationState, "UNKNOWN");
  assert.equal(rulesProposal.qualificationState, "NOT_EVALUATED");
  assert.equal(rulesProposal.runtimeAvailability, "UNKNOWN");
  assert.equal(rulesProposal.executionAdmission, "NOT_ADMITTED");
  assert.match(rulesExtension.channelApplicability.status, /cannot satisfy owner acceptance, independent acceptance, closure/u);

  for (const requirement of requirements.requirements) {
    if (requirement.id === "MEDIA-REQ-CAP-RULES") {
      assert.match(requirement.downstreamMappings.viewsAndChannels,
        /proposed-applicability-in-applications-channels\.yaml#proposalCapabilityApplicability/u);
      continue;
    }
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

test("AUD-SPEC-020 has a separate candidate-only capability proposal and transcription provenance stays explicit", () => {
  const extension = campaignExtensions.records.find(({ id }) => id === "AUD-SPEC-020");
  assert.ok(artifactIdentities.records.some(({ path, artifactId }) =>
    path === ".product-experience/pdp-0-product-truth/campaign-extensions.yaml" && artifactId === "ART-P0-CAMPAIGN-EXTENSIONS"));
  const rules = extension?.capabilityDefinition;
  const rulesRequirement = extension?.requirementDefinition;
  const rulesIntent = extension?.intentDefinition;
  const profileRequirement = requirements.requirements.find(({ id }) => id === "MEDIA-REQ-CAP-PROFILE");
  assert.ok(extension && rules && rulesRequirement && rulesIntent && profileRequirement);
  assert.equal(extension.stableFeatureId, "media.rules.manage");
  assert.equal(extension.coordinatorScopeDecision.disposition, "INCLUDED_IN_PDP0_CAMPAIGN");
  assert.equal(extension.coordinatorScopeDecision.ownerApproval, "NOT_CLAIMED");
  assert.equal(extension.coordinatorScopeDecision.independentAcceptance, "NOT_CLAIMED");
  assert.equal(extension.coordinatorScopeDecision.implementationState, "UNKNOWN");
  assert.equal(extension.coordinatorScopeDecision.qualificationState, "NOT_EVALUATED");
  assert.equal(extension.coordinatorScopeDecision.runtimeAvailability, "UNKNOWN");
  assert.equal(extension.coordinatorScopeDecision.executionAdmission, "NOT_ADMITTED");
  assert.equal(rules.familyId, "media.rules");
  assert.equal(rulesRequirement.capabilityIds[0], "media.rules.manage");
  assert.equal(rulesIntent.id, "media.intent.manage-reusable-rules");
  assert.ok(rulesRequirement.acceptanceCases.some(({ id }) => id === "MEDIA-REQ-CAP-RULES-AC-01"));
  assert.ok(rulesRequirement.acceptanceCases.some(({ id }) => id === "MEDIA-REQ-CAP-RULES-AC-02"));
  assert.ok(rules.acceptanceCases.every(({ id }) => id?.startsWith("AUD-SPEC-020-CAP-AC-")));
  const rightsCase = rulesRequirement.acceptanceCases.find(({ id }) => id === "AUD-SPEC-020-REQ-AC-RIGHTS-LICENSE-01");
  assert.ok(rightsCase);
  assert.match(rightsCase.given, /rights, consent, privacy, egress, security, or applicable license evidence/u);
  assert.match(rightsCase.then, /no rule, preserve the prior rule-set version, and perform no affected media operation/u);
  assert.ok(!profileRequirement.acceptanceCases.some(({ id }) => id === "MEDIA-REQ-CAP-PROFILE-AC-03"));
  assert.match(rules.ownerDefinition.semanticOutcomeContract.result, /candidate operation plan only[\s\S]*None approves or executes/u);
  assert.match(rules.ownerDefinition.semanticOutcomeContract.unknownDisposition, /UNKNOWN[\s\S]*do not reuse a different version/u);
  assert.equal(rules.coverageDecisionRef, "NOT_CLAIMED");
  assert.match(rules.channelDispositionState, /owner review pending; no runtime admission/u);
  assert.equal(rules.ownerDefinition.availability.executionAdmission, "NOT_ADMITTED");
  assert.ok(rules.ownerDefinition.semanticOutcomeContract.sourceRefs.some((ref) => ref.endsWith("@audit_id=AUD-SPEC-020")));
  assert.deepEqual(rules.proposedApplicableChannels, ["web", "api", "embedded", "http-api", "grpc-api", "sdk", "cli", "product-integration"]);
  assert.match(rules.channelDispositionState, /no runtime admission/u);
  assert.equal(extension.compileAcceptance.outputs.normalizedSemanticGraph, "media.rules.normalized-semantic-graph");
  assert.equal(extension.compileAcceptance.outputs.semanticFingerprint, "media.rules.semantic-fingerprint");
  assert.match(extension.compileAcceptance.criterion, /equivalent normalized semantic graph[\s\S]*same stable semantic fingerprint/u);
  assert.match(extension.compileAcceptance.criterion, /Invalid or unauthorized input produces no effects/u);
  assert.equal(extension.compileAcceptance.algorithmAndVersionFormat, "PDP-1-owned; not defined by this PDP-0 proposal");
  assert.deepEqual(Object.keys(extension.validationCoverage.auditValidationDimensions).sort(), [
    "UNKNOWN_or_explicit_NA", "manual_agent_parity_when_applicable", "negative", "positive",
    "rights_license", "source_version_and_provenance", "unavailable",
  ].sort());
  for (const dimension of Object.values(extension.validationCoverage.auditValidationDimensions)) {
    assert.ok(dimension.caseRefs.length > 0);
    assert.ok(dimension.criterion);
    for (const anchor of dimension.caseRefs) {
      assert.match(anchor, /^\.product-experience\/pdp-0-product-truth\/campaign-extensions\.yaml#records\/@id=AUD-SPEC-020\//u);
      assert.doesNotMatch(anchor, /\[[0-9.]+\]/u, "validation anchors use stable selectors, not array indexes");
      assert.notEqual(resolveCampaignAnchor(anchor), undefined, `stale validation anchor: ${anchor}`);
    }
  }
  assert.equal(extension.validationCoverage.auditValidationDimensions.manual_agent_parity_when_applicable.disposition, "JUSTIFIED_NA");
  assert.equal(extension.validationCoverage.compileEquivalenceAndFingerprint.boundToNormalizedSemanticGraph, true);
  assert.equal(extension.validationCoverage.compileEquivalenceAndFingerprint.boundToStableSemanticFingerprint, true);
  assert.equal(resolveCampaignAnchor(extension.validationCoverage.compileEquivalenceAndFingerprint.compileAcceptanceRef), extension.compileAcceptance);
  assert.equal(resolveCampaignAnchor(extension.validationCoverage.compileEquivalenceAndFingerprint.criterionRef), extension.compileAcceptance.criterion);
  assert.equal(extension.validationCoverage.compileEquivalenceAndFingerprint.compileAcceptanceId, extension.compileAcceptance.id);

  const transcription = requirements.requirements
    .flatMap(({ acceptanceCases }) => acceptanceCases)
    .find(({ id }) => id === "MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-06");
  assert.ok(transcription);
  assert.match(transcription.then, /every supplied per-segment speaker, locale, source-timing, and translation-provenance field/u);
  assert.match(transcription.then, /absent or unknown rather than silently omitting or fabricating/u);
  assert.match(transcription.then, /audio\/video export synchronization, which remains a separate requirement/u);
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
  assert.equal(migration.pdp38ClaimReconciliation.candidateTargetPendingSemanticParityCount, 360,
    "the current locator-only remainder is recomputed from the 860 routed claims and 500 parity-verified claims, without gating current P0-03");
  assert.match(migration.sourceChangeLedger.reconciliationStatus, /historical inventory; non-gating for current P0-03/u);
  assert.equal(migrationDelta.claimCount, 129);
  assert.deepEqual(migrationDelta.p0MeaningOnlyInOldPlan, []);
  assert.match(migrationGap.remaining, /do not reopen the historical 260\/361 populations as a P0-03 gate/u);
  assert.match(migrationGap.impact, /does-not-block-current-P0-03-development-exit/u);
  assert.doesNotMatch(migrationGap.remaining, /P0-03 remains open/u);
  assert.equal(requirements.independentAcceptance, undefined, "historical extraction counts do not alter per-rule acceptance");
  assert.match(requirements.authority, /not accepted Product Truth/u);
});
