import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const paths = {
  ledger: ".product-experience/pdp-1-domain-data/privacy.yaml",
  p0Policy: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
  p0States: ".product-experience/pdp-0-product-truth/state-models.yaml",
  authority: ".product-experience/pdp-1-domain-data/authority.yaml",
  offline: ".product-experience/pdp-1-domain-data/offline-sync.yaml",
  versioning: ".product-experience/pdp-1-domain-data/versioning.yaml",
  evidence: ".product-experience/pdp-1-domain-data/evidence.yaml",
  artifactStore: "providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/S3PostgresqlMediaArtifactStore.java",
  jobStore: "providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaJobStore.java",
  streamStore: "providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaStreamSessionStore.java",
  schema: "providers/aws-postgresql/src/main/resources/db/media-runtime/V001__media_runtime_state.sql",
  runtime: "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java",
  maintenanceContract: "runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaPrivacyMaintenance.java",
  maintenance: "providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaPrivacyMaintenance.java",
  maintenanceRuntime: "launcher/src/main/java/com/ghatana/media/launcher/MediaPrivacyMaintenanceRuntime.java",
  consentTest: "launcher/src/test/java/com/ghatana/media/launcher/MediaConsentRevocationTest.java",
  activeTest: "launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeActiveTest.java",
  pgTest: "providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/MediaAwsPostgresqlRuntimeStateTest.java",
  restartTest: "launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeRestartReconciliationTest.java",
  client: "libs/audio-video-client/src/operations.ts",
  openapi: "contracts/openapi/media.yaml",
};
const read = (path) => readFileSync(path, "utf8");

function validate(files) {
  const errors = [];
  const needs = (file, marker, label = marker) => {
    if (!files[file].includes(marker)) errors.push(`${file} missing source evidence: ${label}`);
  };
  const audit = files.ledger.slice(files.ledger.indexOf("sourceIndexedAudit:"));
  for (const marker of [
    "status: source-observation-only; security-and-privacy-owner-approval-and-independent-review-pending",
    "id: media.privacy.observation.tenant-scope",
    "id: media.privacy.observation.consent-revocation",
    "id: media.privacy.observation.retention-and-legal-hold",
    "id: media.privacy.observation.stale-revision",
    "id: media.privacy.observation.physical-erasure",
    "id: media.privacy.observation.uncertain-effect-replay",
    "legalHoldStatus: not-implemented-or-proven-by-inspected-runtime-schema-and-provider",
    "safe-replay-or-deduplication-contract",
    "securityAndPrivacyOwnerApproval: pending",
    "independentReview: pending",
  ]) if (!audit.includes(marker)) errors.push(`privacy observation ledger missing ${marker}`);

  needs("p0Policy", "default: deny-cross-tenant-access-and-reuse");
  needs("p0Policy", "policy-revocation-stops-future-dispatch-and-restricts-outputs-at-the-next-enforcement-point");
  needs("p0Policy", "default: declared-retention-with-physical-erasure-evidence");
  needs("p0Policy", "BLOCKED_BY_HOLD");
  needs("p0States", "id: BLOCKED_BY_HOLD");
  needs("authority", "deployed-identity-and-delegation-provider-binding-not-established");
  needs("authority", "consent-revocation-does-not-by-itself-prove-cancellation-recall-or-deletion-of-prior-effects");

  for (const marker of [
    "WHERE tenant_id=? AND artifact_id=? FOR UPDATE",
    "WHERE tenant_id=? AND principal_id=? AND sha256=? AND size_bytes=? FOR UPDATE",
  ]) needs("artifactStore", marker);
  needs("jobStore", "WHERE tenant_id=? AND job_id=? AND version=?");
  needs("streamStore", "WHERE tenant_id=? AND session_id=? AND version=?");
  for (const marker of [
    "PRIMARY KEY (tenant_id, upload_id)", "PRIMARY KEY (tenant_id, artifact_id)",
    "PRIMARY KEY (tenant_id, job_id)", "PRIMARY KEY (tenant_id, session_id)",
  ]) needs("schema", marker);
  needs("pgTest", 'artifacts.artifact("tenant-b", artifact.artifactId())).isEmpty()');
  needs("pgTest", 'jobs.find("tenant-b", accepted.jobId())).isEmpty()');
  needs("pgTest", 'streams.find("tenant-b", "stream-a")).isEmpty()');
  needs("activeTest", 'runtime.artifact("tenant-a", "principal-b", artifact.artifactId())).isEmpty()');

  needs("runtime", "if (!decision.activeAt(Instant.now()))");
  needs("runtime", "if (!governance.consentId().equals(decision.consentId()))");
  needs("runtime", "ConsentDecision consent = refreshConsent(current, control);");
  needs("runtime", "consentAuthority.verify(tenantId, principalId, governance, operation)");
  needs("consentTest", "revocationStopsNewFramesAndReconnectButStillAllowsResourceTermination");
  needs("consentTest", 'assertThat(provider.acceptedFrames()).isEqualTo(1)');
  needs("consentTest", 'assertThatThrownBy(() -> runtime.connectStream(');
  needs("consentTest", 'assertThat(closed.state()).isEqualTo(StreamState.CLOSED)');

  needs("maintenanceContract", "PurgeReport purgeExpired(Instant now)");
  needs("maintenance", "WHERE expires_at<=? ORDER BY expires_at LIMIT ?");
  needs("maintenance", "DELETE FROM media_artifacts WHERE tenant_id=? AND artifact_id=? AND expires_at<=?");
  needs("maintenance", "WHERE tenant_id=? AND artifact_id=? AND expires_at<=? FOR UPDATE");
  needs("maintenance", "deleteObject(objectKey(reference));");
  needs("maintenance", "WHERE tenant_id=? AND upload_id=? FOR UPDATE");
  needs("maintenance", "List<String> objectKeys = uploadChunkKeys(connection, upload);");
  needs("maintenance", "Expired Media upload changed while row lock was held");
  needs("maintenance", "DELETE FROM media_processing_jobs WHERE status IN ('COMPLETED','FAILED','CANCELLED')");
  needs("maintenance", "DELETE FROM media_stream_sessions WHERE state IN ('CLOSED','FAILED')");
  needs("pgTest", "verifiesPhysicalRetentionDeletesBlobsAndDerivedRuntimeState");
  needs("pgTest", "assertThat(report.artifactsDeleted()).isEqualTo(1)");
  if (/legal[_A-Z]?hold|hold_status|hold_check/iu.test(`${files.maintenance}\n${files.schema}`)) errors.push("inspected purge provider/schema unexpectedly contains legal-hold behavior; ledger requires re-audit");
  if (!audit.includes("legalHoldStatus: not-implemented-or-proven-by-inspected-runtime-schema-and-provider")) errors.push("PDP0 hold requirement must not be represented as implemented by this provider");

  needs("jobStore", "Media job version changed concurrently");
  needs("jobStore", "lease_token=?");
  needs("runtime", "if (!jobStore.leaseValid(lease))");
  needs("pgTest", 'hasMessageContaining("version changed")');
  needs("versioning", "no-canonical-artifact-version-record-or-key-observed");

  needs("maintenance", "private void deleteObject(String objectKey)");
  needs("maintenance", ".deleteObject(DeleteObjectRequest.builder()");
  needs("pgTest", "noneMatch(object -> object.key().equals(artifactObjectKey))");
  needs("ledger", "copy-complete-erasure-receipt");
  needs("ledger", "restore-tombstone-replay");

  needs("runtime", '"provider outcome unknown after runtime restart"');
  needs("runtime", '"RESTART_RECONCILIATION_REQUIRED"');
  needs("restartTest", 'assertThat(calls).hasValue(1)');
  needs("client", '`/api/v1/media/operations/${encodeURIComponent(operationId)}:retry`');
  needs("client", 'const response = await this.fetchImpl(`${this.baseUrl}${path}`');
  needs("offline", "safeReplay: not-established");
  needs("openapi", "No replay-safe idempotency guarantee is declared; clients must not automatically retry this mutation.");
  needs("ledger", "provider-outcome-reconciliation");
  needs("ledger", "replay-contract-unbound");
  if (files.offline.includes("safeReplay: guaranteed") || audit.includes("safe-replay-or-deduplication-contract: established")) {
    errors.push("uncertain-effect replay must remain unestablished");
  }
  return errors;
}

