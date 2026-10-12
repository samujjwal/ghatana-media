import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
const handoff = readYaml(".product-experience/pdp-2-design-interface-system/handoff-contracts.yaml")
  .handoffs.pdp2ToPdp3DesignInterface;
const grammar = readYaml(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml")
  .boundedTranscriptionSubmissionSlice;
const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
  .find(({ id }) => id === "media.action.request-transcription");
const step = journey.steps.find(({ stepId }) => stepId === "J03-2");

test("PDP-3 reconciles the frozen J03-2 handoff references as distinct lineage and projection decisions", () => {
  const finding = handoff.deferredDownstreamFindings.find(
    ({ id }) => id === "PDP3-J03-2-DECISION-REFERENCE-CROSSWALK",
  );
  assert.ok(finding);
  assert.equal(finding.disposition, "SOURCE_CROSS_REFERENCE_RECONCILIATION_REQUIRED");

  const p2Decision = ".product-experience/decision-log.md#PXD-072";
  const p3ProjectionDecision = ".product-experience/decision-log.md#PXD-159";
  assert.equal(grammar.journeyDecisionRef, p2Decision, "frozen PDP-2 reference is preserved");
  assert.equal(step.decisionRef, p3ProjectionDecision, "PDP-3 journey projection uses its accepted decision");
  assert.equal(step.transitionDisposition.decisionRef, p3ProjectionDecision);
  assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, p2Decision,
    "the existing action-definition lineage remains on PXD-072");

  const reconciliation = decisionLog.split("### PXD-162 — Reconcile the J03-2 PDP-3 decision-reference crosswalk")[1];
  assert.ok(reconciliation, "the P3-side reconciliation decision exists");
  assert.match(reconciliation, /PDP-2's `boundedTranscriptionSubmissionSlice\.journeyDecisionRef` remains PXD-072/u);
  assert.match(reconciliation, /PDP-3's J03-2 `decisionRef` and `transitionDisposition\.decisionRef` use PXD-159/u);
  assert.match(reconciliation, /Runtime and transport remain `NOT_ADMITTED`/u);
  assert.match(reconciliation, /does not constitute PDP-3 phase acceptance/u);

  assert.equal(grammar.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
});
