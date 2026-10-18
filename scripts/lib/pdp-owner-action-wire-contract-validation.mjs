const OWNER_ACTION_PREFIX = "media.operation.action.";

const fail = (code, detail) => ({ code, detail });

function sourceRows(document) {
  return [
    ...(document.operations ?? []),
    ...(document.individualOperationContracts?.records ?? []),
    ...(document.ownerDefinedOperationContracts?.records ?? []),
    ...(document.capabilityOperationContracts?.records ?? []),
  ];
}

function sourceOperationSelector(document, id) {
  const collections = [
    ["operations", document.operations],
    ["individualOperationContracts/records", document.individualOperationContracts?.records],
    ["ownerDefinedOperationContracts/records", document.ownerDefinedOperationContracts?.records],
    ["capabilityOperationContracts/records", document.capabilityOperationContracts?.records],
  ];
  const matches = collections.filter(([, rows]) => rows?.some((row) => row.id === id));
  if (matches.length !== 1) return null;
  return `${matches[0][0]}/@id=${id}`;
}

function schemaContainsPseudoType(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.type === "string" && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(value.type)) return true;
  return Object.values(value).some(schemaContainsPseudoType);
}

const CANONICAL_REFERENCE_PATH = (objectRef) => `#/$defs/canonicalReferences/${objectRef.replaceAll(".", "_")}`;
const STRING_SCHEMA = (pattern, maxLength = 256) => ({
  type: "string", minLength: 1, maxLength, pattern,
});
const SIMPLE_STRING_TYPES = new Set([
  "exact-operation-id", "exact-purpose-id", "exact-authorized-destination-ref",
  "exact-owner-profile-ref", "typed-destination-acknowledgment-ref",
  "opaque-owner-issued-review-correlation-id", "owner-declared-actor-workspace-preference-id",
]);
const REF_TYPES = {
  "current-authority-decision-ref": ["media.domain.rights-decision"],
  "authority-issued-rights-decision-ref": ["media.domain.rights-decision"],
  "authority-issued-consent-reference": ["media.domain.consent-reference", "media.domain.consent-record"],
  "current-consent-authority-receipt": ["media.domain.consent-reference", "media.domain.consent-record"],
  "immutable-manifest-ref": ["media.domain.provenance-manifest"],
  "immutable-world-version-ref": ["media.domain.simulation-world"],
  "immutable-plan-ref": ["media.domain.resolved-plan"],
  "typed-initial-condition-ref": ["media.domain.simulation-world"],
  "opaque-version-or-parent-id": [
    "media.domain.project-revision", "media.domain.artifact-version", "media.domain.timeline",
    "media.domain.composition-config", "media.domain.scene-plan", "media.domain.scene-graph",
    "media.domain.animation-graph",
  ],
};
const OWNER_COMPLETION_SCHEMAS = {
  declaredScopeRef: { $ref: "#/$defs/purposeRegionTimeDistributionScope" },
};
const TENANT_SCOPE_RULE = "Every tenantId inside a submitted canonical object reference must equal the tenant resolved by the trusted host context; caller-selected tenant IDs never select or grant scope.";
const UNKNOWN_OUTCOME_RULE = "UNKNOWN is neither success nor failure; reconcile the same tenant/principal request identity and payload fingerprint before any command resubmission; never blindly replay or allocate a new request identity. Queries may only perform a fresh authorized read observation.";
const RESULT_PROJECTION_RULE = "OWNER_DECLARED_NORMALIZED_PROJECTION; no producer-payload or field-value equivalence is implied";
const CANCELLATION_REQUESTED_MEANING = "SUCCEEDED acknowledges only the durable cancellation-request record or an already-terminal-job observation; the request may move an attempt to CANCEL_REQUESTED after durability, but does not confirm stop.";
const CANCELLATION_CONFIRMED_STOP_MEANING = "A stop is confirmed only by authoritative finality evidence that no further effect can occur; a cancellation request, returned projection, detach, timeout, or provider acknowledgement alone is not that evidence.";
const CANCELLATION_UNKNOWN_MEANING = "UNKNOWN_OUTCOME remains unknown; inspect the same job and attempt evidence, reconcile the same request identity before resubmission, and never automatically retry after lost acknowledgement.";
const CANCELLATION_NO_REVERSAL_MEANING = "Cancellation is not reversal, remote recall, provider stop, or rewriting terminal history; preserve the current or unknown state until authoritative evidence.";
const PURPOSE_SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["purposeId", "regionCode", "validFrom", "validUntil", "distributionClass"],
  properties: {
    purposeId: STRING_SCHEMA("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"),
    regionCode: { type: "string", minLength: 2, maxLength: 32 },
    validFrom: { type: "string", format: "date-time" },
    validUntil: { type: "string", format: "date-time" },
    distributionClass: { type: "string", enum: ["INTERNAL", "AUTHORIZED_RECIPIENTS", "PUBLIC", "RESTRICTED"] },
  },
};

