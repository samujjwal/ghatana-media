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

  if (actionOwnerOps.length !== 79) issues.push(fail("SOURCE_POPULATION", `expected 79 action operations; got ${actionOwnerOps.length}`));
  if (records.length !== 79) issues.push(fail("CONTRACT_POPULATION", `expected 79 normalized records; got ${records.length}`));
  if (identities.filter((row) => row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY").length !== 37) {
    issues.push(fail("IDENTITY_POPULATION", "expected exactly 37 registered canonical Media identity tuples"));
  }
  if (canonicalIdentityIds.has("media.domain.persisted-audio-file")) {
    issues.push(fail("SOURCE_OBSERVATION_PROMOTED", "persisted-audio-file is a source observation, not a canonical identity"));
  }

  for (const identity of catalog.canonicalIdentityTypes ?? []) {
    const source = identities.find((row) => row.objectRef === identity.objectRef && row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY");
    if (!source || identity.identityContractRef !== `.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=${source.id}`
      || JSON.stringify(identity.identityTuple) !== JSON.stringify(source.canonicalIdentityTuple)) {
      issues.push(fail("IDENTITY_SOURCE_MISMATCH", identity.objectRef));
    }
  }
  if ((catalog.canonicalIdentityTypes ?? []).length !== 37) issues.push(fail("IDENTITY_TYPE_POPULATION", "canonicalIdentityTypes must enumerate all 37 source identities exactly once"));

  for (const source of actionOwnerOps) {
    const selector = sourceOperationSelector(operations, source.id);
    const record = records.find((candidate) => candidate.sourceOperationRef === `${
      source.id === source.id ? ".product-experience/pdp-1-domain-data/operations.yaml#" : ""
    }${selector}`);
    if (!record) {
      issues.push(fail("MISSING_SOURCE_OPERATION_BINDING", source.id));
      continue;
    }
    if (record.operationKind !== source.operationKind || record.sourceEffect !== source.sourceEffect || record.sourceFinality !== source.sourceFinality) {
      issues.push(fail("SOURCE_SEMANTICS_DRIFT", source.id));
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
    if (record.requestSchema?.additionalProperties !== false || record.resultSchema?.additionalProperties !== false) {
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
    if (source.operationKind === "QUERY" && record.semantics?.effectKind !== "READ_ONLY_OBSERVATION") issues.push(fail("QUERY_MUTATION_CONFUSION", source.id));
    if (source.operationKind !== "QUERY" && record.semantics?.effectKind === "READ_ONLY_OBSERVATION") issues.push(fail("MUTATION_QUERY_CONFUSION", source.id));
    if (record.semantics?.runtimeAdmission !== "NOT_ADMITTED" || record.semantics?.unknownIsNotSuccess !== true) {
      issues.push(fail("ADMISSION_OR_UNKNOWN_POLICY", source.id));
    }
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
