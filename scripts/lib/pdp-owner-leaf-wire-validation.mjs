import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const Ajv = require("ajv").default ?? require("ajv");
const addFormats = require("ajv-formats");
const yaml = require("yaml");

const operationsSource = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const scalarDefinitions = operationsSource.capabilityOperationContracts.scalarTypes;
const scalarTypes = Object.values(scalarDefinitions);
const strictUtcInstant = (value) => {
  const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};
const scalarMatches = (definition, value) => {
  const schema = definition.validator;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return false;
  if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return false;
  if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) return false;
  return schema.format !== "date-time" || strictUtcInstant(value);
};
const declaredFormats = new Set(scalarTypes.map((definition) => definition.validator?.format).filter(Boolean));
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addFormat("date-time", { type: "string", validate: strictUtcInstant });
for (const format of declaredFormats) {
  if (format === "date-time") continue;
  const candidates = scalarTypes.filter((definition) => definition.validator?.format === format);
  ajv.addFormat(format, { type: "string", validate: (value) => candidates.some((definition) => scalarMatches(definition, value)) });
}

function assertDeclaredFormats(schema, depth = 0) {
  if (depth > 64) throw new Error("wire schema recursion limit exceeded");
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) return schema.forEach((part) => assertDeclaredFormats(part, depth + 1));
  if (schema.format && !declaredFormats.has(schema.format) && !["date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uri-reference", "uri-template", "json-pointer", "relative-json-pointer", "regex"].includes(schema.format)) {
    throw new Error(`wire schema uses undeclared format ${schema.format}`);
  }
  for (const value of Object.values(schema)) assertDeclaredFormats(value, depth + 1);
}

function compileClosedSchema(schema) {
  assertDeclaredFormats(schema);
  return ajv.compile(schema);
}

function applyOperationSchemaNarrowing(typed, operation) {
  const typedObject = typed && typeof typed === "object" && !Array.isArray(typed) && typed.type === "object";
  const operationObject = operation && typeof operation === "object" && !Array.isArray(operation) && operation.type === "object";
  if (!typedObject || !operationObject) return { allOf: [structuredClone(typed), structuredClone(operation)] };

  // Typed registry is the closed, complete payload contract. The inline
  // operation schema supplies additional owner-specific constraints, but is
  // sometimes a legacy partial projection (e.g. it omits a new required
  // sessionDisposition field). Merge properties/required fields into the
  // complete registry shape and retain inline conditional/branch constraints
  // as an intersection. Never let its partial property list widen bounds or
  // let its additionalProperties:false hide fields declared by the registry.
  const result = structuredClone(typed);
  result.properties ??= {};
  for (const [key, schema] of Object.entries(operation.properties ?? {})) {
    result.properties[key] = Object.hasOwn(result.properties, key)
      ? applyOperationSchemaNarrowing(result.properties[key], schema)
      : structuredClone(schema);
  }
  result.required = [...new Set([...(typed.required ?? []), ...(operation.required ?? [])])];
  const inlineConstraints = Object.entries(operation)
    .filter(([key]) => !["type", "properties", "required", "additionalProperties", "allOf"].includes(key))
    .map(([key, value]) => ({ [key]: structuredClone(value) }));
  if (operation.additionalProperties && typeof operation.additionalProperties === "object") {
    inlineConstraints.push({ additionalProperties: structuredClone(operation.additionalProperties) });
  }
  if (Array.isArray(operation.allOf)) inlineConstraints.push(...structuredClone(operation.allOf));
  if (inlineConstraints.length) result.allOf = [...(result.allOf ?? []), ...inlineConstraints];
  return result;
}

/**
 * Validate a dynamically selected owner schema using the same closed-schema
 * format registry as capability leaf requests/results. This is used for the
 * Media job-submit operation-parameter schema selected by exact capability
 * and operation identity.
 */
export function validateOwnerClosedJsonSchema(schema, value, contextSchema = undefined) {
  try {
    const contextualSchema = contextSchema && typeof contextSchema === "object"
      ? { ...schema, ...(contextSchema.definitions ? { definitions: contextSchema.definitions } : {}), ...(contextSchema.$defs ? { $defs: contextSchema.$defs } : {}) }
      : schema;
    const validate = compileClosedSchema(contextualSchema);
    const valid = validate(value);
    return { valid, reason: valid ? "CLOSED_OWNER_SCHEMA_MATCH" : "OWNER_SCHEMA_REJECTED", errors: validate.errors ?? [] };
  } catch (error) {
    return { valid: false, reason: "OWNER_SCHEMA_UNSUPPORTED_OR_INVALID", errors: [{ message: error.message }] };
  }
}
const pathValue = (root, path) => {
  if (path === "$.contract.operationRef") return root.contract?.operationRef;
  if (path === "$.contract.selectionKind") return root.contract?.selectionKind;
  const parts = path.replace(/^\$\./u, "").replace(/\[(\d+)\]/gu, ".$1").split(".");
  return parts.reduce((value, part) => value?.[part], root);
};

