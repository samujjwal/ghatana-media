import { resolveEffectiveCapabilityWireSchemas, validateOwnerClosedJsonSchema } from "./pdp-owner-leaf-wire-validation.mjs";

const ACTION_OPERATION_ID = "media.operation.action.request-admitted-speech-operation";
const TARGET_COLLECTION = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records";

const targetRef = (id, field) => `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${id}/${field}`;

/** Definition-only validation of the selected-command mapping for an action wrapper. */
export function validateSelectedTargetOperationRequest({ wrapper, request, targetOperationRecords, operationsSource }) {
  const binding = wrapper?.selectedTargetOperationBinding;
  const schema = wrapper?.requestSchema;
  if (wrapper?.id !== ACTION_OPERATION_ID || wrapper?.actionRef !== "media.action.request-admitted-speech-operation"
    || binding?.status !== "OWNER_DEFINED_EXACT_SELECTED_TARGET_COMMAND_BINDING"
    || binding.actionOperationRef !== wrapper.id
    || binding.admittedOperationRefMeaning?.includes("never carries the selected target identity") !== true
    || binding.targetOperationSourceCollectionRef !== TARGET_COLLECTION
    || binding.selection !== "TRUSTED_EXPLICIT_USER_SELECTION_REQUIRED; NO_DEFAULT; NO_DISPATCH_UNTIL_EXACTLY_ONE_TARGET_IS_SELECTED"
    || schema?.additionalProperties !== false
    || schema.properties?.admittedOperationRef?.mustMatchActionDefinition !== true
    || schema.properties?.admittedOperationRef?.const !== wrapper.id
    || !["requestId", "exactTargetRefs", "admittedOperationRef", "selectedTargetCapabilityRef",
      "selectedTargetOperationRef", "selectedTargetOperationVersion", "selectedTargetRequestSchemaRef",
      "selectedTargetResultSchemaRef", "selectedTargetRequest", "explicitConfirmation"]
      .every((field) => schema.required?.includes(field))) {
    return { valid: false, reason: "SELECTED_TARGET_WRAPPER_CONTRACT_MISMATCH" };
  }

  if (!request || request.admittedOperationRef !== wrapper.id) {
    return { valid: false, reason: "ACTION_WRAPPER_IDENTITY_MISMATCH" };
  }
  if (request.selectedTargetOperationRef === wrapper.id) {
    return { valid: false, reason: "RECURSIVE_OR_WRAPPER_TARGET_REJECTED" };
  }
  const sourceMatches = (operationsSource?.capabilityOperationContracts?.records ?? [])
    .filter((record) => record?.id === request.selectedTargetOperationRef);
  if (sourceMatches.length !== 1) return { valid: false, reason: "SELECTED_TARGET_NOT_UNIQUE" };
  const target = sourceMatches[0];
  if (!Array.isArray(target.operationRefs) || target.operationRefs.length !== 1
    || target.operationRefs[0] !== target.id || !target.requestSchema
    || !target.resultSchema || typeof target.resultSchema !== "object") {
    return { valid: false, reason: "UNKNOWN_TARGET_SCHEMA" };
  }
  const effectiveSchemas = resolveEffectiveCapabilityWireSchemas(operationsSource, target.capabilityRef);
  if (!effectiveSchemas.valid || effectiveSchemas.operation?.id !== target.id
    || !effectiveSchemas.resultSchema || typeof effectiveSchemas.resultSchema !== "object") {
    return { valid: false, reason: "UNKNOWN_TARGET_RESULT" };
  }
  const suppliedMatches = (targetOperationRecords ?? []).filter((record) => record?.id === target.id);
  if (suppliedMatches.length !== 1) return { valid: false, reason: "SELECTED_TARGET_NOT_UNIQUE" };
  const suppliedTarget = suppliedMatches[0];
  if (suppliedTarget.capabilityRef !== target.capabilityRef
    || suppliedTarget.operationRefs?.length !== target.operationRefs.length
    || suppliedTarget.operationRefs?.some((operationRef, index) => operationRef !== target.operationRefs[index])
    || suppliedTarget.recordKind !== target.recordKind
    || suppliedTarget.operationKind !== target.operationKind
    || suppliedTarget.operationVersion !== target.operationVersion
    || suppliedTarget.isOrderedWorkflow !== target.isOrderedWorkflow
    || JSON.stringify(suppliedTarget.requestSchema) !== JSON.stringify(target.requestSchema)
    || JSON.stringify(suppliedTarget.resultSchema) !== JSON.stringify(target.resultSchema)) {
    return { valid: false, reason: "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH" };
  }
  if (target.recordKind !== "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION"
    || target.operationKind !== "COMMAND"
    || target.operationVersion !== request.selectedTargetOperationVersion
    || target.capabilityRef !== request.selectedTargetCapabilityRef
    || request.selectedTargetRequestSchemaRef !== targetRef(target.id, "requestSchema")
    || request.selectedTargetResultSchemaRef !== targetRef(target.id, "resultSchema")
    || target.id === wrapper.id || target.operationRefs.includes(wrapper.id)
    || target.isOrderedWorkflow === true || target.operationKind === "QUERY") {
    return { valid: false, reason: "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH" };
  }
  const targetRequestResult = validateOwnerClosedJsonSchema(effectiveSchemas.requestSchema, request.selectedTargetRequest);
  if (!targetRequestResult.valid) return { valid: false, reason: "SELECTED_TARGET_REQUEST_SCHEMA_REJECTED", errors: targetRequestResult.errors ?? [] };

  if (binding.targetRequestSchemaJoin?.includes("exact selected operation record requestSchema") !== true
    || binding.targetResultSchemaJoin?.includes("exact selected operation record resultSchema") !== true
    || binding.targetResultBoundary?.includes("only the wrapper receipt") !== true
    || binding.targetResultBoundary?.includes("cannot satisfy") !== true
    || binding.reject?.includes("MISSING_OR_AMBIGUOUS_TARGET") !== true
    || binding.reject?.includes("QUERY_TARGET") !== true
    || binding.reject?.includes("WRAPPER_SELF_TARGET") !== true
    || binding.reject?.includes("RECURSIVE_WRAPPER_TARGET") !== true) {
    return { valid: false, reason: "SELECTED_TARGET_FAIL_CLOSED_RULES_MISSING" };
  }
  return { valid: true, reason: "EXACT_SELECTED_COMMAND_AND_SEPARATE_RESULT_BOUND" };
}
