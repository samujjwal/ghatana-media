import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveEffectiveCapabilityWireSchemas, validateOwnerLeafWireResult } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
// Keep one parsed source document per YAML file, but hand each test its own
// copy. Many tests deliberately mutate these fixtures to verify diagnostics;
// cloning here preserves that isolation while avoiding repeated YAML parsing.
const sourceDocuments = new Map();
const source = (path) => {
  if (!sourceDocuments.has(path)) sourceDocuments.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  return sourceDocuments.get(path);
};
const read = (path) => structuredClone(source(path));
const CAP_PATH = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const OPS_PATH = ".product-experience/pdp-1-domain-data/operations.yaml";
const ACTION_PATH = ".product-experience/pdp-3-product-experience/action-registry.yaml";
const DECISION_PATH = ".product-experience/decision-log.md";
const actionRowsSource = source(ACTION_PATH).actions ?? [];
const decisionSource = readFileSync(resolve(root, DECISION_PATH), "utf8");
const primitiveTypes = new Set(["string", "integer", "number", "boolean", "object", "array", "null"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

// P0 permits a domain scalar name as a shorthand. Expand it with PDP-1's
// registered scalar validator before comparing to its JSON Schema projection.
function normalizedSchema(schema, scalarTypes) {
  if (Array.isArray(schema)) return schema.map((part) => normalizedSchema(part, scalarTypes));
  if (!schema || typeof schema !== "object") return schema;
  // PDP-0 uses `type: enum, values` as shorthand for a string enum. Compare its
  // semantics with the JSON Schema form used by owner wire contracts.
  if (schema.type === "enum" && Array.isArray(schema.values)) {
    return stable({ type: "string", enum: [...schema.values] });
  }
  if (typeof schema.type === "string" && !primitiveTypes.has(schema.type)) {
    const scalar = scalarTypes[schema.type];
    if (scalar?.validator) {
      const validator = structuredClone(scalar.validator);
      // P0 expresses rational frame-rate bounds at the use site, while P1
      // carries the same domain limits in its rational-range extension.
      // Normalize both representations to the P1 extension instead of
      // treating a range-preserving encoding difference as a mismatch.
      if (schema.type === "rational-frame-rate"
        && (schema.minimum !== undefined || schema.maximum !== undefined)) {
        validator["x-rationalRange"] = {
          ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
          ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
        };
      }
      return normalizedSchema(validator, scalarTypes);
    }
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["description", "title", "$comment", "emptyDisposition"].includes(key)) continue;
    result[key] = normalizedSchema(value, scalarTypes);
  }
  return stable(result);
}

function normalizedParameterField(schema, parameterSchema, scalarTypes) {
  const normalized = normalizedSchema(schema, scalarTypes);
  if (parameterSchema?.emptyDisposition === "NOT_EMPTY"
    && normalized?.type === "string" && !normalized.pattern && !normalized.enum) {
    return stable({ ...normalized, pattern: ".*\\S.*" });
  }
  return normalized;
}

function outputTypes(schema) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const outputs = node.properties?.outputs;
    const item = outputs?.items;
    if (item) {
      const branches = item.oneOf ?? item.anyOf ?? [item];
      for (const branch of branches) {
        const type = branch.properties?.artifactType?.const;
        if (typeof type === "string" && !found.includes(type)) found.push(type);
      }
    }
    for (const key of ["allOf", "oneOf", "anyOf"]) for (const child of node[key] ?? []) walk(child);
  };
  walk(schema);
  return found;
}

function diagnostics(capabilities, operations, { ignoredIssues = () => false } = {}) {
  const issues = [];
  const fail = (id, check, detail = "mismatch") => issues.push(`${id}: ${check} (${detail})`);
  const capRows = capabilities.capabilities ?? [];
  const actionRows = actionRowsSource;
  const contractRows = operations.capabilityOperationContracts?.records ?? [];
  const capById = new Map(capRows.map((row) => [row.id, row]));
  const contractByCapability = new Map();
  for (const row of contractRows) {
    if (contractByCapability.has(row.capabilityRef)) fail(row.capabilityRef, "unique-operation-binding");
    contractByCapability.set(row.capabilityRef, row);
  }
  const scalarTypes = operations.capabilityOperationContracts?.scalarTypes ?? {};
  for (const intent of capRows) {
    const id = intent.id;
    const p0 = intent.ownerDefinition;
    const operation = contractByCapability.get(id);
    if (!operation) { fail(id, "operation-binding-present"); continue; }
    const bound = operations.capabilityOperationContracts.bounds?.find(({ id: boundId }) => boundId === operation.boundsRef);
    const slots = p0?.typedInputSlots ?? [];
    if (!bound || bound.maximumInputSlots < slots.length) fail(id, "maximum-input-bound-covers-intent-slots");

    if (operation.recordKind === "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION") {
      const effective = resolveEffectiveCapabilityWireSchemas(operations, id);
      if (!effective.valid) { fail(id, "effective-request-result-schema-resolves", effective.reason); continue; }
      const p1Slots = operation.inputSlots ?? [];
      if (slots.length !== p1Slots.length) fail(id, "typed-input-slot-count", `${slots.length} P0 vs ${p1Slots.length} P1`);
      for (let index = 0; index < Math.max(slots.length, p1Slots.length); index++) {
        const source = slots[index];
        const target = p1Slots[index];
        if (!source || !target) continue;
        for (const field of ["sourceType", "cardinality", "required"]) {
          if (source[field] !== target[field]) fail(id, `input[${index}].${field}`, `${source[field]} vs ${target[field]}`);
        }
        if (JSON.stringify(source.alternatives ?? []) !== JSON.stringify(target.alternatives ?? [])) {
          fail(id, `input[${index}].alternatives`, `${JSON.stringify(source.alternatives ?? [])} vs ${JSON.stringify(target.alternatives ?? [])}`);
        }
        const wireProperty = effective.requestSchema?.properties?.[target.slotId];
        const isRequired = effective.requestSchema?.required?.includes(target.slotId) ?? false;
        if (!wireProperty) fail(id, `request-schema-slot[${target.slotId}]-resolves`);
        if (isRequired !== target.required) fail(id, `request-schema-slot[${target.slotId}]-requiredness`);
        const typedPayload = operations.capabilityOperationContracts.inputPayloadSchemas?.find(({ id: schemaId }) => schemaId === target.payloadSchemaRef);
        const requestArtifactTypes = artifactTypes(wireProperty);
        const declaredArtifactTypes = typedPayload ? artifactTypes(typedPayload.schema) : [];
        if (declaredArtifactTypes.some((type) => !requestArtifactTypes.includes(type))) {
          fail(id, `request-schema-slot[${target.slotId}]-artifactType-const`, `${declaredArtifactTypes.join(",")} vs ${requestArtifactTypes.join(",")}`);
        }
      }
      compareParameters(id, p0?.parameterSchema, operation.parameterSchema, scalarTypes, fail);
      const declaredOutputs = p0?.successOutputs ?? [];
      const mappedOutputs = operation.ownerLeafWireContractRef
        ? outputTypes(effective.resultSchema).map((artifactType) => ({ artifactType, requiredOnSuccess: true }))
        : (operation.successOutputs ?? []);
      if (declaredOutputs.length !== mappedOutputs.length) fail(id, "success-output-count", `${declaredOutputs.length} P0 vs ${mappedOutputs.length} P1`);
      for (let index = 0; index < Math.max(declaredOutputs.length, mappedOutputs.length); index++) {
        if (declaredOutputs[index]?.artifactType !== mappedOutputs[index]?.artifactType) fail(id, `success-output[${index}].artifactType`, `${declaredOutputs[index]?.artifactType} vs ${mappedOutputs[index]?.artifactType}`);
        if (declaredOutputs[index]?.requiredOnSuccess !== mappedOutputs[index]?.requiredOnSuccess) fail(id, `success-output[${index}].requiredOnSuccess`);
      }
      const schemaOutputs = outputTypes(effective.resultSchema);
      if (JSON.stringify(declaredOutputs.map(({ artifactType }) => artifactType)) !== JSON.stringify(schemaOutputs)) {
        fail(id, "effective-result-schema-carries-exact-P0-success-output-identities", `${JSON.stringify(declaredOutputs.map(({ artifactType }) => artifactType))} vs ${JSON.stringify(schemaOutputs)}`);
      }
      for (const output of declaredOutputs) {
        if (output.requiredOnSuccess && !successRequiresOutput(effective.resultSchema, output.artifactType)) {
          fail(id, `effective-result-schema-requires-success-output[${output.artifactType}]`);
        } else if (!output.requiredOnSuccess && successRequiresOutput(effective.resultSchema, output.artifactType)) {
          fail(id, `success-output[${output.artifactType}]-remains-optional-on-success`);
        }
      }
      if (declaredOutputs.some(({ artifactType }) => artifactType === "versioned-project-state")) {
        const typed = operations.capabilityOperationContracts.outputPayloadSchemas?.find(({ artifactType }) => artifactType === "versioned-project-state");
        const generic = typed?.schema.properties.payload.oneOf?.find((variant) => variant.properties?.kind?.const === "project-revision-state");
        const actual = findOutputBranch(operation.resultSchema, "versioned-project-state")?.properties?.payload;
        if (!generic || JSON.stringify(stable(actual)) !== JSON.stringify(stable(generic))) {
          fail(id, "effective-project-state-output-matches-source-defined-project-revision-variant");
        }
      }
      if (id === "media.artifact.inspect") {
        const typed = operations.capabilityOperationContracts.outputPayloadSchemas?.find(({ artifactType }) => artifactType === "integrity-and-lifecycle-disposition");
        const wireSource = resolveSelector(operations, operation.canonicalWireSchemaRefs?.[0]);
        const wirePayload = findOutputBranch(wireSource?.resultSchema, "integrity-and-lifecycle-disposition")?.properties?.payload;
        if (!typed || JSON.stringify(stable(typed.schema.properties.payload)) !== JSON.stringify(stable(wirePayload))) {
          fail(id, "effective-output-payload-schema[integrity-and-lifecycle-disposition]");
        }
      }
      const effectiveParameterSchema = effective.requestSchema?.properties?.parameters;
      if (effectiveParameterSchema) compareParameters(id, p0?.parameterSchema, effectiveParameterSchema, scalarTypes, fail);
    } else if (operation.recordKind === "CAPABILITY_TO_EXISTING_OPERATION_BINDING") {
      const refs = operation.canonicalSourceContractRefs ?? [];
      const wireRefs = operation.canonicalWireSchemaRefs ?? [];
      if (!refs.length || refs.length !== wireRefs.length || refs.length !== (operation.operationRefs ?? []).length) {
        fail(id, "ordered-source-wire-operation-reference-alignment");
      }
      const resolvedWires = [];
      for (let index = 0; index < wireRefs.length; index++) {
        const wire = resolveSelector(operations, wireRefs[index]);
        const source = resolveSelector(operations, refs[index]);
        if (!wire || !source || wire.operationRef !== (operation.operationRefs ?? [])[index]
          || source.id !== (operation.operationRefs ?? [])[index]) {
          fail(id, `source-owned-wire-schema[${index}]-resolves-to-declared-operation`);
          continue;
        }
        resolvedWires.push(wire);
      }
      const selectedAction = actionRows.find((action) => action.id === operation.typedInputMappings?.selectedAction?.actionRef);
      validateTypedInputMappings(id, intent, operation, resolvedWires, scalarTypes, selectedAction, {
        [CAP_PATH]: capabilities, [OPS_PATH]: operations, [ACTION_PATH]: { actions: actionRows },
        [DECISION_PATH]: decisionSource,
      }, fail);
      if (id === "media.artifact.inspect") {
        const typed = operations.capabilityOperationContracts.outputPayloadSchemas?.find(({ artifactType }) => artifactType === "integrity-and-lifecycle-disposition");
        const wirePayload = findOutputBranch(resolvedWires[0]?.resultSchema, "integrity-and-lifecycle-disposition")?.properties?.payload;
        if (!typed || JSON.stringify(stable(typed.schema.properties.payload)) !== JSON.stringify(stable(wirePayload))) {
          fail(id, "effective-output-payload-schema[integrity-and-lifecycle-disposition]");
        }
      }
      const requiresSelectedAction = (operation.typedInputMappings?.entries ?? []).some((entry) => entry.mappingDisposition === "ACTION_SELECTION_ONLY");
      if (requiresSelectedAction || operation.typedInputMappings?.selectedAction) {
        const selection = operation.typedInputMappings?.selectedAction ?? {};
        const sourceOperation = [
          ...(operations.individualOperationContracts?.records ?? []),
          ...(operations.ownerDefinedOperationContracts?.records ?? []),
        ].find(({ id: opId }) => opId === operation.operationRefs?.[0]);
        if (![`${ACTION_PATH}#${selection.actionRef}`, `${ACTION_PATH}#actions/@id=${selection.actionRef}`].includes(selection.sourceRef)
          || resolveSourceRef(selection.sourceRef, { [ACTION_PATH]: { actions: actionRows } })?.id !== selection.actionRef
          || !selectedAction
          || selectedAction.actionDefinitionSemantics?.operationRef !== operation.operationRefs?.[0]
          || !(sourceOperation?.actionIntentRefs ?? [sourceOperation?.actionRef]).includes(selection.actionRef)) {
          fail(id, "typed-input-selected-action-source-binding", `${selection.actionRef ?? "missing"}`);
        }
      }
      const parameterDisposition = operation.parameterSchemaDisposition;
      if (parameterDisposition === "EXACT_PARAMETER_SCHEMA") {
        const wireParams = mergedRequestSchema(resolvedWires);
        compareParameters(id, p0?.parameterSchema, wireParams, scalarTypes, fail);
      } else if (parameterDisposition === "EXACT_P0_PARAMETER_FIELD_MAPPINGS") {
        for (const entry of operation.typedInputMappings?.entries ?? []) {
          if (entry.source?.kind !== "P0_PARAMETER") continue;
          const target = (entry.targets ?? [])[0];
          const wireIndex = (operation.operationRefs ?? []).indexOf(target?.operationRef);
          const p0Schema = p0?.parameterSchema?.properties?.[entry.source.parameterName];
          const wireSchema = wireIndex >= 0 ? resolveJsonPointer(resolvedWires[wireIndex]?.requestSchema, target.requestPointer) : undefined;
          const comparableP0Schema = normalizedParameterField(p0Schema, p0?.parameterSchema, scalarTypes);
          if (!p0Schema || !wireSchema || JSON.stringify(comparableP0Schema) !== JSON.stringify(normalizedSchema(wireSchema, scalarTypes))) {
            fail(id, `parameter[${entry.source.parameterName}]-schema`, `${JSON.stringify(comparableP0Schema)} vs ${JSON.stringify(normalizedSchema(wireSchema, scalarTypes))}`);
          }
          const isP0Required = p0?.parameterSchema?.required?.includes(entry.source.parameterName) ?? false;
          if (target && isP0Required !== (wireSchema ? isRequiredPointer(resolvedWires[wireIndex]?.requestSchema, target.requestPointer) : false)) {
            fail(id, `parameter[${entry.source.parameterName}]-requiredness`, `${isP0Required} vs ${wireSchema ? isRequiredPointer(resolvedWires[wireIndex]?.requestSchema, target.requestPointer) : false}`);
          }
        }
      } else if (Object.keys(p0?.parameterSchema?.properties ?? {}).length > 0) {
        fail(id, "parameter-fields-resolved-from-source-owned-wire-schema", parameterDisposition ?? "disposition absent");
      }
      const expected = p0?.successOutputs ?? [];
      const actual = resolvedWires.flatMap((wire) => outputTypes(wire.resultSchema));
      const uniqueActual = [...new Set(actual)];
      const outputMapping = operation.outputMapping;
      if (!outputMapping || !outputMapping.success) fail(id, "acknowledgment-output-mapping-present-for-every-existing-operation-binding");
      if (outputMapping?.success) {
        const workflowSteps = outputMapping.workflowSteps ?? [];
        const additionalSuccessMappings = outputMapping.additionalSuccessMappings ?? [];
        if (!Array.isArray(additionalSuccessMappings)) fail(id, "output-mapping-additional-success-is-array");
        const additionalSuccessRows = Array.isArray(additionalSuccessMappings) ? additionalSuccessMappings : [];
        const mappedTargetTypes = new Set([outputMapping.success.targetArtifactType,
          ...additionalSuccessRows.map(({ targetArtifactType }) => targetArtifactType),
          ...workflowSteps.map(({ targetArtifactType }) => targetArtifactType).filter(Boolean)]);
        const mappedSourceTypesOrdered = [
          ...(outputMapping.success.receiptProjection ? [] : [outputMapping.success.sourceArtifactType]),
          ...additionalSuccessRows.map(({ sourceArtifactType }) => sourceArtifactType),
          ...workflowSteps.map(({ sourceArtifactType }) => sourceArtifactType)];
        const mappedSourceTypes = new Set(mappedSourceTypesOrdered);
        const deferred = outputMapping.deferredP0Outputs ?? [];
        if ([...mappedTargetTypes].some((artifactType) => !expected.some((output) => output.artifactType === artifactType))) {
          fail(id, "acknowledged-output-maps-exact-P0-output-types");
        }
        if (JSON.stringify(uniqueActual) !== JSON.stringify([...new Set(mappedSourceTypesOrdered)])) {
          fail(id, "ordered-acknowledgment-output-identities-match-explicit-P0-adapter",
            `${JSON.stringify(uniqueActual)} vs ${JSON.stringify([...new Set(mappedSourceTypesOrdered)])}`);
        }
        for (const output of expected) {
          if (mappedTargetTypes.has(output.artifactType)) continue;
          const deferredOutput = deferred.find(({ artifactType }) => artifactType === output.artifactType);
          if (!deferredOutput || deferredOutput.requiredOnAcknowledgment !== false
            || output.requiredOnSuccess) {
            fail(id, `optional-output[${output.artifactType}]-has-explicit-deferred-observation-disposition`);
          }
        }
        const acknowledgedWireOutcome = outputMapping.wireOutcome;
        const wireOutcomeMap = resolvedWires[0]?.outcomeMapping;
        const mappedOutcome = wireOutcomeMap === undefined
          ? acknowledgedWireOutcome
          : wireOutcomeMap[acknowledgedWireOutcome];
        if (!wireOutcomeIsDeclared(resolvedWires[0]?.resultSchema, acknowledgedWireOutcome)
          || mappedOutcome !== outputMapping.acknowledgedOutcome) {
          fail(id, "acknowledgment-outcome-matches-wire-outcome-adapter");
        }
        const primaryP0Output = expected.find(({ artifactType }) =>
          artifactType === outputMapping.success.targetArtifactType);
        const mappedRequired = primaryP0Output?.requiredOnSuccess === true;
        if (mappedRequired && !outputMapping.success.receiptProjection && !resolvedWires.some((wire) => successRequiresOutput(
          wire.resultSchema, outputMapping.success.sourceArtifactType, acknowledgedWireOutcome,
        ))) fail(id, `success-output[${outputMapping.success.sourceArtifactType}]-required-on-${outputMapping.acknowledgedOutcome}`);
        validateAcknowledgmentOutputMapping(id, intent, operation, resolvedWires, outputMapping, { [CAP_PATH]: capabilities, [OPS_PATH]: operations }, fail);
      } else {
        if (JSON.stringify(expected.map(({ artifactType }) => artifactType)) !== JSON.stringify(uniqueActual)) {
          fail(id, "ordered-success-output-identities-from-source-owned-results", `${JSON.stringify(expected.map(({ artifactType }) => artifactType))} vs ${JSON.stringify(uniqueActual)}`);
        }
        for (const output of expected) {
          if (output.requiredOnSuccess && !resolvedWires.some((wire) => successRequiresOutput(wire.resultSchema, output.artifactType))) {
            fail(id, `success-output[${output.artifactType}]-required-on-success`);
          } else if (!output.requiredOnSuccess && resolvedWires.some((wire) => successRequiresOutput(wire.resultSchema, output.artifactType))) {
            fail(id, `success-output[${output.artifactType}]-remains-optional-on-success`);
          }
        }
      }
      validateProjectOutputContract(id, operation, resolvedWires, fail);
    } else fail(id, "supported-operation-record-kind", operation.recordKind);
  }
  for (const id of contractByCapability.keys()) if (!capById.has(id)) fail(id, "P0-capability-exists");
  const remainingIssues = issues.filter((issue) => !ignoredIssues(issue));
  return remainingIssues;
}

