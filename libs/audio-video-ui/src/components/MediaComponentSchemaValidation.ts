import { MEDIA_COMPONENT_INPUT_SCHEMAS, MEDIA_COMPONENT_VALUE_SCHEMAS } from "./MediaComponentInputSchemas";

type JsonSchema = Readonly<Record<string, unknown>>;
export interface MediaComponentSchemaValidation { readonly valid: boolean; readonly errors: readonly string[]; }

const schemaKeywords = new Set([
  "$ref", "$schema", "additionalProperties", "allOf", "anyOf", "const", "description", "enum", "examples",
  "exclusiveMinimum", "format", "if", "items", "maxItems", "maxLength", "maximum", "minItems", "minLength",
  "minimum", "not", "oneOf", "pattern", "prefixItems", "properties", "required", "then", "title", "type", "uniqueItems",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "null": return value === null;
      case "object": return isRecord(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "integer": return typeof value === "number" && Number.isSafeInteger(value);
      case "boolean": return typeof value === "boolean";
      default: return false;
    }
  });
}

function isDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 14 || Number(offsetMinuteText) > 59
    || (Number(offsetHourText) === 14 && Number(offsetMinuteText) !== 0))) return false;
  return Number.isFinite(Date.parse(value));
}

function validateNode(value: unknown, schemaInput: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 64) { errors.push(`${path}: schema recursion limit exceeded`); return; }
  if (typeof schemaInput === "boolean") {
    if (!schemaInput) errors.push(`${path}: value is prohibited by the schema`);
    return;
  }
  if (!isRecord(schemaInput)) { errors.push(`${path}: malformed schema node`); return; }
  const schema = schemaInput as JsonSchema;
  for (const keyword of Object.keys(schema)) if (!schemaKeywords.has(keyword)) errors.push(`${path}: unsupported schema keyword ${keyword}`);
  if (typeof schema.$ref === "string") {
    const match = /^media\.component-value-types\.v1#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/u.exec(schema.$ref);
    if (!match) { errors.push(`${path}: unresolved external schema reference ${schema.$ref}`); return; }
    const target = Reflect.get(MEDIA_COMPONENT_VALUE_SCHEMAS, match[1]!);
    if (target === undefined) { errors.push(`${path}: missing value schema ${match[1]}`); return; }
    validateNode(value, target, path, errors, depth + 1);
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type)}`);
    return;
  }
  if (Object.hasOwn(schema, "const") && stable(value) !== stable(schema.const)) errors.push(`${path}: value does not match its exact constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => stable(value) === stable(candidate))) errors.push(`${path}: value is outside the declared enum`);

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${path}: string is shorter than minLength`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${path}: string exceeds maxLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: string does not match its declared pattern`);
    if (schema.format === "date-time" && !isDateTime(value)) errors.push(`${path}: invalid date-time`);
    if (schema.format !== undefined && schema.format !== "date-time") errors.push(`${path}: unsupported format ${String(schema.format)}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: value is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: value exceeds maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: value is not above exclusiveMinimum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: array is shorter than minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: array exceeds maxItems`);
    if (schema.uniqueItems === true && new Set(value.map(stable)).size !== value.length) errors.push(`${path}: array items must be unique`);
    if (Array.isArray(schema.prefixItems)) schema.prefixItems.forEach((itemSchema, index) => {
      if (index < value.length) validateNode(value[index], itemSchema, `${path}[${index}]`, errors, depth + 1);
    });
    if (schema.items !== undefined) value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors, depth + 1));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const required of schema.required) {
      if (typeof required === "string" && (!Object.hasOwn(value, required) || value[required] === undefined)) errors.push(`${path}.${required}: required property is missing`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = Reflect.get(properties, key);
      if (childSchema !== undefined) validateNode(child, childSchema, `${path}.${key}`, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property is not allowed`);
      else if (isRecord(schema.additionalProperties)) validateNode(child, schema.additionalProperties, `${path}.${key}`, errors, depth + 1);
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const branchErrors = branches.map((branch, index) => {
      const local: string[] = [];
      validateNode(value, branch, `${path}<${keyword}:${index}>`, local, depth + 1);
      return local;
    });
    const matches = branchErrors.filter((branch) => branch.length === 0).length;
    if (keyword === "allOf" && matches !== branches.length) errors.push(`${path}: allOf constraint failed`);
    if (keyword === "anyOf" && matches === 0) errors.push(`${path}: no anyOf branch matched`);
    if (keyword === "oneOf" && matches !== 1) errors.push(`${path}: expected exactly one oneOf branch, found ${matches}`);
  }
  if (schema.not !== undefined) {
    const local: string[] = [];
    validateNode(value, schema.not, path, local, depth + 1);
    if (local.length === 0) errors.push(`${path}: forbidden schema branch matched`);
  }
  if (schema.if !== undefined) {
    const local: string[] = [];
    validateNode(value, schema.if, path, local, depth + 1);
    const branch = local.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) validateNode(value, branch, path, errors, depth + 1);
  }
}

/** Validates exact Media family inputSchema plus the shared closed value schemas. */
export function validateMediaComponentInputSchema(componentId: string, value: unknown): MediaComponentSchemaValidation {
  if (!Object.hasOwn(MEDIA_COMPONENT_INPUT_SCHEMAS, componentId)) return { valid: false, errors: [`No source input schema for ${componentId}`] };
  const errors: string[] = [];
  const schema = Reflect.get(MEDIA_COMPONENT_INPUT_SCHEMAS, componentId);
  validateNode(value, schema, componentId, errors);
  return { valid: errors.length === 0, errors };
}
