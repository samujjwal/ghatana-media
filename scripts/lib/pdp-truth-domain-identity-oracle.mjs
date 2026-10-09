export class IdentityContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IdentityContractError";
    this.code = code;
  }
}

const SCALAR_REF_PREFIX = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/scalarTypes/";

function resolveScalarType(ref, scalarTypes, field) {
  if (typeof ref !== "string" || !ref.startsWith(SCALAR_REF_PREFIX)) {
    throw new IdentityContractError("IDENTITY_TYPE_UNRESOLVED", `${field} must reference the exact canonical PDP-1 scalar registry`);
  }
  const typeId = ref.slice(SCALAR_REF_PREFIX.length);
  if (!typeId || typeId.includes("/") || typeId.includes("#") || !Object.hasOwn(scalarTypes, typeId)) {
    throw new IdentityContractError("IDENTITY_TYPE_UNRESOLVED", `${field} references an undeclared canonical scalar type`);
  }
  return scalarTypes[typeId];
}

function validateScalar(value, scalarType, field) {
  const rule = scalarType?.validator;
  const expectedJsType = rule?.type === "integer" || rule?.type === "number" ? "number" : rule?.type;
  if (!rule || typeof value !== expectedJsType) {
    throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${field} does not satisfy its resolved scalar type`);
  }
  if (rule.type === "string") {
    if (typeof rule.pattern === "string" && !(new RegExp(rule.pattern)).test(value)) {
      throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${field} violates its scalar pattern`);
    }
    if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)) {
      throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${field} violates scalar length bounds`);
    }
  }
  if (rule.type === "integer" && (!Number.isSafeInteger(value) || value < (rule.minimum ?? Number.MIN_SAFE_INTEGER) || value > (rule.maximum ?? Number.MAX_SAFE_INTEGER))) {
    throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${field} violates safe integer scalar bounds`);
  }
}

export function canonicalIdentityKey(contract, body, trustedTenantId, scalarTypes = {}, canonicalObjectRefs = undefined) {
  if (contract.canonicalDisposition !== "CANONICAL_MEDIA_IDENTITY") {
    throw new IdentityContractError("SOURCE_OBSERVATION_NOT_CANONICAL", "source observation cannot be promoted to canonical identity");
  }
  if (typeof trustedTenantId !== "string" || trustedTenantId.trim() === "") {
    throw new IdentityContractError("TRUSTED_TENANT_REQUIRED", "trusted host tenant context is required");
  }
  const tenantComponent = contract.identityComponents.find(({ field }) => field === "tenantId");
  if (!tenantComponent?.scalarTypeRef) {
    throw new IdentityContractError("IDENTITY_TYPE_UNRESOLVED", "trusted tenant identity type must resolve to a declared canonical scalar");
  }
  validateScalar(trustedTenantId, resolveScalarType(tenantComponent.scalarTypeRef, scalarTypes, "tenantId"), "tenantId");
  if (Object.hasOwn(body ?? {}, "tenantId")) {
    throw new IdentityContractError("CALLER_TENANT_FORBIDDEN", "tenant identity comes from trusted host context, not the request body");
  }
  const components = contract.identityComponents.filter(({ field }) => field !== "tenantId");
  const expected = new Set(components.map(({ field }) => field));
  const supplied = Object.keys(body ?? {});
  const extras = supplied.filter((field) => !expected.has(field));
  const missing = [...expected].filter((field) => !Object.hasOwn(body ?? {}, field));
  if (extras.length) throw new IdentityContractError("UNKNOWN_IDENTITY_FIELD", `unknown identity field(s): ${extras.join(",")}`);
  if (missing.length) throw new IdentityContractError("IDENTITY_FIELD_REQUIRED", `missing identity field(s): ${missing.join(",")}`);
  for (const component of components) {
    const value = body[component.field];
    const constraint = component.inlineConstraint;
    if (component.scalarTypeRef) {
      validateScalar(value, resolveScalarType(component.scalarTypeRef, scalarTypes, component.field), component.field);
    } else if (constraint?.type === "integer" && (!Number.isSafeInteger(value) || value < (constraint.minimum ?? Number.MIN_SAFE_INTEGER) || value > (constraint.maximum ?? Number.MAX_SAFE_INTEGER))) {
      throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${component.field} violates its safe integer identity constraint`);
    } else if (!constraint && (typeof value !== "string" || value.trim() === "")) {
      throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${component.field} must be a nonempty typed identifier`);
    }
    if (constraint?.type === "integer" && (!Number.isSafeInteger(value) || value < (constraint.minimum ?? Number.MIN_SAFE_INTEGER) || value > (constraint.maximum ?? Number.MAX_SAFE_INTEGER))) {
      throw new IdentityContractError("IDENTITY_FIELD_INVALID", `${component.field} violates its safe integer identity constraint`);
    }
  }
  const identityNamespaceRef = contract.canonicalIdentityNamespaceRef ?? contract.objectRef;
  if (typeof identityNamespaceRef !== "string" || identityNamespaceRef.trim() === "") {
    throw new IdentityContractError("IDENTITY_NAMESPACE_INVALID", "canonical identity namespace must be a nonempty owner-defined reference");
  }
  if (contract.canonicalIdentityNamespaceRef) {
    const expectedSourceRef = `.product-experience/pdp-1-domain-data/domain-objects.yaml#${identityNamespaceRef}`;
    if (contract.canonicalIdentityNamespaceSourceRef !== expectedSourceRef
      || !(canonicalObjectRefs instanceof Set)
      || !canonicalObjectRefs.has(identityNamespaceRef)) {
      throw new IdentityContractError("IDENTITY_NAMESPACE_UNRESOLVED", "canonical identity namespace must resolve to an exact registered PDP-1 domain object");
    }
  }
  return JSON.stringify([identityNamespaceRef, trustedTenantId, ...components.map(({ field }) => body[field])]);
}

