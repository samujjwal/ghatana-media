import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (file) => parse(readFileSync(resolve(root, file), "utf8"));
const readReference = (reference) => {
  const [file, pointer] = reference.split("#");
  let value = readYaml(file);
  for (const segment of (pointer ?? "").split("/").filter(Boolean)) {
    const selector = /^@(id|stepId|audit_id)=(.+)$/u.exec(segment);
    if (selector) {
      assert.ok(Array.isArray(value), `${reference}: ${segment} selects an array`);
      value = value.find((entry) => entry[selector[1]] === selector[2]);
    } else {
      value = value?.[segment];
    }
    assert.notEqual(value, undefined, `${reference}: resolves through ${segment}`);
  }
  return value;
};
const handoff = readYaml(".product-experience/pdp-2-design-interface-system/handoff-contracts.yaml").handoffs.pdp2ToPdp3DesignInterface;

test("PDP-2 exports a finite design/interface definition handoff for PDP-3", () => {
  assert.equal(handoff.id, "media.pdp2-pdp3.design-interface-handoff.v1");
  assert.equal(handoff.sourcePhase, "PDP-2");
  assert.equal(handoff.consumerPhase, "PDP-3");
  assert.equal(handoff.status, "DEFINITION_HANDOFF_CONTRACT");
  assert.match(handoff.authorityBoundary, /does not claim Shared package release or owner acceptance.*production deployment/u);
  assert.deepEqual(handoff.sourcePopulations, {
    componentFamilies: { count: 31, source: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml#components" },
    componentValueTypes: { count: 122, source: ".product-experience/pdp-2-design-interface-system/component-value-types.yaml#normativeTypeRecords" },
    semanticTokenAliases: { count: 9, source: ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml#aliases" },
    sharedPublicCssVariables: { count: 24, source: ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml#cssVariableBindings/bindings" },
    mediaCssProjections: { count: 20, source: ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml#cssVariableBindings/bindings" },
    templates: { count: 13, source: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml#templates" },
    layouts: { count: 11, source: ".product-experience/pdp-2-design-interface-system/gui/layout.yaml#layouts" },
    recipes: { count: 13, source: ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml#recipes" },
    compositionRules: { count: 43, source: ".product-experience/pdp-2-design-interface-system/gui/composition-validation-grammar.yaml#normativeRuleRecords" },
    interactionPatterns: { count: 19, source: ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml#patterns" },
    machineInterfaceInvariants: { count: 12, source: ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml#invariants" },
    selectedScreenDesignLinks: { count: 47, source: ".product-experience/pdp-3-product-experience/screen-contracts" },
  });
  assert.ok(handoff.consumerObligations.length >= 6);
  assert.ok(handoff.negativeCases.length >= 6);
  assert.equal(new Set(handoff.negativeCases).size, handoff.negativeCases.length);
  assert.ok(handoff.deferredEvidence.length >= 3);
  assert.match(handoff.scopeStatus, /development-gate-status-is-recorded-separately/u);
  assert.equal(handoff.developmentStatusRef, "docs/implementation/pdp-2-phase-dev-status.json");
  for (const source of handoff.sourceRefs) assert.ok(existsSync(resolve(root, source.split("#", 1)[0])), source);
  for (const source of [
    ".product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml",
    ".product-experience/pdp-2-design-interface-system/api/read-consumer-adapters.yaml",
    ".product-experience/pdp-2-design-interface-system/cli-language.yaml",
    ".product-experience/pdp-2-design-interface-system/cli/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/sdk/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/events/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml",
  ]) assert.ok(handoff.sourceRefs.includes(source), `PDP-3 handoff must pin concrete machine-interface definition ${source}`);
});

test("PDP-2 handoff consumes only the frozen PDP-1 canonical domain contract", () => {
  const p1 = readYaml(".product-experience/pdp-1-domain-data/handoff-contracts.yaml").handoffs.pdp1ToPdp2CanonicalDomain;
  assert.equal(p1.id, "media.pdp1-pdp2.canonical-domain-handoff.v1");
  assert.equal(p1.status, "DEFINITION_HANDOFF_CONTRACT");
  assert.ok(handoff.sourceRefs.includes(".product-experience/pdp-1-domain-data/handoff-contracts.yaml#/handoffs/pdp1ToPdp2CanonicalDomain"));
  assert.match(handoff.requiredMeaning.stateAndFinality, /unknown is never a blind retry/u);
  assert.match(handoff.requiredMeaning.interfaceMeaning, /do not gain invented routes or guarantees/u);
});

test("PDP-2 records the J03-2 decision-reference crosswalk for PDP-3 reconciliation", () => {
  const finding = handoff.deferredDownstreamFindings.find(
    ({ id }) => id === "PDP3-J03-2-DECISION-REFERENCE-CROSSWALK",
  );
  assert.ok(finding);
  assert.equal(finding.ownerPhase, "PDP-3");
  assert.equal(finding.disposition, "SOURCE_CROSS_REFERENCE_RECONCILIATION_REQUIRED");
  assert.deepEqual(finding.observedReferences, {
    pdp2GrammarJourneyDecisionRef: ".product-experience/decision-log.md#PXD-072",
    pdp3JourneyStepDecisionRef: ".product-experience/decision-log.md#PXD-159",
    pdp3ActionRegistryReviewDecisionRef: ".product-experience/decision-log.md#PXD-072",
  });
  assert.match(finding.reviewQuestion, /intentionally name distinct decisions or whether an exact PDP-3 projection update is needed/u);
  assert.match(finding.reviewQuestion, /not a proven defect or runtime-admission finding/u);
  assert.deepEqual(finding.sourceRefs, [
    ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml#boundedTranscriptionSubmissionSlice/journeyDecisionRef",
    ".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml#steps/@stepId=J03-2/decisionRef",
    ".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.request-transcription/actionDefinitionSemantics/reviewDecisionRef",
  ]);
  const p2Grammar = readYaml(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml").boundedTranscriptionSubmissionSlice;
  const p3Journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
  const p3Action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === "media.action.request-transcription");
  assert.equal(p2Grammar.journeyDecisionRef, finding.observedReferences.pdp2GrammarJourneyDecisionRef);
  assert.equal(p3Journey.steps.find(({ stepId }) => stepId === "J03-2").decisionRef,
    finding.observedReferences.pdp3JourneyStepDecisionRef);
  assert.equal(p3Action.actionDefinitionSemantics.reviewDecisionRef,
    finding.observedReferences.pdp3ActionRegistryReviewDecisionRef);
});

test("PDP-2 binds the proposal-only rule-management interface, presentation, and accessible outcomes", () => {
  const p2 = readYaml(".product-experience/pdp-2-design-interface-system/interface-grammar.yaml");
  const binding = p2.ruleManagementProposalInterfaceBinding;
  const p1 = readYaml(".product-experience/pdp-1-domain-data/rule-management-contracts.yaml");
  assert.equal(binding.id, "media.pdp2.interface.rule-management-proposal-binding.v1");
  assert.equal(binding.featureRef, "media.rules.manage");
  assert.equal(binding.disposition, "PROPOSAL_ONLY; PENDING_OWNER_REVIEW; NOT_IN_CANONICAL_OPERATION_DENOMINATOR");
  assert.equal(binding.ownerApproval, "NOT_CLAIMED");
  assert.equal(binding.independentAcceptance, "NOT_CLAIMED");
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(binding.executionAdmission, "NOT_ADMITTED");
  assert.equal(readReference(binding.sourceHandoff).id, "media.rules.manage.pdp1-definition-handoff.v1");
  assert.equal(readReference(binding.sourceChannelProposal).length, 11);
  assert.deepEqual(binding.operationRefs, [
    "media.rules.compile-candidate.v1",
    "media.rules.inspect-candidate.v1",
    "media.rules.validate-candidate.v1",
    "media.rules.reuse-candidate.v1",
  ]);
  for (const [key, ref] of Object.entries(binding.typedBindings)) {
    assert.ok(existsSync(resolve(root, ref.split("#", 1)[0])), `${key} source exists`);
    assert.notEqual(readReference(ref), undefined, `${key} is an exact schema or identity pointer`);
  }
  assert.deepEqual(binding.typedBindings, {
    versionedCandidate: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/ruleSetVersion/candidate/schema",
    normalizedSemanticGraph: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/normalizedSemanticGraph/schema",
    semanticFingerprint: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/semanticFingerprint/schema",
    compileRequest: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/compileContract/requestSchema",
    compileResult: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/compileContract/resultSchema",
    inspectRequest: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/inspectContract/requestSchema",
    inspectResult: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/inspectContract/resultSchema",
    validationRequest: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/validationContract/requestSchema",
    validationResult: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/validationContract/resultSchema",
    validationReceiptIdentity: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/validationContract/validationResultIdentity",
    reuseRequest: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/reuseContract/requestSchema",
    reuseResult: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/reuseContract/resultSchema",
    candidateOperationPlan: ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/reuseContract/operationPlanSchema",
  });
  assert.equal(binding.typedBindings.versionedCandidate,
    ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/ruleSetVersion/candidate/schema");
  assert.equal(binding.typedBindings.validationReceiptIdentity,
    ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml#/validationContract/validationResultIdentity");
  assert.deepEqual(binding.operationRefs, [
    p1.compileContract.operationRef,
    p1.inspectContract.operationRef,
    p1.validationContract.operationRef,
    p1.reuseContract.operationRef,
  ]);
  assert.equal(binding.channelProposalMappings.mappings.length, 11);
  assert.equal(new Set(binding.channelProposalMappings.mappings.map(({ id }) => id)).size, 11);
  assert.ok(binding.channelProposalMappings.mappings.every(({ sourceRef }) => {
    assert.ok(sourceRef.includes("AUD-SPEC-020-CHANNEL-"));
    return readReference(sourceRef) !== undefined;
  }));
  assert.match(binding.channelProposalMappings.authority, /no owner applicability decision or implementation claim/u);
  assert.ok(binding.preservedBindings.optimisticConcurrency.includes("expectedVersionRef"));
  assert.ok(binding.preservedBindings.optimisticConcurrency.includes("fingerprint"));
  assert.ok(binding.preservedBindings.semantics.some(value => /no partial effects/u.test(value)));
  assert.ok(binding.controlSemantics.forbiddenImplications.includes("channel-mapping-implies-applicability"));

  const presentation = readYaml(".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml")
    .ruleManagementProposalPresentation;
  assert.equal(presentation.semantics.presentationOnly, true);
  assert.equal(presentation.semantics.createsPersistentLifecycleState, false);
  assert.deepEqual(presentation.operationOutcomes.map(({ operationRef }) => operationRef), binding.operationRefs);
  assert.deepEqual(presentation.operationOutcomes.map(({ outcomes }) => outcomes), [
    ["COMPILED", "REJECTED", "UNSUPPORTED", "DENIED", "CONFLICT", "STALE", "UNKNOWN", "UNAVAILABLE"],
    ["INSPECTED", "DENIED", "CONFLICT", "STALE", "UNKNOWN", "UNAVAILABLE"],
    ["VALID", "INVALID", "UNSUPPORTED", "UNAVAILABLE", "DENIED", "CONFLICT", "STALE", "UNKNOWN"],
    ["REUSE_REQUESTED", "DENIED", "CONFLICT", "UNKNOWN", "UNAVAILABLE", "STALE", "INVALID", "UNSUPPORTED"],
  ]);
  assert.equal(presentation.nonClaims.ownerApproval, "NOT_CLAIMED");
  assert.equal(presentation.nonClaims.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(presentation.negativeCases.some(value => /latest version/u.test(value)));
  for (const source of presentation.sourceRefs) assert.notEqual(readReference(source), undefined, source);

  const accessibility = readYaml(".product-experience/pdp-2-design-interface-system/accessibility.yaml")
    .ownerDefinedRuleManagementProposalControls;
  assert.equal(accessibility.id, "media.a11y.rule-management-proposal-controls.v1");
  assert.equal(accessibility.evidenceBoundary.status, "DEFINITION_ONLY_NOT_MEASURED");
  assert.ok(accessibility.interactionRequirements.some(value => /keyboard-operable, non-drag equivalent/u.test(value)));
  assert.ok(accessibility.requiredBindings.some(value => /exact immutable rule-set version/u.test(value)));
  assert.equal(accessibility.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(accessibility.executionAdmission, "NOT_ADMITTED");
  for (const source of accessibility.sourceRefs) assert.notEqual(readReference(source), undefined, source);

  const proposalHandoff = handoff.proposalFeatureHandoffs.find(({ featureRef }) => featureRef === "media.rules.manage");
  assert.ok(proposalHandoff);
  assert.equal(proposalHandoff.sourcePhase, "PDP-2");
  assert.equal(proposalHandoff.consumerPhase, "PDP-3");
  assert.equal(proposalHandoff.ownerApproval, "NOT_CLAIMED");
  assert.equal(proposalHandoff.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(proposalHandoff.consumerObligations.some(value => /complete author, inspect, validate, reuse, and recovery journeys/u.test(value)));
  assert.equal(proposalHandoff.typedMeaningRefs.compileRequest, binding.typedBindings.compileRequest);
  assert.equal(proposalHandoff.typedMeaningRefs.compileResult, binding.typedBindings.compileResult);
  assert.equal(proposalHandoff.typedMeaningRefs.inspectRequest, binding.typedBindings.inspectRequest);
  assert.equal(proposalHandoff.typedMeaningRefs.inspectResult, binding.typedBindings.inspectResult);
  assert.equal(proposalHandoff.typedMeaningRefs.validationRequest, binding.typedBindings.validationRequest);
  assert.equal(proposalHandoff.typedMeaningRefs.validationResult, binding.typedBindings.validationResult);
  assert.equal(proposalHandoff.typedMeaningRefs.reuseRequest, binding.typedBindings.reuseRequest);
  assert.equal(proposalHandoff.typedMeaningRefs.reuseResult, binding.typedBindings.reuseResult);
  for (const source of proposalHandoff.sourceRefs) assert.ok(existsSync(resolve(root, source.split("#", 1)[0])), source);
});
