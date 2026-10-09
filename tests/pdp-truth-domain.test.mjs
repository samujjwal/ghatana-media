import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const paths = {
  objectRegistry: ".product-experience/pdp-1-domain-data/domain-objects.yaml",
  states: ".product-experience/pdp-1-domain-data/states.yaml",
  transitions: ".product-experience/pdp-1-domain-data/transitions.yaml",
  operations: ".product-experience/pdp-1-domain-data/operations.yaml",
  sourceStates: ".product-experience/pdp-0-product-truth/state-models.yaml",
  sourceActions: ".product-experience/pdp-3-product-experience/action-registry.yaml",
  capabilityReview: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
};

function validateIdentityPopulation(registry) {
  const identities = registry.canonicalIdentityAdjudication.registeredObjectIdentityRefs;
  const objectIds = new Set(registry.objects.map(({ id }) => id));
  const identityIds = identities.map(({ objectId }) => objectId);
  return identityIds.length === 38
    && new Set(identityIds).size === identityIds.length
    && identityIds.every((id) => objectIds.has(id))
    && identities.every((entry) => ["MEDIA_PRODUCT_IDENTITY_DEFINED", "SOURCE_OBSERVATION_WITH_EXPLICIT_NON_EQUIVALENCE"].includes(entry.disposition))
    && identities.filter(({ disposition }) => disposition === "MEDIA_PRODUCT_IDENTITY_DEFINED").length === 33
    && identities.filter(({ disposition }) => disposition === "SOURCE_OBSERVATION_WITH_EXPLICIT_NON_EQUIVALENCE").length === 5
    && identities.filter(({ disposition }) => disposition === "MEDIA_PRODUCT_IDENTITY_DEFINED").every(({ ownerSelectedIdentity }) => typeof ownerSelectedIdentity === "string" && ownerSelectedIdentity.length > 0)
    && registry.canonicalIdentityAdjudication.excludedHistoricalRecords.some(({ objectId, disposition }) => objectId === "media.domain.transcription" && disposition === "LEGACY_STORAGE_AND_PROVIDER_OBSERVATION_NOT_CANONICAL_TRANSCRIPT_VERSION");
}

function stateIdsByDimension(states, machineId) {
  const machine = states.stateMachines.find((entry) => entry.machineId === machineId);
  if (!machine) return new Set();
  if (machine.machineId === "media-rights-and-consent") {
    return new Map([
      ["rightsAssertion", new Set(machine.stateDefinitionsByDimension.rightsAssertion.map(({ id }) => id))],
      ["consent", new Set(machine.stateDefinitionsByDimension.consent.map(({ id }) => id))],
    ]);
  }
  return new Set(machine.stateDefinitions.map(({ id }) => id));
}

function transitionIsDefined(transitions, machineId, dimension, from, to) {
  return [...transitions.transitionRecords, ...(transitions.ownerDefinedTransitionRecords ?? [])].some((entry) => entry.sourceMachineId === machineId
    && (entry.stateDimension ?? null) === (dimension ?? null)
    && entry.from.includes(from)
    && entry.to.includes(to));
}

function validateActionInventory(inventory, sourceActions, knownOperationIds) {
  if (inventory.length !== sourceActions.length) return false;
  const sourceById = new Map(sourceActions.map((entry) => [entry.id, entry]));
  const ids = inventory.map(({ actionId }) => actionId);
  return new Set(ids).size === ids.length
    && ids.every((id) => sourceById.has(id))
    && inventory.every((entry) => {
      const source = sourceById.get(entry.actionId);
      return entry.sourceEvidence.effect === source.effect
        && entry.sourceEvidence.finality === source.finality
        && entry.exactOperationRefs.every((id) => knownOperationIds.has(id));
    });
}

test("PDP-1 adjudicates exactly 38 product identities and retains legacy transcription as noncanonical evidence", () => {
  const registry = readYaml(paths.objectRegistry);
  assert.equal(validateIdentityPopulation(registry), true);
  const relationRecords = registry.canonicalRelationshipAdjudication.records;
  assert.equal(relationRecords.length, 38);
  assert.equal(new Set(relationRecords.map(({ objectRef }) => objectRef)).size, 38);
  const objectRefs = new Set(registry.objects.map(({ id }) => id));
  for (const record of relationRecords) {
    assert.ok(objectRefs.has(record.objectRef));
    for (const edge of record.relationships) {
      if (edge.targetObjectRef) {
        assert.ok(objectRefs.has(edge.targetObjectRef), `${record.objectRef} has an unknown relationship target`);
        assert.equal(edge.tenantInvariant, "source-and-target-tenant-ids-must-match");
      }
    }
  }
  const invalidRelation = structuredClone(registry);
  invalidRelation.canonicalRelationshipAdjudication.records[0].relationships.push({
    name: "broken", targetObjectRef: "media.domain.missing", cardinality: "one-to-one",
  });
  assert.equal(invalidRelation.canonicalRelationshipAdjudication.records[0].relationships
    .filter(({ targetObjectRef }) => targetObjectRef && !objectRefs.has(targetObjectRef)).length, 1,
  "unknown relationship targets fail closed");
  const broken = structuredClone(registry);
  broken.canonicalIdentityAdjudication.registeredObjectIdentityRefs.pop();
  assert.equal(validateIdentityPopulation(broken), false, "a dropped identity must fail the exact denominator check");
  const duplicate = structuredClone(registry);
  duplicate.canonicalIdentityAdjudication.registeredObjectIdentityRefs[1].objectId = duplicate.canonicalIdentityAdjudication.registeredObjectIdentityRefs[0].objectId;
  assert.equal(validateIdentityPopulation(duplicate), false, "duplicate identities must fail instead of masking an omitted object");
});

