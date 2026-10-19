import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (file) => parse(readFileSync(resolve(root, file), "utf8"));
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
