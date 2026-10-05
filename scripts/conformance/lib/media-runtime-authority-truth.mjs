export function validateMediaRuntimeAuthorityTruth({
  launcherSource, runtimeSource, contractsSource,
  consentAdministrationContractSource = '', privacyMaintenanceContractSource = '',
  metadataSanitizerSource = '', resultSanitizerSource = '', localSource, httpSource,
  consentAdministrationRuntimeSource = '', privacyMaintenanceRuntimeSource = '',
  semanticRedactionRuntimeSource = '', artifactProviderSource = '', jobStoreSource = '',
  streamStoreSource = '', consentAuthorityProviderSource = '',
  consentAdministrationProviderSource = '', privacyMaintenanceProviderSource = '',
  processingProviderSource = '', streamingProviderSource = '',
  cancellationTruthMigrationSource = '', cancellationTruthIntegrationTestSource = '',
  providerBuildSource = '', javaRoutesSource, routeManifest, openApiSource, sourceOverlay,
  registryOverlay, obsoleteHealthHandlerPresent = false, obsoleteLauncherContractsPresent = false,
}) {
  const errors = [];
  require(errors, 'launcher', launcherSource, [
    'MediaRuntime.compose(environment)', 'MediaHttpHandler', 'MediaSecurityFilter',
    'MediaPrivacyMaintenanceRuntime.compose(environment)',
    'MediaConsentAdministrationRuntime.compose(environment)',
    'ServiceLauncherSupport.startHttpService', 'runtime.close()',
  ]);
  if (/HealthHttpHandler|MediaHealthHandler/.test(launcherSource)) {
    errors.push('Media launcher must not start a health-only runtime');
  }
  require(errors, 'runtime', runtimeSource, [
    'ServiceLoader.load(MediaProcessingProvider.class)',
    'ServiceLoader.load(MediaStreamingProvider.class)',
    'ServiceLoader.load(MediaConsentAuthority.class)',
    'selectConsentAuthority(', 'consentFor(', 'refreshConsent(',
    'MediaSemanticRedactionRuntime.compose(', 'semanticRedaction.promoteIfRequested(',
    'MediaSemanticRedactionRuntime.promotionRequested(request)', 'SEMANTIC_REDACTION_FAILED',
    'semanticRedactionProviderId', 'semanticRedactionReady',
    'MediaArtifactStore', 'MediaJobStore', 'MediaStreamSessionStore',
    'beginUpload', 'appendChunk', 'completeUpload', 'selectProcessingProvider',
    'openStream', 'connectStream', 'acceptFrame', 'closeStream',
    'orTimeout(config.jobTimeout()', 'Semaphore', 'connectionToken()',
    'tokenMatches', 'maximumBufferedBytes', 'null future',
    'raw.copy()', 'raw.cancel(true)', 'providerFuture.cancel(true)', 'PROCESSING_TIMEOUT',
    'cancelTimedOutStreamFrame(control, future)',
    'External Media processing requires a ready consent authority',
    'governance.consentId', 'consentAuthorityReady',
  ]);
  require(errors, 'contracts', contractsSource, [
    'UploadRequest', 'UploadSession', 'MediaArtifact', 'ProcessingJobRequest',
    'StreamSessionRequest', 'StreamSessionRegistration', 'StreamFrame', 'StreamAck',
    'MediaArtifactStore', 'MediaJobStore', 'MediaStreamSessionStore',
    'MediaProcessingProvider', 'MediaStreamingProvider', 'MediaConsentAuthority',
    'MediaGovernanceContext', 'ConsentDecision', 'ProcessingBoundary',
    'MediaSemanticRedactionProvider', 'SemanticRedactionRequest', 'SemanticRedactionResult',
    'ResultClassification', 'safeForPromotion', 'policyVersion', 'redactionCategories',
    'externalProcessingAllowed', 'biometricProcessingAllowed', 'allowedRegions',
    'expectedSha256', 'classification', 'retention', 'leaseDuration',
    'CancellationOutcome { CONFIRMED, REQUESTED_UNCONFIRMED, UNSUPPORTED }',
  ]);
  require(errors, 'consent administration contract', consentAdministrationContractSource, [
    'interface MediaConsentAdministration', 'ConsentRecord grant(GrantRequest request)',
    'Optional<ConsentRecord> revoke', 'tenantId', 'principalId', 'correlationId',
  ]);
  require(errors, 'privacy maintenance contract', privacyMaintenanceContractSource, [
    'interface MediaPrivacyMaintenance', 'PurgeReport purgeExpired', 'productionEligible()',
  ]);
  require(errors, 'metadata sanitizer', metadataSanitizerSource, [
    'MediaMetadataSanitizer', 'sanitize', 'gps', 'authorization',
  ]);
  require(errors, 'result sanitizer', resultSanitizerSource, [
    'MediaJobResultSanitizer', 'privacyRedactedFields', 'voiceprint', 'biometricvector',
    'normalized.equals("token")',
  ]);
  require(errors, 'consent administration runtime', consentAdministrationRuntimeSource, [
    'ServiceLoader.load(MediaConsentAdministration.class)',
    'Production Media Runtime requires a ready consent-administration provider',
    'productionEligible()',
  ]);
  require(errors, 'privacy maintenance runtime', privacyMaintenanceRuntimeSource, [
    'ServiceLoader.load(MediaPrivacyMaintenance.class)',
    'runCycle(true)', 'scheduleWithFixedDelay',
    'Production Media Runtime requires a ready physical privacy-maintenance authority',
  ]);
  require(errors, 'semantic redaction runtime', semanticRedactionRuntimeSource, [
    'promotionTier', 'DEIDENTIFIED', 'MediaJobResultSanitizer.sanitize',
    'SemanticRedactionRequest', 'safeForPromotion()',
    'Semantic redaction provider returned mismatched provider identity',
    'Semantic transcript redaction cannot use an external provider',
  ]);
  require(errors, 'local support', localSource, [
    'Expected chunk index', 'Upload checksum does not match expected SHA-256',
    'requestedRetention', 'safeResolve', 'local-diagnostic', 'rawMediaRead',
    'local-stream-store', 'Invalid media stream connection token',
    'ProcessingBoundary.LOCAL',
  ]);
  require(errors, 'artifact provider', artifactProviderSource, [
    'S3PostgresqlMediaArtifactStore', 'FINALIZING', 'finalization_token',
    'createMultipartUpload', 'completeMultipartUpload', 'abortMultipartUpload',
    'ServerSideEncryption.AES256', 'expectedSha256', 'MessageDigest',
    'media_upload_chunks', 'media_artifacts', 'opaque(tenantId)',
    'Media artifact byte identity conflicts with governed metadata',
    'existing.fileName().equals(requested.fileName())',
    'existing.contentType().equals(requested.contentType())',
    'existing.classification().equals(requested.classification())',
    'existing.metadata().equals(requested.metadata())',
    'DEDUP_RETENTION_TOLERANCE_MILLIS',
    'connection.setSavepoint("media_artifact_deduplication")',
    'connection.rollback(deduplicationSavepoint)',
    'duplicateKey(failure)',
    '"23505".equals(failure.getSQLState())',
  ]);
  require(errors, 'job store', jobStoreSource, [
    'PostgresqlMediaJobStore', 'media_processing_jobs', 'request_id',
    'version=?', 'Media request ID was reused for a different job',
    'MediaJobResultSanitizer.sanitize',
  ]);
  require(errors, 'Media cancellation truth migration', cancellationTruthMigrationSource, [
    'media_job_cancelled_requires_confirmation',
    "status = 'CANCELLED'",
    "'CANCELLED_UNCONFIRMED'",
    "'CANCELLATION_REQUESTED_UNCONFIRMED'",
    "'CANCELLATION_UNSUPPORTED'",
  ]);
  require(errors, 'Media cancellation truth integration test', cancellationTruthIntegrationTestSource, [
    'migrationRejectsUnconfirmedCancellationAsTerminalTruth',
    'REQUESTED_UNCONFIRMED',
    'CANCELLED_UNCONFIRMED',
    'isInstanceOf(SQLException.class)',
  ]);
  require(errors, 'stream store', streamStoreSource, [
    'PostgresqlMediaStreamSessionStore', 'connection_token_hash',
    'lease_expires_at', 'last_sequence', 'maximum_buffered_bytes',
    'MessageDigest.isEqual', 'Invalid Media stream transition',
    'lease is absent or expired', 'must be connected before accepting frames',
  ]);
  require(errors, 'consent authority provider', consentAuthorityProviderSource, [
    'PostgresqlMediaConsentAuthority', 'media_consents', 'revoked_at',
    'principal_id', 'ConsentDecision.unverified()',
  ]);
  require(errors, 'consent administration provider', consentAdministrationProviderSource, [
    'PostgresqlMediaConsentAdministration', 'media_consents',
    'MEDIA_CONSENT_GRANTED', 'MEDIA_CONSENT_REVOKED', 'version',
  ]);
  require(errors, 'privacy maintenance provider', privacyMaintenanceProviderSource, [
    'PostgresqlMediaPrivacyMaintenance', 'purgeExpired', 'DeleteObjectRequest',
    'media_artifacts', 'media_upload_sessions', 'media_processing_jobs', 'media_stream_sessions',
  ]);
  require(errors, 'processing provider', processingProviderSource, [
    'HttpMediaProcessingProvider', 'MediaExternalDisclosureSanitizer.artifact', 'X-Tenant-Id',
    'X-Correlation-Id', 'productionEligible()', 'ProcessingBoundary.EXTERNAL',
    'externalProcessingAllowed()', 'permitsRegion', 'consentDecision().activeAt',
    'biometricProcessingAllowed()', 'CancellationOutcome.REQUESTED_UNCONFIRMED',
  ]);
  require(errors, 'streaming provider', streamingProviderSource, [
    'HttpMediaStreamingProvider', 'acceptedSequence', 'bufferedBytes',
    'X-End-Of-Stream', 'closeSession', 'ProcessingBoundary.EXTERNAL',
    'externalProcessingAllowed()', 'permitsRegion', 'consentDecision().activeAt',
  ]);
  require(errors, 'provider build', providerBuildSource, [
    ':services:media:runtime-contracts', 'libs.aws.s3', 'libs.flyway.postgresql',
  ]);
  require(errors, 'HTTP handler', httpSource, [
    '/api/v1/consents', 'MediaConsentAdministration', 'grantConsent(', 'revokeConsent(',
    'MediaMetadataSanitizer.sanitize', '/api/v1/artifacts/uploads', '/chunks/', '/complete',
    '/api/v1/jobs', '/cancel', '/api/v1/streams', '/connect', '/frames/', '/close',
    '/api/v1/providers', 'X-Tenant-Id', 'X-Principal-Id', 'X-Stream-Token',
    'maximumChunkBytes()', 'maximumBodyBytes()',
  ]);

  forbid(errors, 'runtime', runtimeSource, [
    'new ConsentDecision(true',
    'ConsentDecision(true, "caller"',
  ]);
  forbid(errors, 'processing provider', processingProviderSource, ['ProcessingBoundary.LOCAL']);
  forbid(errors, 'streaming provider', streamingProviderSource, ['ProcessingBoundary.LOCAL']);
  forbid(errors, 'semantic redaction runtime', semanticRedactionRuntimeSource, [
    'safeForPromotion = true',
    'ResultClassification.DEIDENTIFIED; // trust caller',
  ]);

  const expected = new Set([
    'GET /health','GET /health/live','GET /health/ready','GET /health/startup',
    'GET /ready','GET /metrics','GET /info','GET /api/v1/health',
    'POST /api/v1/consents','GET /api/v1/consents',
    'GET /api/v1/consents/{consentId}','DELETE /api/v1/consents/{consentId}',
    'POST /api/v1/artifacts/uploads','GET /api/v1/artifacts/uploads/{uploadId}',
    'PUT /api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}',
    'POST /api/v1/artifacts/uploads/{uploadId}/complete',
    'GET /api/v1/artifacts/{artifactId}','POST /api/v1/jobs','GET /api/v1/jobs',
    'GET /api/v1/jobs/{jobId}','POST /api/v1/jobs/{jobId}/cancel',
    'POST /api/v1/streams','GET /api/v1/streams/{sessionId}',
    'POST /api/v1/streams/{sessionId}/connect',
    'POST /api/v1/streams/{sessionId}/frames/{sequence}',
    'POST /api/v1/streams/{sessionId}/close','GET /api/v1/providers',
  ]);
  const actual = new Set((routeManifest?.routes ?? []).map(route => `${route.method} ${route.path}`));
  if (actual.size !== expected.size || [...expected].some(route => !actual.has(route))) {
    errors.push('Media JSON route manifest must contain exactly the executable route set');
  }
  for (const route of expected) {
    const [method,path] = route.split(' ');
    if (!javaRoutesSource.includes(`\"${method}\", \"${path}\"`)) errors.push(`Media Java routes missing ${route}`);
    if (!openApiSource.includes(`  ${path}:`)) errors.push(`Media OpenAPI missing ${path}`);
  }
  if (!openApiSource.includes('version: 1.3.0')) errors.push('Media OpenAPI must expose version 1.3.0');
  if (!openApiSource.includes('ConsentGrantRequest') || !openApiSource.includes('ConsentRecord')) {
    errors.push('Media OpenAPI must expose typed consent schemas');
  }
  if (!openApiSource.includes('promotionTier') || !openApiSource.includes('DEIDENTIFIED')) {
    errors.push('Media OpenAPI must expose fail-closed de-identification promotion intent');
  }
  validateSource(errors, sourceOverlay);
  validateRegistry(errors, registryOverlay);
  const modules = new Set(registryOverlay?.addGradleModules ?? []);
  for (const module of [':services:media:runtime-contracts', ':services:media:providers:aws-postgresql']) {
    if (!modules.has(module)) errors.push(`Media registry overlay missing ${module}`);
  }
  if (obsoleteHealthHandlerPresent) errors.push('MediaHealthHandler must remain removed');
  if (obsoleteLauncherContractsPresent) errors.push('Launcher-owned MediaRuntimeContracts must remain removed');
  return errors;
}