test("PDP-1 state meanings and transitions preserve all source dimensions, guards, and endpoints", () => {
  const states = readYaml(paths.states);
  const transitions = readYaml(paths.transitions);
  const source = readYaml(paths.sourceStates);
  assert.equal(states.stateMachines.length, 11);
  assert.equal(states.inventory.extractedStateRecords, 75, "source extraction denominator remains historical metadata");
  const ownerDefinedStateCount = states.stateMachines.reduce((count, machine) => count
    + (machine.stateDefinitions?.length ?? 0)
    + (machine.stateDefinitionsByDimension?.rightsAssertion?.length ?? 0)
    + (machine.stateDefinitionsByDimension?.consent?.length ?? 0), 0);
  assert.equal(ownerDefinedStateCount, 87, "owner semantics add rights and consent axes without changing source extraction counts");
  assert.equal(transitions.transitionRecords.length, 49, "source transition extraction population remains preserved");
  assert.equal(transitions.ownerDefinedTransitionRecords.length, 6, "rights and consent transitions are separately enumerated owner definitions");

  for (const sourceMachine of source.models) {
    const machine = states.stateMachines.find(({ machineId }) => machineId === sourceMachine.modelId);
    assert.ok(machine, `missing machine ${sourceMachine.modelId}`);
    if (sourceMachine.modelId === "media-rights-and-consent") {
      assert.deepEqual(machine.stateDefinitionsByDimension.rightsAssertion.map(({ id }) => id), sourceMachine.rightsAssertionStates);
      assert.deepEqual(machine.stateDefinitionsByDimension.consent.map(({ id }) => id), sourceMachine.consentStates);
      assert.equal(new Set(machine.stateDefinitionsByDimension.rightsAssertion.map(({ id }) => id)).has("ACTIVE"), false);
      assert.equal(new Set(machine.stateDefinitionsByDimension.consent.map(({ id }) => id)).has("ACTIVE"), true);
    } else {
      const sourceIds = (sourceMachine.states ?? []).map((state) => typeof state === "string" ? state : state.id);
      assert.deepEqual(machine.stateDefinitions.map(({ id }) => id), sourceIds, `${sourceMachine.modelId} source state identities must be retained in order`);
      assert.ok(machine.stateDefinitions.every(({ meaning }) => typeof meaning === "string" && meaning.length > 0), `${sourceMachine.modelId} has an untyped or unexplained state`);
    }
  }

  const sourceMachineById = new Map(source.models.map((machine) => [machine.modelId, machine]));
  const transitionIds = transitions.transitionRecords.map(({ id }) => id);
  assert.equal(new Set(transitionIds).size, transitionIds.length);
  for (const record of transitions.transitionRecords) {
    const sourceMachine = sourceMachineById.get(record.sourceMachineId);
    assert.ok(sourceMachine, `${record.id} references an unknown source machine`);
    assert.ok(record.ownerGuardDefinition, `${record.id} must carry the source guard alongside the historical extraction fields`);
    const dimension = record.stateDimension;
    let allowed;
    if (record.sourceMachineId === "media-rights-and-consent") {
      const field = dimension === "rightsAssertion" ? "rightsTransitions" : dimension === "consent" ? "consentTransitions" : null;
      assert.ok(field, `${record.id} must name the rights or consent dimension`);
      allowed = sourceMachine[field][record.sourceTransitionIndex - 1];
    } else {
      allowed = sourceMachine.transitions[record.sourceTransitionIndex - 1];
    }
    assert.deepEqual(record.from, allowed.from, `${record.id} source from-states drifted`);
    assert.deepEqual(record.to, allowed.to, `${record.id} source to-states drifted`);
    assert.equal(record.ownerGuardDefinition, allowed.guard, `${record.id} guard drifted`);
    const available = stateIdsByDimension(states, record.sourceMachineId);
    const dimensionIds = available instanceof Map ? available.get(dimension) : available;
    assert.ok(record.from.every((id) => dimensionIds.has(id)), `${record.id} has a cross-machine or cross-dimension source`);
    assert.ok(record.to.every((id) => dimensionIds.has(id)), `${record.id} has a cross-machine or cross-dimension destination`);
  }

  assert.equal(transitionIsDefined(transitions, "media-job", null, "OUTCOME_UNKNOWN", "RECONCILING"), true);
  assert.equal(transitionIsDefined(transitions, "media-job", null, "OUTCOME_UNKNOWN", "COMPLETED"), false, "unknown job outcomes cannot bypass reconciliation");
  assert.equal(transitionIsDefined(transitions, "media-attempt", null, "RUNNING", "CANCELLED"), false, "attempt state cannot be normalized into a job terminal state");
  assert.equal(transitionIsDefined(transitions, "media-rights-and-consent", "rightsAssertion", "ASSERTED", "VERIFIED_FOR_DECLARED_SCOPE"), false, "rights assertions require the review stage");
  assert.equal(transitionIsDefined(transitions, "media-rights-and-consent", "consent", "PENDING_VERIFICATION", "ACTIVE"), true);
});

