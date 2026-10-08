/** Validate only the three owner-reviewed, principal-scoped Media read slices.
 * Family status never admits an individual contract or a production identity host. */
const READS = {
  'media.operation-slice.inspect-upload': ['upload', 'getMediaUpload', 'UPLOAD_NOT_FOUND', 'UploadSession'],
  'media.operation-slice.inspect-artifact': ['artifact', 'getMediaArtifact', 'ARTIFACT_NOT_FOUND', 'MediaArtifact'],
  'media.operation-slice.inspect-job': ['job', 'getMediaJob', 'JOB_NOT_FOUND', 'ProcessingJob'],
};

export function validateCanonicalMediaReads({ operations, openapi, runtimeSource, handlerSource }) {
  const errors = [];
  const records = operations?.individualOperationContracts?.records ?? [];
  for (const [id, [resource, operationId, errorCode, resultType]] of Object.entries(READS)) {
    const matches = records.filter(record => record.id === id);
    if (matches.length !== 1) { errors.push(`${id}: expected one exact contract`); continue; }
    const record = matches[0];
    const binding = record.wireBinding;
    const semantics = record.readSemantics;
    if (record.operationKind !== 'QUERY' || record.contractVersion !== 1
      || record.resourceScope !== 'tenant-and-owning-principal') errors.push(`${id}: invalid query scope/version`);
    if (record.ownerDecisionRef !== '.product-experience/decision-log.md#PXD-040'
      || !record.status?.startsWith('accepted-bounded-read-semantics;')) errors.push(`${id}: missing exact owner disposition`);
    if (JSON.stringify(record.requestFields) !== JSON.stringify(['tenantId', 'principalId', `${resource}Id`]))
      errors.push(`${id}: missing tenant/principal/resource context`);
    if (binding?.method !== 'GET' || binding.operationId !== operationId || binding.successStatus !== 200
      || binding.absentOrInaccessibleStatus !== 404 || binding.absentOrInaccessibleCode !== errorCode)
      errors.push(`${id}: invalid wire/status binding`);
    if (semantics?.mutatesDomainState !== false || semantics?.rightsImplication !== 'none; metadata-read-does-not-authorize-bytes-processing-or-delivery'
      || semantics?.noResultMeaning !== 'absent-in-caller-scope; never-global-nonexistence-or-no-prior-effect')
      errors.push(`${id}: unsafe mutation/rights/absence semantics`);
    if (!record.executionAdmission?.startsWith('LOCAL_CONTRACT_TESTS_ONLY;')) errors.push(`${id}: unqualified production admission`);
    const path = `/api/v1/${resource === 'upload' ? 'artifacts/uploads' : resource === 'artifact' ? 'artifacts' : 'jobs'}/{${resource}Id}`;
    const wire = openapi?.paths?.[path]?.get;
    if (wire?.operationId !== operationId || !wire.responses?.['200'] || !wire.responses?.['404'])
      errors.push(`${id}: OpenAPI source identity or responses drifted`);
    const runtimeSignature = `public Optional<${resultType}> ${resource}(String tenantId, String principalId, String ${resource}Id)`;
    const runtimeBody = runtimeSource.split(runtimeSignature)[1]?.split('\n    }')[0];
    const storeRead = resource === 'job' ? 'jobStore.find' : `artifactStore.${resource}`;
    if (!runtimeBody?.includes(`return ${storeRead}(tenantId, ${resource}Id)`)
      || !runtimeBody.includes('ensureOpen();') || !runtimeBody.includes('requirePrincipal(principalId);')
      || !runtimeBody?.includes('.principalId().equals(principalId)')) errors.push(`${id}: principal-scoped runtime guard missing`);
    const handlerBody = handlerSource.split(`private void ${resource}(HttpExchange exchange, String tenantId, String principalId, String ${resource}Id)`)[1]?.split('\n    }')[0];
    if (!handlerBody?.includes(`runtime.${resource}(tenantId, principalId, ${resource}Id)`)
      || !handlerBody?.includes(`error(exchange, 404, "${errorCode}"`)
      || !handlerBody?.includes('json(exchange, 200,')) errors.push(`${id}: handler scope/status drifted`);
  }
  return errors;
}