export function registerImmutableIdentity(registry, contract, body, trustedTenantId, immutableFingerprint, scalarTypes = {}, canonicalObjectRefs = undefined) {
  if (typeof immutableFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(immutableFingerprint)) {
    throw new IdentityContractError("IMMUTABLE_FINGERPRINT_INVALID", "immutable-field fingerprint must be a declared sha256 digest");
  }
  const key = canonicalIdentityKey(contract, body, trustedTenantId, scalarTypes, canonicalObjectRefs);
  const previous = registry.get(key);
  if (previous === undefined) {
    registry.set(key, immutableFingerprint);
    return { key, disposition: "CREATED" };
  }
  if (previous === immutableFingerprint) return { key, disposition: "IDEMPOTENT_DUPLICATE" };
  throw new IdentityContractError("IDENTITY_COLLISION", "same-tenant identity already names different immutable content or lineage");
}

export function validateAcyclicSameTenantLineage(edges, contracts, scalarTypes = {}) {
  const byRef = new Map((contracts ?? []).map((contract) => [contract.objectRef, contract]));
  if (byRef.size === 0) throw new IdentityContractError("LINEAGE_TYPE_REGISTRY_REQUIRED", "lineage validation requires the exact canonical identity registry");
  const graph = new Map();
  const allowedKinds = new Set(["version-parent", "DERIVED_FROM", "TRANSFORMED_FROM", "GENERATED_FROM", "INFERRED_FROM", "EXECUTED_BY", "AUTHORIZED_BY", "ASSESSED_BY"]);
  for (const edge of edges) {
    if (!edge || typeof edge.kind !== "string" || !edge.from || !edge.to || typeof edge.from.objectRef !== "string" || typeof edge.to.objectRef !== "string" || typeof edge.from.tenantId !== "string" || typeof edge.to.tenantId !== "string") {
      throw new IdentityContractError("LINEAGE_IDENTITY_INCOMPLETE", "lineage edges require a relation kind and complete canonical endpoint type and tenant fields");
    }
    if (!allowedKinds.has(edge.kind)) throw new IdentityContractError("LINEAGE_RELATION_KIND_INVALID", "lineage relation kind is not declared by the Media owner contract");
    const canonicalEndpoint = (endpoint) => {
      const contract = byRef.get(endpoint.objectRef);
      if (!contract || contract.canonicalDisposition !== "CANONICAL_MEDIA_IDENTITY") throw new IdentityContractError("LINEAGE_TYPE_UNKNOWN", "lineage endpoint type must be an exact registered canonical object type");
      const body = Object.fromEntries(Object.entries(endpoint).filter(([key]) => key !== "objectRef" && key !== "tenantId"));
      const key = canonicalIdentityKey(contract, body, endpoint.tenantId, scalarTypes, new Set(byRef.keys()));
      return { key, objectRef: contract.objectRef };
    };
    const from = canonicalEndpoint(edge.from);
    const to = canonicalEndpoint(edge.to);
    if (edge.from.tenantId !== edge.to.tenantId) {
      throw new IdentityContractError("CROSS_TENANT_LINEAGE", "lineage cannot cross tenant boundaries");
    }
    if (from.objectRef !== to.objectRef && edge.kind === "version-parent") {
      throw new IdentityContractError("LINEAGE_OBJECT_KIND_MISMATCH", "version-parent edges must join the same immutable object kind");
    }
    const targets = graph.get(from.key) ?? new Set();
    targets.add(to.key);
    graph.set(from.key, targets);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) throw new IdentityContractError("LINEAGE_CYCLE", "immutable version lineage must be acyclic");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return { edgeCount: edges.length, acyclic: true, runtimeObservation: "NOT_EVALUATED" };
}
