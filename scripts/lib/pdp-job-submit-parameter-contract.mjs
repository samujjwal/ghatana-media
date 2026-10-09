import { createHash } from "node:crypto";
import {
  validateOwnerClosedJsonSchema,
  validateOwnerLeafWireRequest,
  resolveEffectiveCapabilityWireSchemas,
} from "./pdp-owner-leaf-wire-validation.mjs";
import { computeSelectedOwnerRequestSchemaDigest } from "./pdp-tts-request-origin-binding.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactOperationRecord(operations, sourceRef) {
  const [sourcePath, selector] = typeof sourceRef === "string" ? sourceRef.split("#") : [];
  if (sourcePath !== ".product-experience/pdp-1-domain-data/operations.yaml") return null;
  const match = /^(individualOperationContracts|ownerDefinedOperationContracts|operations)\/(?:records\/)?@id=([^/]+)$/u.exec(selector ?? "");
  if (!match) return null;
  const records = match[1] === "operations"
    ? operations?.operations ?? []
    : operations?.[match[1]]?.records ?? [];
  const found = records.filter((row) => row?.id === match[2]);
  return found.length === 1 ? found[0] : null;
}

function selectRequestSchema(operations, capabilityContract, targetOperationRef) {
  if (capabilityContract.requestSchema) {
    if (capabilityContract.id === targetOperationRef && capabilityContract.capabilityRef) {
      const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityContract.capabilityRef);
      if (!effective.valid || effective.operation !== capabilityContract) return null;
      return {
        requestSchema: effective.requestSchema,
        requestSchemaRef: `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${capabilityContract.id}/effectiveRequestSchema`,
        inputSlots: capabilityContract.inputSlots ?? [],
      };
    }
    return {
      requestSchema: capabilityContract.requestSchema,
      requestSchemaRef: `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${capabilityContract.id}/requestSchema`,
      inputSlots: capabilityContract.inputSlots ?? [],
    };
  }
  const refs = capabilityContract.canonicalSourceContractRefs;
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const matching = refs.map((ref) => ({ ref, record: exactOperationRecord(operations, ref) }))
    .filter(({ record }) => record && (record.id === targetOperationRef || record.operationRef === targetOperationRef));
  if (matching.length !== 1) return null;
  const [{ ref, record }] = matching;
  const requestSchema = record.ownerWireSchema?.requestSchema ?? record.requestSchema;
  if (!requestSchema) return null;
  const schemaPath = record.ownerWireSchema?.requestSchema ? "ownerWireSchema/requestSchema" : "requestSchema";
  return { requestSchema, requestSchemaRef: `${ref}/${schemaPath}`, sourceRecord: record };
}

function schemaHasParameters(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.properties && Object.hasOwn(schema.properties, "parameters")) return true;
  return ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(schema[key]) && schema[key].some(schemaHasParameters));
}