function validateTypedInputMappings(id, intent, operation, wires, scalarTypes, selectedAction, documents, fail) {
  const contract = operation.typedInputMappings;
  const slots = intent.ownerDefinition?.typedInputSlots ?? [];
  const parameters = Object.keys(intent.ownerDefinition?.parameterSchema?.properties ?? []);
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail(id, "typed-input-mapping-contract-present", "missing typedInputMappings object");
    return;
  }
  if (contract.sourceCapabilityRef !== `${CAP_PATH}#capabilities/@id=${id}`) fail(id, "typed-input-mapping-source-capability-ref");
  if (contract.slotSelectorRef !== `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/typedInputSlots`) fail(id, "typed-input-mapping-slot-selector-ref");
  if (contract.parameterSelectorRef !== `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/parameterSchema/properties`) fail(id, "typed-input-mapping-parameter-selector-ref");
  const entries = contract.entries ?? [];
  const seenSources = new Set();
  const targeted = new Map();
  const unqualifiedTargets = new Map();
  const optionalTargets = new Set();
  const optionalObjectTargets = new Set();
  const slotTargetRequiredness = new Map();
  const slotsWithWireTargets = new Set();
  const origins = { mappedFromP0: 0, trustedContext: 0, generatedProtocol: 0, ownerResolved: 0, outsideSelectedActionScope: 0, unresolved: 0, operationSelection: 0, preconditionOnly: 0 };
  for (const entry of entries) {
    const source = entry.source;
    const sourceKey = source?.kind === "P0_SLOT" ? `slot:${source.slotId}`
      : source?.kind === "P0_PARAMETER" ? `parameter:${source.parameterName}` : undefined;
    if (!sourceKey || seenSources.has(sourceKey)) fail(id, "typed-input-mapping-source-unique", sourceKey ?? "invalid source");
    if (sourceKey) seenSources.add(sourceKey);
    const expectedRef = source?.kind === "P0_SLOT"
      ? `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/typedInputSlots/@slotId=${source.slotId}`
      : source?.kind === "P0_PARAMETER"
        ? `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/parameterSchema/properties/${source.parameterName}` : undefined;
    if (!expectedRef || source.sourceRef !== expectedRef) fail(id, "typed-input-mapping-exact-P0-source-ref", `${source?.sourceRef ?? "missing"}`);
    const p0Slot = source?.kind === "P0_SLOT" ? slots.find(({ slotId }) => slotId === source.slotId) : undefined;
    const p0Parameter = source?.kind === "P0_PARAMETER" ? intent.ownerDefinition?.parameterSchema?.properties?.[source.parameterName] : undefined;
    if (source?.kind === "P0_SLOT" && (!p0Slot || entry.cardinality !== p0Slot.cardinality)) fail(id, `typed-input-mapping-slot-cardinality[${source.slotId}]`);
    if (source?.kind === "P0_PARAMETER" && !p0Parameter) fail(id, `typed-input-mapping-parameter-exists[${source.parameterName}]`);
    if (!(["DIRECT", "SELECTOR", "EXPLICIT_PROJECTION"].includes(entry.mappingMode))) fail(id, `typed-input-mapping-mode[${sourceKey}]`);
    if (entry.valueOrigin !== "P0_DERIVED") fail(id, `typed-input-mapping-value-origin[${sourceKey}]`);
    if (typeof entry.evidence?.rationale !== "string" || !entry.evidence.rationale.trim()) fail(id, `typed-input-mapping-evidence-rationale[${sourceKey}]`);
    const targets = entry.targets ?? [];
    if (!targets.length) {
      if (source?.kind === "P0_SLOT" && entry.mappingDisposition === "ACTION_SELECTION_ONLY"
        && p0Slot?.sourceType === "user-intent"
        && contract.selectedAction?.actionRef === selectedAction?.id
        && entry.valueOrigin === "P0_DERIVED" && typeof entry.evidence?.rationale === "string"
        && entry.evidence.rationale.trim()) origins.operationSelection++;
      else if (source?.kind === "P0_SLOT" && entry.mappingDisposition === "OWNER_PRECONDITION_ONLY"
        && p0Slot && entry.valueOrigin === "P0_DERIVED"
        && resolveOwnerPrecondition(entry, p0Slot, operation, documents)) origins.preconditionOnly++;
      else fail(id, `typed-input-mapping-targets[${sourceKey}]`);
    }
    if (entry.mappingDisposition === "ACTION_SELECTION_ONLY" && (source?.kind !== "P0_SLOT" || p0Slot?.sourceType !== "user-intent")) {
      fail(id, `typed-input-action-selection-only-source[${sourceKey}]`);
    }
    for (const target of targets) {
      if (!hasExactKeys(target, ["operationRef", "step", "requestPointer", "required"], ["requestSection", "branch"])) {
        fail(id, `typed-input-mapping-target-uses-closed-shape[${sourceKey}]`);
      }
      if (Object.hasOwn(target, "branch") && (id !== "media.provenance.source-lineage.inspect"
        || ![["artifact", "/subject/payload/artifactId"], ["artifact", "/subject/payload/versionId"],
          ["execution-reference", "/subject/payload/reference"]].some(([branch, branchPointer]) =>
          target.branch === branch && target.requestPointer === branchPointer))) {
        fail(id, `typed-input-mapping-branch-selector-is-exact[${sourceKey}]`);
      }
      const stepIndex = (operation.operationRefs ?? []).indexOf(target.operationRef);
      if (stepIndex < 0 || target.step !== stepIndex + 1) fail(id, `typed-input-mapping-target-step[${sourceKey}]`, `${target.operationRef}/${target.step}`);
      const wireIndex = stepIndex;
      const wire = wireIndex >= 0 ? wires[wireIndex] : undefined;
      const expectedWireRef = operation.canonicalWireSchemaRefs?.[wireIndex];
      if (!wire || entry.evidence?.wireSchemaRef !== expectedWireRef) fail(id, `typed-input-mapping-evidence-wire-ref[${sourceKey}]`);
      const requestSection = target.requestSection ?? "body";
      const requestSchema = wire && requestSchemaForSection(wire, requestSection);
      const pointer = target.requestPointer;
      const resolved = requestSchema && resolveJsonPointer(requestSchema, pointer);
      if (!resolved) fail(id, `typed-input-mapping-target-pointer[${sourceKey}]`, `${target.operationRef}${pointer}`);
      else {
        if (entry.mappingMode === "DIRECT" && !directMappingIsStructurallyCompatible(
          source, p0Slot, p0Parameter, pointer, resolved, scalarTypes,
        )) fail(id, `typed-input-mapping-direct-source-target-compatible[${sourceKey}]`, pointer);
        if (id === "media.artifact.upload" && source?.kind === "P0_SLOT" && source.slotId === "input3"
          && pointer === "/expectedSha256") {
          const decisionRef = entry.evidence?.decisionRef;
          const decision = resolveSourceRef(decisionRef, documents);
          const digestTargetValid = target.operationRef === "media.operation-slice.begin-upload"
            && requestSection === "body" && resolved?.type === "string"
            && resolved.pattern === "^[0-9a-fA-F]{64}$" && resolved.minLength === 64 && resolved.maxLength === 64;
          if (source.sourceRef !== `${CAP_PATH}#capabilities/@id=media.artifact.upload/ownerDefinition/typedInputSlots/@slotId=input3`
            || entry.mappingMode !== "EXPLICIT_PROJECTION"
            || decisionRef !== `${DECISION_PATH}#PXD-146`
            || typeof decision !== "string"
            || !/accept P0's prefixed SHA-256 only after validating the complete digest and removing exactly the `sha256:` prefix/iu.test(decision)
            || entry.evidence?.wireSchemaRef !== operation.canonicalWireSchemaRefs?.[wireIndex]
            || Object.hasOwn(source, "sourcePointer") || !digestTargetValid) {
            fail(id, "upload-digest-projection-is-authorized-by-PXD-146-and-exact-wire-schema", pointer);
          }
        }
        const actualRequired = isRequiredPointer(requestSchema, pointer);
        if (target.required !== actualRequired) fail(id, `typed-input-mapping-target-requiredness[${sourceKey}]`, `${pointer}: ${target.required} vs ${actualRequired}`);
        if (source?.kind === "P0_SLOT") {
          slotsWithWireTargets.add(sourceKey);
          const requiredTargets = slotTargetRequiredness.get(sourceKey) ?? 0;
          slotTargetRequiredness.set(sourceKey, requiredTargets + (actualRequired ? 1 : 0));
        }
        const targetKey = requestTargetKey(target.operationRef, requestSection, pointer);
        targeted.set(targetKey, (targeted.get(targetKey) ?? 0) + 1);
        const unqualifiedKey = `${target.operationRef}#${pointer}`;
        unqualifiedTargets.set(unqualifiedKey, (unqualifiedTargets.get(unqualifiedKey) ?? 0) + 1);
        if (actualRequired) origins.mappedFromP0++;
        else if (isWireLeafSchema(resolved)) optionalTargets.add(targetKey);
        else if (id === "media.job.submit" && source?.kind === "P0_SLOT" && source.slotId === "input1"
          && ["/directRequestFields", "/projectContext"].includes(pointer)
          && requestSection === "body" && resolved.type === "object") optionalObjectTargets.add(targetKey);
      }
    }
  }
  for (const slot of slots) if (!seenSources.has(`slot:${slot.slotId}`)) fail(id, `typed-input-mapping-missing-P0-slot[${slot.slotId}]`);
  for (const slot of slots) {
    const sourceKey = `slot:${slot.slotId}`;
    const requiredTargets = slotTargetRequiredness.get(sourceKey) ?? 0;
    if (slot.required === true && slotsWithWireTargets.has(sourceKey) && requiredTargets === 0) {
      fail(id, `typed-input-mapping-required-slot-has-required-target[${slot.slotId}]`);
    }
    if (slot.required !== true && requiredTargets > 0) {
      const entry = entries.find(({ source }) => source?.kind === "P0_SLOT" && source.slotId === slot.slotId);
      const boundOperation = documents[OPS_PATH].operations?.find(({ id: operationId }) => operationId === operation.operationRefs?.[0]);
      const conditional = operation.inputSlotMapping;
      const explicitAbsentBranch = id === "media.speech.transcription.file"
        && slot.slotId === "input2"
        && entry?.cardinality === "ZERO_OR_ONE"
        && entry?.mappingMode === "EXPLICIT_PROJECTION"
        && entry?.mappingDisposition === "EXACT_PROFILE_AND_LANGUAGE_INTENT_PROJECTION"
        && conditional?.p0Cardinality === "ZERO_OR_ONE"
        && conditional?.p0Required === false
        && /before-construction-of-operation-request/iu.test(conditional?.boundary ?? "")
        && /explicit-BCP-47-language-intent-or-explicit-AUTO_REQUESTED-and-exact-profileId-profileVersion-profileConfigurationDigest/iu.test(conditional?.present ?? "")
        && /UNSUPPORTED_PROFILE.*before-operation-request.*job.*receipt.*dispatch/iu.test(conditional?.absent ?? "")
        && /do-not-default-infer-or-map-to-AUTO_REQUESTED/iu.test(conditional?.absent ?? "")
        && (boundOperation?.error?.definitivePreDispatchCodes ?? []).includes("UNSUPPORTED_PROFILE");
      if (!explicitAbsentBranch) fail(id, `typed-input-mapping-optional-slot-not-required-target[${slot.slotId}]`);
    }
  }
  for (const name of parameters) if (!seenSources.has(`parameter:${name}`)) fail(id, `typed-input-mapping-missing-P0-parameter[${name}]`);
  for (const key of targeted.keys()) if (targeted.get(key) > 1) fail(id, "typed-input-mapping-duplicate-target", key);
  for (const [key, count] of unqualifiedTargets) if (count > 1) fail(id, "typed-input-mapping-body-header-duplicate-target", key);

  const dispositions = contract.requestFieldDispositions ?? [];
  const dispositionByTarget = new Map();
  const unqualifiedDispositions = new Map();
  for (const disposition of dispositions) {
    if (!hasExactKeys(disposition, ["operationRef", "step", "requestPointer", "valueOrigin", "disposition", "rationale", "sourceRef"], ["requestSection"])) {
      fail(id, "typed-input-disposition-uses-closed-shape");
    }
    const requestSection = disposition.requestSection ?? "body";
    const targetKey = requestTargetKey(disposition.operationRef, requestSection, disposition.requestPointer);
    const unqualifiedKey = `${disposition.operationRef}#${disposition.requestPointer}`;
    unqualifiedDispositions.set(unqualifiedKey, (unqualifiedDispositions.get(unqualifiedKey) ?? 0) + 1);
    if (dispositionByTarget.has(targetKey)) fail(id, "typed-input-disposition-unique", targetKey);
    dispositionByTarget.set(targetKey, disposition);
    const stepIndex = (operation.operationRefs ?? []).indexOf(disposition.operationRef);
    const wire = stepIndex >= 0 ? wires[stepIndex] : undefined;
    const requestSchema = wire && requestSchemaForSection(wire, requestSection);
    if (!wire || disposition.step !== stepIndex + 1 || !requestSchema || !resolveJsonPointer(requestSchema, disposition.requestPointer)) fail(id, "typed-input-disposition-target-resolves", targetKey);
    if (!["TRUSTED_TRANSPORT_CONTEXT", "GENERATED_PROTOCOL_VALUE", "OWNER_RESOLVED_FROM_P0_REFERENCE", "OUTSIDE_SELECTED_CAPABILITY_ACTION_SCOPE", "P0_SCHEMA_INCOMPLETE"].includes(disposition.valueOrigin)) fail(id, "typed-input-disposition-origin", targetKey);
    if (typeof disposition.disposition !== "string" || !disposition.disposition.trim() || typeof disposition.rationale !== "string" || !disposition.rationale.trim() || typeof disposition.sourceRef !== "string" || !disposition.sourceRef.trim()) fail(id, "typed-input-disposition-evidence", targetKey);
    const sourceLocation = resolveSourceRef(disposition.sourceRef, documents);
    if (sourceLocation === undefined) fail(id, "typed-input-disposition-source-ref-resolves", disposition.sourceRef ?? targetKey);
    else if (!dispositionOriginIsSupported(disposition, sourceLocation, selectedAction)) {
      fail(id, "typed-input-disposition-origin-source-semantics", `${disposition.valueOrigin}: ${disposition.sourceRef}`);
    }
    if (requestSection === "headers" && (disposition.valueOrigin !== "GENERATED_PROTOCOL_VALUE"
      || !isExactOwnerReplayIdentityRef(disposition.sourceRef, operation, documents))) {
      fail(id, "generated-header-sourced-from-exact-owner-request-identity", targetKey);
    }
    if (disposition.valueOrigin === "TRUSTED_TRANSPORT_CONTEXT") origins.trustedContext++;
    if (disposition.valueOrigin === "GENERATED_PROTOCOL_VALUE") origins.generatedProtocol++;
    if (disposition.valueOrigin === "OWNER_RESOLVED_FROM_P0_REFERENCE") origins.ownerResolved++;
    if (disposition.valueOrigin === "OUTSIDE_SELECTED_CAPABILITY_ACTION_SCOPE") origins.outsideSelectedActionScope++;
    if (disposition.valueOrigin === "P0_SCHEMA_INCOMPLETE") origins.unresolved++;
  }
  const required = wires.flatMap((wire, index) => ["body", "headers"].flatMap((requestSection) => {
    const schema = requestSchemaForSection(wire, requestSection);
    return requiredWireLeafPointers(schema).map((pointer) => ({
      key: requestTargetKey(operation.operationRefs[index], requestSection, pointer),
      operationRef: operation.operationRefs[index], step: index + 1, pointer, requestSection,
    }));
  }));
  for (const leaf of required) {
    if ((targeted.get(leaf.key) ?? 0) + (dispositionByTarget.has(leaf.key) ? 1 : 0) !== 1) fail(id, "required-wire-leaf-covered-exactly-once", leaf.key);
  }
  for (const key of [...targeted.keys(), ...dispositionByTarget.keys()]) {
    if (!required.some((leaf) => leaf.key === key) && !optionalTargets.has(key) && !optionalObjectTargets.has(key)) {
      fail(id, "mapping-or-disposition-targets-required-wire-leaf", key);
    }
  }
  for (const key of new Set([...unqualifiedTargets.keys(), ...unqualifiedDispositions.keys()])) {
    if ((unqualifiedTargets.get(key) ?? 0) + (unqualifiedDispositions.get(key) ?? 0) > 1) {
      fail(id, "typed-input-mapping-body-header-duplicate-target", key);
    }
  }
  const coverage = contract.coverage ?? {};
  const expectedCoverage = {
    requiredFields: required.length,
    mappedFromP0: required.filter(({ key }) => targeted.has(key)).length,
    optionalMappedFromP0: optionalTargets.size,
    trustedContext: origins.trustedContext,
    generatedProtocol: origins.generatedProtocol,
    ownerResolved: origins.ownerResolved,
    outsideSelectedActionScope: origins.outsideSelectedActionScope,
    unresolved: origins.unresolved,
    operationSelection: origins.operationSelection,
    preconditionOnly: origins.preconditionOnly,
  };
  for (const [key, value] of Object.entries(expectedCoverage)) {
    if (["optionalMappedFromP0", "preconditionOnly"].includes(key) && value === 0 && coverage[key] === undefined) continue;
    if (coverage[key] !== value) fail(id, `typed-input-coverage-${key}`, `${coverage[key]} vs ${value}`);
  }
  const complete = expectedCoverage.unresolved === 0 && required.every(({ key }) => (targeted.has(key) ? 1 : 0) + (dispositionByTarget.has(key) ? 1 : 0) === 1);
  if (coverage.status !== (complete ? "COMPLETE" : "INCOMPLETE")) fail(id, "typed-input-coverage-status", `${coverage.status} vs ${complete ? "COMPLETE" : "INCOMPLETE"}`);
}

function requestTargetKey(operationRef, section, pointer) {
  return `${operationRef}#${section === "body" ? "body" : section}${pointer}`;
}

function requestSchemaForSection(wire, section) {
  if (section === "body") return wire?.requestSchema;
  if (section === "headers") return wire?.requestHeadersSchema;
  return undefined;
}

function resolveJsonPointer(schema, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  const parts = pointer.slice(1).split("/").map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  const descend = (current, index) => {
    if (!current || typeof current !== "object") return undefined;
    if (index === parts.length) return current;
    const key = parts[index];
    const direct = key === "*" ? current.items : current.properties?.[key];
    const found = descend(direct, index + 1);
    if (found) return found;
    for (const branch of [...(current.allOf ?? []), ...(current.oneOf ?? []), ...(current.anyOf ?? []), current.then, current.else]) {
      const branchFound = descend(branch, index);
      if (branchFound) return branchFound;
    }
    return undefined;
  };
  return descend(schema, 0);
}

function isRequiredPointer(schema, pointer) {
  return requiredWireLeafPointers(schema).includes(pointer);
}

function isWireLeafSchema(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type === "object" || schema.properties) return false;
  return !schema.allOf?.length && !schema.oneOf?.length && !schema.anyOf?.length;
}

