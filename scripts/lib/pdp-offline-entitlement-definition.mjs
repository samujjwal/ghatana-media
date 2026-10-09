function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

const exactContextFields = [
  "tenantScopeRef", "principalRef", "issuerRef", "capabilityRef", "profileRef",
  "profileVersionRef", "purposeRef", "entitlementRef", "entitlementVersionRef",
  "policyDecisionRef", "readAuthorityRef", "readVersion", "currentness", "revocationDisposition",
  "validFrom", "validUntil",
];

/** A definition oracle only. It never admits a runtime or executes offline work. */
export function evaluateOfflineEntitlementDefinition(entitlement, expected, requestedOperationRef, now) {
  if (!entitlement || !expected || !validInstant(now)) return { disposition: "UNKNOWN", reason: "INVALID_TRUSTED_CONTEXT_OR_TIME" };
  for (const field of exactContextFields) {
    if (typeof expected[field] !== "string" || expected[field].trim() === ""
      || typeof entitlement[field] !== "string" || entitlement[field] !== expected[field]) {
      return { disposition: "DENIED", reason: `CONTEXT_MISMATCH:${field}` };
    }
  }
  if (entitlement.currentness !== "CURRENT"
    || entitlement.revocationDisposition !== "ACTIVE"
    || expected.currentness !== "CURRENT"
    || expected.revocationDisposition !== "ACTIVE"
    || !Array.isArray(expected.allowedOperationRefs)
    || expected.allowedOperationRefs.length === 0
    || expected.allowedOperationRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")
    || new Set(expected.allowedOperationRefs).size !== expected.allowedOperationRefs.length
    || !Array.isArray(entitlement.allowedOperationRefs)
    || entitlement.allowedOperationRefs.length !== expected.allowedOperationRefs.length
    || entitlement.allowedOperationRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")
    || new Set(entitlement.allowedOperationRefs).size !== entitlement.allowedOperationRefs.length
    || expected.allowedOperationRefs.slice().sort().some((ref, index) => ref !== entitlement.allowedOperationRefs.slice().sort()[index])
    || new Set(entitlement.allowedOperationRefs).size !== entitlement.allowedOperationRefs.length
    || typeof requestedOperationRef !== "string"
    || !expected.allowedOperationRefs.includes(requestedOperationRef)) {
    return { disposition: "DENIED", reason: "ENTITLEMENT_OR_OPERATION_NOT_CURRENTLY_AUTHORIZED" };
  }
  if (!validInstant(entitlement.validFrom) || !validInstant(entitlement.validUntil)) {
    return { disposition: "UNKNOWN", reason: "INVALID_ENTITLEMENT_INTERVAL" };
  }
  const start = Date.parse(entitlement.validFrom);
  const end = Date.parse(entitlement.validUntil);
  const instant = Date.parse(now);
  if (start >= end) return { disposition: "UNKNOWN", reason: "INVALID_ENTITLEMENT_INTERVAL" };
  if (instant < start || instant >= end) return { disposition: "DENIED", reason: "OUTSIDE_ENTITLEMENT_WINDOW" };
  return { disposition: "ELIGIBLE_BY_DEFINITION_ONLY", reason: "CURRENT_EXACT_ENTITLEMENT_TUPLE" };
}
