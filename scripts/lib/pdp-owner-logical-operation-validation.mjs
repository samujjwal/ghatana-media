import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateOwnerClosedJsonSchema } from './pdp-owner-leaf-wire-validation.mjs';

const require = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'));
const operations = require('yaml').parse(readFileSync(resolve(process.cwd(), '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'));
const byId = new Map(operations.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some((present) => !present)) throw new TypeError('Sparse arrays are not canonical JSON');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Only plain JSON values are accepted');
}
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const sha256 = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const isNonblank = (value) => typeof value === 'string' && value.trim().length > 0;
function canonicalInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) return null;
  return millis;
}

/** Validate a definition-only logical operation request/result and its declared exact joins. */
export function validateLogicalOwnerOperationResult(operationId, request, result, trustedTuple = {}) {
  const operation = byId.get(operationId);
  if (!operation || !isRecord(request) || !isRecord(result)) return { valid: false, reason: 'UNKNOWN_OPERATION_OR_MALFORMED_ENVELOPE' };
  const requestCheck = validateOwnerClosedJsonSchema(operation.requestSchema, request, operation.requestSchema);
  const resultCheck = validateOwnerClosedJsonSchema(operation.resultSchema, result, operation.resultSchema);
  if (!requestCheck.valid || !resultCheck.valid) return { valid: false, reason: 'CLOSED_SCHEMA_REJECTED', requestErrors: requestCheck.errors, resultErrors: resultCheck.errors };
  if (operation.consistency?.maxObservationAgeMs !== undefined) {
    try {
      if (result.outcome === 'OBSERVED') {
        const required = ['tenantId', 'principalId', 'readAuthorityRef', 'readVersion', 'now'];
        if (required.some((field) => !isNonblank(trustedTuple[field]))) return { valid: false, reason: 'TRUSTED_READ_CONTEXT_INCOMPLETE' };
        for (const field of ['tenantId', 'principalId', 'readAuthorityRef', 'readVersion']) {
          if (!same(result[field], trustedTuple[field])) return { valid: false, reason: `TRUSTED_READ_TUPLE_MISMATCH:${field}` };
        }
        if (result.currentness !== 'CURRENT') return { valid: false, reason: 'READ_NOT_CURRENT' };
        const observedAt = canonicalInstant(result.observedAt);
        const now = canonicalInstant(trustedTuple.now);
        if (observedAt === null || now === null || observedAt > now) return { valid: false, reason: 'READ_TIME_INVALID_OR_FUTURE' };
        if (now - observedAt > operation.consistency.maxObservationAgeMs) return { valid: false, reason: 'READ_EXPIRED' };
        const expectedFingerprint = sha256({
          operationRef: operation.id,
          request,
          tenantId: trustedTuple.tenantId,
          principalId: trustedTuple.principalId,
        });
        if (result.requestFingerprint !== expectedFingerprint) return { valid: false, reason: 'REQUEST_FINGERPRINT_MISMATCH' };
      }
    } catch {
      return { valid: false, reason: 'MALFORMED_TRUSTED_READ_CONTEXT' };
    }
  }
  const readPath = (root, path) => path.split('.').reduce((value, key) => value?.[key], root);
  for (const rule of operation.requestResultBindings ?? []) {
    const outcomes = rule.when === undefined ? [] : Array.isArray(rule.when) ? rule.when : [rule.when];
    if (outcomes.length && !outcomes.includes(result.outcome)) continue;
    for (const pair of rule.pairs ?? []) {
      const left = readPath(request, pair.request);
      const right = readPath(result, pair.result);
      if (left === undefined || right === undefined || !same(left, right)) return { valid: false, reason: `BINDING_MISMATCH:${rule.id}:${pair.request}:${pair.result}` };
    }
    for (const field of rule.exactPairs ?? []) {
      const expected = field === 'requestFingerprint' && operation.consistency?.maxObservationAgeMs !== undefined
        ? sha256({ operationRef: operation.id, request, tenantId: trustedTuple.tenantId, principalId: trustedTuple.principalId })
        : Object.hasOwn(trustedTuple, field) ? trustedTuple[field] : request[field];
      const observed = result[field];
      if (expected === undefined || observed === undefined || !same(expected, observed)) return { valid: false, reason: `BINDING_MISMATCH:${rule.id}:${field}` };
    }
    for (const field of rule.outputExactPairs ?? []) {
      const expected = Object.hasOwn(trustedTuple, field) ? trustedTuple[field] : request[field];
      const observed = result.outputs?.[0]?.payload?.[field];
      if (expected === undefined ? observed !== undefined : !same(observed, expected)) return { valid: false, reason: `OUTPUT_BINDING_MISMATCH:${rule.id}:${field}` };
    }
    for (const field of rule.outputFields ?? []) if (result[field] === undefined) return { valid: false, reason: `OUTPUT_FIELD_MISSING:${rule.id}:${field}` };
    for (const field of rule.forbiddenOutputFields ?? []) if (result[field] !== undefined) return { valid: false, reason: `OUTPUT_FIELD_FORBIDDEN:${rule.id}:${field}` };
    if (rule.outputCount !== undefined && (result.outputs?.length ?? 0) !== rule.outputCount) return { valid: false, reason: `OUTPUT_COUNT_MISMATCH:${rule.id}` };
    if (rule.currentness !== undefined && result.currentness !== rule.currentness) return { valid: false, reason: `CURRENTNESS_MISMATCH:${rule.id}` };
  }
  return { valid: true, reason: 'CLOSED_SCHEMA_AND_OWNER_BINDINGS_MATCH' };
}