function requiredWireLeafPointers(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const result = [];
  const propertyFor = (node, key) => {
    if (!node || typeof node !== "object") return undefined;
    if (node.properties?.[key]) return node.properties[key];
    for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? []), node.then, node.else]) {
      const property = propertyFor(branch, key);
      if (property) return property;
    }
    return undefined;
  };
  for (const key of schema.required ?? []) {
    const pointer = `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const property = propertyFor(schema, key);
    if (property && (property.type === "object" || property.properties || property.allOf || property.oneOf || property.anyOf)
      && (property.required?.length || property.allOf?.length || property.oneOf?.length || property.anyOf?.length)) {
      result.push(...requiredWireLeafPointers(property, pointer));
    }
    else result.push(pointer);
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of schema[key] ?? []) result.push(...requiredWireLeafPointers(branch, prefix));
  }
  // A `then` or `else` requirement is conditional on the request instance,
  // but every such possible required field still needs an explicit mapping or
  // disposition. The `if` schema itself is a predicate, not a requirement.
  for (const branch of [schema.then, schema.else]) if (branch) result.push(...requiredWireLeafPointers(branch, prefix));
  for (const branch of Object.values(schema.dependentSchemas ?? {})) result.push(...requiredWireLeafPointers(branch, prefix));
  return [...new Set(result)];
}

function pointerLeaf(pointer) {
  return pointer.split("/").at(-1)?.replace(/~1/g, "/").replace(/~0/g, "~");
}

function primitiveSchemaType(schema, scalarTypes) {
  if (typeof schema?.type === "string") {
    if (primitiveTypes.has(schema.type)) return schema.type;
    const validator = scalarTypes[schema.type]?.validator;
    return primitiveTypes.has(validator?.type) ? validator.type : undefined;
  }
  return undefined;
}

// DIRECT means the P0 value is sent unchanged. For direct parameter mappings,
// require the same field name and JSON primitive shape. For typed slots, check
// primitive shape when P0 names a registered scalar; projections/selectors are
// intentionally exempt because they may transform or extract a value.
function directMappingIsStructurallyCompatible(source, slot, parameter, pointer, targetSchema, scalarTypes) {
  if (source?.kind === "P0_PARAMETER") {
    if (pointerLeaf(pointer) !== source.parameterName) return false;
    const sourceType = primitiveSchemaType(parameter, scalarTypes);
    const targetType = primitiveSchemaType(targetSchema, scalarTypes);
    return !sourceType || !targetType || sourceType === targetType;
  }
  if (source?.kind === "P0_SLOT") {
    const sourceType = scalarTypes[slot?.sourceType]?.validator?.type;
    const targetType = primitiveSchemaType(targetSchema, scalarTypes);
    return !primitiveTypes.has(sourceType) || !targetType || sourceType === targetType;
  }
  return false;
}

function compareParameters(id, p0, p1, scalarTypes, fail) {
  if (!p0 || !p1) { fail(id, "parameter-schema-present-on-both-sides"); return; }
  const p0Names = Object.keys(p0.properties ?? {}).sort();
  const p1Names = Object.keys(p1.properties ?? {}).sort();
  if (JSON.stringify(p0Names) !== JSON.stringify(p1Names)) fail(id, "parameter-property-population", `${p0Names.join(",")} vs ${p1Names.join(",")}`);
  if (JSON.stringify([...(p0.required ?? [])].sort()) !== JSON.stringify([...(p1.required ?? [])].sort())) fail(id, "parameter-required-population", `${(p0.required ?? []).join(",")} vs ${(p1.required ?? []).join(",")}`);
  for (const name of new Set([...p0Names, ...p1Names])) {
    const left = normalizedParameterField(p0.properties?.[name], p0, scalarTypes);
    const right = normalizedSchema(p1.properties?.[name], scalarTypes);
    if (JSON.stringify(left) !== JSON.stringify(right)) fail(id, `parameter[${name}]-schema`, `${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
}

function validateAcknowledgmentOutputMapping(id, intent, operation, wires, outputMapping, documents, fail) {
  if (!hasExactKeys(outputMapping, ["sourceCapabilityRef", "wireOutcome", "acknowledgedOutcome", "success", "deferredP0Outputs"], ["workflowSteps", "additionalSuccessMappings", "transcriptDraft", "recognitionEvidence"])) {
    fail(id, "output-mapping-uses-closed-explicit-shape");
  }
  const p0Outputs = intent.ownerDefinition?.successOutputs ?? [];
  const expectedCapabilityRef = `${CAP_PATH}#capabilities/@id=${id}`;
  if (outputMapping.sourceCapabilityRef !== expectedCapabilityRef
    || resolveSourceRef(outputMapping.sourceCapabilityRef, documents)?.id !== id) {
    fail(id, "output-mapping-source-capability-ref-resolves");
  }
  const wireRefs = operation.canonicalWireSchemaRefs ?? [];
  const source = outputMapping.success ?? {};
  if (!hasExactKeys(source, ["sourceWireRef", "sourceArtifactType", "targetOutputRef", "targetArtifactType", "identityProjection"], ["additionalEvidenceRefs", "receiptProjection", "outputProjection", "targetIdentity"])) {
    fail(id, "output-mapping-success-uses-closed-explicit-shape");
  }
  const sourceWireIndex = wireRefs.indexOf(source.sourceWireRef?.replace(/\/resultSchema$/u, ""));
  const sourceWire = sourceWireIndex >= 0 ? wires[sourceWireIndex] : undefined;
  const sourceResultRef = source.sourceWireRef;
  const expectedSourceResultRef = sourceWireIndex >= 0 ? `${wireRefs[sourceWireIndex]}/resultSchema` : undefined;
  const sourceResultSchema = sourceWire && typeof sourceResultRef === "string" && (sourceResultRef.endsWith("/resultSchema")
    ? resolveSourceRef(sourceResultRef, documents)
    : sourceWire.resultSchema);
  const receiptProjection = source.receiptProjection;
  const outputProjection = source.outputProjection;
  const sourceBranch = receiptProjection ? undefined : findOutputBranch(sourceResultSchema, source.sourceArtifactType);
  const sourcePayload = sourceBranch?.properties?.payload;
  if (!sourceWire || !sourceResultSchema || (!sourceBranch && !receiptProjection)
    || sourceResultRef !== expectedSourceResultRef) {
    fail(id, "output-mapping-source-wire-result-ref-resolves");
  }
  const targetRef = source.targetOutputRef;
  const targetRow = resolveSourceRef(targetRef, documents);
  const expectedTargetRef = `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${source.targetArtifactType}`;
  const p0Target = p0Outputs.find(({ artifactType }) => artifactType === source.targetArtifactType);
  if (targetRef !== expectedTargetRef || !targetRow || targetRow.artifactType !== source.targetArtifactType
    || !p0Target || targetRow.requiredOnSuccess !== p0Target.requiredOnSuccess
    || p0Target.requiredOnSuccess !== (receiptProjection ? true
      : successRequiresOutput(sourceResultSchema, source.sourceArtifactType, outputMapping.wireOutcome))) {
    fail(id, "output-mapping-target-is-exact-required-P0-output-ref");
  }
  if (receiptProjection) {
    if (source.sourceArtifactType !== receiptProjection.sourceOutcome) fail(id, "output-mapping-receipt-source-outcome-is-exact");
  } else if (source.sourceArtifactType !== sourceBranch?.properties?.artifactType?.const) {
    fail(id, "output-mapping-source-artifact-type-matches-wire-branch");
  }
  const projectionRows = source.identityProjection ?? [];
  if (!projectionRows.length && !receiptProjection && !outputProjection) fail(id, "output-mapping-has-identity-projection-evidence");
  for (const projection of projectionRows) {
    if (!hasExactKeys(projection, ["sourcePointer", "sourceOutputRef", "evidenceRef", "evidencePointer", "operator"])) {
      fail(id, "output-mapping-projection-uses-closed-explicit-shape");
    }
    const sourcePointer = projection.sourcePointer;
    const sourceField = resolveJsonPointer(sourcePayload, sourcePointer);
    const evidenceRef = projection.evidenceRef;
    const evidencePointer = projection.evidencePointer;
    const evidenceSchema = resolveOutputEvidenceSchema(evidenceRef, operation, wires, documents);
    const evidenceField = evidenceSchema && resolveJsonPointer(evidenceSchema, evidencePointer);
    const projectionRef = projection.sourceOutputRef;
    const isReceiptIdentity = projection.operator === "OWNER_ISSUED_RECEIPT_IDENTITY"
      && isExactSourcePayloadEvidenceRef(evidenceRef, sourceResultRef, sourcePayload, documents)
      && evidencePointer === sourcePointer && evidenceField === sourceField
      && isRequiredPointer(sourcePayload, sourcePointer)
      && canEstablishReceiptIdentity(sourceField);
    const isExactEcho = projection.operator === "EXACT_EQUAL"
      && typeof evidenceRef === "string"
      && evidenceRef.endsWith("/requestSchema")
      && pointerLeaf(sourcePointer) === pointerLeaf(evidencePointer)
      && JSON.stringify(stable(normalizedSchema(sourceField, {}))) === JSON.stringify(stable(normalizedSchema(evidenceField, {})))
      && hasExactResultRequestBinding(sourceWire, sourcePointer, evidencePointer);
    if (projectionRef !== targetRef || !sourceField || !evidenceField || !(isReceiptIdentity || isExactEcho)) {
      fail(id, "output-mapping-field-projection-is-exact-and-resolvable", `${sourcePointer} -> ${evidenceRef}${evidencePointer}`);
    }
  }
  const typedOutput = (documents[OPS_PATH].capabilityOperationContracts.outputPayloadSchemas ?? [])
    .find(({ artifactType }) => artifactType === source.targetArtifactType);
  const targetPayload = typedOutput?.schema?.properties?.payload;
  if (receiptProjection) {
    const outcomeBranch = (sourceResultSchema?.oneOf ?? []).find(({ properties }) =>
      properties?.outcome?.const === receiptProjection.sourceOutcome);
    const sourceField = outcomeBranch && resolveJsonPointer(outcomeBranch, receiptProjection.sourcePointer);
    const targetField = targetPayload && resolveJsonPointer(targetPayload, receiptProjection.targetPointer);
    if (!hasExactKeys(receiptProjection, ["sourceOutcome", "sourcePointer", "targetOutputRef", "targetArtifactType", "targetPointer", "operator"])
      || receiptProjection.sourceOutcome !== "REQUEST_ACKNOWLEDGED"
      || receiptProjection.sourcePointer !== "/jobId"
      || receiptProjection.targetPointer !== "/jobId"
      || receiptProjection.targetArtifactType !== "accepted-media-job-reference-and-admission-observation"
      || receiptProjection.targetOutputRef !== targetRef
      || source.targetArtifactType !== receiptProjection.targetArtifactType
      || receiptProjection.operator !== "OWNER_ISSUED_RECEIPT_IDENTITY"
      || !sourceField || !targetField
      || !isRequiredPointer(outcomeBranch, receiptProjection.sourcePointer)
      || !isRequiredPointer(typedOutput.schema, `/payload${receiptProjection.targetPointer}`)
      || JSON.stringify(stable(normalizedSchema(sourceField, {}))) !== JSON.stringify(stable(normalizedSchema(targetField, {})))) {
      fail(id, "output-mapping-receipt-projection-is-exact-and-resolvable");
    }
  }
  if (outputProjection) {
    const sourceKindBranch = (sourcePayload?.oneOf ?? []).find(({ properties }) =>
      properties?.kind?.const === outputProjection.sourceBranchKind);
    const targetKindBranch = (targetPayload?.oneOf ?? []).find(({ properties }) =>
      properties?.kind?.const === outputProjection.targetBranchKind);
    const sourceField = sourceKindBranch && resolveJsonPointer(sourceKindBranch, outputProjection.sourcePointer);
    const targetField = targetKindBranch && resolveJsonPointer(targetKindBranch, outputProjection.targetPointer);
    if (!hasExactKeys(outputProjection, ["sourceBranchKind", "sourcePointer", "targetOutputRef", "targetArtifactType", "targetBranchKind", "targetPointer", "operator"])
      || source.sourceArtifactType !== "governed-artifact-reference-or-lifecycle-observation"
      || source.targetArtifactType !== source.sourceArtifactType
      || outputProjection.sourceBranchKind !== "lifecycle-observation"
      || outputProjection.targetBranchKind !== "lifecycle-observation"
      || outputProjection.sourcePointer !== "/jobId"
      || outputProjection.targetPointer !== "/reference"
      || outputProjection.targetOutputRef !== targetRef
      || outputProjection.targetArtifactType !== source.targetArtifactType
      || outputProjection.operator !== "EXACT_OPAQUE_REFERENCE_VALUE"
      || !sourceField || !targetField
      || !isRequiredPointer(sourceKindBranch, outputProjection.sourcePointer)
      || !isRequiredPointer(targetKindBranch, outputProjection.targetPointer)
      || sourceField.type !== "string" || targetField.type !== "string"
      || sourceField.format !== "opaque-id" || targetField.format !== "opaque-versioned-reference") {
      fail(id, "output-mapping-branch-projection-is-exact-and-resolvable");
    }
  }
  const additionalEvidenceRefs = source.additionalEvidenceRefs ?? [];
  for (const evidence of additionalEvidenceRefs) {
    if (!hasExactKeys(evidence, ["sourceRef", "pointer", "role"])) fail(id, "output-mapping-additional-evidence-uses-closed-shape");
    const evidenceSchema = resolveOutputEvidenceSchema(evidence.sourceRef, operation, wires, documents);
    const field = evidenceSchema && resolveJsonPointer(evidenceSchema, evidence.pointer);
    const transcriptionReceiptField = id === "media.speech.transcription.file"
      && evidence.sourceRef === sourceResultRef
      && ["/submissionReceiptId", "/requestFingerprint"].includes(evidence.pointer)
      && field && isRequiredPointer(sourceResultSchema, evidence.pointer);
    const exactPayloadEvidence = evidence.sourceRef === sourceResultRef
      && isRequiredPointer(sourcePayload, evidence.pointer)
      && isExactSourcePayloadEvidenceRef(evidence.sourceRef, sourceResultRef, sourcePayload, documents);
    if (!field || !(exactPayloadEvidence || transcriptionReceiptField)
      || !["RECEIPT_FIELD", "ADMISSION_EVIDENCE"].includes(evidence.role)) {
      fail(id, "output-mapping-additional-evidence-is-exact-source-field", `${evidence.sourceRef}${evidence.pointer}`);
    }
  }
  const rawAdditionalSuccessMappings = outputMapping.additionalSuccessMappings ?? [];
  if (!Array.isArray(rawAdditionalSuccessMappings)) fail(id, "output-mapping-additional-success-is-array");
  const additionalSuccessMappings = Array.isArray(rawAdditionalSuccessMappings) ? rawAdditionalSuccessMappings : [];
  const seenSuccessTargets = new Set([source.targetArtifactType]);
  for (const [index, additional] of additionalSuccessMappings.entries()) {
    if (seenSuccessTargets.has(additional.targetArtifactType)) fail(id, "output-mapping-success-targets-are-unique", additional.targetArtifactType);
    seenSuccessTargets.add(additional.targetArtifactType);
    validateAdditionalSuccessOutputMapping(id, intent, operation, wires, outputMapping, additional, index, documents, fail);
  }
  for (const [index, step] of (outputMapping.workflowSteps ?? []).entries()) {
    if (!step.targetArtifactType) continue;
    if (seenSuccessTargets.has(step.targetArtifactType)) {
      const exactResumeAlias = id === "media.artifact.upload.resume" && index === 0
        && outputSuccessAliasesWorkflowStep(outputMapping.success, step);
      if (!exactResumeAlias) fail(id, "output-mapping-success-targets-are-unique", step.targetArtifactType);
    } else seenSuccessTargets.add(step.targetArtifactType);
  }
  const mappedOutputTypes = new Set([source.targetArtifactType,
    ...additionalSuccessMappings.map(({ targetArtifactType }) => targetArtifactType),
    ...(outputMapping.workflowSteps ?? []).map(({ targetArtifactType }) => targetArtifactType).filter(Boolean)]);
  const expectedDeferred = p0Outputs.filter(({ artifactType, requiredOnSuccess }) => !mappedOutputTypes.has(artifactType) && !requiredOnSuccess);
  const deferred = outputMapping.deferredP0Outputs ?? [];
  const deferredTypes = deferred.map(({ artifactType }) => artifactType);
  if (new Set(deferredTypes).size !== deferredTypes.length
    || JSON.stringify([...deferredTypes].sort()) !== JSON.stringify(expectedDeferred.map(({ artifactType }) => artifactType).sort())) {
    fail(id, "acknowledgment-deferred-outputs-equal-exact-P0-optional-set", JSON.stringify(deferredTypes));
  }
  if (p0Outputs.some(({ artifactType, requiredOnSuccess }) => !mappedOutputTypes.has(artifactType) && requiredOnSuccess)) {
    fail(id, "output-mapping-does-not-defer-unmapped-required-P0-output");
  }
  for (const output of deferred) {
    const expectedRef = `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${output.artifactType}`;
    const row = resolveSourceRef(output.outputRef, documents);
    const receipt = output.receiptCondition ?? {};
    const receiptWireRef = receipt.sourceWireRef;
    const receiptSchema = resolveCanonicalWireResultSchema(receiptWireRef, operation, wires, documents);
    const receiptBranch = findOutputBranch(receiptSchema, receipt.sourceArtifactType);
    const receiptPayload = receiptBranch?.properties?.payload;
    const requiredFields = receipt.requiredFields ?? [];
    const exactRegistrationReceipt = output.artifactType === "artifact-version-reference-only-after-owner-confirmed-registration"
      ? receiptWireRef?.includes("/@id=media.operation.artifact.output.register.v1/ownerWireSchema/resultSchema")
        && /(?:artifact|version|registration)/u.test(receipt.sourceArtifactType ?? "")
      : true;
    const hasReceiptCondition = Object.hasOwn(output, "receiptCondition");
    const sourceDeclaredCondition = !hasReceiptCondition
      && /(?:verification|quarantine).*only-if-issued-by-owner-contract/u.test(output.artifactType)
      && output.disposition === "IF_ISSUED_BY_OWNER_CONTRACT";
    const transcriptionObservationCondition = id === "media.speech.transcription.file" && !hasReceiptCondition
      && ((output.artifactType === "transcript-draft-with-source-version-and-timebase-if-produced"
        && output.disposition === "not-produced-by-request-acknowledgment; emit-only-from-a-later-authoritative-owner-observation")
        || (output.artifactType === "language-and-recognition-evidence-when-provided"
          && output.disposition === "not-produced-by-request-acknowledgment; available-only-when-authoritatively-provided"));
    if (!hasExactKeys(output, ["outputRef", "artifactType", "requiredOnAcknowledgment", "disposition"], ["receiptCondition"])
      || (hasReceiptCondition && !hasExactKeys(receipt, ["sourceWireRef", "sourceArtifactType", "requiredFields"]))
      || output.outputRef !== expectedRef || !row || row.artifactType !== output.artifactType
      || output.requiredOnAcknowledgment !== false
      || (!sourceDeclaredCondition && !transcriptionObservationCondition && (!hasReceiptCondition || !receiptSchema || !receiptBranch || !requiredFields.length
        || !exactRegistrationReceipt
        || output.disposition !== "RECEIPT_GATED_NO_ACKNOWLEDGMENT"
        || requiredFields.some((field) => !receiptPayload?.required?.includes(field) || !receiptPayload.properties?.[field])))) {
      fail(id, `acknowledgment-deferred-output[${output.artifactType}]-has-exact-receipt-condition`);
    }
  }
  if (id === "media.speech.transcription.file"
    && (outputMapping.transcriptDraft !== "not-produced-by-request-acknowledgment; emit-only-from-a-later-authoritative-owner-observation"
      || outputMapping.recognitionEvidence !== "only-when-authoritatively-provided-by-owner; never-infer-language-or-speaker-identity"
      || source.targetIdentity !== "exact-jobId-from-authoritative-accepted-request-observation")) {
    fail(id, "transcription-acknowledgment-preserves-only-authoritative-receipt-and-deferred-observations");
  }
  if (outputMapping.workflowSteps !== undefined) {
    validateOrderedOutputWorkflow(id, intent, operation, wires, outputMapping, documents, fail);
  }
}

function validateAdditionalSuccessOutputMapping(id, intent, operation, wires, outputMapping, source, index, documents, fail) {
  const label = `output-mapping-additional-success[${index}]`;
  if (!hasExactKeys(source, ["sourceWireRef", "sourceArtifactType", "targetOutputRef", "targetArtifactType", "identityProjection"], ["additionalEvidenceRefs"])) {
    fail(id, `${label}-uses-closed-explicit-shape`);
  }
  const p0Outputs = intent.ownerDefinition?.successOutputs ?? [];
  const wireRefs = operation.canonicalWireSchemaRefs ?? [];
  const sourceWireIndex = wireRefs.indexOf(source.sourceWireRef?.replace(/\/resultSchema$/u, ""));
  const sourceWire = sourceWireIndex >= 0 ? wires[sourceWireIndex] : undefined;
  const expectedResultRef = sourceWireIndex >= 0 ? `${wireRefs[sourceWireIndex]}/resultSchema` : undefined;
  const sourceSchema = sourceWire && source.sourceWireRef === expectedResultRef ? resolveSourceRef(source.sourceWireRef, documents) : undefined;
  const sourceBranch = findOutputBranch(sourceSchema, source.sourceArtifactType);
  const sourcePayload = sourceBranch?.properties?.payload;
  const targetRef = `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${source.targetArtifactType}`;
  const targetRow = resolveSourceRef(source.targetOutputRef, documents);
  const p0Target = p0Outputs.find(({ artifactType }) => artifactType === source.targetArtifactType);
  const sourceOutputRequired = successRequiresOutput(sourceSchema, source.sourceArtifactType, outputMapping.wireOutcome);
  if (!sourceWire || source.sourceWireRef !== expectedResultRef || !sourceBranch
    || source.sourceArtifactType !== sourceBranch.properties?.artifactType?.const) {
    fail(id, `${label}-source-is-exact-canonical-wire-result-branch`);
  }
  if (source.targetOutputRef !== targetRef || !targetRow || !p0Target
    || targetRow.artifactType !== source.targetArtifactType
    || targetRow.requiredOnSuccess !== p0Target.requiredOnSuccess
    || p0Target.requiredOnSuccess !== sourceOutputRequired) {
    fail(id, `${label}-maps-an-exact-P0-output-with-matching-requiredness`);
  }
  const projections = source.identityProjection ?? [];
  const additionalEvidenceRefs = source.additionalEvidenceRefs ?? [];
  const optionalEvidenceOnly = p0Target?.requiredOnSuccess === false
    && sourceOutputRequired === false
    && projections.length === 0
    && additionalEvidenceRefs.length > 0;
  if (!projections.length && !optionalEvidenceOnly) fail(id, `${label}-has-identity-or-optional-evidence-projection`);
  if (optionalEvidenceOnly) {
    const typedOutput = documents[OPS_PATH]?.capabilityOperationContracts?.outputPayloadSchemas
      ?.find(({ artifactType }) => artifactType === source.targetArtifactType);
    const typedPayload = typedOutput?.schema?.properties?.payload;
    if (!typedPayload || JSON.stringify(stable(sourcePayload)) !== JSON.stringify(stable(typedPayload))) {
      fail(id, `${label}-optional-output-payload-matches-canonical-typed-output-schema`);
    }
    for (const field of typedPayload?.required ?? []) {
      const evidenceCount = additionalEvidenceRefs.filter(({ pointer }) => pointer === `/${field}`).length;
      if (evidenceCount !== 1) {
        fail(id, `${label}-optional-output-evidence-covers-canonical-required-field-exactly-once[${field}]`, `${evidenceCount}`);
      }
    }
  }
  for (const projection of projections) {
    if (!hasExactKeys(projection, ["sourcePointer", "sourceOutputRef", "evidenceRef", "evidencePointer", "operator"])) {
      fail(id, `${label}-projection-uses-closed-shape`);
    }
    const sourceField = resolveJsonPointer(sourcePayload, projection.sourcePointer);
    const evidenceSchema = resolveOutputEvidenceSchema(projection.evidenceRef, operation, wires, documents);
    const evidenceField = evidenceSchema && resolveJsonPointer(evidenceSchema, projection.evidencePointer);
    const receiptIdentity = projection.operator === "OWNER_ISSUED_RECEIPT_IDENTITY"
      && isExactSourcePayloadEvidenceRef(projection.evidenceRef, source.sourceWireRef, sourcePayload, documents)
      && projection.evidencePointer === projection.sourcePointer && sourceField === evidenceField
      && isRequiredPointer(sourcePayload, projection.sourcePointer)
      && canEstablishReceiptIdentity(sourceField);
    const exactEcho = projection.operator === "EXACT_EQUAL"
      && projection.evidenceRef === `${wireRefs[sourceWireIndex]}/requestSchema`
      && pointerLeaf(projection.sourcePointer) === pointerLeaf(projection.evidencePointer)
      && JSON.stringify(stable(normalizedSchema(sourceField, {}))) === JSON.stringify(stable(normalizedSchema(evidenceField, {})))
      && hasExactResultRequestBinding(sourceWire, projection.sourcePointer, projection.evidencePointer);
    if (projection.sourceOutputRef !== source.targetOutputRef || !sourceField || !evidenceField || !(receiptIdentity || exactEcho)) {
      fail(id, `${label}-field-projection-is-exact-and-resolvable`);
    }
  }
  for (const evidence of additionalEvidenceRefs) {
    if (!hasExactKeys(evidence, ["sourceRef", "pointer", "role"])) fail(id, `${label}-additional-evidence-uses-closed-shape`);
    const schema = resolveOutputEvidenceSchema(evidence.sourceRef, operation, wires, documents);
    const field = schema && resolveJsonPointer(schema, evidence.pointer);
    if (!field || !isExactSourcePayloadEvidenceRef(evidence.sourceRef, source.sourceWireRef, sourcePayload, documents)
      || (!optionalEvidenceOnly && !isRequiredPointer(sourcePayload, evidence.pointer))
      || !["RECEIPT_FIELD", "ADMISSION_EVIDENCE"].includes(evidence.role)) {
      fail(id, `${label}-additional-evidence-is-exact-source-field`);
    }
  }
}

function wireOutcomeIsDeclared(resultSchema, outcome) {
  const schema = resultSchema?.properties?.outcome;
  if (schema?.const === outcome || schema?.enum?.includes(outcome) === true) return true;
  return ["oneOf", "anyOf", "allOf"].some((key) =>
    (resultSchema?.[key] ?? []).some((branch) => wireOutcomeIsDeclared(branch, outcome)));
}

function canEstablishReceiptIdentity(schema) {
  if (schema?.const !== undefined || (Array.isArray(schema?.enum) && schema.enum.length > 0)) return true;
  return schema?.type === "string"
    && ["opaque-id", "opaque-version-id", "opaque-versioned-reference"].includes(schema.format);
}

function validateOrderedOutputWorkflow(id, intent, operation, wires, outputMapping, documents, fail) {
  const steps = outputMapping.workflowSteps;
  const operationRefs = operation.operationRefs ?? [];
  if (!Array.isArray(steps) || !steps.length || steps.length !== operationRefs.length) {
    fail(id, "output-workflow-steps-cover-ordered-operation-refs");
    return;
  }
  const p0Outputs = intent.ownerDefinition?.successOutputs ?? [];
  const seen = new Set();
  const seenTargets = new Set();
  const rows = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const supplementalCompletion = id === "media.artifact.upload.resume"
      && step.operationRef === "media.operation-slice.complete-upload"
      && step.disposition === "SUPPLEMENTAL_NOT_MAPPED_TO_P0_OUTPUT";
    if (supplementalCompletion) {
      const expectedWireRef = `${operation.canonicalWireSchemaRefs?.[index]}/resultSchema`;
      const schema = resolveSourceRef(step.sourceWireRef, documents);
      const branch = findOutputBranch(schema, step.sourceArtifactType);
      if (!hasExactKeys(step, ["step", "operationRef", "sourceWireRef", "sourceArtifactType", "disposition"])
        || step.step !== index + 1 || operation.operationRefs[index] !== step.operationRef
        || step.sourceWireRef !== expectedWireRef || !branch
        || p0Outputs.some(({ artifactType }) => artifactType === step.sourceArtifactType)) {
        fail(id, `output-workflow-step[${index + 1}]-supplemental-completion-is-source-backed-and-unmapped`);
      }
      rows.push({ step, branch, p0: undefined, index, supplemental: true });
      continue;
    }
    if (!hasExactKeys(step, ["step", "operationRef", "sourceWireRef", "sourceArtifactType", "targetOutputRef", "targetArtifactType", "identityProjection"])) {
      fail(id, `output-workflow-step[${index + 1}]-uses-closed-explicit-shape`);
    }
    const expectedWireRef = `${operation.canonicalWireSchemaRefs?.[index]}/resultSchema`;
    const expectedOutputRef = `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${step.targetArtifactType}`;
    const schema = resolveSourceRef(step.sourceWireRef, documents);
    const sourceType = step.sourceArtifactType;
    const branch = findOutputBranch(schema, sourceType);
    const p0 = p0Outputs.find(({ artifactType }) => artifactType === step.targetArtifactType);
    const targetRow = resolveSourceRef(step.targetOutputRef, documents);
    const key = `${step.targetOutputRef}:${step.sourceWireRef}`;
    if (step.operationRef !== operationRefs[index] || step.step !== index + 1
      || step.sourceWireRef !== expectedWireRef || !branch || !p0 || !targetRow
      || step.targetOutputRef !== expectedOutputRef || targetRow.artifactType !== step.targetArtifactType
      || targetRow.requiredOnSuccess !== p0.requiredOnSuccess
      || p0.requiredOnSuccess !== successRequiresOutput(schema, sourceType, outputMapping.wireOutcome)
      || seen.has(key) || seenTargets.has(step.targetArtifactType)) {
      fail(id, `output-workflow-step[${index + 1}]-exact-ordered-source-target-ref`);
    }
    seen.add(key);
    seenTargets.add(step.targetArtifactType);
    rows.push({ step, branch, p0, index });
    validateWorkflowIdentityProjection(id, step, branch, operation, wires[index], wires, documents, fail);
  }
  if (id === "media.artifact.upload.resume") {
    const requiredProgress = [
      ["media.operation-slice.inspect-upload", "same-uploadId-and-authoritative-transfer-state"],
      ["media.operation-slice.append-upload-chunk", "newly-acknowledged-ranges-only"],
    ];
    for (const [operationRef, artifactType] of requiredProgress) {
      if (!rows.some(({ step }) => step.operationRef === operationRef && step.targetArtifactType === artifactType)) {
        fail(id, `output-workflow-preserves-required-progress[${operationRef}:${artifactType}]`);
      }
    }
    const inspectIndex = operationRefs.indexOf("media.operation-slice.inspect-upload");
    const appendIndex = operationRefs.indexOf("media.operation-slice.append-upload-chunk");
    if (inspectIndex < 0 || appendIndex <= inspectIndex) fail(id, "output-workflow-inspect-precedes-append");
    const completionIndex = operationRefs.indexOf("media.operation-slice.complete-upload");
    if (completionIndex < 0) fail(id, "output-workflow-retains-supplemental-completion-step");
    else {
      const completion = rows[completionIndex];
      if (completionIndex <= appendIndex || completionIndex !== operationRefs.length - 1 || !completion?.supplemental) {
        fail(id, "output-workflow-completion-is-supplemental-after-progress-only");
      }
    }
    if (!outputSuccessAliasesWorkflowStep(outputMapping.success, steps[inspectIndex])) {
      fail(id, "output-workflow-top-level-success-exactly-aliases-inspect-mapping");
    }
  }
}

function outputSuccessAliasesWorkflowStep(success, step) {
  if (!success || !step) return false;
  return ["sourceWireRef", "sourceArtifactType", "targetOutputRef", "targetArtifactType", "identityProjection"]
    .every((key) => JSON.stringify(stable(success[key])) === JSON.stringify(stable(step[key])));
}

function validateWorkflowIdentityProjection(id, step, branch, operation, wire, wires, documents, fail) {
  const sourcePayload = branch?.properties?.payload;
  const projections = step.identityProjection ?? [];
  if (!projections.length) fail(id, `output-workflow-step[${step.step}]-has-identity-projection`);
  for (const projection of projections) {
    if (!hasExactKeys(projection, ["sourcePointer", "sourceOutputRef", "evidenceRef", "evidencePointer", "operator"])) {
      fail(id, `output-workflow-step[${step.step}]-projection-uses-closed-shape`);
    }
    const sourceField = resolveJsonPointer(sourcePayload, projection.sourcePointer);
    const evidenceSchema = resolveOutputEvidenceSchema(projection.evidenceRef, operation, wires, documents);
    const evidenceField = evidenceSchema && resolveJsonPointer(evidenceSchema, projection.evidencePointer);
    const receiptIdentity = projection.operator === "OWNER_ISSUED_RECEIPT_IDENTITY"
      && isExactSourcePayloadEvidenceRef(projection.evidenceRef, step.sourceWireRef, sourcePayload, documents)
      && projection.sourcePointer === projection.evidencePointer && sourceField === evidenceField
      && isRequiredPointer(sourcePayload, projection.sourcePointer)
      && canEstablishReceiptIdentity(sourceField);
    const exactEcho = projection.operator === "EXACT_EQUAL"
      && typeof projection.evidenceRef === "string" && projection.evidenceRef.endsWith("/requestSchema")
      && pointerLeaf(projection.sourcePointer) === pointerLeaf(projection.evidencePointer)
      && JSON.stringify(stable(normalizedSchema(sourceField, {}))) === JSON.stringify(stable(normalizedSchema(evidenceField, {})))
      && hasExactResultRequestBinding(wire, projection.sourcePointer, projection.evidencePointer);
    const expectedOutputRef = `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${step.targetArtifactType}`;
    if (projection.sourceOutputRef !== expectedOutputRef || !sourceField || !evidenceField || !(receiptIdentity || exactEcho)) {
      fail(id, `output-workflow-step[${step.step}]-identity-projection-resolves`);
    }
  }
}