function immutableSnapshotProjectionIssues(catalog, sourceOperations) {
  const source = (sourceOperations.ownerDefinedOperationContracts?.records ?? [])
    .find((row) => row.id === "media.operation.action.submit-render");
  const sourceSnapshot = source?.requestSchema?.properties?.sourceSnapshot;
  if (sourceSnapshot?.type !== "object") return [];

  const definition = catalog.$defs?.immutableSourceSnapshot;
  const issues = [];
  const detail = "media.operation.action.submit-render.sourceSnapshot";
  const artifactRefs = definition?.properties?.artifactVersionRefs;
  const artifactRefAlternatives = artifactRefs?.items?.oneOf ?? [];
  const expectedArtifactRef = { $ref: "#/$defs/canonicalReferences/media_domain_artifact-version" };
  const projectRevisionRef = definition?.properties?.projectRevisionRef;
  const expectedProjectRevisionRef = { oneOf: [{ $ref: "#/$defs/canonicalReferences/media_domain_project-revision" }] };
  const scalarTypes = sourceOperations.capabilityOperationContracts?.scalarTypes;
  const projectedSourceSnapshot = normalizeSourceProperty(sourceSnapshot, { operationId: source.id, propertyName: "sourceSnapshot", scalarTypes });
  const projectedSourceDefinition = structuredClone(sourceSnapshot);
  const sourceCondition = sourceSnapshot.allOf?.find((clause) => clause.if && clause.then);
  delete projectedSourceDefinition.allOf;
  if (projectedSourceDefinition.properties?.artifactVersionRefs?.items?.type === "CanonicalObjectReference"
    || (projectedSourceDefinition.properties?.artifactVersionRefs?.items?.type === "string"
      && (Array.isArray(projectedSourceDefinition.properties.artifactVersionRefs.items.allowedObjectRefs)
        || typeof projectedSourceDefinition.properties.artifactVersionRefs.items.objectRef === "string"))) {
    projectedSourceDefinition.properties.artifactVersionRefs.items = normalizeSourceProperty(sourceSnapshot.properties.artifactVersionRefs.items, { scalarTypes, operationId: source.id, propertyName: "artifactVersionRefs" });
  }
  if (projectedSourceDefinition.properties?.projectRevisionRef?.type === "CanonicalObjectReference"
    || (projectedSourceDefinition.properties?.projectRevisionRef?.type === "string"
      && (typeof projectedSourceDefinition.properties.projectRevisionRef.objectRef === "string"
        || Array.isArray(projectedSourceDefinition.properties.projectRevisionRef.allowedObjectRefs)))) {
    projectedSourceDefinition.properties.projectRevisionRef = normalizeSourceProperty(sourceSnapshot.properties.projectRevisionRef, { scalarTypes, operationId: source.id, propertyName: "projectRevisionRef" });
  }
  if (sourceCondition) {
    projectedSourceDefinition.if = structuredClone(sourceCondition.if);
    projectedSourceDefinition.then = structuredClone(sourceCondition.then);
  }
  const wireSnapshotWithoutOwnerOnlyRef = structuredClone(definition ?? {});
  if (definition?.type !== "object" || definition.additionalProperties !== false
    || !definition.required?.includes("artifactVersionRefs")
    || artifactRefs?.type !== "array" || (artifactRefs.minItems ?? 0) < 1
    || !sameShape(artifactRefAlternatives, [expectedArtifactRef])
    || !sameShape(projectedSourceSnapshot, { $ref: "#/$defs/immutableSourceSnapshot" })
    || !sameShape(projectedSourceDefinition, wireSnapshotWithoutOwnerOnlyRef)) {
    issues.push(fail("SNAPSHOT_ARTIFACT_IDENTITY_SHAPE_DRIFT", detail));
  }
  const selector = "projectBacked";
  const sourceConditionResolved = sourceSnapshot.required?.includes(selector)
    && sourceSnapshot.properties?.[selector]?.type === "boolean"
    && sourceCondition?.if?.required?.includes(selector)
    && sourceCondition?.if?.properties?.[selector]?.const === true
    && sourceCondition.then?.required?.includes("projectRevisionRef");
  const wireConditionResolved = definition?.required?.includes(selector)
    && definition?.properties?.[selector]?.type === "boolean"
    && definition?.if?.required?.includes(selector)
    && definition?.if?.properties?.[selector]?.const === true
    && definition?.then?.required?.includes("projectRevisionRef")
    && projectRevisionRef && sameShape(projectRevisionRef, expectedProjectRevisionRef);
  if (!sourceConditionResolved || !wireConditionResolved) {
    issues.push(fail("SNAPSHOT_PROJECT_REVISION_CONDITION_UNRESOLVED", detail));
  }
  if (artifactRefs?.uniqueItems === true || Object.hasOwn(artifactRefs ?? {}, "maxItems")) {
    issues.push(fail("SNAPSHOT_UNSUPPORTED_ARRAY_REFINEMENT", detail));
  }
  return issues;
}

