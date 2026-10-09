import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const dateParts = (value) => typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u.exec(value);
const validInstant = (value) => {
  const parts = dateParts(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const Ajv = require("ajv").default ?? require("ajv");
const addFormats = require("ajv-formats");
const source = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const scalarTypes = source.capabilityOperationContracts.scalarTypes;
const schemaAjv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(schemaAjv);
schemaAjv.addFormat("date-time", { type: "string", validate: validInstant });
const sourceFormats = new Set(Object.values(scalarTypes).map((definition) => definition.validator?.format).filter(Boolean));
for (const definition of Object.values(scalarTypes)) {
  const format = definition.validator?.format;
  if (format && format !== "date-time" && !schemaAjv.formats[format]) schemaAjv.addFormat(format, { type: "string", validate: nonempty });
}

function assertSupportedFormats(schema, depth = 0) {
  if (depth > 64) throw new Error("observation schema recursion limit exceeded");
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) return schema.forEach((part) => assertSupportedFormats(part, depth + 1));
  const standard = new Set(["date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uri-reference", "uri-template", "json-pointer", "relative-json-pointer", "regex"]);
  if (schema.format && !sourceFormats.has(schema.format) && !standard.has(schema.format)) throw new Error(`unsupported observation schema format ${schema.format}`);
  for (const value of Object.values(schema)) assertSupportedFormats(value, depth + 1);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function typedObservationRequestFingerprint(request, trusted) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize({
    request: canonicalize(request),
    trusted: canonicalize({
      tenantScopeRef: trusted.tenantScopeRef,
      principalRef: trusted.principalRef,
      expectedOperationRef: trusted.expectedOperationRef,
      expectedReadAuthorityRef: trusted.expectedReadAuthorityRef,
      expectedReadVersion: trusted.expectedReadVersion,
    }),
  }))).digest("hex")}`;
}

function expandScalarRefs(schema, depth = 0) {
  if (schema === null || typeof schema !== "object") return schema;
  if (depth > 48) throw new Error("invalid or recursive observation schema");
  if (Array.isArray(schema)) return schema.map((item) => expandScalarRefs(item, depth + 1));
  const expanded = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "scalarTypeRef") continue;
    expanded[key] = expandScalarRefs(value, depth + 1);
  }
  if (schema.scalarTypeRef) {
    const prefix = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/scalarTypes/";
    if (typeof schema.scalarTypeRef !== "string" || !schema.scalarTypeRef.startsWith(prefix)) throw new Error(`foreign scalar type reference ${schema.scalarTypeRef}`);
    const scalarId = schema.scalarTypeRef.slice(prefix.length);
    if (!scalarId || scalarId.includes("/") || scalarId.includes("#")) throw new Error(`malformed scalar type reference ${schema.scalarTypeRef}`);
    const definition = scalarTypes[scalarId]?.validator;
    if (!definition) throw new Error(`unresolved scalar type ${scalarId}`);
    return { allOf: [expandScalarRefs(definition, depth + 1), expanded] };
  }
  return expanded;
}

const validatorCache = new WeakMap();
function validateSchema(schema, value) {
  try {
    let validator = validatorCache.get(schema);
    if (!validator) {
      const expanded = expandScalarRefs(schema);
      assertSupportedFormats(expanded);
      validator = schemaAjv.compile(expanded);
      validatorCache.set(schema, validator);
    }
    return validator(value);
  } catch {
    return false;
  }
}

function validateClosedRequest(schema, request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || schema.type !== "object" || schema.additionalProperties !== false) return false;
  return validateSchema(schema, request);
}

function getRefValue(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("$.")) return { found: false };
  const parts = ref.slice(2).split(".");
  let current = [root];
  let selectedArray = false;
  for (const part of parts) {
    const match = /^(.*?)\[\*\]$/u.exec(part);
    if (match) {
      selectedArray = true;
      const next = [];
      for (const value of current) {
        const array = value?.[match[1]];
        if (!Array.isArray(array)) return { found: false };
        next.push(...array);
      }
      current = next;
      continue;
    }
    current = current.map((value) => value?.[part]);
  }
  if (current.some((value) => value === undefined || value === null)) return { found: false };
  return { found: true, value: selectedArray ? current : current.length === 1 ? current[0] : current };
}

function validateBindingRules(contract, request, result) {
  if (contract.bindingRules === undefined) return true;
  if (!Array.isArray(contract.bindingRules)) return false;
  const root = { request, result };
  for (const rule of contract.bindingRules) {
    const left = getRefValue(root, rule.leftRef);
    const right = getRefValue(root, rule.rightRef);
    if (!left.found || !right.found) return false;
    if (rule.operator === "EXACT_EQUAL") {
      if (JSON.stringify(canonicalize(left.value)) !== JSON.stringify(canonicalize(right.value))) return false;
    } else if (rule.operator === "ALL_EXACT_EQUAL") {
      const values = Array.isArray(right.value) ? right.value : [right.value];
      if (values.some((value) => JSON.stringify(canonicalize(value)) !== JSON.stringify(canonicalize(left.value)))) return false;
    } else if (rule.operator === "EXACT_SET_EQUAL") {
      if (!Array.isArray(left.value) || !Array.isArray(right.value)) return false;
      const leftSet = new Set(left.value);
      const rightSet = new Set(right.value);
      if (leftSet.size !== left.value.length || rightSet.size !== right.value.length
          || leftSet.size !== rightSet.size || [...leftSet].some((value) => !rightSet.has(value))) return false;
    } else if (rule.operator === "SUBSET_OF_LEFT") {
      if (!Array.isArray(left.value) || !Array.isArray(right.value)) return false;
      const leftSet = new Set(left.value);
      const rightSet = new Set(right.value);
      if (rightSet.size !== right.value.length || [...rightSet].some((value) => !leftSet.has(value))) return false;
    } else if (rule.operator === "COVERED_KINDS_BY_COVERAGE") {
      if (!Array.isArray(left.value) || !Array.isArray(right.value)) return false;
      const leftSet = new Set(left.value);
      const rightSet = new Set(right.value);
      if (leftSet.size !== left.value.length || rightSet.size !== right.value.length
          || [...rightSet].some((value) => !leftSet.has(value))) return false;
      if (result.assessmentCoverage === "COMPLETE" && (leftSet.size !== rightSet.size || [...leftSet].some((value) => !rightSet.has(value)))) return false;
    } else return false;
  }
  return true;
}

/**
 * Evaluate only the exact owner-defined observation receipt/currentness tuple.
 * The oracle does not grant rights, qualify a profile, or establish runtime support.
 */
export function validateTypedObservationCurrentRead({ contract, request, result, trusted, now, maxAgeMs }) {
  const fail = (reason) => ({ truth: "UNKNOWN", reason });
  if (!contract?.requestSchema || !contract?.resultSchema || !Array.isArray(contract.operationRefs) || !Array.isArray(contract.readAuthorityRefs)) return fail("OBSERVATION_CONTRACT_INVALID");
  if (!validateClosedRequest(contract.requestSchema, request)) return fail("OBSERVATION_REQUEST_INVALID_OR_OPEN");
  if (!result || typeof result !== "object" || Array.isArray(result)) return fail("OBSERVATION_RESULT_MISSING");
  if (!validateSchema(contract.resultSchema, result)) return fail("OBSERVATION_RESULT_INVALID_OR_OPEN");
  if (!trusted || !nonempty(trusted.tenantScopeRef) || !nonempty(trusted.principalRef)
      || !nonempty(trusted.expectedOperationRef) || !nonempty(trusted.expectedReadAuthorityRef)
      || !nonempty(trusted.expectedReadVersion) || !validInstant(now)
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return fail("TRUSTED_CURRENT_READ_CONTEXT_INVALID");
  if (result.tenantScopeRef !== trusted.tenantScopeRef || result.principalRef !== trusted.principalRef) return fail("TRUSTED_SUBJECT_SCOPE_MISMATCH");
  if (result.queryId !== request.queryId || !nonempty(request.queryId)) return fail("QUERY_CORRELATION_MISMATCH");
  if (!contract.operationRefs.includes(trusted.expectedOperationRef) || result.operationRef !== trusted.expectedOperationRef) return fail("QUERY_OPERATION_MISMATCH");
  if (!contract.readAuthorityRefs.includes(trusted.expectedReadAuthorityRef) || result.readAuthorityRef !== trusted.expectedReadAuthorityRef) return fail("READ_AUTHORITY_NOT_ALLOWLISTED_OR_MISMATCHED");
  if (result.readVersion !== trusted.expectedReadVersion) return fail("READ_VERSION_MISMATCH");
  if (result.currentness !== "CURRENT") return fail("READ_CURRENTNESS_NOT_ESTABLISHED");
  if (result.requestFingerprint !== typedObservationRequestFingerprint(request, trusted)) return fail("REQUEST_FINGERPRINT_MISMATCH");
  if (!validInstant(result.observedAt)) return fail("OBSERVATION_TIME_INVALID");
  const age = Date.parse(now) - Date.parse(result.observedAt);
  if (age < 0 || age > maxAgeMs) return fail("OBSERVATION_STALE_OR_FUTURE");
  if (!validateBindingRules(contract, request, result)) return fail("OBSERVATION_BINDING_RULE_MISMATCH");
  return { truth: "TRUE", reason: "EXACT_CURRENT_READ_RECEIPT" };
}

/** Validate the retry-policy specialization without treating it as a command authorization. */
export function validateRetryPolicyCurrentRead(args) {
  const { contract, request, result } = args;
  const current = validateTypedObservationCurrentRead(args);
  if (current.truth !== "TRUE") return current;
  const observation = result.observation;
  if (observation?.kind !== "OBSERVED_RETRY_POLICY_AND_ATTEMPT") {
    return { truth: "UNKNOWN", reason: "RETRY_POLICY_OBSERVATION_UNAVAILABLE" };
  }
  const bounds = source.capabilityOperationContracts?.bounds?.find((row) => row.id === observation.boundsRef);
  const profile = source.capabilityOperationContracts?.families?.find((row) => row.id === observation.profileRef);
  if (!bounds || !profile || bounds.capabilityRef !== observation.capabilityRef
      || bounds.profileRef !== observation.profileRef || !profile.capabilityRefs?.includes(observation.capabilityRef)
      || observation.retryOperationRef !== "media.operation-slice.retry-job"
      || observation.budgetUnit !== "ADDITIONAL_ATTEMPTS_PER_LOGICAL_JOB"
      || !Number.isSafeInteger(observation.maximumExplicitRetries) || observation.maximumExplicitRetries < 0
      || !Number.isSafeInteger(observation.retriesUsed) || observation.retriesUsed < 0
      || !Number.isSafeInteger(observation.retriesRemaining) || observation.retriesRemaining < 0
      || observation.maximumExplicitRetries !== bounds.maximumExplicitRetries
      || observation.retriesRemaining !== observation.maximumExplicitRetries - observation.retriesUsed) {
    return { truth: "UNKNOWN", reason: "RETRY_BUDGET_OR_OWNER_BINDING_INCONSISTENT" };
  }
  const retryableOutcome = ["DEFINITIVE_NO_EFFECT", "DEFINITIVE_RETRYABLE_FAILURE"].includes(observation.outcomeClass);
  if (observation.retryability === "RETRYABLE" && (!retryableOutcome || observation.retriesRemaining === 0)) {
    return { truth: "UNKNOWN", reason: "RETRYABILITY_CONTRADICTS_OUTCOME_OR_BUDGET" };
  }
  if (["EFFECT_UNKNOWN", "TERMINAL", "UNKNOWN"].includes(observation.outcomeClass)
      && observation.retryability === "RETRYABLE") {
    return { truth: "UNKNOWN", reason: "UNCERTAIN_OR_TERMINAL_OUTCOME_CANNOT_BE_RETRYABLE" };
  }
  return { truth: "TRUE", reason: "EXACT_CURRENT_RETRY_POLICY_AND_ATTEMPT_READ" };
}
