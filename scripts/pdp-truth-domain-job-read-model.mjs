/**
 * Definition-only oracle for the Media stored-job read projection.
 * This validates owner semantics; it is not a runtime store, endpoint, or qualification claim.
 */
export function validateMediaJobReadProjection({ job, readObservation, providerReconciliation } = {}, ownerWireSchema) {
  const violations = [];
  if (!job || typeof job !== "object") return ["JOB_RECORD_REQUIRED"];
  if (!readObservation || typeof readObservation !== "object") return ["READ_OBSERVATION_REQUIRED"];
  if (!ownerWireSchema || !Array.isArray(ownerWireSchema.statusMappings?.mappings)) return ["OWNER_STATUS_MAPPING_REQUIRED"];
  if (readObservation.tenantId !== job.tenantId) violations.push("TENANT_SCOPE_MISMATCH");
  if (readObservation.principalId !== job.principalId) violations.push("OWNER_SCOPE_MISMATCH");
  if (readObservation.readVersion !== job.version) violations.push("READ_VERSION_MISMATCH");
  if (readObservation.canonicalStateMapping?.sourceStatus !== job.status) violations.push("SOURCE_STATUS_MAPPING_MISMATCH");
  const mapping = ownerWireSchema.statusMappings.mappings.find(({ sourceStatus }) => sourceStatus === job.status);
  if (!mapping) {
    violations.push("UNRECOGNIZED_RUNTIME_STATUS");
  } else {
    const observed = readObservation.canonicalStateMapping;
    for (const field of ["sourceStatus", "disposition", "reason", "canonicalStateRef"]) {
      if ((mapping[field] ?? null) !== (observed?.[field] ?? null)) violations.push(`CANONICAL_MAPPING_${field.toUpperCase()}_MISMATCH`);
    }
    if (readObservation.effectFinality !== ownerWireSchema.finalityByRuntimeStatus?.[job.status]) {
      violations.push("EFFECT_FINALITY_STATUS_MISMATCH");
    }
  }
  if (providerReconciliation !== undefined && providerReconciliation !== "NOT_PERFORMED_BY_STORED_JOB_READ") {
    violations.push("STORED_READ_CANNOT_CLAIM_PROVIDER_RECONCILIATION");
  }
  return violations;
}