function resolveOutputEvidenceSchema(ref, operation, wires, documents) {
  if (typeof ref !== "string") return undefined;
  const wireRefs = operation.canonicalWireSchemaRefs ?? [];
  const index = wireRefs.findIndex((wireRef) => ref === `${wireRef}/requestSchema`
    || ref.startsWith(`${wireRef}/requestSchema/`)
    || ref === `${wireRef}/resultSchema`
    || ref.startsWith(`${wireRef}/resultSchema/`));
  if (index < 0 || !wires[index]) return undefined;
  if (ref === `${wireRefs[index]}/requestSchema`) return wires[index].requestSchema;
  return resolveSourceRef(ref, documents);
}

function isExactSourcePayloadEvidenceRef(ref, sourceResultRef, sourcePayload, documents) {
  if (typeof ref !== "string" || typeof sourceResultRef !== "string" || !sourcePayload) return false;
  if (ref === sourceResultRef) return true;
  return ref.startsWith(`${sourceResultRef}/`) && resolveSourceRef(ref, documents) === sourcePayload;
}

function resolveCanonicalWireResultSchema(ref, operation, wires, documents) {
  if (typeof ref !== "string" || !ref.endsWith("/resultSchema")) return undefined;
  const wireRefs = operation.canonicalWireSchemaRefs ?? [];
  const index = wireRefs.findIndex((wireRef) => ref === `${wireRef}/resultSchema`);
  if (index >= 0) return wires[index]?.resultSchema;
  const operations = documents[OPS_PATH];
  const rows = [
    ...(operations?.individualOperationContracts?.records ?? []),
    ...(operations?.ownerDefinedOperationContracts?.records ?? []),
  ];
  const canonical = rows.some(({ id }) => [
    `${OPS_PATH}#individualOperationContracts/records/@id=${id}/ownerWireSchema/resultSchema`,
    `${OPS_PATH}#ownerDefinedOperationContracts/records/@id=${id}/ownerWireSchema/resultSchema`,
  ].includes(ref));
  return canonical ? resolveSourceRef(ref, documents) : undefined;
}

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function hasExactResultRequestBinding(wire, resultPointer, requestPointer) {
  const leftRef = `$.request${requestPointer}`.replace(/\/$/u, "");
  const rightRef = `$.result.outputs[0].payload${resultPointer}`.replace(/\/$/u, "");
  return (wire?.crossFieldRules ?? []).some((rule) => rule.operator === "EXACT_EQUAL"
    && rule.leftRef === leftRef && rule.rightRef === rightRef && rule.whenOutcome === "SUCCEEDED");
}

function resolveSelector(rootDoc, ref) {
  const prefix = `${OPS_PATH}#`;
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return undefined;
  let value = rootDoc;
  for (const segment of ref.slice(prefix.length).split("/")) {
    const match = /^@(id|slotId|artifactType)=(.+)$/u.exec(segment);
    if (match) {
      if (!Array.isArray(value)) return undefined;
      const selectorKey = { id: "id", slotId: "slotId", artifactType: "artifactType" }[match[1]];
      const matches = value.filter((row) => row?.[selectorKey] === match[2]
        || (selectorKey === "artifactType" && row?.properties?.artifactType?.const === match[2]));
      if (matches.length !== 1) return undefined;
      [value] = matches;
    } else value = Array.isArray(value) && /^\d+$/u.test(segment)
      ? value[Number(segment)]
      : value && typeof value === "object" ? value[segment] : undefined;
    if (value === undefined) return undefined;
  }
  return value;
}

function resolveSourceRef(ref, documents) {
  if (typeof ref !== "string") return undefined;
  const separator = ref.indexOf("#");
  if (separator < 0) return undefined;
  let path = ref.slice(0, separator);
  const selector = ref.slice(separator + 1);
  if (path === "media.capability-contract-envelope.request.v1") {
    path = OPS_PATH;
    return resolveSourceRef(`${path}#capabilityOperationContracts/requestEnvelope/${selector}`, documents);
  }
  const document = documents[path];
  if (!document || !selector) return undefined;
  if (path === DECISION_PATH) {
    if (selector !== "PXD-146" || typeof document !== "string") return undefined;
    const start = document.search(/^### PXD-146\b/mu);
    if (start < 0) return undefined;
    const tail = document.slice(start + 1);
    const next = tail.search(/^### PXD-\d+\b/mu);
    return document.slice(start, next < 0 ? document.length : start + 1 + next);
  }
  let value = document;
  const segments = selector.split("/");
  if (path === ACTION_PATH) {
    const [actionId, ...tail] = segments;
    const matches = (document.actions ?? []).filter(({ id }) => id === actionId);
    if (matches.length !== 1) return undefined;
    [value] = matches;
    segments.splice(0, segments.length, ...tail);
  }
  for (const segment of segments) {
    const match = /^@(id|slotId|artifactType)=(.+)$/u.exec(segment);
    if (match) {
      if (!Array.isArray(value)) return undefined;
      const selectorKey = { id: "id", slotId: "slotId", artifactType: "artifactType" }[match[1]];
      const matches = value.filter((row) => row?.[selectorKey] === match[2]
        || (selectorKey === "artifactType" && row?.properties?.artifactType?.const === match[2]));
      if (matches.length !== 1) return undefined;
      [value] = matches;
    } else if (segment.startsWith("@artifactType=")) {
      if (!Array.isArray(value)) return undefined;
      const artifactType = segment.slice("@artifactType=".length);
      const matches = value.filter((row) => row?.artifactType === artifactType
        || row?.properties?.artifactType?.const === artifactType);
      if (matches.length !== 1) return undefined;
      [value] = matches;
    } else if (Array.isArray(value) && /^\d+$/u.test(segment)) value = value[Number(segment)];
    else if (typeof value === "string" && /^\d+$/u.test(segment)) return undefined;
    else value = value?.[segment];
    if (value === undefined) return undefined;
  }
  return value;
}

function resolveOwnerPrecondition(entry, p0Slot, operation, documents) {
  const ref = entry.preconditionRef;
  if (typeof ref !== "string") return undefined;
  const sourceRefs = operation.canonicalSourceContractRefs ?? [];
  const matchesSource = sourceRefs.some((sourceRef) => ref === `${sourceRef}/preconditions`);
  if (!matchesSource) return undefined;
  const source = resolveSourceRef(ref, documents);
  if (source === undefined || typeof source !== "string" || !source.trim()) return undefined;
  const trustedContext = entry.preconditionContextRef === undefined
    ? undefined
    : resolveSourceRef(entry.preconditionContextRef, documents);
  if (entry.preconditionContextRef !== undefined
    && (entry.preconditionContextRef !== "media.capability-contract-envelope.request.v1#trustedContext"
      || !hasCanonicalTrustedContext(trustedContext))) return undefined;
  const sourceType = p0Slot.sourceType ?? "";
  if (/workspace/u.test(sourceType)
    && (!/workspace/u.test(source) || !/(?:scope|tenant|context|bind|match|identity|authority)/u.test(source))) return undefined;
  if (/(?:resume|upload).*?(?:authority|session)|(?:authority|session).*?upload/u.test(sourceType)
    && (!/(?:upload|session|authority)/u.test(source) || !/(?:bind|match|validate|authorize|owner-issued)/u.test(source))) return undefined;
  if (/selected-local-source|admitted-source-reference/u.test(sourceType)
    && (!/source/u.test(source) || !/(?:resolve|readable|admitted|selected)/u.test(source))) return undefined;
  if (/(?:rights|retention|policy)/u.test(sourceType)
    && (!/(?:rights|retention|policy)/u.test(source) || !/(?:resolve|current|applicable|owner)/u.test(source))) return undefined;
  if (/(?:content-metadata|purpose)/u.test(sourceType)
    && (!/(?:media type|content type|size|purpose)/u.test(source) || !/(?:resolve|declared|admission|owner-approved)/u.test(source))) return undefined;
  const contextRef = entry.preconditionContextRef;
  if (/workspace/u.test(p0Slot.sourceType ?? "")) {
    if (contextRef !== "media.capability-contract-envelope.request.v1#trustedContext"
      || !hasCanonicalTrustedContext(trustedContext) || !trustedContext.workspaceId) return undefined;
  } else if (contextRef !== undefined && contextRef !== "media.capability-contract-envelope.request.v1#trustedContext") return undefined;
  return source;
}

function hasCanonicalTrustedContext(context) {
  return context !== null && typeof context === "object"
    && ["tenantId", "principalId", "workspaceId"].every((key) =>
      typeof context[key] === "string" && context[key].trim().length > 0);
}

function dispositionOriginIsSupported(disposition, sourceLocation, selectedAction) {
  const ref = disposition.sourceRef;
  if (disposition.valueOrigin === "TRUSTED_TRANSPORT_CONTEXT") {
    return ref.startsWith(`${CAP_PATH}#capabilities/@id=`)
      && /\/ownerDefinition\/guards\/(?:preconditions|authority|authorization)(?:\/|$)/u.test(ref);
  }
  if (disposition.valueOrigin === "GENERATED_PROTOCOL_VALUE") {
    return ref.startsWith(`${OPS_PATH}#`)
      && (/(?:idempotency|requestFingerprint|selectorValues|operationRef|operationVersion|inputSemantics)(?:\/|$)/u.test(ref)
        || ref.endsWith("/requestIdentity") && typeof sourceLocation === "string"
          && /idempotency-key/iu.test(sourceLocation));
  }
  if (disposition.valueOrigin === "OUTSIDE_SELECTED_CAPABILITY_ACTION_SCOPE") {
    return Boolean(selectedAction) && ref === `${ACTION_PATH}#${selectedAction.id}` && sourceLocation.id === selectedAction.id;
  }
  if (disposition.valueOrigin === "OWNER_RESOLVED_FROM_P0_REFERENCE") {
    return ref.startsWith(`${CAP_PATH}#capabilities/@id=`)
      && /\/ownerDefinition\/(?:typedInputSlots|parameterSchema)(?:\/|$)/u.test(ref);
  }
  if (disposition.valueOrigin === "P0_SCHEMA_INCOMPLETE") {
    return ref.startsWith(`${CAP_PATH}#capabilities/@id=`)
      && /\/ownerDefinition\/(?:typedInputSlots|parameterSchema)(?:\/|$)/u.test(ref);
  }
  return false;
}

function isExactOwnerReplayIdentityRef(ref, operation, documents) {
  const sourceRefs = operation.canonicalSourceContractRefs ?? [];
  return sourceRefs.some((sourceRef) => {
    const contract = resolveSourceRef(sourceRef, documents);
    if (!contract || typeof contract !== "object") return false;
    const exactRefs = [
      `${sourceRef}/requestIdentity`,
      `${sourceRef}/retry/replay`,
      `${sourceRef}/replay`,
    ];
    return exactRefs.includes(ref) && resolveSourceRef(ref, documents) !== undefined;
  });
}

function requestHasField(schema, field, required) {
  if (!schema) return false;
  if (schema.oneOf) return schema.oneOf.some((branch) => requestHasField(branch, field, required));
  return Boolean(schema.properties?.[field]) && (!required || schema.required?.includes(field));
}

function mergedRequestSchema(wires) {
  const properties = {};
  const required = new Set();
  for (const wire of wires) {
    for (const [key, value] of Object.entries(wire.requestSchema?.properties ?? {})) properties[key] ??= value;
    for (const key of wire.requestSchema?.required ?? []) required.add(key);
  }
  return { type: "object", properties, required: [...required] };
}

function successRequiresOutput(schema, artifactType, outcomeValue = "SUCCEEDED") {
  if (!schema) return false;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
    const matching = branches.filter((branch) => wireOutcomeIsDeclared(branch, outcomeValue));
    return matching.length > 0 && matching.every((branch) => successRequiresOutput(branch, artifactType, outcomeValue));
  }
  const rootRequired = schema.required ?? [];
  const successClauses = (schema.allOf ?? []).filter((clause) =>
    clause.if?.properties?.outcome?.const === outcomeValue || clause.if?.properties?.outcome?.enum?.includes(outcomeValue));
  const successVariants = [
    ...successClauses.map((clause) => clause.then),
    ...(wireOutcomeIsDeclared(schema, outcomeValue) ? [schema] : []),
  ].filter(Boolean);
  for (const success of successVariants) {
    const outputSchema = success?.properties?.outputs;
    if (!outputSchema || !(success.required ?? []).includes("outputs") && !rootRequired.includes("outputs")) continue;
    const baseOutput = schema.properties?.outputs;
    const hasRequiredIdentity = (node) => {
      if (!node || typeof node !== "object") return false;
      if (node.contains && (node.minContains ?? 1) >= 1
        && schemaImpliesArtifactType(node.contains, artifactType)) return true;
      return Object.values(node).some((child) => Array.isArray(child)
        ? child.some(hasRequiredIdentity) : hasRequiredIdentity(child));
    };
    if (hasRequiredIdentity(success) || hasRequiredIdentity(baseOutput)) return true;
    const minimum = outputSchema.minItems ?? schema.properties?.outputs?.minItems ?? 0;
    if (minimum < 1) continue;
    const minItems = Math.max(outputSchema.minItems ?? 0, baseOutput?.minItems ?? 0);
    const itemSchemas = [outputSchema.items, baseOutput?.items].filter(Boolean);
    // `allOf` constraints combine, while every alternative in oneOf/anyOf has
    // to guarantee the identity. A matching branch beside an unconstrained
    // branch is only permission to emit this artifact, not a guarantee.
    const itemSchema = { allOf: itemSchemas };
    if (minItems >= 1 && schemaImpliesArtifactType(itemSchema, artifactType)) return true;
  }
  return false;
}

function schemaImpliesArtifactType(schema, artifactType) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.properties?.artifactType?.const === artifactType) return true;
  if ((schema.allOf ?? []).some((branch) => schemaImpliesArtifactType(branch, artifactType))) return true;
  for (const key of ["oneOf", "anyOf"]) {
    const branches = schema[key] ?? [];
    if (branches.length && branches.every((branch) => schemaImpliesArtifactType(branch, artifactType))) return true;
  }
  return false;
}

function artifactTypes(schema) {
  const found = [];
  const constants = (node, result = []) => {
    if (!node || typeof node !== "object") return result;
    if (Object.hasOwn(node, "const") && typeof node.const === "string") result.push(node.const);
    for (const key of ["allOf", "oneOf", "anyOf"]) for (const child of node[key] ?? []) constants(child, result);
    return result;
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const type of constants(node.properties?.artifactType)) if (!found.includes(type)) found.push(type);
    for (const key of ["properties", "items"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") Object.values(key === "properties" ? child : { item: child }).forEach(visit);
    }
    for (const key of ["allOf", "oneOf", "anyOf"]) for (const child of node[key] ?? []) visit(child);
  };
  visit(schema);
  return found;
}

function findOutputBranch(schema, artifactType) {
  if (!schema || typeof schema !== "object") return undefined;
  const item = schema.properties?.outputs?.items;
  for (const branch of item?.oneOf ?? item?.anyOf ?? [item].filter(Boolean)) {
    if (branch.properties?.artifactType?.const === artifactType) return branch;
  }
  for (const clause of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    const found = findOutputBranch(clause, artifactType);
    if (found) return found;
  }
  return undefined;
}

function validateProjectOutputContract(id, operation, wires, fail) {
  const expected = {
    "media.project.create": {
      kind: "project-creation-receipt",
      required: ["kind", "projectId", "initialRevisionId"],
    },
    "media.project.inspect": {
      kinds: ["project-head-observation", "project-creation-reconciliation-receipt"],
    },
    "media.project.source-asset.attach": {
      kind: "project-source-attachment-commit-receipt",
      required: ["kind", "projectId", "priorHeadRevisionId", "newRevisionId", "attachedArtifactId", "attachedArtifactVersionId", "committedAt"],
    },
  }[id];
  if (!expected) return;
  const branch = findOutputBranch(wires[0]?.resultSchema, "versioned-project-state");
  const payload = branch?.properties?.payload;
  if (!payload) {
    fail(id, "project-versioned-state-payload-present");
    return;
  }
  if (expected.kind) {
    const fields = payload.required ?? [];
    if (expected.required.some((field) => !fields.includes(field))
      || payload.properties?.kind?.const !== expected.kind
      || payload.additionalProperties !== false
      || fields.some((field) => ["artifactId", "versionId", "sourceRef", "declaredMediaType", "declaredByteLength"].includes(field))) {
      fail(id, `project-versioned-state-payload[${expected.kind}]-exact-fields`);
    }
    return;
  }
  const variants = payload.oneOf ?? [];
  const kinds = variants.map((variant) => variant.properties?.kind?.const);
  if (JSON.stringify(kinds) !== JSON.stringify(expected.kinds)) {
    fail(id, "project-inspect-result-preserves-selector-specific-branches", JSON.stringify(kinds));
    return;
  }
  const head = variants[0];
  const receipt = variants[1];
  if (head.properties?.headRevisionSnapshot?.additionalProperties !== false
    || JSON.stringify(head.properties?.headRevisionSnapshot?.required ?? []) !== JSON.stringify(["projectId", "revisionId"])) {
    fail(id, "project-inspect-head-snapshot-is-limited-to-canonical-revision-identity");
  }
  if (["creationRequestId", "requestFingerprint", "initialRevisionId", "creationOutcome"].some((field) => !(receipt.required ?? []).includes(field))) {
    fail(id, "project-inspect-reconciliation-preserves-original-create-receipt");
  }
  const bindings = wires[0]?.crossFieldRules ?? [];
  const expectedBinding = [
    ["$.request.projectId", "$.result.outputs[0].payload.kind", "project-head-observation"],
    ["$.request.creationRequestId", "$.result.outputs[0].payload.kind", "project-creation-reconciliation-receipt"],
  ];
  const actualBinding = bindings.map(({ leftRef, rightRef, expectedConst }) => [leftRef, rightRef, expectedConst]);
  if (JSON.stringify(actualBinding) !== JSON.stringify(expectedBinding)
    || bindings.some((rule) => rule.operator !== "PRESENT_THEN_CONST" || rule.whenOutcome !== "SUCCEEDED" || rule.scope !== "SUCCESS_OUTPUT_ONLY" || !rule.sourceRef)) {
    fail(id, "project-inspect-selector-to-result-variant-binding", JSON.stringify(actualBinding));
  }
}

test("required request leaves include every alternative and conditional branch", () => {
  const schema = {
    type: "object",
    required: ["mode"],
    properties: { mode: { type: "string" } },
    oneOf: [
      { required: ["source"], properties: { source: { type: "string" } } },
      { required: ["options"], properties: { options: { type: "object", required: ["quality"], properties: { quality: { type: "string" } } } } },
    ],
    anyOf: [{ required: ["tenant"], properties: { tenant: { type: "string" } } }],
    if: { properties: { mode: { const: "advanced" } } },
    then: { required: ["profile"], properties: { profile: { type: "string" } } },
    else: { required: ["preset"], properties: { preset: { type: "string" } } },
    dependentSchemas: {
      source: { required: ["sourceVersion"], properties: { sourceVersion: { type: "string" } } },
    },
  };
  assert.deepEqual(requiredWireLeafPointers(schema).sort(), [
    "/mode", "/options/quality", "/preset", "/profile", "/source", "/sourceVersion", "/tenant",
  ].sort());
});

test("source selectors reject accidental character indexing into scalar preconditions", () => {
  const documents = { [OPS_PATH]: { records: [{ id: "example", preconditions: "Owner validates upload session authority." }] } };
  const base = `${OPS_PATH}#records/@id=example/preconditions`;
  assert.equal(resolveSourceRef(base, documents), "Owner validates upload session authority.");
  assert.equal(resolveSourceRef(`${base}/0`, documents), undefined);
});

test("workspace precondition context resolves to the canonical trusted context object", () => {
  const sourceRef = `${OPS_PATH}#individualOperationContracts/records/@id=example`;
  const contextRef = "media.capability-contract-envelope.request.v1#trustedContext";
  const context = {
    tenantId: "required host-attested tenant identity",
    principalId: "required host-attested principal identity",
    workspaceId: "required authorized host workspace scope",
  };
  const documents = {
    [OPS_PATH]: {
      capabilityOperationContracts: { requestEnvelope: { trustedContext: context } },
      individualOperationContracts: { records: [{ id: "example", preconditions: "Owner binds workspace identity to host-attested trusted scope before execution." }] },
    },
  };
  const operation = { canonicalSourceContractRefs: [sourceRef] };
  const slot = { sourceType: "workspace-scope" };
  const entry = { preconditionRef: `${sourceRef}/preconditions`, preconditionContextRef: contextRef };
  assert.deepEqual(resolveSourceRef(contextRef, documents), context);
  assert.equal(resolveOwnerPrecondition(entry, slot, operation, documents), documents[OPS_PATH].individualOperationContracts.records[0].preconditions);

  const incomplete = structuredClone(documents);
  delete incomplete[OPS_PATH].capabilityOperationContracts.requestEnvelope.trustedContext.workspaceId;
  assert.equal(resolveOwnerPrecondition(entry, slot, operation, incomplete), undefined,
    "a trusted context without an authorized workspace scope cannot cover the P0 workspace slot");
});

test("required wire leaves include headers as a distinct request section", () => {
  const wire = {
    requestSchema: { type: "object", properties: { "Idempotency-Key": { type: "string" } } },
    requestHeadersSchema: {
      type: "object", required: ["Idempotency-Key"],
      properties: { "Idempotency-Key": { type: "string" } },
    },
  };
  assert.deepEqual(requiredWireLeafPointers(wire.requestSchema), []);
  assert.deepEqual(requiredWireLeafPointers(wire.requestHeadersSchema), ["/Idempotency-Key"]);
  assert.notEqual(requestTargetKey("op", "body", "/Idempotency-Key"), requestTargetKey("op", "headers", "/Idempotency-Key"));
  assert.equal(requestSchemaForSection(wire, "headers"), wire.requestHeadersSchema);
});

test("success output proof rejects an unconstrained alternative item branch", () => {
  const result = (item) => ({
    type: "object",
    required: ["outputs"],
    properties: { outputs: { type: "array", items: item } },
    allOf: [{
      if: { properties: { outcome: { const: "SUCCEEDED" } } },
      then: { required: ["outputs"], properties: { outputs: { minItems: 1 } } },
    }],
  });
  const exact = { properties: { artifactType: { const: "candidate-image" } } };
  assert.equal(successRequiresOutput(result({ oneOf: [exact, {}] }), "candidate-image"), false);
  assert.equal(successRequiresOutput(result({ anyOf: [exact, { properties: { artifactType: { const: "other" } } }] }), "candidate-image"), false);
  assert.equal(successRequiresOutput(result({ oneOf: [exact, { allOf: [exact] }] }), "candidate-image"), true);
  assert.equal(successRequiresOutput(result({ anyOf: [{ allOf: [exact] }, exact] }), "candidate-image"), true);
});

test("direct input mappings reject mismatched parameter names and primitive shapes", () => {
  const scalarTypes = { "intent-text": { validator: { type: "string" } } };
  assert.equal(directMappingIsStructurallyCompatible(
    { kind: "P0_PARAMETER", parameterName: "title" }, undefined,
    { type: "string" }, "/title", { type: "string" }, scalarTypes,
  ), true);
  assert.equal(directMappingIsStructurallyCompatible(
    { kind: "P0_PARAMETER", parameterName: "title" }, undefined,
    { type: "string" }, "/tenantId", { type: "string" }, scalarTypes,
  ), false);
  assert.equal(directMappingIsStructurallyCompatible(
    { kind: "P0_SLOT", slotId: "input1" }, { sourceType: "intent-text" },
    undefined, "/enabled", { type: "boolean" }, scalarTypes,
  ), false);
});

function assertMutationDetected(capabilities, operations, mutate, expectedCheck) {
  const changed = structuredClone(operations);
  mutate(changed);
  const issues = diagnostics(capabilities, changed);
  assert.ok(issues.some((issue) => issue.includes(expectedCheck)), `expected mutation to be caught by ${expectedCheck}; first issues: ${issues.slice(0, 5).join(" | ")}`);
}

