import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMediaRuntimeAuthorityTruth } from '../lib/media-runtime-authority-truth.mjs';

function fixture() {
  const routes = [
    ['GET','/health'],['GET','/health/live'],['GET','/health/ready'],['GET','/health/startup'],
    ['GET','/ready'],['GET','/metrics'],['GET','/info'],['GET','/api/v1/health'],
    ['POST','/api/v1/consents'],['GET','/api/v1/consents'],
    ['GET','/api/v1/consents/{consentId}'],['DELETE','/api/v1/consents/{consentId}'],
    ['POST','/api/v1/artifacts/uploads'],['GET','/api/v1/artifacts/uploads/{uploadId}'],
    ['PUT','/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}'],
    ['POST','/api/v1/artifacts/uploads/{uploadId}/complete'],['GET','/api/v1/artifacts/{artifactId}'],
    ['POST','/api/v1/jobs'],['GET','/api/v1/jobs'],['GET','/api/v1/jobs/{jobId}'],
    ['POST','/api/v1/jobs/{jobId}/cancel'],
    ['POST','/api/v1/streams'],['GET','/api/v1/streams/{sessionId}'],
    ['POST','/api/v1/streams/{sessionId}/connect'],
    ['POST','/api/v1/streams/{sessionId}/frames/{sequence}'],
    ['POST','/api/v1/streams/{sessionId}/close'],['GET','/api/v1/providers'],
  ];
  return {
    launcherSource:'MediaRuntime.compose(environment) MediaPrivacyMaintenanceRuntime.compose(environment) MediaConsentAdministrationRuntime.compose(environment) MediaHttpHandler MediaSecurityFilter ServiceLauncherSupport.startHttpService runtime.close()',
    runtimeSource:'ServiceLoader.load(MediaProcessingProvider.class) ServiceLoader.load(MediaStreamingProvider.class) ServiceLoader.load(MediaConsentAuthority.class) selectConsentAuthority( consentFor( refreshConsent( MediaSemanticRedactionRuntime.compose( semanticRedaction.promoteIfRequested( MediaSemanticRedactionRuntime.promotionRequested(request) SEMANTIC_REDACTION_FAILED semanticRedactionProviderId semanticRedactionReady MediaArtifactStore MediaJobStore MediaStreamSessionStore beginUpload appendChunk completeUpload selectProcessingProvider openStream connectStream acceptFrame closeStream orTimeout(config.jobTimeout() Semaphore connectionToken() tokenMatches maximumBufferedBytes null future raw.copy() raw.cancel(true) providerFuture.cancel(true) PROCESSING_TIMEOUT cancelTimedOutStreamFrame(control, future) External Media processing requires a ready consent authority governance.consentId consentAuthorityReady',
    contractsSource:'UploadRequest UploadSession MediaArtifact ProcessingJobRequest StreamSessionRequest StreamSessionRegistration StreamFrame StreamAck MediaArtifactStore MediaJobStore MediaStreamSessionStore MediaProcessingProvider MediaStreamingProvider MediaConsentAuthority MediaGovernanceContext ConsentDecision ProcessingBoundary MediaSemanticRedactionProvider SemanticRedactionRequest SemanticRedactionResult ResultClassification safeForPromotion policyVersion redactionCategories externalProcessingAllowed biometricProcessingAllowed allowedRegions expectedSha256 classification retention leaseDuration CancellationOutcome { CONFIRMED, REQUESTED_UNCONFIRMED, UNSUPPORTED }',
    consentAdministrationContractSource:'interface MediaConsentAdministration ConsentRecord grant(GrantRequest request) Optional<ConsentRecord> revoke tenantId principalId correlationId',
    privacyMaintenanceContractSource:'interface MediaPrivacyMaintenance PurgeReport purgeExpired productionEligible()',
    metadataSanitizerSource:'MediaMetadataSanitizer sanitize gps authorization',
    resultSanitizerSource:'MediaJobResultSanitizer privacyRedactedFields voiceprint biometricvector normalized.equals("token")',
    consentAdministrationRuntimeSource:'ServiceLoader.load(MediaConsentAdministration.class) Production Media Runtime requires a ready consent-administration provider productionEligible()',
    privacyMaintenanceRuntimeSource:'ServiceLoader.load(MediaPrivacyMaintenance.class) runCycle(true) scheduleWithFixedDelay Production Media Runtime requires a ready physical privacy-maintenance authority',
    semanticRedactionRuntimeSource:'promotionTier DEIDENTIFIED MediaJobResultSanitizer.sanitize SemanticRedactionRequest safeForPromotion() Semantic redaction provider returned mismatched provider identity Semantic transcript redaction cannot use an external provider',
    localSource:'Expected chunk index Upload checksum does not match expected SHA-256 requestedRetention safeResolve local-diagnostic rawMediaRead local-stream-store Invalid media stream connection token ProcessingBoundary.LOCAL',
    artifactProviderSource:'S3PostgresqlMediaArtifactStore FINALIZING finalization_token createMultipartUpload completeMultipartUpload abortMultipartUpload ServerSideEncryption.AES256 expectedSha256 MessageDigest media_upload_chunks media_artifacts opaque(tenantId) Media artifact byte identity conflicts with governed metadata existing.fileName().equals(requested.fileName()) existing.contentType().equals(requested.contentType()) existing.classification().equals(requested.classification()) existing.metadata().equals(requested.metadata()) DEDUP_RETENTION_TOLERANCE_MILLIS connection.setSavepoint("media_artifact_deduplication") connection.rollback(deduplicationSavepoint) duplicateKey(failure) "23505".equals(failure.getSQLState())',
    jobStoreSource:'PostgresqlMediaJobStore media_processing_jobs request_id version=? Media request ID was reused for a different job MediaJobResultSanitizer.sanitize',
    cancellationTruthMigrationSource:"media_job_cancelled_requires_confirmation status = 'CANCELLED' 'CANCELLED_UNCONFIRMED' 'CANCELLATION_REQUESTED_UNCONFIRMED' 'CANCELLATION_UNSUPPORTED'",
    cancellationTruthIntegrationTestSource:'migrationRejectsUnconfirmedCancellationAsTerminalTruth REQUESTED_UNCONFIRMED CANCELLED_UNCONFIRMED isInstanceOf(SQLException.class)',
    streamStoreSource:'PostgresqlMediaStreamSessionStore connection_token_hash lease_expires_at last_sequence maximum_buffered_bytes MessageDigest.isEqual Invalid Media stream transition lease is absent or expired must be connected before accepting frames',
    consentAuthorityProviderSource:'PostgresqlMediaConsentAuthority media_consents revoked_at principal_id ConsentDecision.unverified()',
    consentAdministrationProviderSource:'PostgresqlMediaConsentAdministration media_consents MEDIA_CONSENT_GRANTED MEDIA_CONSENT_REVOKED version',
    privacyMaintenanceProviderSource:'PostgresqlMediaPrivacyMaintenance purgeExpired DeleteObjectRequest media_artifacts media_upload_sessions media_processing_jobs media_stream_sessions',
    processingProviderSource:'HttpMediaProcessingProvider MediaExternalDisclosureSanitizer.artifact X-Tenant-Id X-Correlation-Id productionEligible() ProcessingBoundary.EXTERNAL externalProcessingAllowed() permitsRegion consentDecision().activeAt biometricProcessingAllowed() CancellationOutcome.REQUESTED_UNCONFIRMED',
    streamingProviderSource:'HttpMediaStreamingProvider acceptedSequence bufferedBytes X-End-Of-Stream closeSession ProcessingBoundary.EXTERNAL externalProcessingAllowed() permitsRegion consentDecision().activeAt',
    providerBuildSource:':services:media:runtime-contracts libs.aws.s3 libs.flyway.postgresql',
    httpSource:'/api/v1/consents MediaConsentAdministration grantConsent( revokeConsent( MediaMetadataSanitizer.sanitize /api/v1/artifacts/uploads /chunks/ /complete /api/v1/jobs /cancel /api/v1/streams /connect /frames/ /close /api/v1/providers X-Tenant-Id X-Principal-Id X-Stream-Token maximumChunkBytes() maximumBodyBytes()',
    javaRoutesSource:routes.map(([m,p])=>`new RouteEntry("${m}", "${p}"`).join('\n'),
    routeManifest:{routes:routes.map(([method,path])=>({method,path}))},
    openApiSource:'version: 1.3.0\nConsentGrantRequest\nConsentRecord\npromotionTier\nDEIDENTIFIED\n'+routes.map(([,path])=>`  ${path}:`).join('\n'),
    sourceOverlay:{overlayKind:'service-contract-source',serviceId:'media',patch:{
      currentState:{implementationStatus:'implemented',runtimeStatus:'active',readiness:'internal-preview'},
      dependencyHealth:{dependencies:{'data-cloud':{required:false},'ai-inference':{required:false}}},
      requirements:[
        {id:'MEDIA-RUNTIME-001',status:'implemented',staticBlockers:[],implementationRefs:[
          'S3PostgresqlMediaArtifactStore.java','PostgresqlMediaJobStore.java','PostgresqlMediaStreamSessionStore.java','HttpMediaProcessingProvider.java','HttpMediaStreamingProvider.java']},
        {id:'MEDIA-UPLOAD-001',status:'implemented',staticBlockers:[]},
        {id:'MEDIA-STREAM-001',status:'implemented',staticBlockers:[]},
        {id:'MEDIA-PRIVACY-001',status:'implemented',staticBlockers:[],implementationRefs:[
          'PostgresqlMediaConsentAuthority.java','PostgresqlMediaConsentAdministration.java','PostgresqlMediaPrivacyMaintenance.java','MediaSemanticRedactionRuntime.java']},
        {id:'MEDIA-CONTRACT-001',status:'implemented',staticBlockers:[]},
      ],
    }},
    registryOverlay:{overlayKind:'runtime-service-registry',serviceId:'media',
      addGradleModules:[':services:media:runtime-contracts',':services:media:providers:aws-postgresql'],
      patch:{conformance:{implementationStatus:'implemented',runtimeExecutionReady:true,runtimeStatus:'active',productionProfileAllowed:false},lifecycleExecutionAllowed:true}},
  };
}