function satisfies(rule, root) {
  const left = pathValue(root, rule.leftRef);
  const right = pathValue(root, rule.rightRef);
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (rule.expectedConst !== undefined && (left !== rule.expectedConst || right !== rule.expectedConst)) return false;
  if (rule.operator === "EXACT_EQUAL") return left === right;
  if (rule.operator === "ARRAY_CONTAINS") return Array.isArray(right) && right.includes(left);
  if (rule.operator === "MEDIA_FAMILY_EQUAL") {
    const family = (value) => typeof value === "string" ? value.split("/", 1)[0] : null;
    return rule.allowedFamilies.includes(family(left)) && family(left) === family(right);
  }
  return false;
}

/**
 * Definition-only schema and binding oracle for owner leaf wire overlays.
 * A TRUE result validates the authored definition shape; it does not establish
 * a runtime endpoint, effect, provider result, qualification, or admission.
 */
export function validateOwnerLeafWireRequest(contract, request) {
  if (!contract?.requestSchema) return { valid: false, reason: "OWNER_WIRE_CONTRACT_MISSING" };
  try {
    const validate = compileClosedSchema(contract.requestSchema);
    const valid = validate(request);
    if (!valid) return { valid: false, reason: "REQUEST_SCHEMA_REJECTED", errors: validate.errors ?? [] };
    const context = { request, contract };
    for (const rule of contract.requestFieldRules ?? []) {
      if (rule.scope !== "REQUEST_ALWAYS" || !satisfies(rule, context)) {
        return { valid: false, reason: "REQUEST_FIELD_BINDING_REJECTED", errors: [{ ruleId: rule.id }] };
      }
    }
    return { valid: true, reason: "CLOSED_REQUEST_SCHEMA_MATCH", errors: [] };
  } catch (error) {
    return { valid: false, reason: "REQUEST_SCHEMA_UNSUPPORTED_OR_INVALID", errors: [{ message: error.message }] };
  }
}