function assertMutationIntroducesIssue(capabilities, operations, mutate, capabilityId, expectedCheck) {
  const issueForCapability = (rows) => rows.filter((issue) => issue.startsWith(`${capabilityId}: `)
    && issue.includes(expectedCheck));
  const baselineIssues = issueForCapability(diagnostics(capabilities, operations));
  assert.deepEqual(baselineIssues, [], `baseline must pass ${capabilityId} ${expectedCheck}`);
  const changed = structuredClone(operations);
  mutate(changed);
  const allChangedIssues = diagnostics(capabilities, changed);
  const changedIssues = issueForCapability(allChangedIssues);
  assert.ok(changedIssues.length > 0, `mutation must introduce ${capabilityId} ${expectedCheck}; found: ${changedIssues.join(" | ")}; all: ${allChangedIssues.slice(0, 8).join(" | ")}`);
}

test("required P0 parameters cannot bind to optional wire fields", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    const source = resolveSelector(copy, row.canonicalSourceContractRefs[0]);
    source.ownerWireSchema.requestSchema.required = source.ownerWireSchema.requestSchema.required.filter((field) => field !== "title");
    const mapping = row.typedInputMappings.entries.find(({ source: from }) => from.kind === "P0_PARAMETER" && from.parameterName === "title");
    mapping.targets[0].required = false;
  }, "parameter[title]-requiredness");
});

test("optional P0 slots cannot be made required by their wire target", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    const mapping = row.typedInputMappings.entries.find(({ source: from }) => from.kind === "P0_SLOT" && from.slotId === "input2");
    const target = mapping.targets[0];
    target.required = false;
  }, "typed-input-mapping-target-requiredness[slot:input2]");
});

test("request-field dispositions require resolvable, origin-appropriate evidence", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    row.typedInputMappings.requestFieldDispositions[0].sourceRef = `${CAP_PATH}#capabilities/@id=media.project.create/ownerDefinition/guards/not-a-real-source`;
  }, "typed-input-disposition-source-ref-resolves");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    row.typedInputMappings.requestFieldDispositions[0].valueOrigin = "GENERATED_PROTOCOL_VALUE";
  }, "typed-input-disposition-origin-source-semantics");
});

test("required generated upload idempotency header is separately covered by owner replay identity", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const upload = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
  assert.ok(upload, "upload mapping exists");
  const header = upload.typedInputMappings.requestFieldDispositions.find(({ requestSection, requestPointer }) =>
    requestSection === "headers" && requestPointer === "/Idempotency-Key");
  assert.ok(header, "required idempotency header has a distinct mapping disposition");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    row.typedInputMappings.requestFieldDispositions = row.typedInputMappings.requestFieldDispositions.filter((entry) => entry !== row.typedInputMappings.requestFieldDispositions.find(({ requestSection, requestPointer }) =>
      requestSection === "headers" && requestPointer === "/Idempotency-Key"));
  }, "required-wire-leaf-covered-exactly-once");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    const disposition = row.typedInputMappings.requestFieldDispositions.find(({ requestSection, requestPointer }) =>
      requestSection === "headers" && requestPointer === "/Idempotency-Key");
    disposition.sourceRef = `${CAP_PATH}#capabilities/@id=media.artifact.upload/ownerDefinition/typedInputSlots/@slotId=input1`;
  }, "generated-header-sourced-from-exact-owner-request-identity");
});

test("upload digest normalization is bound to PXD-146 and the exact bare-hex wire field", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    const entry = row.typedInputMappings.entries.find(({ source }) => source.kind === "P0_SLOT" && source.slotId === "input3");
    delete entry.evidence.decisionRef;
  }, "upload-digest-projection-is-authorized-by-PXD-146-and-exact-wire-schema");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    const entry = row.typedInputMappings.entries.find(({ source }) => source.kind === "P0_SLOT" && source.slotId === "input3");
    entry.evidence.decisionRef = `${DECISION_PATH}#PXD-147`;
  }, "upload-digest-projection-is-authorized-by-PXD-146-and-exact-wire-schema");
});

test("acknowledgment adapters preserve source-backed identity and exact deferred outputs", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    delete row.outputMapping;
  }, "acknowledgment-output-mapping-present-for-every-existing-operation-binding");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.success.identityProjection[0].evidencePointer = "/payload/not-a-real-field";
  }, "output-mapping-field-projection-is-exact-and-resolvable");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    const projection = row.outputMapping.success.identityProjection[0];
    projection.sourcePointer = "/value/expectedByteLength";
    projection.evidencePointer = "/value/expectedByteLength";
  }, "media.artifact.upload", "output-mapping-field-projection-is-exact-and-resolvable");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.success.sourceWireRef = `${row.canonicalWireSchemaRefs[0]}/requestSchema`;
  }, "output-mapping-source-wire-result-ref-resolves");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.success.targetOutputRef = `${CAP_PATH}#capabilities/@id=media.speech.transcription.file/ownerDefinition/successOutputs/@artifactType=not-a-P0-output`;
  }, "output-mapping-target-is-exact-required-P0-output-ref");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.success.targetIdentity = "arbitrary identity claim";
  }, "transcription-acknowledgment-preserves-only-authoritative-receipt-and-deferred-observations");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.deferredP0Outputs.push({
      artifactType: "invented-output",
      requiredOnAcknowledgment: false,
      disposition: "not-produced-by-request-acknowledgment",
    });
  }, "acknowledgment-deferred-outputs-equal-exact-P0-optional-set");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    row.outputMapping.deferredP0Outputs.push(structuredClone(row.outputMapping.deferredP0Outputs[0]));
  }, "acknowledgment-deferred-outputs-equal-exact-P0-optional-set");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    const deferred = row.outputMapping.deferredP0Outputs.find(({ receiptCondition }) => receiptCondition);
    if (deferred) deferred.receiptCondition.sourceWireRef = `${row.canonicalWireSchemaRefs[0]}/requestSchema`;
    else row.outputMapping.deferredP0Outputs[0].outputRef = `${CAP_PATH}#capabilities/@id=media.speech.transcription.file/ownerDefinition/successOutputs/@artifactType=not-a-P0-output`;
  }, "acknowledgment-deferred-output");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
    const deferred = row.outputMapping.deferredP0Outputs.find(({ artifactType }) =>
      artifactType === "artifact-version-reference-only-after-owner-confirmed-registration");
    deferred.receiptCondition.sourceWireRef = `${row.canonicalWireSchemaRefs[0]}/resultSchema`;
  }, "acknowledgment-deferred-output");
});

test("optional transcription profile mapping is required only on its explicit present branch", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const source = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    source.inputSlotMapping.absent = "UNSUPPORTED_PROFILE after operation request; inferred AUTO_REQUESTED";
  }, "media.speech.transcription.file", "typed-input-mapping-optional-slot-not-required-target[input2]");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const source = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.transcription.file");
    source.inputSlotMapping.present = "use default language and profile";
  }, "media.speech.transcription.file", "typed-input-mapping-optional-slot-not-required-target[input2]");
});

test("receipt and lifecycle projections reject unsupported source fields, branches, and target refs", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.job.submit");
    row.outputMapping.success.receiptProjection.sourcePointer = "/requestFingerprint";
  }, "output-mapping-receipt-projection-is-exact-and-resolvable");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.derive");
    row.outputMapping.success.outputProjection.sourceBranchKind = "governed-artifact-reference";
  }, "output-mapping-branch-projection-is-exact-and-resolvable");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.derive");
    row.outputMapping.success.outputProjection.targetOutputRef = `${CAP_PATH}#capabilities/@id=media.artifact.derive/ownerDefinition/successOutputs/@artifactType=not-a-P0-output`;
  }, "output-mapping-branch-projection-is-exact-and-resolvable");
});

test("additional success mappings cover each required P0 output exactly once", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const inspect = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
  const inspectP0 = capabilities.capabilities.find(({ id }) => id === "media.artifact.inspect");
  assert.ok(inspect.outputMapping.additionalSuccessMappings?.length, "second required inspect output has an explicit mapping");
  const requiredOutputTypes = inspectP0.ownerDefinition.successOutputs
    .filter(({ requiredOnSuccess }) => requiredOnSuccess).map(({ artifactType }) => artifactType).sort();
  const allMappedTypes = [inspect.outputMapping.success.targetArtifactType,
    ...inspect.outputMapping.additionalSuccessMappings.map(({ targetArtifactType }) => targetArtifactType)];
  assert.deepEqual(allMappedTypes.filter((type) => requiredOutputTypes.includes(type)).sort(), requiredOutputTypes,
    "primary and additional success mappings cover the required P0 outputs");
  assert.equal(new Set(allMappedTypes).size, allMappedTypes.length, "each P0 output maps at most once");
  const optionalP0Output = inspectP0.ownerDefinition.successOutputs.find(({ requiredOnSuccess }) => !requiredOnSuccess);
  assert.ok(optionalP0Output, "inspect retains a separate optional P0 output");
  const optionalMapping = inspect.outputMapping.additionalSuccessMappings.find(({ targetArtifactType }) => targetArtifactType === optionalP0Output.artifactType);
  assert.ok(optionalMapping, "the source's independently optional rights/provenance branch maps to its exact optional P0 output");
  assert.deepEqual(optionalMapping.identityProjection, [], "a non-identity optional evidence artifact does not invent identity projections");
  assert.ok(optionalMapping.additionalEvidenceRefs?.length, "optional output carries explicit source-field evidence");
  assert.ok(!inspect.outputMapping.deferredP0Outputs.some(({ artifactType }) => artifactType === optionalP0Output.artifactType),
    "mapped optional evidence is not redundantly deferred");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    const optional = row.outputMapping.additionalSuccessMappings.find(({ targetArtifactType }) =>
      targetArtifactType === "rights-retention-and-provenance-references-when-authorized");
    optional.additionalEvidenceRefs.push(structuredClone(optional.additionalEvidenceRefs[0]));
  }, "media.artifact.inspect", "output-mapping-additional-success[1]-optional-output-evidence-covers-canonical-required-field-exactly-once[purposeRef]");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    const optional = row.outputMapping.additionalSuccessMappings.find(({ targetArtifactType }) =>
      targetArtifactType === "rights-retention-and-provenance-references-when-authorized");
    optional.sourceWireRef = `${row.canonicalWireSchemaRefs[0]}/requestSchema`;
  }, "media.artifact.inspect", "output-mapping-additional-success[1]-source-is-exact-canonical-wire-result-branch");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    row.outputMapping.additionalSuccessMappings = row.outputMapping.additionalSuccessMappings
      .filter(({ targetArtifactType }) => targetArtifactType !== "rights-retention-and-provenance-references-when-authorized");
  }, "media.artifact.inspect", "acknowledgment-deferred-outputs-equal-exact-P0-optional-set");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    row.outputMapping.additionalSuccessMappings.push(structuredClone(row.outputMapping.additionalSuccessMappings[0]));
  }, "media.artifact.inspect", "output-mapping-success-targets-are-unique");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    row.outputMapping.additionalSuccessMappings[0].sourceWireRef = `${row.canonicalWireSchemaRefs[0]}/requestSchema`;
  }, "media.artifact.inspect", "output-mapping-additional-success[0]-source-is-exact-canonical-wire-result-branch");
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    row.outputMapping.additionalSuccessMappings[0].targetArtifactType = row.outputMapping.success.targetArtifactType;
  }, "media.artifact.inspect", "output-mapping-success-targets-are-unique");
});

test("begin-upload wire output branches match their canonical typed output payloads", () => {
  const operations = read(OPS_PATH);
  const row = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload");
  const wire = resolveSelector(operations, row.canonicalWireSchemaRefs[0]);
  assert.ok(wire, "begin-upload canonical owner wire resolves");
  for (const artifactType of outputTypes(wire.resultSchema)) {
    const branch = findOutputBranch(wire.resultSchema, artifactType);
    const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType: type }) => type === artifactType);
    assert.ok(typed, `${artifactType} typed output schema exists`);
    assert.deepEqual(stable(branch?.properties?.payload), stable(typed.schema.properties?.payload),
      `${artifactType} wire branch preserves the typed output payload shape`);
  }
});

test("resume workflow maps inspect and append progress to distinct exact P0 outputs", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const id = "media.artifact.upload.resume";
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === id);
  const steps = operation.outputMapping.workflowSteps;
  assert.deepEqual(steps.map(({ operationRef, targetArtifactType, disposition }) => [operationRef, targetArtifactType, disposition]), [
    ["media.operation-slice.inspect-upload", "same-uploadId-and-authoritative-transfer-state", undefined],
    ["media.operation-slice.append-upload-chunk", "newly-acknowledged-ranges-only", undefined],
    ["media.operation-slice.complete-upload", undefined, "SUPPLEMENTAL_NOT_MAPPED_TO_P0_OUTPUT"],
  ]);
  assert.deepEqual(operation.operationRefs, [
    "media.operation-slice.inspect-upload",
    "media.operation-slice.append-upload-chunk",
    "media.operation-slice.complete-upload",
  ]);
  assert.equal(steps[2].targetOutputRef, undefined, "completion result does not map to a P0 output");
  assert.ok(outputSuccessAliasesWorkflowStep(operation.outputMapping.success, steps[0]),
    "top-level success exactly aliases the inspect progress mapping");
  const p0Outputs = capabilities.capabilities.find(({ id: capabilityId }) => capabilityId === id).ownerDefinition.successOutputs;
  for (const step of steps.slice(0, 2)) {
    const p0Output = p0Outputs.find(({ artifactType }) => artifactType === step.targetArtifactType);
    assert.ok(p0Output, `${step.targetArtifactType} is declared by P0`);
    assert.equal(step.targetOutputRef,
      `${CAP_PATH}#capabilities/@id=${id}/ownerDefinition/successOutputs/@artifactType=${step.targetArtifactType}`);
    assert.ok(step.identityProjection.some(({ sourcePointer }) => pointerLeaf(sourcePointer) === "uploadId"),
      `${step.operationRef} carries the exact uploadId identity`);
  }
  assert.ok(!p0Outputs.some(({ artifactType }) => artifactType === steps[2].sourceArtifactType),
    "completion output cannot substitute for a P0 progress output");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === id);
    row.outputMapping.success.targetArtifactType = "newly-acknowledged-ranges-only";
  }, "output-workflow-top-level-success-exactly-aliases-inspect-mapping");
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${id}:`)), []);
});

test("NOT_EMPTY parameter semantics survive exact schema normalization", () => {
  const issues = [];
  const fail = (id, check) => issues.push(`${id}: ${check}`);
  const p0 = {
    type: "object",
    required: ["title"],
    emptyDisposition: "NOT_EMPTY",
    properties: { title: { type: "string", minLength: 1 } },
  };
  const p1 = structuredClone(p0);
  delete p1.emptyDisposition;
  compareParameters("test", p0, p1, {}, fail);
  assert.ok(issues.some((issue) => issue.includes("parameter[title]-schema")), "whitespace-only strings do not satisfy NOT_EMPTY");
  issues.length = 0;
  p1.properties.title.pattern = ".*\\S.*";
  compareParameters("test", p0, p1, {}, fail);
  assert.deepEqual(issues, []);
});

test("job cancel and retry mappings bind exact job, attempt, and command identities", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const expected = {
    "media.job.cancel": [
      ["input1", "media.operation-slice.cancel-job", "/jobId"],
      ["input2", "media.operation-slice.cancel-job", "/requestId"],
    ],
    "media.job.retry": [
      ["input1", "media.operation-slice.retry-job", "/jobId"],
      ["input2", "media.operation-slice.retry-job", "/priorAttemptId"],
      ["input3", "media.operation-slice.retry-job", "/requestId"],
    ],
  };
  const issues = diagnostics(capabilities, operations);
  for (const [capabilityRef, mappings] of Object.entries(expected)) {
    const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
    assert.equal(record.typedInputMappings.sourceCapabilityRef, `${CAP_PATH}#capabilities/@id=${capabilityRef}`);
    assert.deepEqual(record.typedInputMappings.entries.map((entry) => [
      entry.source.slotId,
      entry.targets[0].operationRef,
      entry.targets[0].requestPointer,
    ]), mappings);
    assert.deepEqual(issues.filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  }
});

test("project inspect binds its P0 intent to the open-project action without inventing an ID", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.project.inspect";
  const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  const entries = record.typedInputMappings.entries;
  assert.deepEqual(entries.map((entry) => [
    entry.source.slotId,
    entry.mappingDisposition ?? entry.targets[0]?.requestPointer,
  ]), [
    ["input1", "ACTION_SELECTION_ONLY"],
    ["input2", "/projectId"],
  ]);
  assert.equal(entries[0].targets.length, 0);
  assert.equal(entries[1].targets[0].operationRef, "media.operation-slice.inspect-project");
  assert.equal(entries[1].targets[0].required, true);
  assert.equal(record.typedInputMappings.requestFieldDispositions.some((field) =>
    field.requestPointer === "/creationRequestId" && field.disposition === "EXCLUDED_BY_CAPABILITY_ACTION_BINDING"), true);
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
});

test("project review carries its exact declared purpose, scopes, and action parameters", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const intent = capabilities.capabilities.find(({ id }) => id === "media.project.review");
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.review");
  const expected = intent.ownerDefinition.parameterSchema;
  assert.deepEqual(operation.parameterSchema, expected);
  assert.deepEqual(operation.requestSchema.properties.parameters, expected);
  assert.deepEqual(operation.requestSchema.required.includes("parameters"), true);
  const params = operation.parameterSchema;
  assert.deepEqual(params.required, ["reviewPurpose", "reviewScope", "reviewAction"]);
  assert.deepEqual(params.properties.reviewScope.items.enum, ["quality", "rights", "provenance", "approval"]);
  assert.equal(params.properties.reviewScope.minItems, 1);
  assert.equal(params.properties.reviewScope.maxItems, 4);
  assert.equal(params.properties.reviewScope.uniqueItems, true);
  assert.deepEqual(params.properties.reviewAction.enum, ["comment", "approve", "reject", "request-changes"]);
});

test("project create maps its title and explicitly binds authority and replay identity", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.project.create";
  const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  const entries = record.typedInputMappings.entries;
  assert.deepEqual(entries.map((entry) => [entry.source.kind, entry.source.slotId ?? entry.source.parameterName,
    entry.mappingDisposition ?? entry.targets[0]?.requestPointer]), [
    ["P0_SLOT", "input1", "ACTION_SELECTION_ONLY"],
    ["P0_PARAMETER", "title", "/title"],
  ]);
  assert.deepEqual(record.typedInputMappings.requestFieldDispositions.map((field) => [field.requestPointer, field.valueOrigin]), [
    ["/selectedAuthorizedWorkspaceId", "TRUSTED_TRANSPORT_CONTEXT"],
    ["/requestId", "GENERATED_PROTOCOL_VALUE"],
  ]);
  const wire = resolveSelector(operations, record.canonicalWireSchemaRefs[0]);
  assert.equal(wire.requestSchema.properties.title.maxLength, 200);
  assert.equal(wire.requestSchema.properties.title.pattern, ".*\\S.*");
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
});

test("source asset attachment maps exact project head and immutable source version", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.project.source-asset.attach";
  const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  assert.equal(record.typedInputMappings.selectedAction.actionRef, "media.action.attach-source-asset");
  assert.deepEqual(record.typedInputMappings.entries.map((entry) => [entry.source.slotId, entry.targets.map((target) => target.requestPointer)]), [
    ["input1", []],
    ["input2", ["/projectId", "/expectedHeadRevisionId"]],
    ["input3", ["/artifactId", "/artifactVersionId"]],
  ]);
  assert.deepEqual(record.typedInputMappings.requestFieldDispositions.map((field) => [field.requestPointer, field.valueOrigin]), [
    ["/requestId", "GENERATED_PROTOCOL_VALUE"],
  ]);
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
});

test("artifact inspection maps one exact versioned reference to both identity fields", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.artifact.inspect";
  const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  assert.deepEqual(record.typedInputMappings.entries.map((entry) => [entry.source.slotId, entry.targets.map((target) => target.requestPointer)]), [
    ["input1", ["/artifactId", "/artifactVersionId"]],
  ]);
  const source = resolveSelector(operations, record.canonicalSourceContractRefs[0]);
  const wire = resolveSelector(operations, record.canonicalWireSchemaRefs[0]);
  assert.ok(source.resultSchema.fields.includes("integrityAndLifecycleDisposition"));
  assert.equal(successRequiresOutput(wire.resultSchema, "authorized-artifact-version-summary"), true);
  assert.equal(successRequiresOutput(wire.resultSchema, "integrity-and-lifecycle-disposition"), true);
  assert.equal(successRequiresOutput(wire.resultSchema, "rights-retention-and-provenance-references-when-authorized"), false);
  const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === "integrity-and-lifecycle-disposition");
  const wireBranch = findOutputBranch(wire.resultSchema, "integrity-and-lifecycle-disposition");
  assert.deepEqual(stable(wireBranch.properties.payload), stable(typed.schema.properties.payload));
  const disposition = typed.schema.properties.payload.properties.value;
  assert.deepEqual(disposition.required, ["integrityDisposition", "lifecycleDisposition"]);
  for (const field of ["verificationRef", "expectedDigest", "observedDigest", "checkedAt", "reasonRef"]) {
    assert.equal(disposition.required.includes(field), false, `${field} must remain omittable when unknown or withheld`);
  }
  const validate = (integrityDisposition) => validateOwnerLeafWireResult({
    requestSchema: wire.requestSchema,
    resultSchema: wire.resultSchema,
  }, {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
  }, {
    operationRef: "media.operation-slice.inspect-artifact-version",
    outcome: "SUCCEEDED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [
      { artifactType: "authorized-artifact-version-summary", payload: { artifactId: "artifact-1", versionId: "version-1" } },
      { artifactType: "integrity-and-lifecycle-disposition", payload: { value: { integrityDisposition, lifecycleDisposition: "NOT_APPLICABLE" } } },
    ],
  });
  assert.equal(validate("UNKNOWN").valid, true, "unknown and redacted digest/reference fields remain absent, not inferred");
  assert.equal(validate("NOT_CHECKED").valid, true, "not-checked integrity does not require digest evidence");
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const branch = findOutputBranch(resolveSelector(copy, row.canonicalWireSchemaRefs[0]).resultSchema, "integrity-and-lifecycle-disposition");
    branch.properties.payload = structuredClone(branch.properties.payload);
    branch.properties.payload.properties.value.required.push("expectedDigest");
  }, "effective-output-payload-schema[integrity-and-lifecycle-disposition]");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const source = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    const branch = findOutputBranch(source.resultSchema, "integrity-and-lifecycle-disposition");
    branch.properties.payload = structuredClone(branch.properties.payload);
    branch.properties.payload.properties.value.required = ["integrityDisposition"];
  }, "effective-output-payload-schema[integrity-and-lifecycle-disposition]");
});

test("project search returns its bounded page identity with optional opaque continuation", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.project.search";
  const record = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  const output = record.successOutputs[0];
  assert.deepEqual(output, {
    artifactType: "bounded-project-search-result-page-and-opaque-continuation",
    payloadSchemaRef: "media.typed-output.bounded-project-search-result-page-and-opaque-continuation",
    requiredOnSuccess: true,
  });
  const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === output.payloadSchemaRef);
  const payload = typed.schema.properties.payload;
  assert.deepEqual(payload.required, ["projectIds"]);
  assert.equal(payload.properties.projectIds.maxItems, 100);
  assert.equal(payload.properties.continuationToken.format, "opaque-continuation-token");
  assert.equal(payload.required.includes("continuationToken"), false);
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  assertMutationIntroducesIssue(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    row.successOutputs[0].artifactType = "versioned-project-state";
  }, capabilityRef, "effective-request-result-schema-resolves (OUTPUT_PAYLOAD_SCHEMA_UNRESOLVED_OR_MISMATCHED)");
});

