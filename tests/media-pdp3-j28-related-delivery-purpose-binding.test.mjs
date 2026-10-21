import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(path, "utf8"));
const p0 = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
const p1 = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const journey = readYaml(`${p3}/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml`);
const purposes = readYaml(`${p3}/journey-purpose-bindings.yaml`);
const versionBindings = readYaml(`${p3}/step-version-binding-contracts.yaml`);
const channels = readYaml(`${p3}/journey-channel-contract-bindings.yaml`);

test("J28 purpose-binds a conditional exact-version delivery request without claiming destination receipt", () => {
  const p0Journey = p0.journeys.find(({ id }) => id === "J-28");
  const purpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j28-step-04.v1");
  const related = purpose?.relatedActionBindings?.find(({ id }) => id === "media.pdp3.action-binding.j28-deliver-exact-version.v1");
  const operation = p1.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.deliver-exact-version");
  const acknowledgment = p1.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.destination-delivery-acknowledgment.v1");

  assert.ok(p0Journey && purpose && related && operation && acknowledgment);
  assert.match(p0Journey.completion, /Consumer receives an identified package and conversion report/u);
  assert.equal(purpose.ordinal, 4);
  assert.equal(purpose.purposeClass, "LOCAL_SESSION_EFFECT", "destination choice remains the local draft effect");
  assert.equal(purpose.actionRef, "media.action.choose-named-destination");
  assert.equal(purpose.operationRefs.length, 0);
  assert.equal(related.journeyStepTransition, false);
  assert.equal(related.actionRef, "media.action.deliver-exact-version");
  assert.equal(related.operationRef, operation.id);
  assert.equal(related.operationKind, "COMMAND");
  assert.equal(related.requestSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operation.id}/requestSchema`);
  assert.equal(related.resultSchemaRef, `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operation.id}/resultSchema`);
  assert.equal(related.observationContractRef, `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${acknowledgment.id}`);
  assert.ok(operation.requestSchema.required.includes("artifactVersionId"));
  assert.ok(operation.requestSchema.required.includes("destinationRef"));
  assert.ok(operation.requestSchema.required.includes("deliveryProfileRef"));
  assert.match(related.targetBinding.exactArtifactVersion, /immutable output version/u);
  assert.match(related.targetBinding.destination, /exact declared J-28 consumer destination/u);
  assert.match(related.finality, /request receipt is not destination delivery/u);
  assert.match(related.finality, /only the exact current typed destination acknowledgment/u);
  assert.match(related.unknownDisposition, /pending\/UNKNOWN/u);
  assert.equal(related.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(related.transport, "UNBOUND");
  assert.equal(related.externalAcceptance, "PENDING");
  assert.equal(purposes.recordCount, 130);
  assert.equal(journey.steps.length, 4);
});

test("J28 contract reconciles the related delivery action and preserves its exact source boundaries", () => {
  const purpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j28-step-04.v1");
  const related = purpose.relatedActionBindings.find(({ id }) => id === "media.pdp3.action-binding.j28-deliver-exact-version.v1");
  const stepVersion = versionBindings.records.find(({ id }) => id === "media.step-version-binding.j-28-04.v1");
  const workflow = p1.ownerDefinedWorkflowContracts.records.find(({ id }) => id === "media.workflow-contract.spatial-export-boundary.v1");
  const acknowledgment = p1.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.destination-delivery-acknowledgment.v1");
  const journeyBindings = journey.pdp1ResultEvidence.journeySourceBindings;
  const delivery = journeyBindings.spatialExport.deliveryReceiptBinding;
  const expected = journeyBindings.spatialExport.expectedSpatialExportResult;
  const productionGap = journeyBindings.spatialExport.productionResultJoinGap;

  assert.match(delivery.status, /J28_RELATED_DELIVERY_REQUEST_BOUND; TYPED_ACKNOWLEDGMENT_SOURCE_BOUND/u);
  assert.equal(delivery.relatedActionBindingRef,
    `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=${purpose.id}/relatedActionBindings/@id=${related.id}`);
  assert.match(delivery.purposeBindingBoundary, /primary action with EXPLICIT_NO_DOMAIN_DISPATCH/u);
  assert.match(delivery.purposeBindingBoundary, /journeyStepTransition is false/u);
  assert.match(delivery.conditionalReceiptJoin, /REQUEST_ACCEPTED is only a request receipt/u);
  assert.match(delivery.conditionalReceiptJoin, /owner acknowledgment authority and evidence/u);
  assert.match(delivery.pendingDisposition, /runtime remains NOT_ADMITTED and transport remains UNBOUND/u);
  assert.match(delivery.pendingDisposition, /conversion-report receipt/u);

  assert.equal(expected.outputContractRef,
    `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedWorkflowContracts/records/@id=${workflow.id}/output`);
  assert.equal(expected.meaning, workflow.output.success);
  assert.deepEqual(expected.requiredReportFields, workflow.output.requiredReportFields);
  assert.deepEqual(expected.fieldDispositionRecords, workflow.output.fieldDispositionRecords);
  assert.match(expected.resultBoundary, /not a produced result/u);
  assert.equal(productionGap.status, "P1_PREDECESSOR_SOURCE_GAP; UNKNOWN_NOT_ADMITTED");
  assert.match(productionGap.missingJoin, /No reviewed source contract joins the exact J28 render job\/request/u);
  assert.match(journey.sourceGap.missingJourneyEvidence, /do not establish job-to-output production/u);

  // The step-version binding schema only covers the canonical operations and objects of
  // the step transition. J28's related delivery is explicitly not that transition.
  assert.equal(stepVersion.actionRef, "media.action.choose-named-destination");
  assert.deepEqual(stepVersion.operationBindings, []);
  assert.deepEqual(stepVersion.objectBindings, journey.steps[3].objectRefs);
  assert.equal(related.journeyStepTransition, false);

  const channelEdges = [
    "media.pdp3.channel-binding.j28.web.v1",
    "media.pdp3.channel-binding.j28.product-integration.v1",
  ].map((id) => channels.edges.find((edge) => edge.id === id));
  assert.equal(channelEdges.length, 2);
  for (const edge of channelEdges) {
    const operationRefs = edge.p1OperationBindings.map(({ operationRef }) => operationRef);
    assert.ok(operationRefs.includes("media.operation.action.deliver-exact-version"));
    assert.ok(operationRefs.includes("media.operation.action.reconcile-delivery-acknowledgment"));
    assert.deepEqual(new Set(edge.p1OperationStateProofs.map(({ operationRef }) => operationRef)), new Set(operationRefs));
    assert.ok(edge.p1OperationBindings.filter(({ operationRef }) => operationRef !== "media.operation.action.submit-render")
      .every(({ disposition, transportRef }) => disposition === "UNBOUND" && transportRef === "UNBOUND"));
    assert.equal(edge.channelTransportEquivalence, "UNBOUND");
    assert.equal(edge.exactTransportMappingCount, 0);
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(edge.semanticCompleteness, "SOURCE_BOUND_DEFINITION_ONLY");
    assert.ok(edge.p1ObservationRefs.includes(delivery.acknowledgmentObservationRef));
    assert.deepEqual(edge.unresolvedOperationRefs,
      edge.p1OperationBindings.filter(({ disposition }) => disposition === "UNBOUND").map(({ operationRef }) => operationRef));
    assert.deepEqual(edge.logicalDefinitionBlockers, []);
    assert.equal(edge.deferredDependencies[0].dependencyType, "P1_OWNER_CONTRACT");
    assert.equal(edge.deferredDependencies[0].disposition, "UNBOUND_PENDING_P1_OWNER_CONTRACT");
    assert.equal(edge.deferredDependencies[0].blocksPdp3Definition, false);
    assert.equal(edge.deferredDependencies[0].blocksJourneySuccess, true);
  }
  assert.ok(acknowledgment.operationRefs.includes("media.operation.action.reconcile-delivery-acknowledgment"));
  assert.equal(purposes.recordCount, 130);
  assert.equal(versionBindings.recordCount, 130);
  assert.equal(journey.steps.length, 4);
});