test('accepts complete Media Runtime authority',() =>
  assert.deepEqual(validateMediaRuntimeAuthorityTruth(fixture()),[]));

test('rejects health-only, incomplete production providers, and launcher-owned contracts',()=>{
  const value=fixture(); value.launcherSource+=' MediaHealthHandler HealthHttpHandler';
  value.artifactProviderSource='S3PostgresqlMediaArtifactStore'; value.obsoleteLauncherContractsPresent=true;
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('health-only')));
  assert.ok(errors.some(error=>error.includes('createMultipartUpload')));
  assert.ok(errors.some(error=>error.includes('Launcher-owned')));
});

test('rejects missing consent, privacy maintenance, and semantic redaction authorities',()=>{
  const value=fixture(); value.consentAdministrationRuntimeSource=''; value.privacyMaintenanceProviderSource=''; value.semanticRedactionRuntimeSource='';
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('consent administration runtime')));
  assert.ok(errors.some(error=>error.includes('privacy maintenance provider')));
  assert.ok(errors.some(error=>error.includes('semantic redaction runtime')));
});

test('rejects semantic redaction contracts that are not wired into job completion',()=>{
  const value=fixture(); value.runtimeSource=value.runtimeSource.replace('semanticRedaction.promoteIfRequested(','').replace('SEMANTIC_REDACTION_FAILED','');
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('semanticRedaction.promoteIfRequested')));
  assert.ok(errors.some(error=>error.includes('SEMANTIC_REDACTION_FAILED')));
});