test("capability discovery returns bounded declared compatibility pages", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.capability.discover";
  const artifactType = "bounded-declared-capability-compatibility-result-page-and-opaque-continuation";
  const recordType = "declared-capability-and-compatibility-result";
  const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
  const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
  assert.equal(effective.valid, true);
  assert.deepEqual(capability.ownerDefinition.successOutputs.map(({ artifactType: type }) => type), [artifactType]);
  assert.deepEqual(operation.successOutputs, [{
    artifactType,
    payloadSchemaRef: `media.typed-output.${artifactType}`,
    requiredOnSuccess: true,
  }]);
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === `media.typed-output.${artifactType}`);
  assert.ok(typed);
  const page = typed.schema.properties.payload;
  assert.deepEqual(page.required, ["records"]);
  assert.equal(page.properties.records.minItems, 0);
  assert.equal(page.properties.records.maxItems, 100);
  assert.equal(page.properties.records.items.properties.artifactType.const, recordType);
  assert.equal(page.properties.continuationToken.format, "opaque-continuation-token");
  assert.equal(page.required.includes("continuationToken"), false);
  assert.deepEqual(operation.crossFieldRules, [{
    id: "media.operation.capability.media-capability-discover.page-size-bounds-records",
    leftRef: "$.request.parameters.pageSize",
    rightRef: "$.result.outputs[0].payload.records",
    operator: "ARRAY_LENGTH_LE_REQUEST_VALUE",
    mismatch: "REJECT",
    missing: "REJECT",
    whenOutcome: "SUCCEEDED",
    scope: "SUCCESS_OUTPUT_ONLY",
  }]);
  const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules };
  const request = (pageSize) => ({
    input1: { artifactType: "capability-query", payload: { dimensions: ["dimension:compatibility"], criteria: { capabilityRefs: ["media.capability.discover"] } } },
    input2: { artifactType: "requested-operation-and-profile", payload: { profileId: "profile-1", profileVersion: "1.0.0" } },
    parameters: { pageSize },
  });
  const resultRecord = (n) => ({
    artifactType: recordType,
    payload: { value: {
      capabilityRef: `capability-${n}`,
      operationRef: `operation-${n}`,
      profileRef: `media://profile/profile-${n}/v1`,
      compatibility: "COMPATIBLE",
      dimensionResults: [{
        dimensionRef: "dimension:compatibility",
        disposition: "SUPPORTED",
        reasonRef: "media://reason/declared/v1",
        evidenceRefs: [],
      }],
      observedAt: "2026-10-10T12:00:00Z",
    } },
  });
  const result = (outcome, records = [], continuationToken) => ({
    outcome,
    observedAt: "2026-10-10T12:00:00Z",
    outputs: outcome === "SUCCEEDED" ? [{ artifactType, payload: { records, ...(continuationToken ? { continuationToken } : {}) } }] : [],
    provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  });
  const validate = (pageSize, value) => validateOwnerLeafWireResult(contract, request(pageSize), value);
  const hundred = Array.from({ length: 100 }, (_, index) => resultRecord(index + 1));
  const emptySuccess = validate(1, result("SUCCEEDED", []));
  assert.equal(emptySuccess.valid, true, `an empty success page remains a page result: ${JSON.stringify(emptySuccess)}`);
  assert.equal(validate(2, result("SUCCEEDED", [resultRecord(1), resultRecord(2)], "opaque-next-page-token")).valid, true);
  assert.equal(validate(1, result("SUCCEEDED", [resultRecord(1), resultRecord(2)])).reason, "CROSS_FIELD_BINDING_REJECTED", "record count cannot exceed request pageSize");
  assert.equal(validate(100, result("SUCCEEDED", hundred)).valid, true, "100 records fit the declared page bound");
  assert.equal(validate(100, result("SUCCEEDED", [...hundred, resultRecord(101)])).reason, "RESULT_SCHEMA_REJECTED", "101 records exceed the page schema");
  assert.equal(validate(1, result("SUCCEEDED", [], "x".repeat(513))).reason, "RESULT_SCHEMA_REJECTED", "continuation tokens remain capped at 512 characters");
  assert.equal(validate(0, result("SUCCEEDED", [])).reason, "REQUEST_SCHEMA_REJECTED");
  assert.equal(validate(101, result("SUCCEEDED", [])).reason, "REQUEST_SCHEMA_REJECTED");
  assert.equal(validate(1, result("REJECTED")).valid, true);
  assert.equal(validate(1, result("UNKNOWN_OUTCOME")).valid, true);
});

test("streaming synthesis returns the exact P0 speech artifact instead of a stream-session claim", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.speech.synthesis.streaming";
  const artifactType = "speech-artifact-with-voice-rights-and-execution-provenance";
  const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
  const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
  assert.equal(effective.valid, true);
  assert.deepEqual(capability.ownerDefinition.successOutputs.map(({ artifactType: type }) => type), [artifactType]);
  assert.deepEqual(operation.successOutputs, [{
    artifactType,
    payloadSchemaRef: `media.typed-output.${artifactType}`,
    requiredOnSuccess: true,
  }]);
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  assert.equal(operation.streamResultSemantics, undefined);
  assert.equal(JSON.stringify(operation).includes("speech-stream-session-result"), false);
  assert.equal(operations.capabilityOperationContracts.outputPayloadSchemas.some(({ artifactType: type }) => type === "speech-stream-session-result"), false);
  const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === `media.typed-output.${artifactType}`);
  assert.ok(typed);
  const request = {
    input1: { artifactType: "text-or-speech-intent", payload: { kind: "text", text: "Hello there" } },
    parameters: { outputProfileRef: "media://profile/tts-v1" },
    requestId: "tts-request-1",
  };
  const operationRef = operation.id;
  const validSpeechPayload = {
    purposeRef: "purpose:speech-generation",
    rightsEvidenceRefs: ["rights:evidence-1"],
    consentRef: "media://consent/consent-1/v1",
    retentionPolicyRef: "media://retention/policy-1/v1",
    targetOperationRef: operationRef,
    targetOperationVersion: 1,
    capabilityRef,
    tenantId: "tenant-1",
    principalId: "principal-1",
    profileRef: "media://profile/tts-v1",
    profileVersionRef: "media://profile/tts-v1/version-1",
    originKind: "GENERATED_FROM_REQUEST",
    acceptedRequestSnapshotRef: "media://request/snapshot-1/v1",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    targetSchemaDigest: `sha256:${"b".repeat(64)}`,
    outputCandidateRef: "media://candidate/candidate-1/v1",
    outputDigest: `sha256:${"c".repeat(64)}`,
    originBindingRef: "media://origin/binding-1/v1",
    sourceVersionRefs: [],
    dependencyVersionRefs: [],
  };
  const result = (output) => ({
    outcome: "SUCCEEDED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [output],
    provenance: { operationRef, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  });
  const validate = (value) => validateOwnerLeafWireResult({ requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules ?? [] }, request, value);
  assert.equal(validate(result({ artifactType, payload: validSpeechPayload })).valid, true, "success carries the exact governed speech artifact result");
  assert.equal(validate(result({ artifactType: "speech-stream-session-result", payload: { sessionState: "OPEN" } })).reason, "RESULT_SCHEMA_REJECTED", "the obsolete stream-session result is not accepted as P0 success");
});

test("audio analysis outputs retain exact P0 identities with reference-only closed payloads", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const rows = [
    ["media.audio.analysis.segment.content-kind", "speech-music-nonspeech-segmentation-observation"],
    ["media.audio.analysis.measure.loudness", "audio-loudness-measurement-record"],
    ["media.audio.analysis.measure.peaks", "audio-peak-measurement-record"],
    ["media.audio.analysis.detect.clipping", "audio-clipping-detection-observation"],
    ["media.audio.analysis.measure.noise", "audio-noise-measurement-record"],
    ["media.audio.analysis.analyze.spectral", "audio-spectral-analysis-measurement-record"],
    ["media.audio.analysis.analyze.channels", "audio-channel-analysis-measurement-record"],
    ["media.audio.analysis.detect.beat-onset", "audio-beat-onset-detection-observation"],
    ["media.audio.analysis.detect.silence", "audio-silence-detection-observation"],
    ["media.audio.analysis.diagnose.source-separation", "audio-source-separation-diagnostic-record"],
    ["media.audio.analysis.assess.timing", "audio-timing-assessment-record"],
    ["media.audio.analysis.assess.intelligibility", "speech-intelligibility-assessment-record"],
  ];
  const genericType = "typed-audio-measurement-or-observation-with-method-and-limits";
  const profile = operations.capabilityOperationContracts.families.find(({ id }) => id === "media.capability-profile.media-audio-analysis");
  assert.deepEqual(profile.outputTypeRefs, [
    ...rows.map(([, artifactType]) => `media.typed-output.${artifactType}`).slice(0, 6),
    `media.typed-output.${genericType}`,
    ...rows.map(([, artifactType]) => `media.typed-output.${artifactType}`).slice(6),
  ]);
  const genericBefore = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === genericType);
  assert.deepEqual(genericBefore.schema.properties.payload.oneOf.map((branch) => branch.properties.kind.const), [
    "typed-audio-measurement", "observation-with-method-and-limits",
  ]);
  const audioRequest = {
    input1: { artifactType: "audio-artifact", payload: { artifactId: "audio-1", versionId: "audio-v1" } },
    input2: { artifactType: "analysis-request", payload: {
      dimensions: ["dimension:1"],
      criteria: {
        subjectRefs: ["media://audio-1/audio-v1"],
        analysisMethodRef: "method:audio-analysis-v1",
        profileRef: "profile:audio-analysis-v1",
        configurationDigest: `sha256:${"a".repeat(64)}`,
        purposeRef: "purpose:audio-analysis-v1",
      },
    } },
    parameters: {},
    requestId: "audio-analysis-request-1",
  };
  for (const [capabilityRef, artifactType] of rows) {
    const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
    const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
    assert.equal(effective.valid, true, `${capabilityRef} effective wire schema resolves`);
    assert.deepEqual(capability.ownerDefinition.successOutputs.map(({ artifactType: type }) => type), [artifactType], `${capabilityRef} keeps exact P0 output identity`);
    assert.deepEqual(operation.successOutputs, [{
      artifactType,
      payloadSchemaRef: `media.typed-output.${artifactType}`,
      requiredOnSuccess: true,
    }], `${capabilityRef} selects its exact type-specific P1 schema`);
    const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === `media.typed-output.${artifactType}`);
    assert.ok(typed, `${capabilityRef} has a dedicated output schema`);
    assert.equal(typed.artifactType, artifactType);
    assert.deepEqual(typed.schema, {
      type: "object",
      additionalProperties: false,
      required: ["artifactType", "payload"],
      properties: {
        artifactType: { const: artifactType },
        payload: {
          type: "object",
          additionalProperties: false,
          required: ["reference"],
          properties: { reference: { type: "string", format: "opaque-versioned-reference", minLength: 1, maxLength: 384 } },
        },
      },
    });
    assert.match(typed.ownerDefinition, /PXD-143/);
    const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules ?? [] };
    const validResult = (outputs) => ({
      outcome: outputs.length ? "SUCCEEDED" : "REJECTED",
      observedAt: "2026-10-10T12:00:00Z",
      outputs,
      provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
      implementationState: "UNKNOWN",
      qualificationState: "NOT_EVALUATED",
      runtimeAvailability: "UNKNOWN",
    });
    const validate = (result) => validateOwnerLeafWireResult(contract, audioRequest, result);
    assert.equal(validate(validResult([{ artifactType, payload: { reference: `media://output/${artifactType}/v1` } }])).valid, true, `${capabilityRef} accepts an opaque output reference`);
    assert.equal(validate(validResult([{ artifactType, payload: { reference: `media://output/${artifactType}/v1`, metricValue: 1 } }])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} rejects undeclared measurement claims`);
    for (const outcome of ["REJECTED", "UNKNOWN_OUTCOME"]) {
      const nonSuccess = {
        outcome,
        observedAt: "2026-10-10T12:00:00Z",
        outputs: [],
        provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
        implementationState: "UNKNOWN",
        qualificationState: "NOT_EVALUATED",
        runtimeAvailability: "UNKNOWN",
      };
      assert.equal(validate(nonSuccess).valid, true, `${capabilityRef} ${outcome} has zero output claims`);
    }
  }
  const phase = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.audio.analysis.analyze.phase");
  assert.deepEqual(phase.successOutputs, [{ artifactType: genericType, payloadSchemaRef: `media.typed-output.${genericType}`, requiredOnSuccess: true }]);
  const genericSelections = operations.capabilityOperationContracts.records
    .filter(({ familyProfileRef, successOutputs }) => familyProfileRef === profile.id && successOutputs.some(({ artifactType: type }) => type === genericType))
    .map(({ capabilityRef }) => capabilityRef);
  assert.deepEqual(genericSelections, ["media.audio.analysis.analyze.phase"], "the generic audio output remains selected only by phase analysis");
  assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith("media.audio.analysis.")), []);
});

test("artifact search and list page wrappers enforce pageSize without collapsing empty success", () => {
  const operations = read(OPS_PATH);
  const expectedType = "bounded-governed-artifact-result-page-and-opaque-continuation";
  const reference = { artifactType: "governed-artifact-reference-or-lifecycle-observation", payload: { kind: "governed-artifact-reference", artifactId: "artifact-1", versionId: "version-1" } };
  const lifecycle = { artifactType: "governed-artifact-reference-or-lifecycle-observation", payload: { kind: "lifecycle-observation", reference: "media://artifact-2/version-2" } };
  for (const capabilityRef of ["media.artifact.search", "media.artifact.list"]) {
    const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
    assert.equal(effective.valid, true);
    assert.deepEqual(operation.successOutputs, [{ artifactType: expectedType, payloadSchemaRef: "media.typed-output.bounded-governed-artifact-result-page-and-opaque-continuation", requiredOnSuccess: true }]);
    const page = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === expectedType);
    assert.deepEqual(page.schema.properties.payload.required, ["records"]);
    assert.equal(page.schema.properties.payload.properties.records.minItems, 0);
    assert.equal(page.schema.properties.payload.properties.records.maxItems, 100);
    assert.equal(page.schema.properties.payload.properties.continuationToken.maxLength, 512);
    const contract = {
      requestSchema: effective.requestSchema,
      resultSchema: effective.resultSchema,
      crossFieldRules: operation.crossFieldRules,
    };
    const result = (outcome, records = [], continuationToken) => ({
      outcome,
      observedAt: "2026-10-10T12:00:00Z",
      outputs: outcome === "SUCCEEDED" ? [{ artifactType: expectedType, payload: { records, ...(continuationToken ? { continuationToken } : {}) } }] : [],
      provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
      implementationState: "UNKNOWN",
      qualificationState: "NOT_EVALUATED",
      runtimeAvailability: "UNKNOWN",
    });
    const request = (pageSize) => ({
      parameters: { pageSize },
      input1: {
        artifactType: "source-media-or-project-reference",
        payload: { kind: "source-media", artifactId: "artifact-1", versionId: "version-1" },
      },
      input2: {
        artifactType: "rights-and-retention-context",
        payload: { purposeRef: "purpose-1", rightsEvidenceRefs: ["rights-evidence-1"] },
      },
    });
    const validate = (pageSize, value) => validateOwnerLeafWireResult(contract, request(pageSize), value);
    const hundredRecords = Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? { artifactType: "governed-artifact-reference-or-lifecycle-observation", payload: { kind: "governed-artifact-reference", artifactId: `artifact-${index + 1}`, versionId: `version-${index + 1}` } }
      : { artifactType: "governed-artifact-reference-or-lifecycle-observation", payload: { kind: "lifecycle-observation", reference: `media://artifact-${index + 1}/version-${index + 1}` } });
    assert.equal(validate(1, result("SUCCEEDED", [])).valid, true, "empty successful page remains a real page output");
    assert.equal(validate(2, result("SUCCEEDED", [reference, lifecycle], "opaque-next-page-token")).valid, true, "page boundary and optional continuation are valid");
    assert.equal(validate(2, result("SUCCEEDED", [reference, lifecycle, reference])).reason, "CROSS_FIELD_BINDING_REJECTED", "records cannot exceed requested pageSize");
    assert.equal(validate(100, result("SUCCEEDED", hundredRecords)).valid, true, "100 records fit the maximum requested pageSize and page schema");
    assert.equal(validate(100, result("SUCCEEDED", [...hundredRecords, reference])).reason, "RESULT_SCHEMA_REJECTED", "101 records exceed the page schema maxItems");
    assert.equal(validate(0, result("SUCCEEDED", [])).reason, "REQUEST_SCHEMA_REJECTED", "pageSize below the source minimum is rejected");
    assert.equal(validate(101, result("SUCCEEDED", [])).reason, "REQUEST_SCHEMA_REJECTED", "pageSize above the source maximum is rejected");
    assert.equal(validate(1, result("REJECTED")).valid, true, "denied result has no success output");
    assert.equal(validate(1, result("UNKNOWN_OUTCOME")).valid, true, "unknown result has no success output");
  }
});

test("image-to-image requires an exact source image reference and owner-resolved image kind", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.generate.image.image-to-image";
  const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
  const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
  assert.equal(effective.valid, true);
  assert.deepEqual(capability.ownerDefinition.typedInputSlots[1], {
    slotId: "input2",
    sourceType: "source-image-artifact",
    cardinality: "EXACTLY_ONE",
    required: true,
  });
  assert.deepEqual(operation.inputSlots[1], {
    slotId: "input2",
    sourceType: "source-image-artifact",
    payloadSchemaRef: "media.typed-input.image-artifact",
    cardinality: "EXACTLY_ONE",
    required: true,
  });
  const sourceImage = effective.requestSchema.properties.input2;
  assert.equal(effective.requestSchema.required.includes("input2"), true);
  assert.deepEqual(sourceImage.properties.artifactType.allOf.map(({ const: value }) => value), ["image-artifact", "image-artifact"]);
  assert.deepEqual(sourceImage.properties.payload.required, ["artifactId", "versionId"]);
  assert.equal(sourceImage.properties.payload.additionalProperties, false);
  assert.equal(sourceImage.properties.payload.properties.mediaKind, undefined);
  const candidateImage = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === "candidate-image-artifact-with-execution-provenance");
  const imageToImageCandidate = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === "media.typed-output.source-derived-candidate-image-with-lineage");
  const typedRightsContext = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === "policy-decision-reference-or-rights-observation");
  assert.equal(candidateImage.schema.properties.payload.properties.sourceLineage, undefined, "shared candidate-image output remains unchanged for other capabilities");
  assert.deepEqual(operations.capabilityOperationContracts.records
    .filter(({ capabilityRef }) => ["media.generate.image.image-to-image", "media.generate.image.reference"].includes(capabilityRef))
    .map(({ capabilityRef, successOutputs }) => [capabilityRef, successOutputs[0].payloadSchemaRef]), [
    ["media.generate.image.image-to-image", "media.typed-output.source-derived-candidate-image-with-lineage"],
    ["media.generate.image.reference", "media.typed-output.source-derived-candidate-image-with-lineage"],
  ]);
  assert.equal(operation.successOutputs[0].payloadSchemaRef, imageToImageCandidate.id, "I2I selects its capability-specific lineage payload");
  assert.deepEqual(imageToImageCandidate.schema.properties.payload.properties.sourceLineage.properties.rightsContext, typedRightsContext.schema);
  assert.deepEqual(imageToImageCandidate.schema.properties.payload.properties.sourceLineage.required, ["artifactId", "versionId", "sourceRef", "rightsContext"]);
  assert.deepEqual(operation.typedInputMappings.coverage, {
    requiredFields: 12,
    mappedFromP0: 11,
    trustedContext: 0,
    generatedProtocol: 1,
    ownerResolved: 0,
    outsideSelectedActionScope: 0,
    unresolved: 0,
    operationSelection: 0,
    status: "COMPLETE",
  });
  assert.deepEqual(operation.typedInputMappings.entries.find(({ source }) => source.slotId === "input2").targets.map(({ requestPointer }) => requestPointer), [
    "/input2/artifactType",
    "/input2/payload/artifactId",
    "/input2/payload/versionId",
  ]);
  const sourceImagePrecondition = operation.guards.preconditions.find((condition) => condition.includes("exact artifactId and versionId pair"));
  for (const semantic of [
    "authenticated owner authority",
    "artifact authorization",
    "immutable version",
    "canonical sourceRef",
    "authoritative actual media kind is IMAGE",
    "actual byte length at or below 2147483648 bytes (2 GiB)",
    "Never substitute a version",
    "declaredMediaType and declaredByteLength only as untrusted hints",
    "Reject missing, mismatched, unavailable, non-image, or over-bound versions before dispatch",
  ]) assert.equal(sourceImagePrecondition.includes(semantic), true, `owner precondition retains ${semantic}`);
  const rightsPrecondition = operation.guards.preconditions.find((condition) => condition.includes("rights applicability"));
  for (const semantic of [
    "missing, unresolvable, or unknown applicable authority reference blocks SUCCEEDED",
    "absence is never interpreted as NO_APPLICABLE",
    "exact closed policy-decision-reference-or-rights-observation variant in source lineage",
    "currentness, subject scope, and allow at the effect boundary",
    "reference identity alone proves none of these",
  ]) assert.equal(rightsPrecondition.includes(semantic), true, `rights precondition retains ${semantic}`);

  const request = (sourceInput = { artifactType: "image-artifact", payload: { artifactId: "artifact-1", versionId: "version-1" } }) => ({
    input1: { artifactType: "text-or-visual-intent", payload: { kind: "text", text: "restyle the source" } },
    input2: sourceInput,
    parameters: { outputWidth: 1024, outputHeight: 1024, outputProfileRef: "profile:v1" },
    requestId: "request-1",
  });
  const rejectedResult = {
    outcome: "REJECTED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [],
    provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  };
  const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules };
  const validate = (value, result = rejectedResult) => validateOwnerLeafWireResult(contract, value, result);
  assert.equal(validate(request()).valid, true, "exact immutable image references satisfy the request schema");
  const missing = request();
  delete missing.input2;
  assert.equal(validate(missing).reason, "REQUEST_SCHEMA_REJECTED", "required source-image selector cannot be omitted");
  assert.equal(validate(request({ artifactType: "image-artifact", payload: { versionId: "version-1" } })).reason, "REQUEST_SCHEMA_REJECTED", "artifactId cannot be omitted");
  assert.equal(validate(request({ artifactType: "image-artifact", payload: { artifactId: "artifact-1" } })).reason, "REQUEST_SCHEMA_REJECTED", "versionId cannot be omitted");
  assert.equal(validate(request({ artifactType: "optional-authorized-reference-artifacts", payload: { artifactId: "artifact-1", versionId: "version-1" } })).reason, "REQUEST_SCHEMA_REJECTED", "wrong source selector is rejected");
  assert.equal(validate(request({ artifactType: "image-artifact", payload: { artifactId: "artifact-1", versionId: "version-1", mediaKind: "IMAGE" } })).reason, "REQUEST_SCHEMA_REJECTED", "caller-supplied media kind is forbidden");
  const conflictingHints = request({ artifactType: "image-artifact", payload: { artifactId: "artifact-1", versionId: "version-1", declaredMediaType: "video/mp4", declaredByteLength: 2147483648 } });
  assert.equal(validate(conflictingHints).valid, true, "schema accepts bounded declared metadata only as untrusted hints; the owner precondition checks actual kind and byte length");

  const sourceRef = "media://artifact-1/version-1";
  const policyDecisionContext = { artifactType: "policy-decision-reference-or-rights-observation", payload: { kind: "policy-decision-reference", reference: "media://rights-decision/decision-1/policy-v1" } };
  const rightsObservationContext = { artifactType: "policy-decision-reference-or-rights-observation", payload: { kind: "rights-observation", reference: "media://rights-observation/observation-1/v1" } };
  const success = (lineage = { artifactId: "artifact-1", versionId: "version-1", sourceRef, rightsContext: policyDecisionContext }, sourceRefs = [sourceRef]) => ({
    outcome: "SUCCEEDED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [{ artifactType: "candidate-image-artifact-with-execution-provenance", payload: { jobId: "job-1", sourceLineage: lineage } }],
    provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  });
  assert.equal(validate(request(), success()).valid, true, "success carries exact owner-resolved source identity and provenance linkage");
  assert.equal(validate(request(), success({ artifactId: "artifact-1", versionId: "version-1", sourceRef, rightsContext: rightsObservationContext })).valid, true, "the source-backed rights observation alternative is valid");
  assert.equal(validate(request(), success({ artifactId: "artifact-2", versionId: "version-1", sourceRef, rightsContext: policyDecisionContext })).reason, "CROSS_FIELD_BINDING_REJECTED", "source artifact mismatch is rejected");
  assert.equal(validate(request(), success({ artifactId: "artifact-1", versionId: "version-2", sourceRef, rightsContext: policyDecisionContext })).reason, "CROSS_FIELD_BINDING_REJECTED", "source version mismatch is rejected");
  assert.equal(validate(request(), success({ artifactId: "artifact-1", versionId: "version-1", sourceRef: "media://other-artifact/version-1", rightsContext: policyDecisionContext })).reason, "CROSS_FIELD_BINDING_REJECTED", "a sourceRef absent from provenance is rejected");
  assert.equal(validate(request(), success(undefined, [])).reason, "CROSS_FIELD_BINDING_REJECTED", "sourceRef must appear in provenance.sourceRefs");
  assert.equal(validate(request(), success({ artifactId: "artifact-1", versionId: "version-1", rightsContext: policyDecisionContext })).reason, "RESULT_SCHEMA_REJECTED", "sourceRef is required in success lineage");
  assert.equal(validate(request(), success({ artifactId: "artifact-1", versionId: "version-1", sourceRef })).reason, "RESULT_SCHEMA_REJECTED", "applicable rights context is required for success; absence is not a no-applicable branch");
  const missingRightsRef = structuredClone(success());
  delete missingRightsRef.outputs[0].payload.sourceLineage.rightsContext.payload.reference;
  assert.equal(validate(request(), missingRightsRef).reason, "RESULT_SCHEMA_REJECTED", "an unresolvable empty authority reference cannot support success");
  const missingLineage = structuredClone(success());
  delete missingLineage.outputs[0].payload.sourceLineage;
  assert.equal(validate(request(), missingLineage).reason, "RESULT_SCHEMA_REJECTED", "missing success source lineage fails the success schema");
  assert.equal(validate(request(), rejectedResult).valid, true, "REJECTED retains zero success lineage outputs");
  const unknownOutcome = { ...rejectedResult, outcome: "UNKNOWN_OUTCOME" };
  assert.equal(validate(request(), unknownOutcome).valid, true, "UNKNOWN_OUTCOME retains zero success lineage outputs");
});