function normalizeSourceProperty(schema, { actionRef, operationId, propertyName, scalarTypes } = {}) {
  if (!schema || typeof schema !== "object") return schema;
  const type = schema.type;
  let projected;
  if (type === "CanonicalObjectReference") {
    projected = { oneOf: (schema.allowedObjectRefs ?? []).map((ref) => ({ $ref: CANONICAL_REFERENCE_PATH(ref) })) };
  } else if (type === "string" && Array.isArray(schema.allowedObjectRefs) && schema.allowedObjectRefs.length > 0) {
    projected = { oneOf: schema.allowedObjectRefs.map((ref) => ({ $ref: CANONICAL_REFERENCE_PATH(ref) })) };
  } else if (type === "string" && typeof schema.objectRef === "string") {
    projected = { oneOf: [{ $ref: CANONICAL_REFERENCE_PATH(schema.objectRef) }] };
  } else if (type === "string" && schema.tenantPrincipalScoped === true) {
    projected = STRING_SCHEMA("^[A-Za-z0-9][A-Za-z0-9._:-]*$", 128);
  } else if (type === "array") {
    projected = { type: "array" };
    if (schema.items) projected.items = normalizeSourceProperty(schema.items, { actionRef, operationId, propertyName, scalarTypes });
  } else if (type === "opaque-id") {
    projected = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minLength: 1, maxLength: 128 };
  } else if (type === "confirmation") {
    projected = { $ref: "#/$defs/targetBoundConfirmation" };
  } else if (SIMPLE_STRING_TYPES.has(type)) {
    projected = STRING_SCHEMA("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$");
  } else if (type === "opaque-version-id") {
    projected = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:+-]*$", minLength: 1, maxLength: 128 };
  } else if (type === "typed-field-allowlist") {
    // The source names this pseudo-type but defines neither its representation nor
    // item/cardinality constraints. Do not invent a concrete list schema here.
    return null;
  } else if (type === "opaque-owner-evidence-ref" || type === "typed-destination-profile-ref") {
    // These scalar validators are defined by the source contract; do not widen
    // them to unconstrained strings or add a consumer-invented identifier grammar.
    projected = scalarTypes?.[type]?.validator ? structuredClone(scalarTypes[type].validator) : null;
  } else if (type === "declared-simulation-output-kind") {
    // The source does not enumerate this pseudo-type's values.
    projected = { type: "string" };
  } else if (type === "exact-purpose-region-time-and-distribution-scope") {
    projected = { $ref: "#/$defs/purposeRegionTimeDistributionScope" };
  } else if (type === "exact-region-and-time-scope") {
    projected = { $ref: "#/$defs/regionTimeScope" };
  } else if (type === "json-value") {
    projected = { $ref: "#/$defs/boundedPreferenceValue" };
  } else if (type === "ImmutableSourceSnapshot") {
    projected = { $ref: "#/$defs/immutableSourceSnapshot" };
  } else if (type === "object" && operationId === "media.operation.action.submit-render" && propertyName === "sourceSnapshot") {
    projected = { $ref: "#/$defs/immutableSourceSnapshot" };
  } else if (type === undefined && (schema.properties || schema.required || schema.if || schema.then || Object.hasOwn(schema, "const"))) {
    projected = {};
    if (Array.isArray(schema.required)) projected.required = [...schema.required];
    if (schema.properties) {
      projected.properties = Object.fromEntries(Object.entries(schema.properties)
        .map(([name, child]) => [name, normalizeSourceProperty(child, { actionRef, operationId, propertyName: name, scalarTypes })]));
    }
    if (schema.if) projected.if = normalizeSourceProperty(schema.if, { actionRef, operationId, propertyName, scalarTypes });
    if (schema.then) projected.then = normalizeSourceProperty(schema.then, { actionRef, operationId, propertyName, scalarTypes });
  } else if (type === "object") {
    projected = { type: "object" };
    if (Object.hasOwn(schema, "additionalProperties")) projected.additionalProperties = schema.additionalProperties;
    if (Array.isArray(schema.required)) projected.required = [...schema.required];
    if (schema.properties) {
      projected.properties = Object.fromEntries(Object.entries(schema.properties)
        .map(([name, child]) => [name, normalizeSourceProperty(child, { actionRef, operationId, propertyName: name, scalarTypes })]));
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && schema.allOf[0]?.if && schema.allOf[0]?.then) {
      projected.if = normalizeSourceProperty(schema.allOf[0].if, { actionRef, operationId, propertyName, scalarTypes });
      projected.then = normalizeSourceProperty(schema.allOf[0].then, { actionRef, operationId, propertyName, scalarTypes });
    } else if (Array.isArray(schema.allOf)) {
      projected.allOf = schema.allOf.map((child) => normalizeSourceProperty(child, { actionRef, operationId, propertyName, scalarTypes }));
    }
  } else if (type === "ActionSpecificAppendPayload") {
    projected = { $ref: `#/$defs/actionPayloads/${actionRef?.replaceAll(".", "_")}` };
  } else if (type === "ActionSpecificReviewPayload") {
    projected = { $ref: `#/$defs/reviewPayloads/${actionRef?.replaceAll(".", "_")}` };
  } else if (REF_TYPES[type]) {
    projected = { oneOf: REF_TYPES[type].map((ref) => ({ $ref: CANONICAL_REFERENCE_PATH(ref) })) };
  } else if (["string", "number", "integer", "boolean", "object", "null"].includes(type)) {
    projected = { type };
  } else {
    return null;
  }

  // Source structural constraints are retained when they have JSON Schema meaning.
  // Owner metadata (for example immutable/versionRule) is represented by a typed
  // reference projection, not copied as an executable wire constraint.
  for (const key of ["minItems", "maxItems", "uniqueItems", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "format"]) {
    if (Object.hasOwn(schema, key)) projected[key] = schema[key];
  }
  if (type === "array" && Array.isArray(schema.default) && schema.default.length === 0) projected.minItems = 0;
  return projected;
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}
const sameShape = (left, right) => JSON.stringify(sortedObject(left)) === JSON.stringify(sortedObject(right));

/**
 * Validates the finite normalized P1 action-wire source layer against the exact
 * owner rows. This is a definition conformance check, not runtime admission.
 */
