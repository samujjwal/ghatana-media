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
  if (overlay.capabilityRef !== capabilityRef || overlay.operationRef !== base.id || overlay.baseOperationContractRef !== `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts.records.${base.id}`) {
    return { valid: false, reason: "OWNER_WIRE_OVERLAY_SOURCE_MISMATCH" };
  }
  return { valid: true, contract: { ...overlay, baseOperation: base } };
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