test("image reference requires an exact source image and carries success lineage", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityRef = "media.generate.image.reference";
  const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
  const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
  const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
  assert.equal(effective.valid, true);
  assert.deepEqual(capability.ownerDefinition.typedInputSlots.find(({ slotId }) => slotId === "input2"), {
    slotId: "input2",
    sourceType: "source-image-artifact",
    cardinality: "EXACTLY_ONE",
    required: true,
  });
  assert.deepEqual(operation.inputSlots[1], {
    slotId: "input2",
    sourceType: "source-image-artifact",
    payloadSchemaRef: "media.typed-input.image-artifact",
    cardinality: "EXACTLY_ONE",
    required: true,
  });
  assert.deepEqual(operation.parameterSchema.required, []);
  assert.deepEqual(operation.parameterSchema.properties, {});
  assert.deepEqual(operation.requestSchema.required, ["parameters", "input1", "input2", "requestId"]);
  assert.equal(operation.successOutputs[0].payloadSchemaRef, "media.typed-output.source-derived-candidate-image-with-lineage");
  assert.deepEqual(operation.typedInputMappings.entries.find(({ source }) => source.slotId === "input2").targets.map(({ requestPointer }) => requestPointer), [
    "/input2/artifactType",
    "/input2/payload/artifactId",
    "/input2/payload/versionId",
  ]);
  const sourceImagePrecondition = operation.guards.preconditions.find((condition) => condition.includes("exact artifactId and versionId pair"));
  for (const semantic of [
    "immutable version",
    "canonical sourceRef",
    "authoritative actual media kind is IMAGE",
    "actual byte length at or below 2147483648 bytes (2 GiB)",
    "Never substitute a version",
    "only as untrusted hints",
  ]) assert.equal(sourceImagePrecondition.includes(semantic), true, `owner precondition retains ${semantic}`);
  const rightsPrecondition = operation.guards.preconditions.find((condition) => condition.includes("rights applicability"));
  for (const semantic of [
    "missing, unresolvable, or unknown applicable authority reference blocks SUCCEEDED",
    "absence is never interpreted as NOT_APPLICABLE",
    "exact closed policy-decision-reference-or-rights-observation variant in source lineage",
    "currentness, subject scope, and allow at the effect boundary",
    "reference identity alone proves none of these",
  ]) assert.equal(rightsPrecondition.includes(semantic), true, `rights precondition retains ${semantic}`);

  const request = (input2 = { artifactType: "image-artifact", payload: { artifactId: "artifact-r", versionId: "version-r" } }) => ({
    input1: { artifactType: "text-or-visual-intent", payload: { kind: "text", text: "use this reference" } },
    input2,
    parameters: {},
    requestId: "request-r",
  });
  const rejectedResult = {
    outcome: "REJECTED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [],
    provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  };
  const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules };
  const validate = (value, result = rejectedResult) => validateOwnerLeafWireResult(contract, value, result);
  assert.equal(validate(request()).valid, true, "exact required source-image wrapper is accepted");
  const omitted = request();
  delete omitted.input2;
  assert.equal(validate(omitted).reason, "REQUEST_SCHEMA_REJECTED", "required source-image slot cannot be omitted");
  assert.equal(validate(request({ artifactType: "optional-authorized-reference-artifacts", payload: { artifactId: "artifact-r", versionId: "version-r" } })).reason, "REQUEST_SCHEMA_REJECTED", "wrong source wrapper is rejected");
  assert.equal(validate(request({ artifactType: "image-artifact", payload: { versionId: "version-r" } })).reason, "REQUEST_SCHEMA_REJECTED", "source artifact identity is required");
  assert.equal(validate(request({ artifactType: "image-artifact", payload: { artifactId: "artifact-r" } })).reason, "REQUEST_SCHEMA_REJECTED", "source version identity is required");

  const sourceRef = "media://artifact-r/version-r";
  const policyDecisionContext = { artifactType: "policy-decision-reference-or-rights-observation", payload: { kind: "policy-decision-reference", reference: "media://rights-decision/decision-r/policy-v1" } };
  const rightsObservationContext = { artifactType: "policy-decision-reference-or-rights-observation", payload: { kind: "rights-observation", reference: "media://rights-observation/observation-r/v1" } };
  const success = (lineage = { artifactId: "artifact-r", versionId: "version-r", sourceRef, rightsContext: policyDecisionContext }, sourceRefs = [sourceRef]) => ({
    outcome: "SUCCEEDED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [{ artifactType: "candidate-image-artifact-with-execution-provenance", payload: { jobId: "job-r", sourceLineage: lineage } }],
    provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs },
    implementationState: "UNKNOWN",
    qualificationState: "NOT_EVALUATED",
    runtimeAvailability: "UNKNOWN",
  });
  assert.equal(validate(request(), success()).valid, true, "success carries exact source lineage and rights context");
  assert.equal(validate(request(), success({ artifactId: "artifact-r", versionId: "version-r", sourceRef, rightsContext: rightsObservationContext })).valid, true, "rights observation alternative is valid");
  assert.equal(validate(request(), success({ artifactId: "other-artifact", versionId: "version-r", sourceRef, rightsContext: policyDecisionContext })).reason, "CROSS_FIELD_BINDING_REJECTED", "source artifact mismatch is rejected");
  assert.equal(validate(request(), success({ artifactId: "artifact-r", versionId: "other-version", sourceRef, rightsContext: policyDecisionContext })).reason, "CROSS_FIELD_BINDING_REJECTED", "source version mismatch is rejected");
  assert.equal(validate(request(), success(undefined, [])).reason, "CROSS_FIELD_BINDING_REJECTED", "sourceRef must appear in provenance.sourceRefs");
  assert.equal(validate(request(), success({ artifactId: "artifact-r", versionId: "version-r", sourceRef })).reason, "RESULT_SCHEMA_REJECTED", "success requires a typed rights context");
  assert.equal(validate(request(), rejectedResult).valid, true, "REJECTED retains no success lineage outputs");
  assert.equal(validate(request(), { ...rejectedResult, outcome: "UNKNOWN_OUTCOME" }).valid, true, "UNKNOWN_OUTCOME retains no success lineage outputs");
});

test("seven image, video, and audio source slots require exact immutable artifact references", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const cohorts = [
    { mediaKind: "image", artifactType: "image-artifact", sourceType: "source-image-artifact", capabilities: ["media.generate.video.image-to-video", "media.generate.spatial.image-to-3d"] },
    { mediaKind: "video", artifactType: "video-artifact", sourceType: "source-video-artifact", capabilities: ["media.generate.video.video-to-video", "media.generate.audio.video-to-audio"] },
    { mediaKind: "audio", artifactType: "audio-artifact", sourceType: "source-audio-artifact", capabilities: ["media.generate.video.drive.audio", "media.generate.audio.audio-to-audio", "media.generate.audio.stem.generate"] },
  ];
  for (const cohort of cohorts) for (const capabilityRef of cohort.capabilities) {
    const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
    const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
    assert.equal(effective.valid, true, `${capabilityRef} effective wire schema resolves`);
    assert.deepEqual(operation.successOutputs.map(({ artifactType }) => artifactType), capability.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), `${capabilityRef} retains its P0 success output identity`);
    const outputSchema = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === operation.successOutputs[0].payloadSchemaRef);
    const genericOutputSchema = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === operation.successOutputs[0].artifactType);
    assert.ok(outputSchema, `${capabilityRef} selects a dedicated source-derived output schema`);
    assert.equal(JSON.stringify(genericOutputSchema.schema).includes("sourceLineage"), false, `${capabilityRef} leaves the generic typed output unchanged`);
    assert.deepEqual(capability.ownerDefinition.typedInputSlots.find(({ slotId }) => slotId === "input2"), {
      slotId: "input2", sourceType: cohort.sourceType, cardinality: "EXACTLY_ONE", required: true,
    });
    assert.deepEqual(operation.inputSlots[1], {
      slotId: "input2", sourceType: cohort.sourceType, payloadSchemaRef: `media.typed-input.${cohort.artifactType}`, cardinality: "EXACTLY_ONE", required: true,
    });
    assert.deepEqual(operation.inputSlots[0].alternatives, capability.ownerDefinition.typedInputSlots[0].alternatives);
    assert.equal(effective.requestSchema.required.includes("input2"), true, `${capabilityRef} requires input2`);
    const input2 = effective.requestSchema.properties.input2;
    assert.deepEqual([...new Set(artifactTypes(input2))], [cohort.artifactType]);
    assert.deepEqual(input2.properties.payload.required, ["artifactId", "versionId"]);
    const inputMap = operation.typedInputMappings.entries.find(({ source }) => source.slotId === "input2");
    assert.equal(inputMap.cardinality, "EXACTLY_ONE");
    assert.deepEqual(inputMap.targets.map(({ requestPointer }) => requestPointer), [
      "/input2/artifactType", "/input2/payload/artifactId", "/input2/payload/versionId",
    ]);
    const sourcePrecondition = operation.guards.preconditions.find((condition) => condition.includes("exact artifactId and versionId pair"));
    for (const semantic of [
      `actual media kind is ${cohort.mediaKind.toUpperCase()}`,
      "actual byte length at or below 2147483648 bytes (2 GiB)",
      "Never substitute a version",
      "only as untrusted hints",
    ]) assert.equal(sourcePrecondition.includes(semantic), true, `${capabilityRef} retains ${semantic}`);

    const intentWrapper = effective.requestSchema.properties.input1;
    const intentArtifactType = artifactTypes(intentWrapper)[0];
    const parameters = capabilityRef === "media.generate.video.image-to-video" ? {
      outputWidth: 1024, outputHeight: 1024, frameRate: { numerator: 30, denominator: 1 }, durationMilliseconds: 1000, outputProfileRef: "profile:video-v1",
    } : {};
    const request = (source = { artifactType: cohort.artifactType, payload: { artifactId: "source-1", versionId: "source-v1", declaredMediaType: "application/x-untrusted", declaredByteLength: 2147483648 } }) => ({
      input1: { artifactType: intentArtifactType, payload: { kind: "text", text: "animate or transform source" } },
      input2: source,
      parameters,
      requestId: "request-source-1",
    });
    const rejectedResult = {
      outcome: "REJECTED",
      observedAt: "2026-10-10T12:00:00Z",
      outputs: [],
      provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs: [] },
      implementationState: "UNKNOWN",
      qualificationState: "NOT_EVALUATED",
      runtimeAvailability: "UNKNOWN",
    };
    const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules ?? [] };
    const validate = (value) => validateOwnerLeafWireResult(contract, value, rejectedResult);
    const validateResult = (value, result) => validateOwnerLeafWireResult(contract, value, result);
    assert.equal(validate(request()).valid, true, `${capabilityRef} accepts exact IDs and treats declared metadata as hints`);
    const omitted = request();
    delete omitted.input2;
    assert.equal(validate(omitted).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects omitted input2`);
    assert.equal(validate(request({ artifactType: "optional-authorized-reference-artifacts", payload: { artifactId: "source-1", versionId: "source-v1" } })).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects the wrong wrapper`);
    assert.equal(validate(request({ artifactType: cohort.artifactType, payload: { versionId: "source-v1" } })).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects a missing artifactId`);
    assert.equal(validate(request({ artifactType: cohort.artifactType, payload: { artifactId: "source-1" } })).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects a missing versionId`);

    const sourceRef = "media://source-1/source-v1";
    const rightsContext = { artifactType: "policy-decision-reference-or-rights-observation", payload: { kind: "policy-decision-reference", reference: "media://rights-decision/source-use/policy-v1" } };
    const sourceLineage = { artifactId: "source-1", versionId: "source-v1", sourceRef, rightsContext };
    const outputType = operation.successOutputs[0].artifactType;
    const outputPayload = outputType === "spatial-artifact-or-media-pass-with-coordinate-and-fidelity-metadata"
      ? { kind: "spatial-artifact", artifactId: "output-1", versionId: "output-v1", sourceLineage }
      : { jobId: "job-1", sourceLineage };
    const success = (lineage = sourceLineage, sourceRefs = [sourceRef]) => ({
      outcome: "SUCCEEDED",
      observedAt: "2026-10-10T12:00:00Z",
      outputs: [{ artifactType: outputType, payload: { ...outputPayload, sourceLineage: lineage } }],
      provenance: { operationRef: operation.id, observedAt: "2026-10-10T12:00:00Z", sourceRefs },
      implementationState: "UNKNOWN",
      qualificationState: "NOT_EVALUATED",
      runtimeAvailability: "UNKNOWN",
    });
    assert.equal(validateResult(request(), success()).valid, true, `${capabilityRef} success binds exact source identity and provenance`);
    if (outputType === "spatial-artifact-or-media-pass-with-coordinate-and-fidelity-metadata") {
      const duplicateSourceIdentity = structuredClone(success());
      duplicateSourceIdentity.outputs[0].payload.sourceRef = "media://conflicting-source/version-x";
      assert.equal(validateResult(request(), duplicateSourceIdentity).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} rejects a second conflicting top-level sourceRef`);
    }
    assert.equal(validateResult(request(), success({ ...sourceLineage, artifactId: "other-source" })).reason, "CROSS_FIELD_BINDING_REJECTED", `${capabilityRef} rejects source artifact mismatch`);
    assert.equal(validateResult(request(), success({ ...sourceLineage, versionId: "other-version" })).reason, "CROSS_FIELD_BINDING_REJECTED", `${capabilityRef} rejects source version mismatch`);
    assert.equal(validateResult(request(), success({ ...sourceLineage, sourceRef: "media://other-source/version-v1" })).reason, "CROSS_FIELD_BINDING_REJECTED", `${capabilityRef} rejects a sourceRef absent from provenance`);
    assert.equal(validateResult(request(), success(undefined, [])).reason, "CROSS_FIELD_BINDING_REJECTED", `${capabilityRef} requires lineage sourceRef in provenance`);
    const missingRights = structuredClone(success());
    delete missingRights.outputs[0].payload.sourceLineage.rightsContext;
    assert.equal(validateResult(request(), missingRights).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} requires applicable typed rights context on success`);
    assert.equal(validateResult(request(), rejectedResult).valid, true, `${capabilityRef} REJECTED has no success output claims`);
    assert.equal(validateResult(request(), { ...rejectedResult, outcome: "UNKNOWN_OUTCOME" }).valid, true, `${capabilityRef} UNKNOWN_OUTCOME has no success output claims`);
  }
});

test("project create, inspect, and attach preserve exact project receipt variants", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const projectOutput = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ artifactType }) => artifactType === "versioned-project-state");
  assert.equal(projectOutput.payloadKind, "PROJECT_REVISION_STATE_OR_OWNER_RECEIPT_VARIANT");
  const projectKinds = projectOutput.schema.properties.payload.oneOf.map((variant) => variant.properties.kind?.const).filter(Boolean);
  assert.deepEqual(projectKinds, [
    "project-revision-state",
    "project-creation-receipt",
    "project-creation-reconciliation-receipt",
    "project-head-observation",
    "project-source-attachment-commit-receipt",
  ]);
  for (const capabilityRef of ["media.project.create", "media.project.inspect", "media.project.source-asset.attach"]) {
    assert.deepEqual(diagnostics(capabilities, operations).filter((issue) => issue.startsWith(`${capabilityRef}:`)), []);
  }
  const inspect = operations.individualOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-project").ownerWireSchema;
  const inspectRequest = (selector) => ({ selectedAuthorizedWorkspaceId: "workspace-1", ...selector });
  const inspectResult = (kind, payload) => ({
    operationRef: "media.operation-slice.inspect-project",
    outcome: "SUCCEEDED",
    observedAt: "2026-10-10T12:00:00Z",
    outputs: [{ artifactType: "versioned-project-state", payload: { kind, ...payload } }],
  });
  const projectHead = { projectId: "project-1", workspaceId: "workspace-1", title: "Project", projectState: "ACTIVE", headRevisionId: "rev-1", headRevisionState: "COMMITTED", headRevisionSnapshot: { projectId: "project-1", revisionId: "rev-1" } };
  const createReceipt = { projectId: "project-1", creationRequestId: "request-1", requestFingerprint: "fingerprint-1", initialRevisionId: "rev-1", creationOutcome: "CREATED" };
  assert.equal(validateOwnerLeafWireResult(inspect, inspectRequest({ projectId: "project-1" }), inspectResult("project-head-observation", projectHead)).valid, true);
  assert.equal(validateOwnerLeafWireResult(inspect, inspectRequest({ creationRequestId: "request-1" }), inspectResult("project-creation-reconciliation-receipt", createReceipt)).valid, true);
  assert.equal(validateOwnerLeafWireResult(inspect, inspectRequest({ projectId: "project-1" }), inspectResult("project-creation-reconciliation-receipt", createReceipt)).reason, "CROSS_FIELD_BINDING_REJECTED");
  assert.equal(validateOwnerLeafWireResult(inspect, inspectRequest({ creationRequestId: "request-1" }), inspectResult("project-head-observation", projectHead)).reason, "CROSS_FIELD_BINDING_REJECTED");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    const wire = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    findOutputBranch(wire.resultSchema, "versioned-project-state").properties.payload.required = ["kind", "projectId"];
  }, "project-versioned-state-payload[project-creation-receipt]-exact-fields");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.inspect");
    const wire = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    findOutputBranch(wire.resultSchema, "versioned-project-state").properties.payload.oneOf.pop();
  }, "project-inspect-result-preserves-selector-specific-branches");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.inspect");
    const wire = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    wire.crossFieldRules[0].expectedConst = "project-creation-reconciliation-receipt";
  }, "project-inspect-selector-to-result-variant-binding");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.source-asset.attach");
    const wire = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    findOutputBranch(wire.resultSchema, "versioned-project-state").properties.payload.required = ["kind", "projectId", "priorHeadRevisionId", "newRevisionId", "attachedArtifactId", "committedAt"];
  }, "project-versioned-state-payload[project-source-attachment-commit-receipt]-exact-fields");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.update");
    row.resultSchema.properties.outputs.items.oneOf[0].properties.payload.required = ["projectId"];
  }, "effective-project-state-output-matches-source-defined-project-revision-variant");
});