const base = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, read(path)]));

test("privacy ledger binds only source-observed tenant, consent, revision, retention, and retry behavior", () => {
  assert.deepEqual(validate(base), []);
});

test("privacy regression rejects tenant-scope, revocation, and stale-revision source drift", () => {
  const unscopedArtifactRead = base.artifactStore.replace("WHERE tenant_id=? AND artifact_id=? FOR UPDATE", "WHERE artifact_id=? FOR UPDATE");
  assert.match(validate({ ...base, artifactStore: unscopedArtifactRead }).join("\n"), /artifactStore missing source evidence: WHERE tenant_id=\? AND artifact_id=\? FOR UPDATE/u);
  const unrefreshedFrame = base.runtime.replace("ConsentDecision consent = refreshConsent(current, control);", "ConsentDecision consent = control.consent();");
  assert.match(validate({ ...base, runtime: unrefreshedFrame }).join("\n"), /runtime missing source evidence: ConsentDecision consent = refreshConsent/u);
  const noCas = base.jobStore.replaceAll("WHERE tenant_id=? AND job_id=? AND version=?", "WHERE tenant_id=? AND job_id=?");
  assert.match(validate({ ...base, jobStore: noCas }).join("\n"), /jobStore missing source evidence: WHERE tenant_id=\? AND job_id=\? AND version=\?/u);
});

test("privacy regression rejects unsupported hold, erasure, and uncertain-replay claims", () => {
  const claimedHold = base.ledger.replace("legalHoldStatus: not-implemented-or-proven-by-inspected-runtime-schema-and-provider", "legalHoldStatus: enforced");
  assert.match(validate({ ...base, ledger: claimedHold }).join("\n"), /legalHoldStatus: not-implemented-or-proven/u);
  const missingBlobDelete = base.maintenance.replace("deleteObject(objectKey(reference));", "// object delete omitted");
  assert.match(validate({ ...base, maintenance: missingBlobDelete }).join("\n"), /maintenance missing source evidence: deleteObject/u);
  const unlockedUploadPurge = base.maintenance.replace("WHERE tenant_id=? AND upload_id=? FOR UPDATE", "WHERE tenant_id=? AND upload_id=?");
  assert.match(validate({ ...base, maintenance: unlockedUploadPurge }).join("\n"), /maintenance missing source evidence: WHERE tenant_id=\? AND upload_id=\? FOR UPDATE/u);
  const optimisticRestart = base.runtime.replace('"provider outcome unknown after runtime restart"', '"provider outcome confirmed after runtime restart"');
  assert.match(validate({ ...base, runtime: optimisticRestart }).join("\n"), /runtime missing source evidence: "provider outcome unknown/u);
  const claimedSafeReplay = base.offline.replace("safeReplay: not-established", "safeReplay: guaranteed");
  assert.match(validate({ ...base, offline: claimedSafeReplay }).join("\n"), /offline missing source evidence: safeReplay: not-established/u);
});