test('rejects missing privacy service-contract requirement',()=>{
  const value=fixture(); value.sourceOverlay.patch.requirements=value.sourceOverlay.patch.requirements.filter(requirement=>requirement.id!=='MEDIA-PRIVACY-001');
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('MEDIA-PRIVACY-001')));
});

test('rejects route drift including consent operations',()=>{
  const value=fixture(); value.routeManifest.routes=value.routeManifest.routes.filter(route=>!route.path.includes('/consents'));
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('exactly the executable route set')));
});

test('rejects artifact stores that deduplicate bytes without governed metadata compatibility',()=>{
  const value=fixture();
  value.artifactProviderSource=value.artifactProviderSource.replace('Media artifact byte identity conflicts with governed metadata','').replace('existing.classification().equals(requested.classification())','');
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('governed metadata')));
  assert.ok(errors.some(error=>error.includes('classification')));
});

test('rejects artifact stores without concurrent unique-conflict reconciliation',()=>{
  const value=fixture();
  value.artifactProviderSource=value.artifactProviderSource.replace('connection.setSavepoint("media_artifact_deduplication")','').replace('"23505".equals(failure.getSQLState())','');
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('setSavepoint')));
  assert.ok(errors.some(error=>error.includes('23505')));
});

test('rejects stream contract drift and production overclaim',()=>{
  const value=fixture(); value.routeManifest.routes=value.routeManifest.routes.filter(route=>!route.path.includes('/streams'));
  value.sourceOverlay.patch.requirements=value.sourceOverlay.patch.requirements.filter(requirement=>requirement.id!=='MEDIA-STREAM-001');
  value.registryOverlay.patch.conformance.productionProfileAllowed=true;
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('exactly the executable route set')));
  assert.ok(errors.some(error=>error.includes('MEDIA-STREAM-001')));
  assert.ok(errors.some(error=>error.includes('production profile')));
});

test('rejects timeout paths that do not cancel original provider work',()=>{
  const value=fixture(); value.runtimeSource=value.runtimeSource.replace('providerFuture.cancel(true)','').replace('cancelTimedOutStreamFrame(control, future)','');
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('providerFuture.cancel(true)')));
  assert.ok(errors.some(error=>error.includes('cancelTimedOutStreamFrame')));
});

test('rejects false terminal cancellation migration regression',()=>{
  const value=fixture();
  value.cancellationTruthMigrationSource="status = 'CANCELLED'";
  value.cancellationTruthIntegrationTestSource='migrationRejectsUnconfirmedCancellationAsTerminalTruth';
  const errors=validateMediaRuntimeAuthorityTruth(value);
  assert.ok(errors.some(error=>error.includes('media_job_cancelled_requires_confirmation')));
  assert.ok(errors.some(error=>error.includes('CANCELLED_UNCONFIRMED')));
  assert.ok(errors.some(error=>error.includes('REQUESTED_UNCONFIRMED')));
});