/** Resolve an exact capability to its historical base operation and current owner wire overlay. */
export function resolveEffectiveOwnerLeafWireContract(operations, capabilityRef) {
  const baseMatches = operations?.capabilityOperationContracts?.records?.filter((row) => row.capabilityRef === capabilityRef) ?? [];
  if (baseMatches.length !== 1) return { valid: false, reason: "BASE_OPERATION_NOT_UNIQUE" };
  const base = baseMatches[0];
  if (!base.ownerLeafWireContractRef) return { valid: false, reason: "OWNER_WIRE_OVERLAY_NOT_BOUND" };
  const overlays = operations.ownerLeafWireContracts?.records?.filter((row) => row.id === base.ownerLeafWireContractRef) ?? [];
  if (overlays.length !== 1) return { valid: false, reason: "OWNER_WIRE_OVERLAY_NOT_UNIQUE" };
  const overlay = overlays[0];
  const expectedBaseRef = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${base.id}`;
  const [sourcePath, sourceSelector] = overlay.baseOperationContractRef?.split("#") ?? [];
  const match = /^capabilityOperationContracts\/records\/@id=([^/]+)$/u.exec(sourceSelector ?? "");
  const selectedRecord = sourcePath === ".product-experience/pdp-1-domain-data/operations.yaml" && match
    ? operations.capabilityOperationContracts.records.find((row) => row.id === match[1])
    : undefined;
  const profileMatches = operations.capabilityOperationContracts.families?.filter(({ id }) => id === base.familyProfileRef) ?? [];
  const boundsMatches = operations.capabilityOperationContracts.bounds?.filter(({ id }) => id === base.boundsRef) ?? [];
  if (overlay.capabilityRef !== capabilityRef || overlay.operationRef !== base.id
    || overlay.baseOperationContractRef !== expectedBaseRef || selectedRecord !== base
    || profileMatches.length !== 1 || !profileMatches[0].capabilityRefs?.includes(capabilityRef)
    || boundsMatches.length !== 1 || boundsMatches[0].capabilityRef !== capabilityRef) {
    return { valid: false, reason: "OWNER_WIRE_OVERLAY_SOURCE_MISMATCH" };
  }
  return { valid: true, contract: { ...overlay, baseOperation: base } };
}

/**
 * Resolve the executable definition schema for a capability from its exact
 * operation record, closed typed input/output registries, and optional leaf
 * overlay. Inline result envelopes carry outcome/finality constraints; their
 * success payloads are selected by the record's exact `successOutputs` refs.
 */
export function resolveEffectiveCapabilityWireSchemas(operations, capabilityRef) {
  const records = operations?.capabilityOperationContracts?.records ?? [];
  const matches = records.filter((row) => row.capabilityRef === capabilityRef);
  if (matches.length !== 1) return { valid: false, reason: "CAPABILITY_OPERATION_NOT_UNIQUE" };
  const row = matches[0];
  const overlay = resolveEffectiveOwnerLeafWireContract(operations, capabilityRef);
  if (row.ownerLeafWireContractRef) {
    if (!overlay.valid) return overlay;
    return {
      valid: true,
      operation: row,
      requestSchema: overlay.contract.requestSchema,
      resultSchema: overlay.contract.resultSchema,
      outputSchemas: [overlay.contract.resultSchema.properties?.outputs?.items],
      source: "OWNER_LEAF_OVERLAY",
    };
  }
  const inputSchemas = new Map((operations.capabilityOperationContracts.inputPayloadSchemas ?? []).map((entry) => [entry.id, entry.schema]));
  const outputSchemas = new Map((operations.capabilityOperationContracts.outputPayloadSchemas ?? []).map((entry) => [entry.id, entry]));
  const requestSchema = structuredClone(row.requestSchema);
  for (const slot of row.inputSlots ?? []) {
    const typed = inputSchemas.get(slot.payloadSchemaRef);
    if (!typed || !requestSchema.properties?.[slot.slotId]) return { valid: false, reason: "INPUT_PAYLOAD_SCHEMA_UNRESOLVED", operation: row, slotId: slot.slotId };
    // The operation schema may intentionally narrow a shared typed registry
    // branch (for example, one operation can forbid a reasonRef on
    // NOT_SELECTED while the reusable input type permits it). Compose both
    // contracts as an intersection so the reusable registry cannot widen the
    // selected operation's request semantics.
    requestSchema.properties[slot.slotId] = applyOperationSchemaNarrowing(typed, requestSchema.properties[slot.slotId]);
  }
  const resultSchema = structuredClone(row.resultSchema);
  const declared = row.successOutputs ?? [];
  const resolvedOutputs = [];
  for (const output of declared) {
    const typed = outputSchemas.get(output.payloadSchemaRef);
    if (!typed || typed.artifactType !== output.artifactType) return { valid: false, reason: "OUTPUT_PAYLOAD_SCHEMA_UNRESOLVED_OR_MISMATCHED", operation: row, output };
    resolvedOutputs.push(structuredClone(typed.schema));
  }
  const itemSchema = resultSchema.properties?.outputs?.items;
  if (!itemSchema || !Array.isArray(itemSchema.oneOf)) return { valid: false, reason: "RESULT_OUTPUT_ENVELOPE_UNRESOLVED", operation: row };
  const inlineTypes = itemSchema.oneOf.map((schema) => schema.properties?.artifactType?.const);
  if (inlineTypes.length !== resolvedOutputs.length || inlineTypes.some((type, index) => type !== declared[index]?.artifactType)) {
    return { valid: false, reason: "RESULT_OUTPUT_DECLARATION_MISMATCH", operation: row };
  }
  // The exact typed registry is normative for payload shape. The inline
  // envelope remains authoritative for cardinality and outcome conditions.
  const replaceOutputAlternatives = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && value.properties?.outputs?.items?.oneOf) {
      value.properties.outputs.items.oneOf = structuredClone(resolvedOutputs);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(replaceOutputAlternatives);
      else replaceOutputAlternatives(child);
    }
  };
  replaceOutputAlternatives(resultSchema);
  return { valid: true, operation: row, requestSchema, resultSchema, outputSchemas: resolvedOutputs, source: "CANONICAL_TYPED_REGISTRY" };
}

export function validateOwnerLeafWireResult(contract, request, result) {
  if (!contract?.resultSchema) return { valid: false, reason: "OWNER_WIRE_CONTRACT_MISSING" };
  const requestCheck = validateOwnerLeafWireRequest(contract, request);
  if (!requestCheck.valid) return { valid: false, reason: "REQUEST_SCHEMA_REJECTED", errors: requestCheck.errors };
  let validate;
  try { validate = compileClosedSchema(contract.resultSchema); }
  catch (error) { return { valid: false, reason: "RESULT_SCHEMA_UNSUPPORTED_OR_INVALID", errors: [{ message: error.message }] }; }
  if (!validate(result)) return { valid: false, reason: "RESULT_SCHEMA_REJECTED", errors: validate.errors ?? [] };
  const context = { request, result, contract };
  if (result.outcome === "SUCCEEDED") {
    for (const rule of contract.crossFieldRules ?? []) {
      if (rule.whenOutcome !== "SUCCEEDED" || rule.scope !== "SUCCESS_OUTPUT_ONLY") return { valid: false, reason: "CROSS_FIELD_RULE_SCOPE_INVALID", ruleId: rule.id };
      if (!satisfies(rule, context)) return { valid: false, reason: "CROSS_FIELD_BINDING_REJECTED", ruleId: rule.id };
    }
  }
  return { valid: true, reason: "OWNER_DEFINITION_SCHEMA_AND_BINDINGS_MATCH" };
}