export function validateOwnerActionWireCatalog({ catalog, operations, actions, domainObjects }) {
  const issues = [];
  const ownerOps = sourceRows(operations);
  const actionRows = [...(actions.actions ?? []), ...(actions.ownerDefinedActions ?? [])];
  const actionIds = new Set(actionRows.map((row) => row.id));
  const identities = domainObjects.ownerTypedIdentityContracts?.records ?? [];
  const canonicalIdentityIds = new Set(identities
    .filter((row) => row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY")
    .map((row) => row.objectRef));
  const actionOwnerOps = ownerOps.filter((row) => row.id?.startsWith(OWNER_ACTION_PREFIX));
  const records = catalog.records ?? [];
  const bySourceOperation = new Map(records.map((record) => [record.sourceOperationRef, record]));
  const byAction = new Map(records.filter((record) => record.actionRef).map((record) => [record.actionRef, record]));

  if (catalog.canonicalReferenceTenantRule !== TENANT_SCOPE_RULE) {
    issues.push(fail("TENANT_REFERENCE_BINDING_RULE", "canonicalReferenceTenantRule"));
  }
  if (catalog.unknownOutcomeRule !== UNKNOWN_OUTCOME_RULE) {
    issues.push(fail("UNKNOWN_OUTCOME_RULE_DRIFT", "unknownOutcomeRule"));
  }

  if (actionOwnerOps.length !== 79) issues.push(fail("SOURCE_POPULATION", `expected 79 action operations; got ${actionOwnerOps.length}`));
  if (records.length !== 79) issues.push(fail("CONTRACT_POPULATION", `expected 79 normalized records; got ${records.length}`));
  if (identities.filter((row) => row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY").length !== 37) {
    issues.push(fail("IDENTITY_POPULATION", "expected exactly 37 registered canonical Media identity tuples"));
  }
  const canonicalIdentities = identities.filter((row) => row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY");
  if (canonicalIdentityIds.has("media.domain.persisted-audio-file")) {
    issues.push(fail("SOURCE_OBSERVATION_PROMOTED", "persisted-audio-file is a source observation, not a canonical identity"));
  }

  for (const identity of catalog.canonicalIdentityTypes ?? []) {
    const source = identities.find((row) => row.objectRef === identity.objectRef && row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY");
    const expectedSchemaRef = `#/$defs/canonicalReferences/${identity.objectRef.replaceAll(".", "_")}`;
    if (!source || identity.identityContractRef !== `.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=${source.id}`
      || identity.schemaRef !== expectedSchemaRef
      || JSON.stringify(identity.identityTuple) !== JSON.stringify(source.canonicalIdentityTuple)) {
      issues.push(fail("IDENTITY_SOURCE_MISMATCH", identity.objectRef));
    }
    const referenceSchema = catalog.$defs?.canonicalReferences?.[identity.objectRef.replaceAll(".", "_")];
    const tuple = source?.canonicalIdentityTuple ?? [];
    const identitySchema = referenceSchema?.properties?.identity;
    const tupleFields = Object.keys(identitySchema?.properties ?? {}).sort();
    if (referenceSchema?.type !== "object" || referenceSchema.additionalProperties !== false
      || !sameShape([...(referenceSchema.required ?? [])].sort(), ["identity", "objectType"])
      || !sameShape(Object.keys(referenceSchema.properties ?? {}).sort(), ["identity", "objectType"])
      || referenceSchema.properties?.objectType?.const !== identity.objectRef
      || identitySchema?.type !== "object" || identitySchema.additionalProperties !== false
      || !sameShape([...(identitySchema.required ?? [])].sort(), [...tuple].sort())
      || !sameShape(tupleFields, [...tuple].sort())
      || tuple.some((field) => !["string", "integer", "number"].includes(identitySchema.properties?.[field]?.type)
        || (identitySchema.properties[field].type === "string" && (identitySchema.properties[field].minLength ?? 0) < 1))) {
      issues.push(fail("CANONICAL_IDENTITY_SCHEMA_DRIFT", identity.objectRef));
    }
  }
  if ((catalog.canonicalIdentityTypes ?? []).length !== 37) issues.push(fail("IDENTITY_TYPE_POPULATION", "canonicalIdentityTypes must enumerate all 37 source identities exactly once"));
  if (new Set((catalog.canonicalIdentityTypes ?? []).map((identity) => identity.objectRef)).size !== 37
    || !sameShape((catalog.canonicalIdentityTypes ?? []).map((identity) => identity.objectRef).sort(), canonicalIdentities.map((identity) => identity.objectRef).sort())) {
    issues.push(fail("IDENTITY_TYPE_SET_DRIFT", "canonicalIdentityTypes"));
  }
  const canonicalRefNames = (catalog.canonicalIdentityTypes ?? []).map((identity) => `#/$defs/canonicalReferences/${identity.objectRef.replaceAll(".", "_")}`).sort();
  const anyRefs = catalog.$defs?.canonicalReferenceAny?.oneOf?.map((branch) => branch.$ref).sort() ?? [];
  if (!sameShape(anyRefs, canonicalRefNames)) issues.push(fail("CANONICAL_REFERENCE_UNION_DRIFT", "$defs/canonicalReferenceAny"));
  if (!sameShape(Object.keys(catalog.$defs?.canonicalReferences ?? {}).sort(), canonicalRefNames.map((ref) => ref.slice(ref.lastIndexOf("/") + 1)).sort())) {
    issues.push(fail("CANONICAL_REFERENCE_SCHEMA_SET_DRIFT", "$defs/canonicalReferences"));
  }

  const idempotencyBindings = catalog.idempotencyBindings ?? [];
  const idempotencyByOperation = new Map(idempotencyBindings.map((binding) => [binding.sourceOperationRef, binding]));
  const resultProjectionBindings = catalog.resultProjectionBindings ?? [];
  const resultProjectionByOperation = new Map(resultProjectionBindings.map((binding) => [binding.sourceOperationRef, binding]));
  const actorBindings = catalog.actorBindings ?? [];
  const actorBindingByAction = new Map(actorBindings.map((binding) => [binding.sourceActionRef, binding]));
  if (!sameShape(catalog.$defs?.purposeRegionTimeDistributionScope, PURPOSE_SCOPE_SCHEMA)) {
    issues.push(fail("OWNER_SCOPE_SCHEMA_DRIFT", "$defs/purposeRegionTimeDistributionScope"));
  }
  issues.push(...immutableSnapshotProjectionIssues(catalog, operations));

  for (const source of actionOwnerOps) {
    const selector = sourceOperationSelector(operations, source.id);
    const record = records.find((candidate) => candidate.sourceOperationRef === `.product-experience/pdp-1-domain-data/operations.yaml#${selector}`);
    if (!record) {
      issues.push(fail("MISSING_SOURCE_OPERATION_BINDING", source.id));
      continue;
    }
    if (record.operationKind !== source.operationKind || (source.requestSchema && (record.sourceEffect !== source.sourceEffect || record.sourceFinality !== source.sourceFinality))) {
      issues.push(fail("SOURCE_SEMANTICS_DRIFT", source.id));
    }
    if (!source.requestSchema) {
      // inspect-job-retry-policy is intentionally sourced from the typed observation
      // contract linked by its owner-only wire record, not a generic operation schema.
      const observationMatch = record.sourceObservationContractRef?.match(/ownerTypedObservationContracts\/records\/@id=([^/]+)$/u);
      const observation = observationMatch && (operations.ownerTypedObservationContracts?.records ?? [])
        .find((row) => row.id === observationMatch[1]);
      const queryProperties = observation?.requestSchema?.properties ?? {};
      const wireInputs = record.requestSchema?.properties ?? {};
      const sourceRequired = [...new Set(observation?.requestSchema?.required ?? [])].sort();
      const sourceRequestSchema = observation?.requestSchema ?? {};
      const idempotencyBinding = idempotencyByOperation.get(`.product-experience/pdp-1-domain-data/operations.yaml#${selector}`);
      const expectedRequestProperties = structuredClone(queryProperties);
      expectedRequestProperties.operationRef = { const: source.id };
      const queryResultBranches = record.resultSchema?.oneOf ?? [];
      const successBranch = queryResultBranches[0];
      const deniedBranch = queryResultBranches[1];
      const normalizedSuccessBranch = structuredClone(successBranch ?? {});
      if (Array.isArray(normalizedSuccessBranch.required)) normalizedSuccessBranch.required.sort();
      const sourceResultSchema = structuredClone(observation?.resultSchema ?? {});
      if (sourceResultSchema.properties?.operationRef?.enum?.length === 1) {
        sourceResultSchema.properties.operationRef = { const: sourceResultSchema.properties.operationRef.enum[0] };
      }
      if (Array.isArray(sourceResultSchema.required)) sourceResultSchema.required.sort();
      const deniedRequired = ["operationRef", "queryId", "outcome", "reasonCode"].sort();
      const deniedProperties = deniedBranch?.properties ?? {};
      const requestMatches = sourceRequestSchema.type === "object"
        && sourceRequestSchema.additionalProperties === false
        && sameShape(Object.keys(wireInputs).sort(), Object.keys(expectedRequestProperties).sort())
        && sameShape(wireInputs, expectedRequestProperties)
        && record.requestSchema?.additionalProperties === false;
      const resultMatches = observation?.resultSchema?.type === "object"
        && observation.resultSchema.additionalProperties === false
        && record.resultSchema?.type === "object"
        && record.resultSchema.additionalProperties === undefined
        && queryResultBranches.length === 2
        && queryResultBranches.every((branch) => branch.additionalProperties === false)
        && sameShape(normalizedSuccessBranch, sourceResultSchema)
        && deniedBranch?.type === "object"
        && deniedBranch.additionalProperties === false
        && sameShape([...new Set(deniedBranch.required ?? [])].sort(), deniedRequired)
        && sameShape(Object.keys(deniedProperties).sort(), deniedRequired)
        && deniedProperties.operationRef?.const === source.id
        && sameShape(deniedProperties.queryId, queryProperties.queryId)
        && deniedProperties.outcome?.const === "DENIED"
        && deniedProperties.reasonCode?.type === "string"
        && deniedProperties.reasonCode.minLength === 1
        && deniedProperties.reasonCode.maxLength === 128;
      if (record.actionRef !== null || record.sourceActionRef !== null || source.operationKind !== "QUERY"
        || !observation || record.sourceObservationContractRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${observation.id}`
        || record.semantics?.effectKind !== "READ_ONLY_OBSERVATION"
        || wireInputs.operationRef?.const !== source.id
        || !sameShape([...new Set(record.sourceRequiredProperties ?? [])].sort(), sourceRequired)
        || !sameShape([...new Set(record.requestSchema?.required ?? [])].sort(), ["operationRef", ...sourceRequired].sort())
        || !requestMatches || !resultMatches
        || idempotencyBinding?.disposition !== "READ_ONLY_OBSERVATION; fresh authorized re-observation only; no command replay"
        || idempotencyBinding?.sourceObservationContractRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${observation?.id}`
        || idempotencyBinding?.unknownOutcomeRule !== UNKNOWN_OUTCOME_RULE
        || !["STALE", "UNKNOWN"].every((state) => successBranch?.properties?.currentness?.enum?.includes(state))
        || !record.semantics?.unknownIsNotSuccess || !/STALE or UNKNOWN/u.test(record.sourceRecovery ?? "")) {
        issues.push(fail("OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", source.id));
      }
      const resultProjection = resultProjectionByOperation.get(`.product-experience/pdp-1-domain-data/operations.yaml#${selector}`);
      const sourceTypedFields = Object.keys(observation?.resultSchema?.properties ?? {}).sort();
      const wireTypedFields = Object.keys(successBranch?.properties ?? {}).sort();
      const expectedMappings = sourceTypedFields.map((sourceField) => ({
        sourceField,
        wireField: wireTypedFields.includes(sourceField) ? sourceField : null,
        disposition: wireTypedFields.includes(sourceField) ? "EXACT_TYPED_SCHEMA_FIELD" : "NOT_EXPOSED_IN_NORMALIZED_BRANCH",
      }));
      if (!resultProjection
        || resultProjection.sourceResultSchemaRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${observation?.id}/resultSchema`
        || resultProjection.wireSuccessBranchRef !== `.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#records/@id=${record.id}/resultSchema/oneOf/0`
        || resultProjection.mappingStatus !== "EXACT_TYPED_OBSERVATION_SCHEMA; branch equality is separately validated against the linked observation contract"
        || !sameShape(resultProjection.sourceDeclaredFields, sourceTypedFields)
        || !sameShape(resultProjection.normalizedSuccessFields, wireTypedFields)
        || !sameShape(resultProjection.sourceFieldMappings, expectedMappings)
        || !sameShape(resultProjection.normalizedOnlyFields, wireTypedFields.filter((field) => !sourceTypedFields.includes(field)))) {
        issues.push(fail("RESULT_PROJECTION_BINDING_DRIFT", source.id));
      }
      continue;
    }
    const operationSelector = `.product-experience/pdp-1-domain-data/operations.yaml#${selector}`;
    const idempotencyBinding = idempotencyByOperation.get(operationSelector);
    const sourceIdempotency = source.requestIdempotency ?? {};
    if (!idempotencyBinding || !sameShape(idempotencyBinding.sourceRequestIdempotency, sourceIdempotency)
      || idempotencyBinding.unknownOutcomeRule !== UNKNOWN_OUTCOME_RULE) {
      issues.push(fail("IDEMPOTENCY_BINDING_DRIFT", source.id));
    }
    if (!/blind|automatic|new request|unknown.*(?:success|retry|replay)/iu.test(sourceIdempotency.replay ?? "")
      && !sourceIdempotency.replay?.includes("same payload")) {
      issues.push(fail("UNSAFE_OR_UNRESOLVED_REPLAY_SEMANTICS", source.id));
    }
    if (source.requestSchema?.trustedContext?.tenantId !== "authenticated-host-only"
      || source.requestSchema?.trustedContext?.principalId !== "authenticated-host-only") {
      issues.push(fail("SOURCE_TRUSTED_TENANT_CONTEXT_MISSING", source.id));
    }
    const actualRequired = [...new Set(source.requestSchema?.required ?? [])].sort();
    if (JSON.stringify([...record.sourceRequiredProperties].sort()) !== JSON.stringify(actualRequired)) {
      issues.push(fail("SOURCE_REQUIREDNESS_DRIFT", source.id));
    }
    const sourceProperties = source.requestSchema?.properties ?? {};
    const sourceMissingRequired = actualRequired.filter((name) => !Object.hasOwn(sourceProperties, name));
    if (JSON.stringify([...record.ownerCompletedRequiredProperties].sort()) !== JSON.stringify(sourceMissingRequired)) {
      issues.push(fail("OWNER_REQUIREDNESS_REPAIR_DRIFT", source.id));
    }
    const normalizedProperties = record.requestSchema?.properties ?? {};
    for (const propertyName of [...Object.keys(sourceProperties), ...sourceMissingRequired]) {
      if (!Object.hasOwn(normalizedProperties, propertyName)) issues.push(fail("MISSING_NORMALIZED_INPUT", `${source.id}.${propertyName}`));
    }
    if (record.requestSchema?.additionalProperties !== false
      || record.resultSchema?.additionalProperties !== undefined
      || !record.resultSchema?.oneOf?.length
      || record.resultSchema.oneOf.some((branch) => branch.additionalProperties !== false)) {
      issues.push(fail("OPEN_ACTION_ENVELOPE", source.id));
    }
    if (schemaContainsPseudoType(record.requestSchema) || schemaContainsPseudoType(record.resultSchema)) {
      issues.push(fail("UNRESOLVED_SCHEMA_TYPE", source.id));
    }
    const expectedAction = source.actionRef ?? null;
    if (record.actionRef !== expectedAction) issues.push(fail("ACTION_IDENTITY_MISMATCH", source.id));
    if (expectedAction && !actionIds.has(expectedAction)) issues.push(fail("MISSING_SOURCE_ACTION", expectedAction));
    if (expectedAction && record.sourceActionRef !== `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${expectedAction}`) {
      issues.push(fail("ACTION_SOURCE_SELECTOR_MISMATCH", expectedAction));
    }
    if (record.requestSchema?.properties?.operationRef?.const !== source.id) issues.push(fail("REQUEST_OPERATION_NOT_PINNED", source.id));
    const requestProperties = record.requestSchema?.properties ?? {};
    const sourceRequiredProperties = [...new Set(source.requestSchema?.required ?? [])];
    const generatedRequiredProperties = sourceRequiredProperties.filter((name) => !Object.hasOwn(source.requestSchema?.properties ?? {}, name));
    const wireInputProperties = Object.keys(requestProperties).filter((name) => !["operationRef", "actionRef"].includes(name));
    const expectedInputProperties = [...new Set([
      ...Object.keys(source.requestSchema?.properties ?? {}),
      ...generatedRequiredProperties,
    ])].sort();
    if (JSON.stringify(wireInputProperties.sort()) !== JSON.stringify(expectedInputProperties)) {
      issues.push(fail("SOURCE_PROPERTY_SET_DRIFT", source.id));
    }
    for (const [name, sourceSchema] of Object.entries(source.requestSchema?.properties ?? {})) {
      const expectedSchema = normalizeSourceProperty(sourceSchema, {
        actionRef: source.actionRef,
        operationId: source.id,
        propertyName: name,
        scalarTypes: operations.capabilityOperationContracts?.scalarTypes,
      });
    if (!expectedSchema || !sameShape(requestProperties[name], expectedSchema)) {
        issues.push(fail("SOURCE_PROPERTY_SHAPE_DRIFT", `${source.id}.${name}`));
      }
    }
    for (const name of generatedRequiredProperties) {
      const propertySchema = requestProperties[name];
      const expectedCompletionSchema = OWNER_COMPLETION_SCHEMAS[name];
      if (!expectedCompletionSchema || !sameShape(propertySchema, expectedCompletionSchema)
        || schemaContainsPseudoType(propertySchema)) {
        issues.push(fail("UNRESOLVED_OWNER_COMPLETION", `${source.id}.${name}`));
      }
    }
    const wireRequired = [...new Set(record.requestSchema?.required ?? [])].sort();
    const expectedRequired = [...new Set(["operationRef", ...(source.actionRef ? ["actionRef"] : []), ...sourceRequiredProperties])].sort();
    if (JSON.stringify(wireRequired) !== JSON.stringify(expectedRequired)) {
      issues.push(fail("SOURCE_REQUIREDNESS_DRIFT", source.id));
    }
    const sourceFields = [...new Set(source.resultSchema?.fields ?? [])].sort();
    if (source.requestSchema && (!sourceFields.length || !sameShape([...(record.semantics?.sourceDeclaredResultFields ?? [])].sort(), sourceFields))) {
      issues.push(fail("SOURCE_RESULT_FIELDS_DRIFT", source.id));
    }
    const resultProjection = resultProjectionByOperation.get(operationSelector);
    const normalizedSuccess = record.resultSchema?.oneOf?.[0];
    const normalizedFields = Object.keys(normalizedSuccess?.properties ?? {})
      .filter((name) => !["operationRef", "actionRef", "outcome"].includes(name)).sort();
    const declaredFields = [...sourceFields].sort();
    const expectedFieldMappings = declaredFields.map((sourceField) => ({
      sourceField,
      wireField: normalizedFields.includes(sourceField) ? sourceField : null,
      disposition: normalizedFields.includes(sourceField) ? "NAME_MATCH_ONLY" : "NOT_EXPOSED_IN_NORMALIZED_BRANCH",
    }));
    const expectedWireOnlyFields = normalizedFields.filter((field) => !declaredFields.includes(field));
    if (!resultProjection
      || resultProjection.sourceResultSchemaRef !== `${operationSelector}/resultSchema`
      || resultProjection.wireSuccessBranchRef !== `.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#records/@id=${record.id}/resultSchema/oneOf/0`
      || resultProjection.mappingStatus !== RESULT_PROJECTION_RULE
      || !sameShape(resultProjection.sourceDeclaredFields, declaredFields)
      || !sameShape(resultProjection.normalizedSuccessFields, normalizedFields)
      || !sameShape(resultProjection.sourceFieldMappings, expectedFieldMappings)
      || !sameShape(resultProjection.normalizedOnlyFields, expectedWireOnlyFields)) {
      issues.push(fail("RESULT_PROJECTION_BINDING_DRIFT", source.id));
    }
    const outcomeBranches = (record.resultSchema?.oneOf ?? []).map((branch) => branch.properties?.outcome).filter(Boolean);
    const outcomeConstants = outcomeBranches.flatMap((branch) => branch.const ? [branch.const] : branch.enum ?? []);
    const expectedSuccess = source.resultSchema?.successOutcome
      ?? (source.operationKind === "QUERY" ? "OBSERVED" : "ACKNOWLEDGED");
    const failedBranch = record.resultSchema?.oneOf?.find((branch) => branch.properties?.outcome?.enum);
    if (source.requestSchema && (record.resultSchema?.oneOf?.[0]?.properties?.outcome?.const !== expectedSuccess
      || !outcomeConstants.includes("UNKNOWN") || outcomeBranches.some((branch) => branch.const === "UNKNOWN"))) {
      issues.push(fail("UNKNOWN_OR_DENIED_BRANCH_MISSING", source.id));
    }
    const errorProfileId = source.errorSchemaRef?.match(/^([^#]+)#errors$/u)?.[1];
    const errorProfile = (operations.ownerDefinedOperationProfiles?.profiles ?? []).find((profile) => profile.id === errorProfileId);
    if (source.requestSchema && (!errorProfile?.errors?.length || !failedBranch?.properties?.reasonCode
      || failedBranch.properties.reasonCode.type !== "string" || !record.sourceRecovery || !record.semantics?.unknownIsNotSuccess)) {
      issues.push(fail("SOURCE_ERROR_OR_RECOVERY_MEANING_MISSING", source.id));
    }
    if (source.requestSchema && source.operationKind !== "QUERY"
      && (!["scope", "fingerprint", "replay"].every((key) => typeof source.requestIdempotency?.[key] === "string" && source.requestIdempotency[key].length > 0)
        || !source.sourceFinality || !record.sourceFinality)) {
      issues.push(fail("SOURCE_RETRY_OR_FINALITY_MEANING_MISSING", source.id));
    }
    if (source.operationKind === "QUERY" && record.semantics?.effectKind !== "READ_ONLY_OBSERVATION") issues.push(fail("QUERY_MUTATION_CONFUSION", source.id));
    if (source.operationKind !== "QUERY" && record.semantics?.effectKind === "READ_ONLY_OBSERVATION") issues.push(fail("MUTATION_QUERY_CONFUSION", source.id));
    if (record.semantics?.runtimeAdmission !== "NOT_ADMITTED" || record.semantics?.unknownIsNotSuccess !== true) {
      issues.push(fail("ADMISSION_OR_UNKNOWN_POLICY", source.id));
    }
    if (source.actionRef) {
      const action = actionRows.find((row) => row.id === source.actionRef);
      const actorBinding = actorBindingByAction.get(`.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${source.actionRef}`);
      const expectedRecovery = source.sourceRecovery ?? action?.recovery ?? action?.failure;
      if (!action || action.actionDefinitionSemantics?.typedDefinition?.operationRef !== source.id
        || record.actionRef !== action.id || record.sourceEffect !== action.effect || record.sourceFinality !== action.finality) {
        issues.push(fail("ACTION_OPERATION_CONSUMER_LINK_DRIFT", source.id));
      }
      if (!sameShape(record.sourceGuards, action?.preconditions)
        || (expectedRecovery !== undefined && record.sourceRecovery !== expectedRecovery)) {
        issues.push(fail("ACTION_GUARD_OR_RECOVERY_DRIFT", source.id));
      }
      if (!actorBinding || actorBinding.actionRef !== source.actionRef
        || actorBinding.authorityDisposition !== "APPLICABILITY_ONLY; role labels never grant tenant or principal authority"
        || !sameShape(actorBinding.actorRefs, action?.actorRefs ?? [])) {
        issues.push(fail("ACTION_ACTOR_BINDING_DRIFT", source.id));
      }
    }
  }

  if (idempotencyBindings.length !== 79 || idempotencyByOperation.size !== idempotencyBindings.length) {
    issues.push(fail("IDEMPOTENCY_BINDING_POPULATION", `expected 79 unique source operation/read bindings; got ${idempotencyBindings.length}`));
  }
  if (resultProjectionBindings.length !== 79 || resultProjectionByOperation.size !== resultProjectionBindings.length) {
    issues.push(fail("RESULT_PROJECTION_POPULATION", `expected 79 unique result projections; got ${resultProjectionBindings.length}`));
  }
  if (actorBindings.length !== 78 || actorBindingByAction.size !== actorBindings.length) {
    issues.push(fail("ACTOR_BINDING_POPULATION", `expected 78 unique action actor bindings; got ${actorBindings.length}`));
  }

  const cancellation = catalog.relatedOperationCoverage?.find((entry) => entry.actionRef === "media.action.request-cancellation");
  const cancellationOperation = operations.individualOperationContracts?.records?.find((row) => row.id === "media.operation-slice.cancel-job");
  const cancellationAction = actionRows.find((row) => row.id === "media.action.request-cancellation");
  const expectedCancellationNegativeCases = cancellationOperation?.ownerDefinition?.negativeCases ?? [];
  if (catalog.relatedOperationCoverage?.length !== 1 || !cancellationOperation || !cancellationAction
    || cancellation?.operationRef !== cancellationOperation.id
    || cancellation?.sourceOperationRef !== `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=${cancellationOperation.id}`
    || cancellation?.sourceOwnerDefinitionRef !== `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=${cancellationOperation.id}/ownerDefinition`
    || cancellation?.sourceActionRef !== `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${cancellationAction.id}`
    || !sameShape(cancellation?.actorRefs, cancellationAction.actorRefs)
    || !sameShape(cancellation?.negativeCases, expectedCancellationNegativeCases)
    || cancellation?.requestedMeaning !== CANCELLATION_REQUESTED_MEANING
    || cancellation?.confirmedStopMeaning !== CANCELLATION_CONFIRMED_STOP_MEANING
    || cancellation?.unknownMeaning !== CANCELLATION_UNKNOWN_MEANING
    || cancellation?.noReversalMeaning !== CANCELLATION_NO_REVERSAL_MEANING
    || !cancellationOperation.ownerDefinition?.idempotency?.includes(cancellation?.idempotency ?? "\u0000")
    || !cancellationOperation.ownerDefinition?.retry?.includes(cancellation?.retry ?? "\u0000")) {
    issues.push(fail("CANCELLATION_SEMANTICS_COVERAGE_DRIFT", "media.operation-slice.cancel-job"));
  }

  for (const record of records) {
    if (!record.id || !record.id.startsWith("media.owner-action-wire.") || !record.id.endsWith(".v1")) issues.push(fail("INVALID_STABLE_ID", record.id));
    if (!bySourceOperation.has(record.sourceOperationRef)) issues.push(fail("FOREIGN_SOURCE_OPERATION", record.sourceOperationRef));
    if (record.actionRef && byAction.get(record.actionRef) !== record) issues.push(fail("DUPLICATE_ACTION_BINDING", record.actionRef));
    if (!record.requestAuthority || record.requestAuthority.tenantId !== "HOST_AUTHENTICATED_ONLY" || record.requestAuthority.principalId !== "HOST_AUTHENTICATED_ONLY") {
      issues.push(fail("CALLER_AUTHORITY_LEAK", record.id));
    }
  }
  if (bySourceOperation.size !== records.length) issues.push(fail("DUPLICATE_SOURCE_OPERATION_BINDING", "normalized source operation selectors must be unique"));
  return { valid: issues.length === 0, issues };
}