function validateSource(errors, overlay) {
  if (overlay?.overlayKind !== 'service-contract-source' || overlay?.serviceId !== 'media') {
    errors.push('Media source overlay must declare service-owned authority'); return;
  }
  const state = overlay.patch?.currentState ?? {};
  if (state.implementationStatus !== 'implemented' || state.runtimeStatus !== 'active'
      || state.readiness !== 'internal-preview') {
    errors.push('Media effective state must be implemented, active, and internal-preview');
  }
  const dependencies = overlay.patch?.dependencyHealth?.dependencies ?? {};
  for (const id of ['data-cloud','ai-inference']) {
    if (dependencies[id]?.required !== false) errors.push(`${id} must be an optional Media capability dependency`);
  }
  for (const id of ['MEDIA-RUNTIME-001','MEDIA-UPLOAD-001','MEDIA-STREAM-001','MEDIA-PRIVACY-001','MEDIA-CONTRACT-001']) {
    const requirement = (overlay.patch?.requirements ?? []).find(candidate => candidate.id === id);
    if (!requirement || requirement.status !== 'implemented'
        || (requirement.staticBlockers ?? []).length !== 0) {
      errors.push(`Media requirement ${id} must be implemented without static blockers`);
    }
  }
  const implRefs = (overlay.patch?.requirements ?? []).flatMap(req => req.implementationRefs ?? []);
  for (const suffix of [
    'S3PostgresqlMediaArtifactStore.java', 'PostgresqlMediaJobStore.java',
    'PostgresqlMediaStreamSessionStore.java', 'PostgresqlMediaConsentAuthority.java',
    'PostgresqlMediaConsentAdministration.java', 'PostgresqlMediaPrivacyMaintenance.java',
    'MediaSemanticRedactionRuntime.java', 'HttpMediaProcessingProvider.java',
    'HttpMediaStreamingProvider.java',
  ]) {
    if (!implRefs.some(ref => ref.endsWith(suffix))) errors.push(`Media source authority must reference ${suffix}`);
  }
}
function validateRegistry(errors, overlay) {
  if (overlay?.overlayKind !== 'runtime-service-registry' || overlay?.serviceId !== 'media') {
    errors.push('Media registry overlay must declare service-owned authority'); return;
  }
  const conformance = overlay.patch?.conformance ?? {};
  if (conformance.implementationStatus !== 'implemented'
      || conformance.runtimeExecutionReady !== true || conformance.runtimeStatus !== 'active') {
    errors.push('Media registry must expose an active executable runtime');
  }
  if (conformance.productionProfileAllowed !== false) errors.push('Media production profile must remain evidence-gated');
  if (overlay.patch?.lifecycleExecutionAllowed !== true) errors.push('Media lifecycle execution must be enabled');
}
function require(errors, owner, source, tokens) {
  for (const token of tokens) if (!source.includes(token)) errors.push(`${owner} missing ${token}`);
}
function forbid(errors, owner, source, tokens) {
  for (const token of tokens) if (source.includes(token)) errors.push(`${owner} retains forbidden token ${token}`);
}
