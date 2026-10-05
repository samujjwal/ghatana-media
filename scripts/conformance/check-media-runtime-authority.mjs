#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMediaRuntimeAuthorityTruth } from './lib/media-runtime-authority-truth.mjs';
import { validateMediaCancellationTruth } from './lib/media-cancellation-truth.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(read(relative));
const runtimeSource = read('launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java');
const cancellationTruthMigrationSource = read('providers/aws-postgresql/src/main/resources/db/media-runtime/V006__media_job_cancellation_truth.sql');
const errors = validateMediaRuntimeAuthorityTruth({
  launcherSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaLauncher.java'),
  runtimeSource,
  contractsSource: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java'),
  consentAdministrationContractSource: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaConsentAdministration.java'),
  privacyMaintenanceContractSource: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaPrivacyMaintenance.java'),
  metadataSanitizerSource: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaMetadataSanitizer.java'),
  resultSanitizerSource: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaJobResultSanitizer.java'),
  localSource: read('launcher/src/main/java/com/ghatana/media/launcher/LocalMediaRuntimeSupport.java'),
  httpSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java'),
  consentAdministrationRuntimeSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaConsentAdministrationRuntime.java'),
  privacyMaintenanceRuntimeSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaPrivacyMaintenanceRuntime.java'),
  semanticRedactionRuntimeSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaSemanticRedactionRuntime.java'),
  artifactProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/S3PostgresqlMediaArtifactStore.java'),
  jobStoreSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaJobStore.java'),
  streamStoreSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaStreamSessionStore.java'),
  consentAuthorityProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaConsentAuthority.java'),
  consentAdministrationProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaConsentAdministration.java'),
  privacyMaintenanceProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaPrivacyMaintenance.java'),
  processingProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaProcessingProvider.java'),
  streamingProviderSource: read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaStreamingProvider.java'),
  cancellationTruthMigrationSource,
  cancellationTruthIntegrationTestSource: read('providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/MediaAwsPostgresqlRuntimeStateIntegrationTest.java'),
  providerBuildSource: read('providers/aws-postgresql/build.gradle.kts'),
  javaRoutesSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaRouteManifest.java'),
  routeManifest: json('config/route-manifest.json'),
  openApiSource: read('contracts/openapi/media.yaml'),
  sourceOverlay: json('service-contract-supplements/source-overlay.json'),
  registryOverlay: json('config/runtime-service-registry-overlays/media.json'),
  obsoleteHealthHandlerPresent: fs.existsSync(path.join(root,
    'launcher/src/main/java/com/ghatana/media/launcher/MediaHealthHandler.java')),
  obsoleteLauncherContractsPresent: fs.existsSync(path.join(root,
    'launcher/src/main/java/com/ghatana/media/launcher/MediaRuntimeContracts.java')),
});
errors.push(...validateMediaCancellationTruth({
  runtimeSource,
  testSource: read('launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeJobGovernanceTest.java'),
  migrationSource: cancellationTruthMigrationSource,
}));
if (/public\s+MediaRuntime\s*\(\s*\)/.test(runtimeSource)) {
  errors.push('Media Runtime must not expose a public partially initialized constructor');
}
for (const forbidden of [
  'ResilienceSupport',
  'public CircuitBreaker circuitBreaker()',
  'public DeadLetterQueue deadLetterQueue()',
  'public boolean submitJob(',
]) {
  if (runtimeSource.includes(forbidden)) {
    errors.push(`Media Runtime contains detached test-only resilience facade: ${forbidden}`);
  }
}
for (const staleTest of [
  'launcher/src/test/java/com/ghatana/media/launcher/MediaJourneyTest.java',
  'launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeTest.java',
]) {
  if (fs.existsSync(path.join(root, staleTest))) {
    errors.push(`Non-canonical Media Runtime test must remain removed: ${staleTest}`);
  }
}
if (errors.length) {
  console.error(`Media Runtime authority failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('Media artifact, consent, privacy, upload, job, non-terminal cancellation uncertainty, stream, provider, route, lifecycle, and authority truth passed.');