test("all 146 action identities have a source-backed operation or non-operation disposition", () => {
  const operations = readYaml(paths.operations);
  const sourceActions = readYaml(paths.sourceActions).actions;
  const inventory = operations.actionOperationDispositionInventory.records;
  const known = new Set([
    ...operations.operations.map(({ id }) => id),
    ...operations.individualOperationContracts.records.map(({ id }) => id),
    ...operations.ownerDefinedOperationContracts.records.map(({ id }) => id),
  ]);
  assert.equal(validateActionInventory(inventory, sourceActions, known), true);
  const broken = inventory.slice(1);
  assert.equal(validateActionInventory(broken, sourceActions, known), false, "an omitted source action must fail total population validation");

  const byAction = new Map(inventory.map((entry) => [entry.actionId, entry]));
  for (const [actionId, operationId] of [
    ["media.action.attach-source-asset", "media.operation-slice.attach-source-asset"],
    ["media.action.request-cancellation", "media.operation-slice.cancel-job"],
    ["media.action.retry-job", "media.operation-slice.retry-job"],
    ["media.action.inspect-source", "media.operation-slice.inspect-artifact-version"],
    ["media.action.inspect-provenance", "media.operation-slice.inspect-provenance"],
  ]) {
    assert.match(byAction.get(actionId).domainOperationDisposition, /OWNER_DEFINED_EXACT_OPERATION_REFERENCE/u);
    assert.deepEqual(byAction.get(actionId).exactOperationRefs, [operationId]);
  }
  assert.equal(byAction.get("media.action.check-job-outcome").domainOperationDisposition, "OWNER_DEFINED_EXACT_OPERATION_REFERENCE");
  const newActionContracts = operations.ownerDefinedOperationContracts.records.filter(({ id, actionRef }) => id.startsWith("media.operation.action.") && actionRef);
  assert.equal(newActionContracts.length, 78, "the source-backed action contracts remain separate from definition-only observation queries");
  const retryPolicyQuery = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.inspect-job-retry-policy");
  assert.ok(retryPolicyQuery, "retry policy has an exact owner-defined current-read query identity");
  assert.equal(retryPolicyQuery.operationKind, "QUERY");
  assert.equal(retryPolicyQuery.actionRef, undefined, "a supporting policy observation is not mislabeled as a separate user action");
  assert.equal(retryPolicyQuery.readContractRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.retry-policy-current-read.v1");
  assert.equal(retryPolicyQuery.executionAdmission, "NOT_ADMITTED");
  assert.equal(retryPolicyQuery.qualificationState, "NOT_EVALUATED");
  const profileIds = new Set(operations.ownerDefinedOperationProfiles.profiles.map(({ id }) => id));
  for (const contract of newActionContracts) {
    assert.ok(profileIds.has(contract.profileRef), `${contract.id} has no typed operation profile`);
    const sourceAction = sourceActions.find(({ id }) => id === contract.actionRef);
    assert.ok(sourceAction, `${contract.id} is not bound to a source action`);
    assert.equal(contract.sourceEffect, sourceAction.effect);
    assert.equal(contract.sourceFinality, sourceAction.finality);
    assert.ok(contract.domainObjectRefs.length > 0, `${contract.id} has no typed target object set`);
    assert.ok(contract.authorityRefs.length > 0, `${contract.id} has no authority boundary`);
  }
  const badActionContract = structuredClone(newActionContracts[0]);
  badActionContract.actionRef = "media.action.not-registered";
  assert.equal(sourceActions.some(({ id }) => id === badActionContract.actionRef), false,
    "an operation cannot bind an unregistered action identity");
  assert.equal(byAction.get("media.action.resolve-caption-conflict").domainOperationDisposition, "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.match(byAction.get("media.action.select-identity-confirmed-workspace").domainOperationDisposition, /EXTERNAL_SHARED_IDENTITY_HANDOFF/u);

  const attach = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.attach-source-asset");
  assert.deepEqual(attach.requestSchema.required, ["projectId", "expectedHeadRevisionId", "artifactId", "artifactVersionId", "requestId"]);
  assert.ok(attach.preconditions.includes("artifact state is AVAILABLE for the requested source use under current rights, consent, retention, and policy evidence"));
  assert.ok(attach.negativeCases.includes("stale-project-head"));
  assert.match(attach.scopeStatus, /runtime-NOT_ADMITTED/u);

  const inspect = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-artifact-version");
  assert.deepEqual(inspect.requestSchema.required, ["artifactId", "artifactVersionId"]);
  assert.ok(inspect.negativeCases.includes("substitute latest version for exact requested version"));
  assert.match(inspect.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);
  const provenance = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-provenance");
  assert.deepEqual(provenance.requestSchema.required, ["subjectArtifactVersionId"]);
  assert.match(provenance.resultSchema.absence, /not proof that no lineage exists elsewhere/u);
  assert.ok(provenance.negativeCases.includes("infer-rights-from-source-lineage"));
  assert.match(provenance.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);

  for (const id of ["media.operation-slice.cancel-job", "media.operation-slice.retry-job"]) {
    const contract = operations.individualOperationContracts.records.find((record) => record.id === id);
    assert.ok(contract.ownerDefinition, `${id} has no Media owner request/effect/finality contract`);
    assert.ok(contract.ownerDefinition.requestSchema.additionalProperties === false);
    assert.ok(contract.ownerDefinition.negativeCases.length >= 5);
    assert.match(contract.ownerDefinition.scopeStatus, /runtime-NOT_ADMITTED/u);
  }
});

test("P0 exact capability-to-operation decisions resolve only fully classified action slices", () => {
  const review = readYaml(paths.capabilityReview);
  const operations = readYaml(paths.operations);
  const actionIndex = new Map(operations.actionOperationDispositionInventory.records.map((entry) => [entry.actionId, entry]));
  const operationIds = new Set([
    ...operations.operations.map(({ id }) => id),
    ...operations.individualOperationContracts.records.map(({ id }) => id),
    ...operations.ownerDefinedOperationContracts.records.map(({ id }) => id),
  ]);
  const records = review.ownerOperationBindingAdjudication.records;
  assert.ok(records.length >= 12);
  assert.equal(new Set(records.map(({ capabilityId }) => capabilityId)).size, records.length);
  for (const record of records) {
    assert.ok(record.actionRefs.every((id) => actionIndex.has(id)), `${record.capabilityId} refers to an unregistered action`);
    assert.ok(record.canonicalOperationRefs.every((id) => operationIds.has(id)), `${record.capabilityId} refers to an unregistered operation`);
    assert.ok(record.actionRefs.every((id) => [
      "EXACT_OPERATION_REFERENCE", "EXACT_ORDERED_WORKFLOW", "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT", "OWNER_DEFINED_EXACT_OPERATION_REFERENCE",
    ].includes(actionIndex.get(id).domainOperationDisposition)), `${record.capabilityId} contains an unresolved action slice`);
  }
});

function validateCapabilityLeafDefinitions(capabilities, review, operations) {
  const sourceLeaves = capabilities.capabilities;
  const ownerLeaves = review.ownerCapabilityLeafAdjudication?.records ?? [];
  const contractIndex = operations.capabilityOperationContracts;
  const contracts = contractIndex?.records ?? [];
  const inputSchemaRefs = new Set((contractIndex?.inputPayloadSchemas ?? []).map(({ id }) => id));
  const outputSchemaRefs = new Set((contractIndex?.outputPayloadSchemas ?? []).map(({ id }) => id));
  const ownerWireContracts = operations.ownerLeafWireContracts?.records ?? [];
  const ownerWireById = new Map(ownerWireContracts.map((record) => [record.id, record]));
  const profiles = new Set((contractIndex?.families ?? []).map(({ id }) => id));
  const bounds = new Map((contractIndex?.bounds ?? []).map((record) => [record.id, record]));
  const sourceIds = new Set(sourceLeaves.map(({ id }) => id));
  const ownerIds = ownerLeaves.map(({ capabilityRef }) => capabilityRef);
  const adjudicationIds = ownerLeaves.map(({ id }) => id);
  if (sourceLeaves.length !== 462 || ownerLeaves.length !== 462
    || new Set(ownerIds).size !== 462 || ownerIds.some((id) => !sourceIds.has(id))
    || new Set(adjudicationIds).size !== 462
    || ownerLeaves.some(({ id, recordKind, normativeMeaning }) => !id?.startsWith("media.capability-adjudication.")
      || recordKind !== "INDEPENDENT_NORMATIVE_OWNER_CAPABILITY_LEAF_ADJUDICATION"
      || !normativeMeaning?.includes("definition obligation"))) return false;
  if (contracts.length !== 462 || new Set(contracts.map(({ id }) => id)).size !== 462) return false;
  if (ownerLeaves.some((record) => {
    const source = sourceLeaves.find(({ id }) => id === record.capabilityRef);
    const leaf = review.leaves.find(({ id }) => id === record.capabilityRef);
    const contractId = record.operationContractRef?.split("#capabilityOperationContracts/records/@id=")[1];
    const contract = contracts.find(({ id }) => id === contractId);
    const bound = bounds.get(record.boundsRef);
    if (!source || !leaf?.ownerDefinitionBinding || !contract || !bound) return true;
    if (record.operationRefs.join("\0") !== contract.operationRefs.join("\0")) return true;
    if (!profiles.has(record.profileRef) || record.profileRef !== contract.familyProfileRef) return true;
    if (record.exactTypedInputs.join("\0") !== source.inputArtifactTypes.join("\0")) return true;
    if (record.exactTypedOutputs.join("\0") !== source.outputArtifactTypes.join("\0")) return true;
    const currentWireRef = source.ownerLeafWireContractRef ?? leaf.ownerLeafWireContractRef;
    if (currentWireRef || record.ownerLeafWireContractRef) {
      const wire = ownerWireById.get(currentWireRef);
      const outputType = wire?.resultSchema?.properties?.outputs?.items?.properties?.artifactType?.const;
      if (!wire || wire.capabilityRef !== source.id || record.ownerLeafWireContractRef !== wire.id
        || source.ownerDefinition.ownerLeafWireContractRef !== wire.id
        || !outputType || source.outputArtifactTypes.length !== 1 || source.outputArtifactTypes[0] !== outputType
        || source.ownerDefinition.successOutputs?.length !== 1
        || source.ownerDefinition.successOutputs[0].artifactType !== outputType
        || source.ownerDefinition.successOutputs[0].payloadSchemaRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerLeafWireContracts/records/@id=${wire.id}/resultSchema/properties/outputs/items`) return true;
    }
    if (record.requirementRefs.join("\0") !== (source.requirementIds ?? []).join("\0")) return true;
    if (record.implementationState !== "UNKNOWN" || record.qualificationState !== "NOT_EVALUATED"
      || record.runtimeAvailability !== "UNKNOWN") return true;
    const leafContract = source.ownerDefinition;
    if (!leafContract || leafContract.operationRefs.join("\0") !== record.operationRefs.join("\0")
      || leafContract.boundsRef !== record.boundsRef
      || bound.maximumRequestBytes !== 65536
      || bound.maximumInputSlots !== source.inputArtifactTypes.length
      || bound.overflow !== "reject-before-effect-BOUNDS_EXCEEDED") return true;
    if (contract.recordKind === "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION") {
      if (!contract.inputSlots || !contract.parameterSchema || !contract.successOutputs?.length
        || !contract.guards?.preconditions?.length || !contract.errors?.includes("UNKNOWN_OUTCOME")) return true;
      if (contract.requestEnvelopeRef !== "media.capability-contract-envelope.request.v1") return true;
      if (!contract.requestSchema || !contract.resultSchema || contract.requestSchema.properties.tenantId || contract.requestSchema.properties.principalId) return true;
      if (contract.inputSlots.some(({ payloadSchemaRef }) => !inputSchemaRefs.has(payloadSchemaRef))) return true;
      if (contract.successOutputs.some(({ payloadSchemaRef }) => !outputSchemaRefs.has(payloadSchemaRef))) return true;
      if (contract.inputSlots.some((slot) => contract.requestSchema.required.includes(slot.slotId) !== slot.required)) return true;
    } else if (contract.recordKind === "CAPABILITY_TO_EXISTING_OPERATION_BINDING") {
      if (!contract.canonicalSourceContractRefs?.length || contract.canonicalSourceContractRefs.some((ref) => ref.startsWith("UNRESOLVED_CONTRACT_REF:")) || contract.requestSchema || contract.resultSchema) return true;
    } else return true;
  })) return false;
  return true;
}

test("P0 defines every capability leaf with exact typed operations, bounds, and honest admission dimensions", () => {
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const review = readYaml(paths.capabilityReview);
  const operations = readYaml(paths.operations);
  assert.equal(validateCapabilityLeafDefinitions(capabilities, review, operations), true);
  const owner = review.ownerCapabilityLeafAdjudication;
  assert.deepEqual(owner.dispositions, {
    MACHINE_OPERATION_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 383,
    JOURNEY_STEP_WITH_EXACT_OPERATION: 77,
    PLATFORM_DEPENDENCY_WITH_EXACT_MEDIA_CONTRACT: 2,
  });
  assert.equal(operations.capabilityOperationContracts.profileCount, 38);
  assert.equal(operations.capabilityOperationContracts.boundsCount, 462);
  assert.equal(operations.capabilityOperationContracts.recordCount, 462);
  assert.equal(operations.capabilityOperationContracts.canonicalOperationCount, 448);
  assert.equal(operations.capabilityOperationContracts.bindingCount, 14);
  assert.equal(operations.capabilityOperationContracts.boundsCount, 462);
  const textToImage = capabilities.capabilities.find(({ id }) => id === "media.generate.image.text-to-image");
  assert.deepEqual(textToImage.ownerDefinition.parameterSchema.required, ["outputWidth", "outputHeight", "outputProfileRef"]);
  assert.equal(textToImage.ownerDefinition.typedInputSlots[0].required, true, "one-of text or visual intent remains required");
  assert.equal(textToImage.ownerDefinition.typedInputSlots[1].required, false, "optional reference artifacts remain optional");
  assert.ok(operations.capabilityOperationContracts.requestEnvelope.trustedContext.tenantId.includes("never accepted from caller body"));
  const textToImageContract = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.generate.image.text-to-image");
  assert.ok(textToImageContract.requestSchema.required.includes("input1"));
  assert.ok(textToImageContract.requestSchema.required.includes("requestId"));
  assert.equal(textToImageContract.requestSchema.properties.tenantId, undefined, "identity stays host-trusted context, outside caller payload");
  const intentSchema = operations.capabilityOperationContracts.inputPayloadSchemas.find(({ artifactType }) => artifactType === "text-or-visual-intent");
  assert.equal(intentSchema.schema.properties.payload.oneOf.length, 2, "text and visual intent are a closed union");
  assert.deepEqual(textToImageContract.parameterSchema.required, ["outputWidth", "outputHeight", "outputProfileRef"]);

  const malformed = structuredClone(review);
  malformed.ownerCapabilityLeafAdjudication.records.pop();
  assert.equal(validateCapabilityLeafDefinitions(capabilities, malformed, operations), false, "omitting one capability must fail the exact population test");
  const duplicate = structuredClone(review);
  duplicate.ownerCapabilityLeafAdjudication.records[1].capabilityRef = duplicate.ownerCapabilityLeafAdjudication.records[0].capabilityRef;
  assert.equal(validateCapabilityLeafDefinitions(capabilities, duplicate, operations), false, "duplicate identities cannot hide an omitted capability");
  const missingOwnerId = structuredClone(review);
  delete missingOwnerId.ownerCapabilityLeafAdjudication.records[0].id;
  assert.equal(validateCapabilityLeafDefinitions(capabilities, missingOwnerId, operations), false, "each independently normative leaf disposition has a stable identity");
  const badRef = structuredClone(review);
  badRef.ownerCapabilityLeafAdjudication.records[0].operationRefs[0] = "media.operation.not-defined";
  assert.equal(validateCapabilityLeafDefinitions(capabilities, badRef, operations), false, "stale operation refs fail closed");
  const falseQualification = structuredClone(review);
  falseQualification.ownerCapabilityLeafAdjudication.records[0].qualificationState = "QUALIFIED";
  assert.equal(validateCapabilityLeafDefinitions(capabilities, falseQualification, operations), false, "definition closure cannot promote qualification");
  const unbounded = structuredClone(operations);
  unbounded.capabilityOperationContracts.bounds[0].maximumRequestBytes = 0;
  assert.equal(validateCapabilityLeafDefinitions(capabilities, review, unbounded), false, "zero request bounds cannot be treated as valid operation contracts");
  const missingWire = structuredClone(capabilities);
  delete missingWire.capabilities.find(({ id }) => id === "media.simulation.output.rgb").ownerLeafWireContractRef;
  assert.equal(validateCapabilityLeafDefinitions(missingWire, review, operations), false, "a current leaf overlay cannot be omitted from the canonical capability source");
  const wrongWireOutput = structuredClone(capabilities);
  wrongWireOutput.capabilities.find(({ id }) => id === "media.simulation.output.rgb").outputArtifactTypes[0] = "simulation-pass-result-depth";
  assert.equal(validateCapabilityLeafDefinitions(wrongWireOutput, review, operations), false, "a leaf cannot bind another pass's effective output type");
});


test("P0 assigns every capability leaf explicit channel applicability without treating proposals as admission", () => {
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const review = readYaml(paths.capabilityReview);
  const channelFile = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const channels = new Set([...channelFile.channels, ...(channelFile.ownerDefinedChannels?.records ?? [])].map(({ id }) => id));
  assert.equal(channelFile.channels.length, 9, "the historical channel observation denominator remains intact");
  assert.equal(channelFile.ownerDefinedChannels.records.length, 2, "Agent and Event are explicit additive Media owner definitions");
  assert.equal(channels.size, 11, "active owner applicability uses the union of observed and owner-defined channels");
  assert.ok(channels.has("media.channel.agent"));
  assert.ok(channels.has("media.channel.event"));
  assert.equal(review.ownerCapabilityLeafAdjudication.channelCount, channels.size);
  const byId = new Map(capabilities.capabilities.map((entry) => [entry.id, entry]));
  const labels = {web:"media.channel.web",cli:"media.channel.cli",api:"media.channel.api",embedded:"media.channel.embedded","http-api":"media.channel.http-api","grpc-api":"media.channel.grpc-api",sdk:"media.channel.sdk","product-integration":"media.channel.product-integration"};
  for (const record of review.ownerCapabilityLeafAdjudication.records) {
    const source = byId.get(record.capabilityRef);
    assert.equal(record.channelApplicability.length, channels.size);
    assert.deepEqual(new Set(record.channelApplicability.map(({ channelRef }) => channelRef)), channels);
    for (const label of source.supportedChannels) {
      const channelRef = labels[label];
      assert.ok(channelRef, `source label ${label} has an exact channel ID`);
      assert.ok(record.channelApplicability.some((row) => row.channelRef === channelRef && row.disposition === "SOURCE_DECLARED_DEFINITION_APPLICABLE"));
    }
    const event = record.channelApplicability.find(({ channelRef }) => channelRef === "media.channel.event");
    assert.equal(event.disposition, "NOT_A_CAPABILITY_INVOCATION_CHANNEL");
    assert.equal(event.executionAdmission, "NOT_ADMITTED");
    assert.ok(record.channelApplicability.every(({ executionAdmission }) => executionAdmission === "NOT_ADMITTED"));
  }
  const bad = structuredClone(review);
  bad.ownerCapabilityLeafAdjudication.records[0].channelApplicability.pop();
  assert.notEqual(bad.ownerCapabilityLeafAdjudication.records[0].channelApplicability.length, channels.size, "a missing channel disposition is detectable");
});

function validateEventDefinition(events) {
  const sourceEnvelope = events.observedEnvelope;
  const sourceRuntime = sourceEnvelope.lifecyclePublisherInventory.records;
  const sourceNotifications = sourceEnvelope.clientNotificationInventory.records;
  const owner = events.ownerEventContracts;
  const eventRecords = owner?.records ?? [];
  const notificationRecords = owner?.notificationRecords ?? [];
  const eventIds = eventRecords.map(({ id }) => id);
  const notificationIds = notificationRecords.map(({ id }) => id);
  if (eventRecords.length !== 9 || notificationRecords.length !== 15
    || new Set(eventIds).size !== 9 || new Set(notificationIds).size !== 15) return false;
  if (eventRecords.some((event) => {
    const source = sourceRuntime.find(({ eventType }) => eventType === event.eventType);
    if (!source || !event.producer?.sourceRef || !event.schema?.properties?.payload
      || event.schema.additionalProperties !== false
      || !event.deduplication?.persistBeforeDispatch
      || event.durability?.requiredPattern !== "transactional-outbox-or-equivalent-atomic-commit"
      || event.executionAdmission !== "NOT_ADMITTED"
      || event.qualificationState !== "NOT_EVALUATED") return true;
    return event.observedPayloadFields.join("\0") !== source.observedPayloadFields.join("\0")
      || event.schema.properties.aggregateVersion.type !== "integer"
      || event.schema.properties.aggregateVersion.minimum !== 1
      || !event.ordering.rule.includes("aggregateVersion")
      || event.privacy.forbidden.includes("raw-media-bytes") === false;
  })) return false;
  if (notificationRecords.some((event) => {
    const source = sourceNotifications.find(({ eventName }) => eventName === event.eventName);
    return !source || event.semanticEquivalenceToLifecycleType !== "NONE"
      || event.durability.persisted !== false || event.executionAdmission !== "NOT_ADMITTED"
      || event.payloadSchema.additionalProperties !== false
      || event.sourceObservedPayloadFields.join("\0") !== source.observedPayloadFields.join("\0")
      || !event.finality.includes("not a domain event") || !event.finality.includes("bind a separate owner receipt");
  })) return false;
  return true;
}

test("P1-08 distinguishes nine durable event definitions from fifteen local notifications", () => {
  const events = readYaml(".product-experience/pdp-1-domain-data/events.yaml");
  assert.equal(validateEventDefinition(events), true);
  assert.equal(events.ownerEventContracts.runtimeEventCount, 9);
  assert.equal(events.ownerEventContracts.notificationCount, 15);
  const cancelRequest = events.ownerEventContracts.records.find(({ eventType }) => eventType === "media.job.cancel_requested");
  assert.equal(cancelRequest.schema.properties.payload.properties.cancellationDisposition.const, "REQUESTED_NOT_FINAL");
  const cancelled = events.ownerEventContracts.records.find(({ eventType }) => eventType === "media.job.cancelled");
  assert.equal(cancelled.schema.properties.payload.properties.cancellationDisposition.const, "CONFIRMED_CANCELLED");
  const localComplete = events.ownerEventContracts.notificationRecords.find(({ eventName }) => eventName === "stt:transcription:complete");
  assert.equal(localComplete.durability.persisted, false);
  assert.equal(localComplete.payloadSchema.properties.result, undefined, "local event does not carry an unbounded raw result object");

  const duplicate = structuredClone(events);
  duplicate.ownerEventContracts.records[1].eventType = duplicate.ownerEventContracts.records[0].eventType;
  assert.equal(validateEventDefinition(duplicate), false, "duplicate runtime identities fail exact-population validation");
  const falseDurability = structuredClone(events);
  falseDurability.ownerEventContracts.notificationRecords[0].durability.persisted = true;
  assert.equal(validateEventDefinition(falseDurability), false, "local listener events cannot claim durable delivery");
  const missingDedup = structuredClone(events);
  missingDedup.ownerEventContracts.records[0].deduplication.persistBeforeDispatch = false;
  assert.equal(validateEventDefinition(missingDedup), false, "event delivery without durable dedup/outbox semantics fails");
});

test("P0-06 enumerates exact capability applicability without inventing a measured population", () => {
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const operations = readYaml(paths.operations);
  const domains = readYaml(paths.objectRegistry);
  const review = readYaml(paths.capabilityReview);
  const crosswalk = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk;
  const records = crosswalk.records;
  const applicabilityRecords = crosswalk.measureApplicabilityRecords.records;
  const outputTypes = domains.ownerOutputArtifactTypeCrosswalk.records;
  const ids = new Set(capabilities.capabilities.map(({ id }) => id));
  const domainIds = new Set(domains.objects.map(({ id }) => id));
  const measureIds = goals.successMeasureContracts.records.map(({ id }) => id);
  assert.equal(records.length, 462);
  assert.equal(new Set(records.map(({ id }) => id)).size, 462);
  assert.equal(applicabilityRecords.length, 1848);
  assert.equal(new Set(applicabilityRecords.map(({ id }) => id)).size, 1848);
  assert.equal(new Set(applicabilityRecords.map(({ capabilityRef }) => capabilityRef)).size, 462);
  assert.equal(new Set(records.map(({ capabilityRef }) => capabilityRef)).size, 462);
  assert.ok(records.every(({ capabilityRef, measureApplicability, operationContractRef, profileRef, boundsRef }) =>
    ids.has(capabilityRef)
    && operationContractRef.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=")
    && profileRef && boundsRef
    && measureIds.every((id) => measureApplicability[id]?.disposition && measureApplicability[id]?.reason && measureApplicability[id]?.sourceRefs?.length)));
  assert.ok(goals.successMeasureContracts.records.every(({ baseline, target, qualification }) =>
    baseline.startsWith("NOT_EVALUATED") && target.startsWith("NOT_SET") && qualification === "NOT_EVALUATED"));
  assert.equal(operations.capabilityOperationContracts.bounds.length, 462);
  assert.equal(outputTypes.length, 69);
  assert.equal(new Set(outputTypes.map(({ artifactType }) => artifactType)).size, 69);
  assert.equal(new Set(outputTypes.map(({ id }) => id)).size, 69);
  assert.ok(outputTypes.every(({ disposition, domainObjectRefs }) =>
    (disposition === "EXACT_OUTPUT_TYPE_TO_DOMAIN_OBJECT_OWNER_MAPPING" && domainObjectRefs.length > 0)
    || (disposition === "EXPLICIT_NO_CANONICAL_DOMAIN_OBJECT_FOR_TRANSIENT_VALUE" && domainObjectRefs.length === 0)));
  assert.ok(outputTypes.every(({ domainObjectRefs }) => domainObjectRefs.every((id) => domainIds.has(id))));
  assert.ok(review.ownerCapabilityLeafAdjudication.records.every(({ exactTypedOutputs, outputArtifactTypeBindings, outputDomainObjectRefs }) =>
    exactTypedOutputs.length === outputArtifactTypeBindings.length
    && outputArtifactTypeBindings.every(({ artifactType }) => exactTypedOutputs.includes(artifactType))
    && outputDomainObjectRefs.every((id) => domainIds.has(id))));
});

test("P0 capability schemas use closed typed payloads, scalar validators, and the exact flat request envelope", () => {
  const operations = readYaml(paths.operations);
  const contracts = operations.capabilityOperationContracts;
  assert.equal(contracts.scalarTypeRecords.length, 29);
  assert.equal(new Set(contracts.scalarTypeRecords.map(({ id }) => id)).size, 29);
  assert.equal(contracts.scalarTypes["opaque-id"].validator.type, "string");
  assert.ok(contracts.scalarTypes["opaque-id"].validator.pattern);
  assert.equal(contracts.inputPayloadSchemas.filter(({ payloadKind }) => payloadKind === "TYPED_VALUE").length, 0);
  assert.match(contracts.requestEnvelope.body.executableSchemaRef, /record requestSchema/u);
  assert.match(contracts.requestEnvelope.body.rootProperties, /input1\.\.inputN/u);
  assert.equal(contracts.requestEnvelope.body.properties, undefined, "envelope is a composition template, not a conflicting nested-body schema");
  const query = contracts.records.find(({ operationKind, requestSchema }) => operationKind === "QUERY" && requestSchema);
  assert.ok(query);
  for (const row of contracts.records) {
    if (row.recordKind === "CAPABILITY_TO_EXISTING_OPERATION_BINDING") continue;
    assert.ok(["COMMAND", "QUERY", "ORDERED_WORKFLOW"].includes(row.operationKind));
    assert.equal(row.requestSchema.additionalProperties, false);
    assert.equal(row.requestSchema.properties.inputs, undefined, `${row.id} matches the flat per-record request envelope`);
    if (row.operationKind === "QUERY") assert.equal(row.requestSchema.properties.requestId, undefined, `${row.id} is read-only`);
    else assert.ok(row.requestSchema.properties.requestId, `${row.id} carries an idempotency key`);
  }
});

test("P0 canonical capability request schemas accept typed inputs and reject malformed or over-posted requests", () => {
  const operations = readYaml(paths.operations);
  const contracts = operations.capabilityOperationContracts;
  const generated = contracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.update");
  const Ajv = require("ajv");
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const schema = structuredClone(generated.requestSchema);
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!field.schemaRef) continue;
    const payload = contracts.inputPayloadSchemas.find(({ id }) => id === field.schemaRef);
    assert.ok(payload, `typed input ${field.schemaRef} exists`);
    schema.properties[name] = payload.schema;
  }
  const validate = ajv.compile(schema);
  const valid = {
    input1: { artifactType: "user-intent", payload: { text: "make a clean title card" } },
    input2: { artifactType: "versioned-project", payload: { artifactId: "project-1", versionId: "revision-1" } },
    parameters: {},
    requestId: "request-1",
  };
  assert.equal(validate(valid), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...valid, unexpected: true }), false, "additional caller fields are rejected");
  assert.equal(validate({ ...valid, input2: { artifactType: "versioned-project", payload: { artifactId: "project-1", versionId: "" } } }), false,
    "malformed version identity is rejected before an effect");
  assert.equal(validate({ ...valid, parameters: { tenantId: "tenant-override" } }), false,
    "trusted identity cannot be smuggled through leaf parameters");
});

test("P1-10 owner boundaries fail closed while leaving enforcement and qualification unclaimed", () => {
  const authority = readYaml(".product-experience/pdp-1-domain-data/authority.yaml").ownerDefinedPdp10AuthorityScopes;
  const privacy = readYaml(".product-experience/pdp-1-domain-data/privacy.yaml").ownerDefinedPdp10Boundary;
  const offline = readYaml(".product-experience/pdp-1-domain-data/offline-sync.yaml").ownerDefinedOfflineSemantics;
  const versioning = readYaml(".product-experience/pdp-1-domain-data/versioning.yaml").ownerDefinedRevisionSemantics;
  assert.match(authority.identityScope.unknownOrMismatched, /DENY/u);
  assert.ok(privacy.effectBoundary.recheckBefore.includes("provider dispatch"));
  assert.match(privacy.effectBoundary.unknownRule, /DENY/u);
  assert.match(privacy.retentionAndErasure.confirmRule, /all declared primary, replica, backup, cache, export and provider scopes/u);
  assert.match(privacy.duplicateEffectPrevention.ambiguousOutcome, /no blind replay/u);
  assert.ok(offline.prohibitedDisconnectedEffects.includes("job submission, retry or cancellation command"));
  assert.ok(offline.reconnectProtocol.includes("compare every expected canonical source/project revision; stale values produce CONFLICT"));
  assert.match(versioning.projectRevision.stale, /no mutation, automatic merge or overwrite/u);
  assert.match(privacy.scopeStatus, /enforcement.*pending/u);
});

test("P0 model acquisition and reuse policy separates package licenses from model and asset terms", () => {
  const authority = readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml").modelAcquisitionAndFallback;
  const reuse = readYaml(".product-experience/pdp-0-product-truth/reuse-decisions.yaml").mediaArchitectureRules.componentLicenseBoundary;
  assert.equal(authority.automaticAcquisition.default, "DENY");
  assert.match(authority.fallback.localOnly, /always denied/u);
  assert.match(authority.fallback.failureBehavior, /Do not download, substitute, or dispatch/u);
  assert.equal(reuse.unknownDisposition, "DENY_SELECTION_OR_ACQUISITION; NOASSERTION, package-level license, owner label or successful test does not establish component or weight clearance.");
  assert.match(reuse.rule, /independent from every bundled, downloaded or transitively used model weight/u);
  assert.match(reuse.scopeStatus, /legal\/security review.*pending/u);
});

test("P0 channel and dependency update semantics define bounded CLI and promotion rules without admission", () => {
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const cli = channels.channels.find(({ id }) => id === "media.channel.cli").ownerCliDefinitionContract;
  assert.equal(cli.id, "media.cli.definition-boundaries.v1");
  assert.match(cli.pathHandling.rule, /Never reinterpret it as an HTTP route/u);
  assert.equal(cli.interruptHandling.ctrlC.exitCode, 130);
  assert.equal(cli.interruptHandling.ctrlC.serverCancellation, false);
  assert.match(cli.flagApplicability.readOnlyCommands.idempotencyKey, /do not accept a replay key/u);
  assert.equal(cli.executionAdmission, "NOT_ADMITTED");
  const reuse = readYaml(".product-experience/pdp-0-product-truth/reuse-decisions.yaml").mediaArchitectureRules;
  assert.equal(reuse.dependencyUpdatePolicy.id, "media.reuse.dependency-update-policy");
  assert.ok(reuse.dependencyUpdatePolicy.pinning.rule.includes("immutable version and integrity digest"));
  assert.ok(reuse.dependencyUpdatePolicy.validationBeforePromotion.required.includes("security advisory, provenance, integrity and transitive dependency review"));
  assert.match(reuse.dependencyUpdatePolicy.validationBeforePromotion.failure, /Reject promotion/u);
  assert.match(reuse.dependencyUpdatePolicy.scopeStatus, /independent acceptance remain pending/u);
});
