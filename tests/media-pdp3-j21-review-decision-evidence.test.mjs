import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const p1 = parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const p3 = ".product-experience/pdp-3-product-experience";
const journey = parse(readFileSync(`${p3}/journey-contracts/review-exact-version-and-recheck-changes.yaml`, "utf8"));
const actionRegistry = parse(readFileSync(`${p3}/action-registry.yaml`, "utf8"));
const operations = new Map(p1.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
const typedObservations = new Map(p1.ownerTypedObservationContracts.records.map((record) => [record.id, record]));
const decisionRequest = operations.get("media.operation.action.record-version-review-decision");
const approvalQuery = operations.get("media.operation.action.review-rights-approval-and-format-effects");
const approvalObservation = typedObservations.get("media.observation-contract.rights-decision.v1");
const evidence = journey.pdp1ResultEvidence;
const purposes = parse(readFileSync(`${p3}/journey-purpose-bindings.yaml`, "utf8"));
const reviewPurpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j21-step-01.v1");
const outputPurpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j21-step-02.v1");
const decisionActionBinding = reviewPurpose?.relatedActionBindings?.find(({ id }) => id === "media.pdp3.action-binding.j21-review-decision-receipt.v1");
const rightsObservationBinding = reviewPurpose?.relatedActionBindings?.find(({ id }) => id === "media.pdp3.action-binding.j21-read-rights-observation.v1");

test("J21 keeps exact-version review request receipt separate from current approval observation", () => {
  assert.equal(journey.steps.length, 3, "J21 source step denominator remains unchanged");
  assert.deepEqual(journey.steps.map(({ canonicalOperationRef }) => canonicalOperationRef), [
    "media.operation.action.inspect-version-and-review-scope",
    "media.operation.action.inspect-output-preview-and-version",
    "media.operation-slice.inspect-provenance",
  ], "the three ordered step-operation joins remain unchanged");
  assert.equal(evidence.status, "SOURCE_BOUND_DEFINITION_ONLY; PDP3_STEP_ACTION_BINDING_AND_CHANNEL_REVIEW_PENDING");
  assert.equal(evidence.rightsApprovalActionDisposition.status, "BLOCKED_EXCLUDED");
  assert.equal(evidence.rightsApprovalActionDisposition.actionRef, null);
  assert.match(evidence.rightsApprovalActionDisposition.queryBoundary, /read-only query/u);
  assert.match(evidence.rightsApprovalActionDisposition.disposition, /do not dispatch or infer an approval action/u);
  assert.ok(evidence.rightsApprovalActionDisposition.sourceRefs.includes(".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-21/completion"));

  const request = evidence.operationResultBindings.find(({ operationRef }) => operationRef === decisionRequest.id);
  assert.ok(request, "the exact P1 review-request command is bound into the journey evidence");
  assert.equal(request.operationKind, "COMMAND");
  assert.equal(request.actionRef, decisionRequest.actionRef);
  assert.ok(actionRegistry.actions.some(({ id, journeyRefs, viewRefs }) =>
    id === request.actionRef && journeyRefs.includes("J-21") && viewRefs.includes("media.view.review-exact-version")));
  assert.deepEqual(decisionRequest.stateRefs, [], "P1 defines no version transition for the review-record command");
  assert.deepEqual(request.stateRefs, []);
  assert.equal(request.transitionRef, null);
  assert.match(request.receiptMeaning, /do not imply HUMAN_REVIEW_APPROVAL/u);
  assert.match(decisionRequest.resultSchema.finality, /does not\s+imply approval or mutate the reviewed version/u);
  assert.equal(request.runtimeAdmission, "NOT_ADMITTED");

  assert.ok(decisionActionBinding, "the separately related review-record action is joined under the existing review-purpose context");
  assert.equal(reviewPurpose.journeyRef, "J-21");
  assert.equal(reviewPurpose.ordinal, 1);
  assert.equal(decisionActionBinding.actionRef, request.actionRef);
  assert.equal(decisionActionBinding.operationRef, request.operationRef);
  assert.equal(decisionActionBinding.operationKind, request.operationKind);
  assert.equal(decisionActionBinding.intentSourceRef, `${p3}/journey-contracts/review-exact-version-and-recheck-changes.yaml#/pdp1ResultEvidence/operationResultBindings/0`);
  assert.equal(decisionActionBinding.resultSchemaRef, request.operationContractRef + "/resultSchema");
  assert.equal(decisionActionBinding.journeyStepTransition, false);
  assert.equal(decisionActionBinding.bindingKind, "RELATED_OUTCOME_EVIDENCE_NOT_STEP_TRANSITION");
  assert.match(decisionActionBinding.resultMeaning, /does not imply approval or mutate that version/u);
  assert.match(decisionActionBinding.finality, /does not imply approval/u);
  assert.match(decisionActionBinding.unknownDisposition, /UNKNOWN is not failure/u);
  assert.match(decisionActionBinding.unknownDisposition, /never issue a second write/u);
  assert.match(decisionActionBinding.recovery, /reconcile-unknown-effects-before-retry/u);
  assert.deepEqual(decisionActionBinding.actionExactOperationRefs, [decisionRequest.id]);
  assert.deepEqual(decisionRequest.stateRefs, [], "the related command appends a review record but creates no canonical state transition");

  const observation = evidence.operationResultBindings.find(({ operationRef }) => operationRef === approvalQuery.id);
  assert.ok(observation, "approval is represented by the separate P1 read operation");
  assert.equal(observation.journeyStepRef, reviewPurpose.stepRef, "the rights query stays attached to the exact-version review purpose");
  assert.equal(observation.operationKind, "QUERY");
  assert.equal(observation.observationContractRef.split("@id=").at(-1), approvalObservation.id);
  assert.ok(approvalObservation.operationRefs.includes(approvalQuery.id));
  assert.equal(approvalQuery.sourceFinality, "read-only-or-navigation; no-write-finality");
  assert.equal(approvalQuery.stateRefs.length, 0, "the approval read does not mutate P1 state");
  assert.equal(observation.decisionKind, "HUMAN_REVIEW_APPROVAL");
  assert.match(observation.exactSubject, /exact owner-confirmed registered output ArtifactVersionRef/u);
  assert.match(observation.approvedOnlyWhen, /currentness is CURRENT/u);
  assert.match(observation.approvedOnlyWhen, /nonempty authoritative evidenceRefs/u);
  assert.match(observation.unknownDisposition, /remains UNKNOWN/u);
  assert.match(observation.unknownDisposition, /no approval claim/u);
  assert.match(observation.observationEffect, /never creates or changes approval/u);
  assert.equal(observation.runtimeAdmission, "NOT_ADMITTED");

  assert.ok(rightsObservationBinding, "the read-only rights observation is related to the first exact-version review purpose");
  assert.equal(rightsObservationBinding.intentSourceRef, `${p3}/journey-contracts/review-exact-version-and-recheck-changes.yaml#/pdp1ResultEvidence/operationResultBindings/1`);
  assert.equal(rightsObservationBinding.actionRef, approvalQuery.actionRef);
  assert.equal(rightsObservationBinding.operationRef, approvalQuery.id);
  assert.equal(rightsObservationBinding.operationKind, "QUERY");
  assert.equal(rightsObservationBinding.journeyStepTransition, false);
  assert.equal(rightsObservationBinding.bindingKind, "RELATED_READ_ONLY_RIGHTS_OBSERVATION_NOT_STEP_TRANSITION");
  assert.equal(rightsObservationBinding.observationContractRef.split("@id=").at(-1), approvalObservation.id);
  assert.deepEqual(rightsObservationBinding.stateRefs, []);
  assert.equal(rightsObservationBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(rightsObservationBinding.acceptanceEffect, "none");
  assert.match(rightsObservationBinding.observationEffect, /never creates or changes approval/u);

  assert.equal(outputPurpose.journeyRef, "J-21");
  assert.equal(outputPurpose.ordinal, 2);
  const approvalAction = actionRegistry.actions.find(({ id }) => id === approvalQuery.actionRef);
  assert.ok(approvalAction);
  assert.equal(approvalAction.journeyRefs.includes("J-21"), true);
  assert.equal(approvalAction.viewRefs.includes("media.view.review-exact-version"), true);
  assert.equal(approvalAction.actionDefinitionSemantics.typedDefinition.canonicalOperationBindings.operationRef, approvalQuery.id);
  assert.equal(approvalAction.actionDefinitionSemantics.typedDefinition.canonicalOperationBindings.operationKind, "QUERY");
  assert.deepEqual(approvalQuery.stateRefs, [], "the separate approval query remains read-only and adds no step transition");

  assert.match(evidence.completionCondition.meaning, /request receipt alone is insufficient/u);
  assert.match(evidence.completionCondition.meaning, /pending or UNKNOWN/u);
  assert.match(journey.terminalSuccess, /Conditional on the exact review-record receipt/u);
  assert.match(journey.terminalSuccess, /request receipt alone is not approval/u);
  assert.match(journey.terminalSuccess, /no owner approval, runtime result, or delivery is asserted/u);
});