function resolveSchemaPointer(rootSchema, pointer) {
  if (typeof pointer !== "string" || !pointer) return undefined;
  return pointer.replace(/^\//u, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], rootSchema);
}

/** Resolve the exact per-capability parameter definition and asynchronous-submit disposition. */
export function resolveJobSubmitParameterSchema(operations, capabilityRef, targetOperationRef, targetOperationVersion) {
  const capabilityMatches = operations?.capabilityOperationContracts?.records?.filter((row) => row?.capabilityRef === capabilityRef) ?? [];
  if (capabilityMatches.length !== 1) return { valid: false, reason: "TARGET_CAPABILITY_CONTRACT_NOT_UNIQUE" };
  const capabilityContract = capabilityMatches[0];
  if (capabilityContract.operationKind !== "COMMAND"
    || capabilityContract.asyncSubmissionDisposition !== "COMMAND_MAY_BE_SUBMITTED") {
    return { valid: false, reason: "TARGET_OPERATION_NOT_ASYNC_SUBMITTABLE" };
  }
  if (!Number.isSafeInteger(capabilityContract.operationVersion) || capabilityContract.operationVersion < 1
    || targetOperationVersion !== capabilityContract.operationVersion) {
    return { valid: false, reason: "TARGET_OPERATION_VERSION_MISMATCH_OR_UNDEFINED" };
  }
  if (!Array.isArray(capabilityContract.operationRefs)
    || capabilityContract.operationRefs.filter((id) => id === targetOperationRef).length !== 1) {
    return { valid: false, reason: "TARGET_OPERATION_NOT_BOUND_TO_CAPABILITY" };
  }
  const selected = selectRequestSchema(operations, capabilityContract, targetOperationRef);
  if (!selected) return { valid: false, reason: "TARGET_OPERATION_REQUEST_SCHEMA_UNRESOLVED" };
  if (selected.sourceRecord) {
    const sourceVersion = selected.sourceRecord.contractVersion ?? selected.sourceRecord.operationVersion;
    if (sourceVersion !== undefined
      && (!Number.isSafeInteger(sourceVersion) || sourceVersion !== capabilityContract.operationVersion)) {
      return { valid: false, reason: "TARGET_CANONICAL_SOURCE_VERSION_MISMATCH_OR_UNDEFINED" };
    }
  }
  const unboundTargetFields = Object.keys(selected.requestSchema.properties ?? {})
    .filter((name) => !/^input[1-9]\d*$/u.test(name)
      && !["parameters", "requestId", "operationRef", "operationVersion"].includes(name));
  const jobMatches = operations?.ownerDefinedOperationContracts?.records?.filter((row) => row?.id === "media.operation.job.submit.v1") ?? [];
  if (jobMatches.length !== 1) return { valid: false, reason: "JOB_SUBMIT_OWNER_CONTRACT_NOT_UNIQUE" };
  const directAdapters = jobMatches[0].requestSemantics?.typedInputValidator?.directFieldAdapters ?? [];
  const matchingDirectAdapters = directAdapters.filter((adapter) => adapter?.capabilityRef === capabilityRef
    && adapter?.targetOperationRef === targetOperationRef
    && adapter?.targetRequestSchemaRef === selected.requestSchemaRef);
  if (unboundTargetFields.length > 0) {
    if (matchingDirectAdapters.length !== 1
      || !Array.isArray(matchingDirectAdapters[0].directFields)
      || canonicalJson([...matchingDirectAdapters[0].directFields].sort()) !== canonicalJson([...unboundTargetFields].sort())) {
      return { valid: false, reason: "TARGET_DIRECT_REQUEST_FIELDS_REQUIRE_EXACT_ADAPTER", requestSchemaRef: selected.requestSchemaRef, unboundTargetFields };
    }
  } else if (matchingDirectAdapters.length > 0) {
    return { valid: false, reason: "TARGET_DIRECT_FIELD_ADAPTER_HAS_NO_DIRECT_FIELDS" };
  }
  let parametersSchema = selected.requestSchema.properties?.parameters;
  let schemaRef = parametersSchema ? `${selected.requestSchemaRef}/properties/parameters` : null;
  if (!parametersSchema && capabilityContract.parameterSchemaDisposition === "EXACT_NESTED_PARAMETER_SCHEMA") {
    const sourcePrefix = `${selected.requestSchemaRef}/`;
    if (typeof capabilityContract.parameterSchemaSourceRef !== "string"
      || !capabilityContract.parameterSchemaSourceRef.startsWith(sourcePrefix)) {
      return { valid: false, reason: "NESTED_PARAMETER_SCHEMA_SOURCE_MISMATCH" };
    }
    const pointer = capabilityContract.parameterSchemaSourceRef.slice(sourcePrefix.length);
    parametersSchema = resolveSchemaPointer(selected.requestSchema, pointer);
    schemaRef = capabilityContract.parameterSchemaSourceRef;
    if (!parametersSchema || !pointer.endsWith("/parameters")) {
      return { valid: false, reason: "NESTED_PARAMETER_SCHEMA_UNRESOLVED" };
    }
  }
  if (!parametersSchema && (schemaHasParameters(selected.requestSchema)
    || capabilityContract.parameterSchemaDisposition !== "NO_PARAMETERS"
    || capabilityContract.parameterSchemaSourceRef !== selected.requestSchemaRef)) {
    return { valid: false, reason: "PARAMETER_SCHEMA_ABSENCE_NOT_EXPLICIT" };
  }
  if (parametersSchema && capabilityContract.parameterSchemaDisposition === "NO_PARAMETERS") {
    return { valid: false, reason: "PARAMETER_SCHEMA_DISPOSITION_CONTRADICTS_SOURCE" };
  }
  if (!schemaRef) schemaRef = capabilityContract.parameterSchemaSourceRef;
  const parameterSchema = parametersSchema ?? { type: "object", additionalProperties: false, properties: {} };
  let targetSchemaDigest;
  try {
    targetSchemaDigest = computeSelectedOwnerRequestSchemaDigest(operations, {
      operationRef: targetOperationRef,
      capabilityRef,
      operationVersion: capabilityContract.operationVersion,
      requestSchema: selected.requestSchema,
      requestSchemaRef: selected.requestSchemaRef,
      inputSlots: selected.inputSlots ?? [],
    });
  } catch {
    return { valid: false, reason: "TARGET_REQUEST_SCHEMA_CLOSURE_UNRESOLVED", requestSchemaRef: selected.requestSchemaRef };
  }
  return {
    valid: true,
    capabilityContract,
    targetOperationRef,
    targetOperationVersion,
    requestSchema: selected.requestSchema,
    requestSchemaRef: selected.requestSchemaRef,
    parameterSchema,
    schemaRef,
    directFields: unboundTargetFields,
    directFieldAdapter: matchingDirectAdapters[0] ?? null,
    schemaSha256: sha256(canonicalJson(parameterSchema)),
    requestSchemaSha256: sha256(canonicalJson(selected.requestSchema)),
    targetSchemaDigest,
    parameterDisposition: parametersSchema ? "EXACT_CLOSED_PARAMETER_SCHEMA" : "EXPLICIT_NO_PARAMETERS",
  };
}

/**
 * Bind the generic ordered typedInputs vector to the selected target operation's
 * exact inputN slots. Array position is the slot identity; omitted optional
 * slots may only be trailing, so a later slot can never slide into an earlier
 * one. This is definition validation only.
 */
export function validateJobSubmitTypedInputContract(operations, request) {
  const selected = resolveJobSubmitParameterSchema(
    operations,
    request?.capabilityRef,
    request?.targetOperationRef,
    request?.targetOperationVersion,
  );
  if (!selected.valid) return selected;
  if (!Array.isArray(request?.typedInputs)) return { valid: false, reason: "TYPED_INPUTS_NOT_ARRAY" };
  const slots = Object.entries(selected.requestSchema.properties ?? {})
    .map(([name, schema]) => ({ name, schema, index: /^input([1-9]\d*)$/u.exec(name)?.[1] }))
    .filter(({ index }) => index !== undefined)
    .map(({ name, schema, index }) => ({ name, schema, index: Number(index) }))
    .sort((left, right) => left.index - right.index);
  if (slots.some((slot, index) => slot.index !== index + 1)) {
    return { valid: false, reason: "TARGET_INPUT_SLOTS_NOT_CONTIGUOUS" };
  }
  const required = new Set(selected.requestSchema.required ?? []);
  const lastRequiredIndex = slots.reduce((last, slot, index) => required.has(slot.name) ? index + 1 : last, 0);
  if (request.typedInputs.length < lastRequiredIndex || request.typedInputs.length > slots.length) {
    return {
      valid: false,
      reason: "TYPED_INPUT_SLOT_CARDINALITY_MISMATCH",
      expectedMinimum: lastRequiredIndex,
      expectedMaximum: slots.length,
      received: request.typedInputs.length,
    };
  }
  for (let index = 0; index < request.typedInputs.length; index += 1) {
    const slot = slots[index];
    if (!slot) return { valid: false, reason: "TYPED_INPUT_SLOT_UNDECLARED", slotIndex: index };
    const validation = validateOwnerClosedJsonSchema(slot.schema, request.typedInputs[index], selected.requestSchema);
    if (!validation.valid) {
      return {
        valid: false,
        reason: "TYPED_INPUT_SLOT_REJECTED",
        slot: slot.name,
        slotIndex: index,
        errors: validation.errors,
      };
    }
  }
  return {
    valid: true,
    reason: "EXACT_ORDERED_TYPED_INPUT_SLOTS_MATCH",
    targetOperationRef: request.targetOperationRef,
    targetOperationVersion: request.targetOperationVersion,
    slotRefs: slots.slice(0, request.typedInputs.length).map(({ name }) => `${selected.requestSchemaRef}/properties/${name}`),
    runtimeAdmission: "NOT_ADMITTED",
  };
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not JSON parameter values");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("parameters must contain only JSON values");
  if (seen.has(value)) throw new TypeError("cyclic parameter values are not JSON");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/u.test(key))
      || Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some((present) => !present)) {
      throw new TypeError("sparse arrays or non-index array properties are not canonical JSON");
    }
    result = `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("parameter objects must be plain JSON objects");
    const keys = Object.keys(value).sort();
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

export function canonicalizeJobParameterJson(value) {
  return canonicalJson(value);
}

/**
 * Resolve and validate the target-operation parameter object for a canonical
 * Media job-submit request. A successful result proves only source-defined
 * parameter binding; it does not prove runtime execution or admission.
 */
export function validateJobSubmitParameterContract(operations, request) {
  const jobContracts = operations?.ownerDefinedOperationContracts?.records ?? [];
  const jobMatches = jobContracts.filter((row) => row?.id === "media.operation.job.submit.v1");
  if (jobMatches.length !== 1) return { valid: false, reason: "JOB_SUBMIT_OWNER_CONTRACT_NOT_UNIQUE" };
  const jobContract = jobMatches[0];
  const baseValidation = validateOwnerLeafWireRequest(jobContract.ownerWireSchema, request);
  if (!baseValidation.valid) return { valid: false, reason: "JOB_SUBMIT_REQUEST_REJECTED", errors: baseValidation.errors };
  if (!isRecord(request.parameters) || typeof request.targetOperationRef !== "string" || !request.targetOperationRef.trim()) {
    return { valid: false, reason: "TARGET_OPERATION_OR_PARAMETER_OBJECT_MISSING" };
  }
  const selected = resolveJobSubmitParameterSchema(operations, request.capabilityRef, request.targetOperationRef, request.targetOperationVersion);
  if (!selected.valid) return selected;
  const validation = validateOwnerClosedJsonSchema(selected.parameterSchema, request.parameters, selected.requestSchema);
  if (!validation.valid) return {
    valid: false,
    reason: "TARGET_OPERATION_PARAMETERS_REJECTED",
    schemaRef: selected.schemaRef,
    errors: validation.errors,
  };
  const typedInputValidation = validateJobSubmitTypedInputContract(operations, request);
  if (!typedInputValidation.valid) return {
    valid: false,
    reason: "TARGET_OPERATION_TYPED_INPUTS_REJECTED",
    typedInputReason: typedInputValidation.reason,
    errors: typedInputValidation.errors,
  };
  const directFields = request.directRequestFields ?? {};
  if (!isRecord(directFields)) return { valid: false, reason: "TARGET_DIRECT_FIELDS_NOT_OBJECT" };
  const allowedDirectFields = selected.directFieldAdapter?.directFields ?? [];
  if (Object.keys(directFields).some((field) => !allowedDirectFields.includes(field))) {
    return { valid: false, reason: "TARGET_DIRECT_FIELD_UNKNOWN_OR_UNBOUND" };
  }
  if (!selected.directFieldAdapter && Object.keys(directFields).length > 0) {
    return { valid: false, reason: "TARGET_DIRECT_FIELDS_WITHOUT_EXACT_ADAPTER" };
  }
  const targetRequest = {};
  const requiredTargetFields = new Set(selected.requestSchema.required ?? []);
  const slots = Object.keys(selected.requestSchema.properties ?? {}).filter((name) => /^input[1-9]\d*$/u.test(name));
  for (const [index, slot] of slots.map((slot) => [Number(/^input([1-9]\d*)$/u.exec(slot)[1]) - 1, slot])) {
    if (index < request.typedInputs.length) targetRequest[slot] = request.typedInputs[index];
  }
  if (Object.hasOwn(selected.requestSchema.properties ?? {}, "parameters")) targetRequest.parameters = request.parameters;
  if (Object.hasOwn(selected.requestSchema.properties ?? {}, "requestId")) targetRequest.requestId = request.requestId;
  if (Object.hasOwn(selected.requestSchema.properties ?? {}, "operationRef")) targetRequest.operationRef = request.targetOperationRef;
  if (Object.hasOwn(selected.requestSchema.properties ?? {}, "operationVersion")) targetRequest.operationVersion = request.targetOperationVersion;
  for (const field of allowedDirectFields) if (Object.hasOwn(directFields, field)) targetRequest[field] = directFields[field];
  const missingRequiredDirectFields = selected.directFields.filter((field) => requiredTargetFields.has(field) && !Object.hasOwn(directFields, field));
  if (missingRequiredDirectFields.length > 0) return { valid: false, reason: "TARGET_DIRECT_FIELD_REQUIRED", fields: missingRequiredDirectFields };
  const targetRequestValidation = validateOwnerClosedJsonSchema(selected.requestSchema, targetRequest, selected.requestSchema);
  if (!targetRequestValidation.valid) return {
    valid: false,
    reason: "TARGET_REQUEST_RECONSTRUCTION_REJECTED",
    requestSchemaRef: selected.requestSchemaRef,
    errors: targetRequestValidation.errors,
  };
  let canonicalTargetRequest;
  try { canonicalTargetRequest = canonicalJson(targetRequest); }
  catch (error) {
    return { valid: false, reason: "NON_CANONICAL_TARGET_REQUEST", errors: [{ message: error.message }] };
  }
  const schemaRef = selected.schemaRef;
  let canonicalParameters;
  try { canonicalParameters = canonicalJson(request.parameters); }
  catch (error) { return { valid: false, reason: "NON_CANONICAL_PARAMETER_VALUE", errors: [{ message: error.message }] }; }
  const schemaSha256 = selected.schemaSha256;
  const parameterFingerprintInput = JSON.stringify([
    request.capabilityRef,
    request.targetOperationRef,
    selected.targetOperationVersion,
    schemaRef,
    schemaSha256,
    selected.requestSchemaSha256,
    selected.targetSchemaDigest,
    canonicalTargetRequest,
    canonicalParameters,
    canonicalJson({ typedInputs: request.typedInputs, directRequestFields: directFields }),
  ]);
  return {
    valid: true,
    reason: "EXACT_TARGET_OPERATION_PARAMETERS_MATCH",
    schemaRef,
    schemaSha256,
    targetRequestSchemaRef: selected.requestSchemaRef,
    targetRequestSha256: sha256(canonicalTargetRequest),
    requestSchemaSha256: selected.requestSchemaSha256,
    targetSchemaDigest: selected.targetSchemaDigest,
    typedInputSlotRefs: typedInputValidation.slotRefs,
    targetOperationVersion: selected.targetOperationVersion,
    parameterBindingSha256: sha256(parameterFingerprintInput),
    runtimeAdmission: "NOT_ADMITTED",
  };
}