test("all 462 PDP-1 mappings preserve P0 capability input, parameter, and success-output meaning", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const issues = diagnostics(capabilities, operations, {
    ignoredIssues: (issue) => /^media\.speech\.synthesis\.dub: parameter(?:-|\[)/u.test(issue),
  });
  const dub = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.speech.synthesis.dub");
  const dubP0 = capabilities.capabilities.find(({ id }) => id === "media.speech.synthesis.dub").ownerDefinition.parameterSchema;
  const dubScalarTypes = operations.capabilityOperationContracts.scalarTypes ?? {};
  const dubBaseNames = Object.keys(dubP0.properties).sort();
  const dubSupplementalNames = ["sourceLocale", "translatedSegmentVersionRef", "voiceProfileVersionRef"];
  assert.deepEqual(dubBaseNames, ["outputLanguage", "outputProfileRef"]);
  assert.deepEqual(Object.keys(dub.parameterSchema.properties).sort(), ["outputProfileRef", "sourceLocale", "targetLocale", "translatedSegmentVersionRef", "voiceProfileVersionRef"].sort(),
    "PXD-163 C16 adds exactly its approved dub parameters and maps the P0 output-language field");
  assert.equal(dub.parameterSchema.type, "object", "dub parameter envelope is an object");
  assert.equal(dub.parameterSchema.additionalProperties, false, "dub parameter envelope is closed");
  assert.deepEqual([...dub.parameterSchema.required].sort(), ["outputProfileRef", "sourceLocale", "targetLocale", "translatedSegmentVersionRef", "voiceProfileVersionRef"].sort(),
    "dub requires exactly the five PXD-163 C16 parameter fields");
  assert.equal(dub.parameterSchema.emptyDisposition, "NOT_EMPTY", "dub rejects an empty parameter object");
  assert.deepEqual(normalizedParameterField(dubP0.properties.outputProfileRef, dubP0, dubScalarTypes),
    normalizedSchema(dub.parameterSchema.properties.outputProfileRef, dubScalarTypes),
    "dub preserves exact P0 outputProfileRef schema");
  assert.equal(dubP0.required.includes("outputProfileRef"), dub.parameterSchema.required.includes("outputProfileRef"),
    "dub preserves exact P0 outputProfileRef requiredness");
  // P0's optional outputLanguage is represented by C16's exact targetLocale;
  // C16 requires a target locale for dubbing and forbids locale substitution.
  assert.deepEqual(normalizedParameterField(dubP0.properties.outputLanguage, dubP0, dubScalarTypes),
    normalizedSchema(dub.parameterSchema.properties.targetLocale, dubScalarTypes),
    "P0 outputLanguage maps to the exact C16 targetLocale schema");
  assert.equal(dubP0.required.includes("outputLanguage"), false, "P0 outputLanguage remains optional in its source definition");
  assert.equal(dub.parameterSchema.required.includes("targetLocale"), true, "C16 requires the explicitly selected target locale");
  const c16ParameterSchemas = {
    sourceLocale: { type: "string", format: "bcp47-language-tag", pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$", minLength: 2, maxLength: 63 },
    targetLocale: { type: "string", format: "bcp47-language-tag", pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$", minLength: 2, maxLength: 63 },
    translatedSegmentVersionRef: { type: "string", format: "opaque-versioned-reference", minLength: 1, maxLength: 384 },
    voiceProfileVersionRef: { type: "string", format: "versioned-profile-reference", minLength: 1, maxLength: 384, pattern: ".*\\S.*" },
  };
  assert.deepEqual(dubSupplementalNames.sort(), ["sourceLocale", "translatedSegmentVersionRef", "voiceProfileVersionRef"]);
  for (const [name, schema] of Object.entries(c16ParameterSchemas)) {
    assert.deepEqual(normalizedSchema(dub.parameterSchema.properties[name], dubScalarTypes), stable(schema),
      `PXD-163 C16 defines exact ${name} schema`);
    assert.equal(dub.parameterSchema.required.includes(name), true, `PXD-163 C16 requires ${name}`);
  }
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.generate.image.image-to-image");
    row.inputSlots[1].required = false;
    row.requestSchema.required = row.requestSchema.required.filter((name) => name !== row.inputSlots[1].slotId);
  }, "input[1].required");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.generate.image.image-to-image");
    row.inputSlots[1].cardinality = "ZERO_OR_ONE";
  }, "input[1].cardinality");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    const source = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    source.requestSchema.required = source.requestSchema.required.filter((name) => name !== "title");
  }, "typed-input-mapping-target-requiredness[parameter:title]");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.create");
    const source = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    source.resultSchema.properties.outputs.items.oneOf[0].properties.artifactType.const = "wrong-output-identity";
  }, "ordered-acknowledgment-output-identities-match-explicit-P0-adapter");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.inspect");
    delete row.typedInputMappings.selectedAction;
  }, "typed-input-selected-action-source-binding");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.project.inspect");
    const input = row.typedInputMappings.entries.find(({ source }) => source.slotId === "input2");
    input.mappingDisposition = "ACTION_SELECTION_ONLY";
    input.targets = [];
  }, "typed-input-action-selection-only-source[slot:input2]");
  assertMutationDetected(capabilities, operations, (copy) => {
    const row = copy.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === "media.artifact.inspect");
    const wire = resolveSelector(copy, row.canonicalWireSchemaRefs[0]);
    wire.resultSchema.allOf.find((clause) => clause.if?.properties?.outcome?.const === "SUCCEEDED")
      .then.properties.outputs.contains = {
        properties: { artifactType: { const: "rights-retention-and-provenance-references-when-authorized" } },
        required: ["artifactType"],
      };
  }, "output-mapping-additional-success[1]-maps-an-exact-P0-output-with-matching-requiredness");

  if (issues.length) {
    const missingMappingIds = [...new Set(issues.filter((issue) => issue.includes("typed-input-mapping-contract-present")).map((issue) => issue.split(":", 1)[0]))];
    const counts = Object.entries(issues.reduce((result, issue) => { const check = issue.slice(issue.indexOf(": ") + 2).split(" (")[0]; result[check] = (result[check] ?? 0) + 1; return result; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.error(`PDP-1 capability mapping mismatches: ${issues.length}; first: ${issues[0]}; most common: ${JSON.stringify(counts)}; missing typed-input mapping capability IDs: ${missingMappingIds.join(",")}`);
  }
  assert.equal(issues.length, 0, `${issues.length} semantic mapping failures; first: ${issues[0] ?? "none"}${issues.length ? `\n${[...issues].sort().join("\n")}` : ""}`);
});

test("PXD-144 delete, keyframe, attestation, dub, and clone outputs preserve exact source identities", () => {
  const operations = read(OPS_PATH);
  const definitions = [
    ["media.artifact.delete", "artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown"],
    ["media.generate.video.keyframe.start", "candidate-video-keyframe-artifact"],
    ["media.generate.video.keyframe.end", "candidate-video-keyframe-artifact"],
    ["media.generate.video.keyframe.intermediate", "candidate-video-keyframe-sequence-artifact"],
    ["media.rights.attestation.record", "asserted-rights-attestation-record"],
    ["media.speech.synthesis.dub", "candidate-dubbed-media-artifact-with-speech-sync-provenance"],
    ["media.speech.synthesis.speaker.clone-authorized", "derived-authorized-speaker-voice-profile-record"],
  ];
  const timestamp = "2026-10-10T12:00:00Z";
  const identity = { artifactId: "artifact-1", versionId: "version-1" };
  const requests = {
    "media.artifact.delete": {
      input1: { artifactType: "governed-artifact-reference", payload: { ...identity } },
      input2: { artifactType: "rights-and-retention-context", payload: { purposeRef: "purpose-delete", rightsEvidenceRefs: ["media://rights/evidence/delete-v1"] } },
      parameters: {}, requestId: "request-delete-1",
    },
    "media.generate.video.keyframe.start": { input1: { artifactType: "text-or-video-intent", payload: { kind: "text", text: "make a keyframe" } }, parameters: {}, requestId: "request-keyframe-start" },
    "media.generate.video.keyframe.end": { input1: { artifactType: "text-or-video-intent", payload: { kind: "text", text: "make a keyframe" } }, parameters: {}, requestId: "request-keyframe-end" },
    "media.generate.video.keyframe.intermediate": { input1: { artifactType: "text-or-video-intent", payload: { kind: "text", text: "make keyframes" } }, parameters: {}, requestId: "request-keyframe-intermediate" },
    "media.rights.attestation.record": {
      input1: { artifactType: "identity-and-authority-context", payload: { tenantRef: "tenant-1", principalRef: "principal-1", delegationRef: "delegation-1", authorityDecisionRef: "decision-1", issuedAt: timestamp, expiresAt: "2026-10-11T12:00:00Z" } },
      input2: { artifactType: "rights-evidence-reference", payload: { purposeRef: "purpose-attestation", retentionPolicyRef: "media://retention/policy/v1", rightsEvidenceRefs: ["media://rights/evidence/v1"] } },
      parameters: {}, requestId: "request-attestation-1",
    },
    "media.speech.synthesis.dub": {
      input1: { artifactType: "text-or-speech-intent", payload: { kind: "text", text: "dub text" } },
      input2: { artifactType: "source-media-with-speech-artifact", payload: {
        ...identity, sourceContentDigest: `sha256:${"a".repeat(64)}`, sourceClockId: "clock-1", ticksPerSecond: 48000, sourceDurationTicks: 480000,
      } },
      parameters: {
        outputProfileRef: "media://profile/speech/v1", sourceLocale: "en-US", targetLocale: "es-ES",
        translatedSegmentVersionRef: "media://caption/version/translated-v1", voiceProfileVersionRef: "media://voice/profile/v1",
      }, requestId: "request-dub-1",
    },
    "media.speech.synthesis.speaker.clone-authorized": {
      input1: { artifactType: "text-or-speech-intent", payload: { kind: "text", text: "clone request" } },
      input2: { artifactType: "authorized-source-speaker-recording", payload: { ...identity } },
      parameters: { outputProfileRef: "media://profile/speech/v1" }, requestId: "request-clone-1",
    },
  };
  const deleteType = "artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown";
  for (const [capabilityRef, artifactType] of definitions) {
    const operation = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
    const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
    assert.equal(effective.valid, true, `${capabilityRef} effective wire resolves`);
    assert.deepEqual(operation.successOutputs, [{ artifactType, payloadSchemaRef: `media.typed-output.${artifactType}`, requiredOnSuccess: true }]);
    const typed = operations.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) => id === `media.typed-output.${artifactType}`);
    assert.ok(typed, `${artifactType} has a closed output schema`);
    assert.equal(typed.schema.additionalProperties, false);
    const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules ?? [] };
    const output = (type, payload) => ({ artifactType: type, payload });
    const result = (request, outcome, outputs) => ({
      ...(capabilityRef === "media.speech.synthesis.dub" ? { requestId: request.requestId, requestFingerprint: `sha256:${"b".repeat(64)}` } : {}),
      ...(capabilityRef === "media.speech.synthesis.dub" && outcome === "SUCCEEDED" ? {
        acceptedRequest: {
          sourceArtifactId: request.input2.payload.artifactId,
          sourceArtifactVersionId: request.input2.payload.versionId,
          sourceContentDigest: request.input2.payload.sourceContentDigest,
          sourceClockId: request.input2.payload.sourceClockId,
          ticksPerSecond: request.input2.payload.ticksPerSecond,
          sourceDurationTicks: request.input2.payload.sourceDurationTicks,
          sourceLocale: request.parameters.sourceLocale,
          targetLocale: request.parameters.targetLocale,
          translatedSegmentVersionRef: request.parameters.translatedSegmentVersionRef,
          voiceProfileVersionRef: request.parameters.voiceProfileVersionRef,
          outputProfileRef: request.parameters.outputProfileRef,
          candidateOutputRef: outputs[0]?.payload?.reference ?? "media://output/candidate/v1",
        },
      } : {}),
      outcome, observedAt: timestamp, outputs,
      provenance: { operationRef: operation.id, observedAt: timestamp, sourceRefs: [] },
      implementationState: "UNKNOWN", qualificationState: "NOT_EVALUATED", runtimeAvailability: "UNKNOWN",
    });
    const payload = artifactType === deleteType ? { ...identity, state: "ACCESS_REVOKED" } : { reference: `media://output/${artifactType}/v1` };
    const validate = (request, value) => validateOwnerLeafWireResult(contract, request, value);
    const exactSuccess = validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, payload)]));
    assert.equal(exactSuccess.valid, true, `${capabilityRef} accepts its exact success output: ${JSON.stringify(exactSuccess)}`);
    assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} requires its declared output on success`);
    const secondPayload = artifactType === deleteType
      ? { ...identity, state: "BLOCKED_BY_HOLD" }
      : { reference: `media://output/${artifactType}/v2` };
    assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, payload), output(artifactType, secondPayload)])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} success is bounded to one declared output`);
    assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output("wrong-output-type", payload)])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} rejects a substituted discriminator`);
    if (artifactType !== deleteType) {
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { ...payload, contents: "unclaimed" })])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} rejects undeclared payload claims`);
    }
    for (const outcome of ["REJECTED", "UNKNOWN_OUTCOME"]) {
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], outcome, [])).valid, true, `${capabilityRef} ${outcome} has no output claim`);
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], outcome, [output(artifactType, payload)])).reason, "RESULT_SCHEMA_REJECTED", `${capabilityRef} ${outcome} cannot claim success output`);
    }
    if (capabilityRef === "media.artifact.delete") {
      for (const state of ["ACCESS_REVOKED", "BLOCKED_BY_HOLD", "ERASURE_REQUESTED", "PHYSICAL_ERASURE_PENDING", "ERASURE_CONFIRMED", "EXTERNAL_ERASURE_UNCONFIRMED"]) {
        assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { ...identity, state })])).valid, true, `delete preserves lifecycle state ${state}`);
      }
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { artifactId: "other-artifact", versionId: identity.versionId, state: "ACCESS_REVOKED" })])).reason, "CROSS_FIELD_BINDING_REJECTED", "delete output artifact identity equals the requested artifact");
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { artifactId: identity.artifactId, versionId: "other-version", state: "ACCESS_REVOKED" })])).reason, "CROSS_FIELD_BINDING_REJECTED", "delete output version identity equals the requested immutable version");
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { ...identity, state: "DELETED" })])).reason, "RESULT_SCHEMA_REJECTED", "delete does not collapse lifecycle states to a generic deleted state");
      assert.equal(validate(requests[capabilityRef], result(requests[capabilityRef], "SUCCEEDED", [output(artifactType, { ...identity, state: "ACCESS_REVOKED", externalCopiesRecalled: true })])).reason, "RESULT_SCHEMA_REJECTED", "delete output does not claim external-copy recall");
    }
  }
  const families = operations.capabilityOperationContracts.families;
  const profileRefs = (id) => families.find(({ id: profileId }) => profileId === id).outputTypeRefs;
  assert.ok(profileRefs("media.capability-profile.media-artifact").includes(`media.typed-output.${deleteType}`));
  assert.ok(profileRefs("media.capability-profile.media-generate-video").includes("media.typed-output.candidate-video-keyframe-sequence-artifact"));
  assert.ok(profileRefs("media.capability-profile.media-rights").includes("media.typed-output.asserted-rights-attestation-record"));
  assert.ok(profileRefs("media.capability-profile.media-speech-synthesis").includes("media.typed-output.candidate-dubbed-media-artifact-with-speech-sync-provenance"));
  assert.ok(profileRefs("media.capability-profile.media-speech-synthesis").includes("media.typed-output.derived-authorized-speaker-voice-profile-record"));
});

test("PXD-145 exact required inputs preserve P0 source types, identity, and alternatives", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capabilityIds = [
    "media.artifact.delete", "media.artifact.share", "media.artifact.share.revoke",
    "media.generate.audio.foley", "media.generate.audio.music.continue", "media.generate.audio.music.vary",
    "media.generate.image.condition.depth", "media.generate.image.condition.edge", "media.generate.image.condition.pose", "media.generate.image.condition.segmentation", "media.generate.image.control.palette", "media.generate.image.control.reference", "media.generate.image.control.style", "media.generate.image.layout-to-image", "media.generate.image.multi-reference", "media.generate.image.sketch-to-image",
    "media.generate.spatial.compose-3d", "media.generate.spatial.generate.novel-view", "media.generate.spatial.reconstruct.camera", "media.generate.spatial.reconstruct.depth", "media.generate.spatial.reconstruct.multiview", "media.generate.spatial.relight-3d", "media.generate.spatial.representation.gaussian-splatting-adapter", "media.generate.spatial.representation.nerf-adapter",
    "media.generate.video.drive.speech", "media.generate.video.reference-video",
    "media.speech.synthesis.dub", "media.speech.synthesis.speaker.clone-authorized", "media.speech.synthesis.speaker.condition", "media.speech.synthesis.speech-to-speech", "media.speech.synthesis.speech.translate", "media.speech.synthesis.voice.convert",
  ];
  const operationsByCapability = operations.capabilityOperationContracts.records;
  const schemaRows = operations.capabilityOperationContracts.inputPayloadSchemas;
  const timestamp = "2026-10-10T12:00:00Z";
  const sample = (schema) => {
    if (schema.allOf?.length) {
      const constant = schema.allOf.find((part) => part.const !== undefined)?.const;
      if (constant !== undefined) return constant;
      const enumerated = schema.allOf.find((part) => part.enum)?.enum;
      if (enumerated) return enumerated[0];
      const samples = schema.allOf.map(sample).filter((value) => value !== undefined);
      const objects = samples.filter((value) => value && typeof value === "object" && !Array.isArray(value));
      if (objects.length) return Object.assign({}, ...objects);
      if (samples.length) return samples[0];
    }
    if (schema.const !== undefined) return schema.const;
    if (schema.enum) return schema.enum[0];
    if (schema.type === "object") {
      const value = {};
      for (const key of schema.required ?? []) {
        if (schema.properties?.[key]) value[key] = sample(schema.properties[key]);
      }
      for (const union of [schema.oneOf, schema.anyOf]) {
        if (union?.length) {
          const branch = sample(union[0]);
          if (branch && typeof branch === "object" && !Array.isArray(branch)) Object.assign(value, branch);
        }
      }
      for (const branch of schema.allOf ?? []) {
        const extra = sample(branch);
        if (extra && typeof extra === "object" && !Array.isArray(extra)) Object.assign(value, extra);
      }
      return value;
    }
    if (schema.oneOf) return sample(schema.oneOf[0]);
    if (schema.anyOf) return sample(schema.anyOf[0]);
    if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? {}));
    if (schema.type === "string") return schema.format === "date-time" ? timestamp : "x";
    if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
    if (schema.type === "boolean") return false;
    return undefined;
  };
  const rejectedResult = (operation) => ({
    ...(operation.capabilityRef === "media.speech.synthesis.dub" ? { requestId: "x", requestFingerprint: `sha256:${"a".repeat(64)}` } : {}),
    outcome: "REJECTED", observedAt: timestamp, outputs: [],
    provenance: { operationRef: operation.id, observedAt: timestamp, sourceRefs: [] },
    implementationState: "UNKNOWN", qualificationState: "NOT_EVALUATED", runtimeAvailability: "UNKNOWN",
  });
  for (const capabilityRef of capabilityIds) {
    const p0 = capabilities.capabilities.find(({ id }) => id === capabilityRef);
    const operation = operationsByCapability.find(({ capabilityRef: id }) => id === capabilityRef);
    assert.ok(p0 && operation, `${capabilityRef} exists in both PDP-0 and PDP-1`);
    const p0Slots = p0.ownerDefinition.typedInputSlots;
    assert.deepEqual(operation.inputSlots.map(({ sourceType, required, cardinality, alternatives }) => ({ sourceType, required, cardinality, ...(alternatives ? { alternatives } : {}) })),
      p0Slots.map(({ sourceType, required, cardinality, alternatives }) => ({ sourceType, required, cardinality, ...(alternatives ? { alternatives } : {}) })),
      `${capabilityRef} preserves each P0 input type, requiredness, cardinality, and alternatives`);
    for (const slot of operation.inputSlots) {
      assert.ok(operation.requestSchema.required.includes(slot.slotId), `${capabilityRef} requires ${slot.slotId}`);
      assert.equal(operation.requestSchema.properties[slot.slotId].properties.artifactType.const, slot.sourceType, `${capabilityRef} request carries exact ${slot.sourceType} tag`);
      const schemaRef = slot.payloadSchemaRef;
      if (schemaRef) {
        const typed = schemaRows.find(({ id }) => id === schemaRef);
        assert.ok(typed, `${capabilityRef} references a declared typed input schema ${schemaRef}`);
        if (capabilityRef === "media.speech.synthesis.dub" && slot.slotId === "input2") {
          assert.equal(schemaRef, "media.typed-input.source-media-with-speech-dub",
            "PXD-163 C16 uses its dedicated closed source-media input schema");
          assert.equal(typed.schema.type, "object");
          assert.equal(typed.schema.additionalProperties, false);
          assert.deepEqual([...typed.schema.required].sort(), ["artifactType", "payload"]);
          assert.deepEqual(Object.keys(typed.schema.properties).sort(), ["artifactType", "payload"]);
          assert.equal(typed.schema.properties.artifactType.const, "source-media-with-speech-artifact");
          const payloadSchema = typed.schema.properties.payload;
          assert.equal(payloadSchema.additionalProperties, false, "C16 source-media payload is closed");
          assert.deepEqual([...payloadSchema.required].sort(), ["artifactId", "sourceClockId", "sourceContentDigest", "sourceDurationTicks", "ticksPerSecond", "versionId"].sort(),
            "C16 input requires exact source identity, digest, clock, timebase, and duration fields");
          assert.deepEqual(Object.keys(payloadSchema.properties).sort(), ["artifactId", "sourceClockId", "sourceContentDigest", "sourceDurationTicks", "ticksPerSecond", "versionId"].sort(),
            "C16 input exposes exactly the six required source facts");
        }
        assert.deepEqual(stable(operation.requestSchema.properties[slot.slotId]), stable(typed.schema), `${capabilityRef} request schema equals its typed input schema`);
      }
    }
    const effective = resolveEffectiveCapabilityWireSchemas(operations, capabilityRef);
    assert.equal(effective.valid, true, `${capabilityRef} request/result wire resolves`);
    const request = sample(effective.requestSchema);
    if (capabilityRef === "media.speech.synthesis.dub") {
      request.parameters.sourceLocale = "en-US";
      request.parameters.targetLocale = "es-ES";
      request.parameters.translatedSegmentVersionRef = "media://caption/version/translated-v1";
      request.parameters.voiceProfileVersionRef = "media://voice/profile/v1";
      request.parameters.outputProfileRef = "media://profile/speech/v1";
      request.input2.payload.sourceContentDigest = `sha256:${"a".repeat(64)}`;
      request.input2.payload.sourceClockId = "clock-1";
    }
    const contract = { requestSchema: effective.requestSchema, resultSchema: effective.resultSchema, crossFieldRules: operation.crossFieldRules ?? [] };
    const validate = (candidate) => validateOwnerLeafWireResult(contract, candidate, rejectedResult(operation));
    const validRequest = validate(request);
    assert.equal(validRequest.valid, true, `${capabilityRef} valid typed request is accepted: ${JSON.stringify({ request, validation: validRequest })}`);
    const requiredSlot = operation.inputSlots.find(({ slotId }) => slotId === "input2")?.slotId ?? operation.inputSlots.at(-1).slotId;
    const withoutRequired = structuredClone(request);
    delete withoutRequired[requiredSlot];
    assert.equal(validate(withoutRequired).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects omission of ${requiredSlot}`);
    const wrongTag = structuredClone(request);
    wrongTag[requiredSlot].artifactType = "wrong-source-type";
    assert.equal(validate(wrongTag).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects a mismatched typed tag`);
    if (capabilityRef === "media.generate.image.multi-reference" || capabilityRef === "media.generate.spatial.reconstruct.multiview") {
      const slotValue = request.input2.payload;
      assert.equal(slotValue.references.length, 2);
      for (const count of [2, 8]) {
        const bounded = structuredClone(request);
        bounded.input2.payload.references = Array.from({ length: count }, (_, index) => ({ artifactId: `artifact-${index + 1}`, versionId: `version-${index + 1}` }));
        assert.equal(validate(bounded).valid, true, `${capabilityRef} accepts ${count} exact references`);
      }
      for (const count of [1, 9]) {
        const outOfBounds = structuredClone(request);
        outOfBounds.input2.payload.references = Array.from({ length: count }, (_, index) => ({ artifactId: `artifact-${index + 1}`, versionId: `version-${index + 1}` }));
        assert.equal(validate(outOfBounds).reason, "REQUEST_SCHEMA_REJECTED", `${capabilityRef} rejects ${count} references`);
      }
    }
    if (capabilityRef === "media.generate.image.control.palette" || capabilityRef === "media.generate.image.control.style") {
      assert.equal(validate({ ...request, input2: { ...request.input2, payload: { text: "" } } }).reason, "REQUEST_SCHEMA_REJECTED");
      assert.equal(validate({ ...request, input2: { ...request.input2, payload: { text: "x".repeat(4096) } } }).valid, true);
      assert.equal(validate({ ...request, input2: { ...request.input2, payload: { text: "x".repeat(4097) } } }).reason, "REQUEST_SCHEMA_REJECTED");
      assert.match(operation.guards.preconditions.join(" "), /untrusted request intent/);
    }
    if (capabilityRef === "media.speech.synthesis.speaker.condition") {
      assert.equal(request.input2.payload.disposition, "USER_CONFIRMED_REFERENCE");
      assert.ok(request.input2.payload.speakerRef && request.input2.payload.consentRef && request.input2.payload.rightsEvidenceRefs.length);
      assert.equal(operation.requestSchema.properties.input2.properties.payload.properties.disposition.enum, undefined, "only the user-confirmed branch is exposed");
    }
    if (capabilityRef === "media.speech.synthesis.speaker.clone-authorized") {
      assert.ok(request.input2.payload.artifactId && request.input2.payload.versionId);
      assert.equal(request.input2.payload.disposition, undefined, "clone requires a recording identity, not the speaker-condition profile branch");
    }
    for (const slot of p0Slots) {
      if (slot.sourceType.startsWith("source-") || slot.sourceType === "authorized-source-speaker-recording" || slot.sourceType === "authorized-speaker-reference" || slot.sourceType.startsWith("multiple-authorized-")) {
        assert.match(operation.guards.preconditions.join(" "), /trusted owner resolves the exact immutable identity.*verifies actual source kind/s, `${capabilityRef} requires owner resolution for ${slot.sourceType}`);
      }
    }
  }
  const share = operationsByCapability.find(({ capabilityRef }) => capabilityRef === "media.artifact.share");
  assert.deepEqual(share.requestSchema.required.filter((id) => /^input\d+$/.test(id)), ["input1", "input2", "input3"]);
  assert.equal(share.requestSchema.properties.input2.properties.artifactType.const, "recipient-and-sharing-scope");
  assert.equal(share.requestSchema.properties.input3.properties.artifactType.const, "rights-and-retention-context", "share policy context is a separate required input slot");
  const revoke = operationsByCapability.find(({ capabilityRef }) => capabilityRef === "media.artifact.share.revoke");
  const revokePayload = revoke.requestSchema.properties.input1.properties.payload;
  assert.deepEqual(revokePayload.oneOf.map((branch) => branch.properties.kind.const), ["sharing-grant-reference", "artifact-recipient-scope"]);
  assert.equal(revoke.requestSchema.required.includes("input2"), true, "revoke retains its separate required rights/retention context");
  const revokeEffective = resolveEffectiveCapabilityWireSchemas(operations, "media.artifact.share.revoke");
  assert.equal(revokeEffective.valid, true, "revoke request/result wire resolves");
  const revokeContract = {
    requestSchema: revokeEffective.requestSchema,
    resultSchema: revokeEffective.resultSchema,
    crossFieldRules: revoke.crossFieldRules ?? [],
  };
  const validateRevoke = (candidate) => validateOwnerLeafWireResult(revokeContract, candidate, rejectedResult(revoke));
  const revokeRequest = sample(revokeEffective.requestSchema);
  const grantReferenceRequest = structuredClone(revokeRequest);
  grantReferenceRequest.input1.payload = { kind: "sharing-grant-reference", reference: "grant:v1" };
  assert.equal(validateRevoke(grantReferenceRequest).valid, true, "revoke accepts a well-formed sharing-grant-reference alternative");
  const recipientScopeRequest = structuredClone(revokeRequest);
  recipientScopeRequest.input1.payload = {
    kind: "artifact-recipient-scope",
    artifactId: "artifact-1",
    versionId: "version-1",
    recipientRef: "recipient:v1",
    scopeRef: "scope:v1",
  };
  assert.equal(validateRevoke(recipientScopeRequest).valid, true, "revoke accepts a well-formed artifact-recipient-scope alternative");
  const malformedGrant = structuredClone(grantReferenceRequest);
  delete malformedGrant.input1.payload.reference;
  assert.equal(validateRevoke(malformedGrant).reason, "REQUEST_SCHEMA_REJECTED", "revoke rejects a grant-reference alternative without its reference");
  const malformedRecipientScope = structuredClone(recipientScopeRequest);
  delete malformedRecipientScope.input1.payload.versionId;
  assert.equal(validateRevoke(malformedRecipientScope).reason, "REQUEST_SCHEMA_REJECTED", "revoke rejects an artifact-recipient-scope alternative without its immutable version identity");
  const ambiguousAlternatives = structuredClone(recipientScopeRequest);
  ambiguousAlternatives.input1.payload.reference = "grant:v1";
  assert.equal(validateRevoke(ambiguousAlternatives).reason, "REQUEST_SCHEMA_REJECTED", "revoke rejects a payload that mixes both alternatives");
});
