import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const p0Path = ".product-experience/pdp-0-product-truth/campaign-extensions.yaml";
const p1Path = ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml";
const p2Path = ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml";
const journey = readYaml(".product-experience/pdp-3-product-experience/proposal-journeys/manage-reusable-rules-proposal.yaml");
const registry = readYaml(".product-experience/pdp-3-product-experience/journey-registry.yaml");
const approvedChannelBindings = readYaml(".product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml");
const p0 = readYaml(p0Path).records.find((record) => record.id === "AUD-SPEC-020");
const p1 = readYaml(p1Path);
const p2 = readYaml(p2Path);

test("J-31 reusable-rules proposal journey stays source-bound and conditional", () => {
  assert.equal(journey.journeyId, "J-31");
  assert.equal(journey.definitionBoundary.featureRef, "media.rules.manage");
  assert.match(journey.definitionBoundary.disposition, /CONDITIONAL_ON_AUD_SPEC_020_PROPOSAL/u);
  assert.equal(p0.coordinatorScopeDecision.ownerApproval, "NOT_CLAIMED");
  assert.equal(journey.definitionBoundary.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(journey.definitionBoundary.executionAdmission, "NOT_ADMITTED");
  const extension = registry.campaignExtensionProposals.records.find(({ proposalId }) => proposalId === "J-31");
  assert.equal(extension.contract, "proposal-journeys/manage-reusable-rules-proposal.yaml");
  assert.equal(extension.pdp0JourneyLink, "NOT_A_PDP0_CATALOG_JOURNEY");
  assert.equal(extension.disposition, "CONDITIONAL_PROPOSAL; OWNER_APPROVAL_NOT_CLAIMED; RUNTIME_NOT_ADMITTED");

  const applicability = p0.channelApplicability.records[0].channelApplicability;
  const proposed = applicability.filter((item) => item.disposition === "PROPOSED_APPLICABLE").map((item) => item.channelRef);
  const notApplicable = applicability.filter((item) => item.disposition.startsWith("NOT_APPLICABLE_")).map((item) => item.channelRef);
  assert.deepEqual(journey.definitionBoundary.applicability.proposedApplicableChannels, proposed);
  assert.deepEqual(journey.definitionBoundary.applicability.proposedNotApplicableChannels.map((item) => item.channelRef), notApplicable);
  const mappings = journey.definitionBoundary.applicability.proposedChannelSurfaceMappings;
  assert.equal(mappings.status, "EXACT_SOURCE_COPY; PROPOSAL_ONLY; OWNER_APPROVAL_NOT_CLAIMED");
  assert.equal(mappings.uniqueSurfaceIdentityCount, 37);
  assert.deepEqual(mappings.records.map(({ channelRef }) => channelRef), proposed);
  assert.ok(notApplicable.every((channelRef) => !mappings.records.some((record) => record.channelRef === channelRef)),
    "the three proposal-only N/A scopes do not become applicable surface mappings");
  const expectedMappings = applicability.filter((item) => item.disposition === "PROPOSED_APPLICABLE").map((item) => ({
    channelRef: item.channelRef,
    sourceRef: `.product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/channelApplicability/records/@id=AUD-SPEC-020-CHANNEL-APPLICABILITY/channelApplicability/@id=${item.id}`,
    logicalConsumerSurfaceRefs: [...(item.surfaceResolution.logicalConsumerSurfaceRefs ?? [])].sort(),
    physicalSurfaceRefs: [...(item.surfaceResolution.physicalSurfaceRefs ?? [])].sort(),
    compositeSurfaceRefs: [...(item.surfaceResolution.compositeSurfaceRefs ?? [])].sort(),
  }));
  assert.deepEqual(mappings.records.map(({ disposition: _disposition, ...record }) => record), expectedMappings);
  const mappedSurfaces = new Set(mappings.records.flatMap((record) => [
    ...record.logicalConsumerSurfaceRefs,
    ...record.physicalSurfaceRefs,
    ...record.compositeSurfaceRefs,
  ]));
  assert.equal(mappedSurfaces.size, 37);
  assert.equal(approvedChannelBindings.counts.intendedEdges, 61);
  assert.ok(!approvedChannelBindings.edges.some((edge) => edge.journeyRef === "J-31"),
    "proposal scopes stay separate from the owner-approved 61-edge registry");
  assert.ok(journey.definitionBoundary.applicability.bindingRule.includes("do not assert active support"));
  assert.match(journey.channelBindingState, /owner review is pending/u);
  assert.match(journey.channelBindingState, /NOT_ADMITTED/u);
  assert.match(journey.accessibility.web, /keyboard/u);
  assert.match(journey.accessibility.headless, /No endpoint/u);

  const channelExperiences = journey.channelExperienceBindings;
  assert.equal(channelExperiences.length, 8);
  assert.deepEqual(channelExperiences.map(({ channelRef }) => channelRef), proposed);
  const p2Mappings = p2.ruleManagementProposalInterfaceBinding.channelProposalMappings.mappings;
  const interactionStepIds = [
    "author-versioned-candidate",
    "inspect-exact-version",
    "validate-exact-candidate",
    "request-candidate-only-reuse",
    "recover-without-replay-or-rebase",
  ];
  for (const binding of channelExperiences) {
    const p0Mapping = mappings.records.find(({ channelRef }) => channelRef === binding.channelRef);
    const p2Mapping = p2Mappings.find(({ channelRef }) => channelRef === binding.channelRef);
    assert.ok(p0Mapping, `${binding.channelRef} has an exact J-31/P0 source mapping`);
    assert.ok(p2Mapping, `${binding.channelRef} has an exact P2 proposal binding`);
    assert.equal(binding.applicabilitySourceRef, p0Mapping.sourceRef);
    assert.equal(binding.p2InterfaceBindingRef,
      `${p2Path}#ruleManagementProposalInterfaceBinding/channelProposalMappings/mappings/@id=${p2Mapping.id}`);
    assert.deepEqual(binding.logicalConsumerSurfaceRefs, p0Mapping.logicalConsumerSurfaceRefs);
    assert.deepEqual(binding.physicalSurfaceRefs, p0Mapping.physicalSurfaceRefs);
    assert.deepEqual(binding.compositeSurfaceRefs, p0Mapping.compositeSurfaceRefs);
    assert.deepEqual(binding.interactionSequence.map(({ stepId }) => stepId), interactionStepIds);
    assert.ok(binding.interactionSequence.every(({ interaction }) => typeof interaction === "string" && interaction.length > 0));
    assert.ok(binding.nonSuccessPresentation.outcomes.includes("UNKNOWN"));
    assert.ok(binding.nonSuccessPresentation.outcomes.includes("STALE"));
    assert.equal(binding.nonSuccessPresentation.noPartialEffects, true);
    assert.ok(binding.recoveryRefs.length >= 2);
    assert.ok(binding.accessibility.length > 0);
    assert.equal(binding.applicabilityDisposition, "PROPOSED_APPLICABLE; OWNER_APPROVAL_NOT_CLAIMED");
    assert.equal(binding.transportBinding, "UNBOUND");
    assert.equal(binding.invocationBinding, "UNBOUND");
    assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(binding.executionAdmission, "NOT_ADMITTED");
  }
  const apiUmbrella = channelExperiences.find(({ channelRef }) => channelRef === "media.channel.api");
  assert.deepEqual(apiUmbrella.inheritsChannelRefs, ["media.channel.http-api", "media.channel.grpc-api"]);
  assert.equal(apiUmbrella.transportScope, "UMBRELLA_ONLY; INHERITS_HTTP_AND_GRPC_PROPOSAL_SCOPES; NO_THIRD_TRANSPORT");

  const expected = [
    ["media.rules.compile-candidate.v1", "compileContract", "COMPILED"],
    ["media.rules.inspect-candidate.v1", "inspectContract", "INSPECTED"],
    ["media.rules.validate-candidate.v1", "validationContract", "VALID"],
    ["media.rules.reuse-candidate.v1", "reuseContract", "REUSE_REQUESTED"],
  ];
  assert.deepEqual(journey.steps.slice(0, 4).map((step) => step.operationRef), expected.map(([operation]) => operation));
  for (const [operationRef, contractKey, successOutcome] of expected) {
    const step = journey.steps.find((candidate) => candidate.operationRef === operationRef);
    const source = p1[contractKey];
    assert.equal(source.operationRef, operationRef);
    assert.ok(step.requestSchemaRef.endsWith(`#/${contractKey}/requestSchema`));
    assert.ok(step.resultSchemaRef.endsWith(`#/${contractKey}/resultSchema`));
    const sourceSuccess = contractKey === "compileContract" ? "COMPILED"
      : contractKey === "inspectContract" ? "INSPECTED"
        : contractKey === "validationContract" ? "VALID" : "REUSE_REQUESTED";
    assert.equal(successOutcome, sourceSuccess);
    assert.ok(source.disposition.includes("PROPOSAL_ONLY"));
    assert.ok(source.disposition.includes("NOT_ADMITTED"));
  }
  assert.equal(journey.steps[0].nonSuccess.candidateReturned, false);
  assert.equal(journey.steps[2].nonSuccess.authorizesReuse, false);
  assert.equal(journey.steps[3].success.requiredPlanDisposition, "CANDIDATE_OPERATION_PLAN_ONLY");
  assert.equal(journey.steps[3].success.requiredExecutionAdmission, "NOT_ADMITTED");
  assert.match(journey.steps[4].cases.UNKNOWN, /same tenant, principal, operation, request identity, idempotency key/u);
  assert.match(journey.steps[4].cases.STALE_or_CONFLICT, /never select latest or silently rebase/u);
  assert.ok(journey.negativeCases.length >= 5);
});
