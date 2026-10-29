package com.ghatana.media.provider.aws;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.governance.VerifiedPolicyContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration.SourceRecord;
import com.ghatana.security.identity.PrincipalIdentity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Canonical Media source-authorization authority over durable PostgreSQL source records plus the
 * current Shared {@link PolicyEngine}.
 *
 * <p>{@code resolve} reads the authenticated source-owner record for the exact immutable artifact
 * version, checks operation/purpose/region/retention scope and current revocation, then evaluates
 * a verified Shared policy request and durably records the issued decision. {@code revalidate}
 * re-reads the source record, the issued decision, and a fresh policy evaluation; any revocation,
 * epoch advance, expiry, or policy change fails closed. No caller-supplied flag, environment
 * variable, or provenance template can produce {@code ALLOWED} without a registered record and an
 * authoritative Shared ALLOW.
 *
 * @doc.type class
 * @doc.purpose Resolve and revalidate source-version-bound Media processing authorization
 * @doc.layer provider
 * @doc.pattern Provider, PolicyConsumer
 */
public final class PostgresqlMediaSourceAuthorizationAuthority
        implements MediaSourceAuthorizationContracts.Authority {
    private static final Logger audit = LoggerFactory.getLogger("media.auditTrail");
    private static final String AUTHORITY_ID = "postgresql-media-source-authorization";
    private static final Duration POLICY_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration MAX_DECISION_TTL = Duration.ofMinutes(30);

    private final MediaAwsPostgresqlRuntimeState state;
    private final PolicyEngine policyEngine;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    /** ServiceLoader composition: absent an installed Shared PolicyEngine the authority fails closed. */
    public PostgresqlMediaSourceAuthorizationAuthority() {
        this(MediaAwsPostgresqlRuntimeState.acquire(), discoverPolicyEngine());
    }

    public PostgresqlMediaSourceAuthorizationAuthority(PolicyEngine policyEngine) {
        this(MediaAwsPostgresqlRuntimeState.acquire(), policyEngine);
    }

    PostgresqlMediaSourceAuthorizationAuthority(
            MediaAwsPostgresqlRuntimeState state, PolicyEngine policyEngine) {
        this.state = state;
        this.policyEngine = policyEngine;
    }

    private static PolicyEngine discoverPolicyEngine() {
        for (PolicyEngine candidate : ServiceLoader.load(PolicyEngine.class)) {
            try {
                if (candidate != null && candidate.isOpen()) return candidate;
            } catch (RuntimeException unavailable) { }
        }
        return null;
    }

    @Override public String authorityId() { return AUTHORITY_ID; }

    @Override
    public MediaSourceAuthorizationContracts.Decision resolve(
            MediaSourceAuthorizationContracts.Request request) {
        ensureOpen();
        Objects.requireNonNull(request, "request");
        try {
            SourceRecord record = readRecord(request.tenantId(), request.artifactId(),
                    request.sourceVersion().value());
            if (record == null) return decision(MediaSourceAuthorizationContracts.Status.DENIED);
            MediaSourceAuthorizationContracts.Status scope = scopeStatus(record, request, Instant.now());
            if (scope != MediaSourceAuthorizationContracts.Status.ALLOWED) return decision(scope);

            PolicyDecisionRecord policy = evaluatePolicy(request, record);
            if (policy == null) return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            if (policy.outcome() == PolicyDecisionOutcome.DENY) {
                return decision(MediaSourceAuthorizationContracts.Status.DENIED);
            }
            if (!authoritativeAllow(policy, request)) {
                return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            }
            return issue(request, record, policy);
        } catch (IllegalStateException unavailable) {
            return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
        }
    }

    @Override
    public MediaSourceAuthorizationContracts.Decision revalidate(
            MediaSourceAuthorizationContracts.Request request,
            MediaSourceAuthorizationContracts.Evidence expectedEvidence) {
        ensureOpen();
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(expectedEvidence, "expectedEvidence");
        try {
            Instant now = Instant.now();
            DecisionRow decision = readDecisionForUpdate(request.tenantId(), expectedEvidence.decisionId());
            if (decision == null) return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            if (decision.revokedAt != null) return decision(MediaSourceAuthorizationContracts.Status.REVOKED);
            if (!decision.expiresAt.isAfter(now)) return decision(MediaSourceAuthorizationContracts.Status.STALE);
            if (!decision.matches(request, expectedEvidence)) {
                return decision(MediaSourceAuthorizationContracts.Status.DENIED);
            }
            SourceRecord record = readRecord(request.tenantId(), request.artifactId(),
                    request.sourceVersion().value());
            if (record == null) return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            if (record.revoked() || record.revocationEpoch() != expectedEvidence.revocationEpoch()) {
                return decision(MediaSourceAuthorizationContracts.Status.REVOKED);
            }
            if (record.expiredAt(now)) return decision(MediaSourceAuthorizationContracts.Status.STALE);

            PolicyDecisionRecord policy = evaluatePolicy(request, record);
            if (policy == null) return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            if (policy.outcome() == PolicyDecisionOutcome.DENY) {
                return decision(MediaSourceAuthorizationContracts.Status.DENIED);
            }
            if (!authoritativeAllow(policy, request)) {
                return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            }
            return new MediaSourceAuthorizationContracts.Decision(
                    MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
        } catch (IllegalStateException unavailable) {
            return decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
        }
    }

    /** Reads the registered source scope and current revocation for one immutable source version. */
    private SourceRecord readRecord(String tenantId, String artifactId, String sourceVersion) {
        String sql = """
                SELECT source_sha256,principal_id,source_owner_id,source_kind,human_consent_disposition,
                       consent_decision_id,allowed_operations_csv,allowed_purposes_csv,allowed_regions_csv,
                       allowed_provider_retentions_csv,source_clock_evidence_ref,provenance_ref,
                       registered_by,registered_at,expires_at,revocation_epoch,revoked_at
                  FROM media_source_records
                 WHERE tenant_id=? AND artifact_id=? AND source_version=?
                """;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, artifactId);
            statement.setString(3, sourceVersion);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) return null;
                return PostgresqlMediaSourceRightsAdministration.readRecord(row, tenantId, artifactId, sourceVersion);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Media source record read is unavailable", failure);
        }
    }

    private static MediaSourceAuthorizationContracts.Status scopeStatus(
            SourceRecord record,
            MediaSourceAuthorizationContracts.Request request,
            Instant now) {
        if (record.revoked()) return MediaSourceAuthorizationContracts.Status.REVOKED;
        if (record.expiredAt(now)) return MediaSourceAuthorizationContracts.Status.STALE;
        boolean scoped = record.principalId().equals(request.principalId())
                && record.sourceSha256().equals(request.sourceSha256())
                && record.allowedOperations().contains(request.operation().toLowerCase(java.util.Locale.ROOT))
                && record.allowedPurposes().contains(request.purpose().toLowerCase(java.util.Locale.ROOT))
                && (record.allowedRegions().contains("*")
                        || record.allowedRegions().contains(
                                request.processingRegion().toLowerCase(java.util.Locale.ROOT)))
                && record.allowedProviderRetentions().contains(request.providerRetention());
        return scoped
                ? MediaSourceAuthorizationContracts.Status.ALLOWED
                : MediaSourceAuthorizationContracts.Status.DENIED;
    }

    /** Issues a durable rights decision only while the source record is still current. */
    private MediaSourceAuthorizationContracts.Decision issue(
            MediaSourceAuthorizationContracts.Request request,
            SourceRecord observed,
            PolicyDecisionRecord policy) {
        Instant now = Instant.now();
        Instant expiresAt = observed.expiresAt().isBefore(now.plus(MAX_DECISION_TTL))
                ? observed.expiresAt() : now.plus(MAX_DECISION_TTL);
        String decisionId = UUID.randomUUID().toString();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                SourceRecord current;
                try (PreparedStatement select = connection.prepareStatement("""
                        SELECT source_sha256,principal_id,source_owner_id,source_kind,
                               human_consent_disposition,consent_decision_id,allowed_operations_csv,
                               allowed_purposes_csv,allowed_regions_csv,allowed_provider_retentions_csv,
                               source_clock_evidence_ref,provenance_ref,registered_by,registered_at,
                               expires_at,revocation_epoch,revoked_at
                          FROM media_source_records
                         WHERE tenant_id=? AND artifact_id=? AND source_version=? FOR UPDATE
                        """)) {
                    select.setString(1, request.tenantId());
                    select.setString(2, request.artifactId());
                    select.setString(3, request.sourceVersion().value());
                    try (ResultSet row = select.executeQuery()) {
                        if (!row.next()) {
                            connection.rollback();
                            return decision(MediaSourceAuthorizationContracts.Status.DENIED);
                        }
                        current = PostgresqlMediaSourceRightsAdministration.readRecord(
                                row, request.tenantId(), request.artifactId(), request.sourceVersion().value());
                    }
                }
                if (current.revocationEpoch() != observed.revocationEpoch() || current.revoked()) {
                    connection.rollback();
                    return decision(MediaSourceAuthorizationContracts.Status.REVOKED);
                }
                if (current.expiredAt(now) || scopeStatus(current, request, now)
                        != MediaSourceAuthorizationContracts.Status.ALLOWED) {
                    connection.rollback();
                    return decision(MediaSourceAuthorizationContracts.Status.DENIED);
                }
                try (PreparedStatement insert = connection.prepareStatement("""
                        INSERT INTO media_source_rights_decisions
                          (tenant_id,decision_id,artifact_id,source_version,principal_id,source_owner_id,
                           operation,purpose,provider_id,provider_version,processing_boundary,
                           processing_region,provider_retention,policy_decision_id,policy_version,
                           revocation_epoch,decided_at,expires_at,revoked_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                        """)) {
                    insert.setString(1, request.tenantId());
                    insert.setString(2, decisionId);
                    insert.setString(3, request.artifactId());
                    insert.setString(4, request.sourceVersion().value());
                    insert.setString(5, request.principalId());
                    insert.setString(6, current.sourceOwnerId());
                    insert.setString(7, request.operation());
                    insert.setString(8, request.purpose());
                    insert.setString(9, request.providerId());
                    insert.setString(10, request.providerVersion());
                    insert.setString(11, request.processingBoundary().name());
                    insert.setString(12, request.processingRegion());
                    insert.setString(13, request.providerRetention().name());
                    insert.setString(14, policy.decisionId());
                    insert.setString(15, policy.policyVersion());
                    insert.setLong(16, current.revocationEpoch());
                    insert.setLong(17, now.toEpochMilli());
                    insert.setLong(18, expiresAt.toEpochMilli());
                    insert.executeUpdate();
                }
                connection.commit();
            } catch (RuntimeException | SQLException failure) {
                try { connection.rollback(); }
                catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Media source-rights decision write is unavailable", failure);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Media source-rights decision transaction is unavailable", failure);
        }
        audit.info(
                "MEDIA_SOURCE_AUTHORIZED tenantId={} artifactId={} sourceVersion={} decisionId={} policyDecisionId={} correlationFree",
                request.tenantId(), request.artifactId(), request.sourceVersion(), decisionId,
                policy.decisionId());
        return new MediaSourceAuthorizationContracts.Decision(
                MediaSourceAuthorizationContracts.Status.ALLOWED,
                evidence(request, observed, policy, decisionId, now, expiresAt));
    }

    private static MediaSourceAuthorizationContracts.Evidence evidence(
            MediaSourceAuthorizationContracts.Request request,
            SourceRecord record,
            PolicyDecisionRecord policy,
            String decisionId,
            Instant verifiedAt,
            Instant expiresAt) {
        return new MediaSourceAuthorizationContracts.Evidence(
                AUTHORITY_ID, decisionId, request.tenantId(), request.principalId(),
                record.sourceOwnerId(), request.artifactId(), request.sourceVersion(),
                request.sourceSha256(), request.operation(), request.purpose(), request.providerId(),
                request.providerVersion(), request.processingBoundary(), request.processingRegion(),
                request.providerRetention(), record.allowedOperations(), record.allowedRegions(),
                record.allowedProviderRetentions(), decisionId, policy.decisionId(),
                policy.policyVersion(), record.sourceKind(), record.humanConsentDisposition(),
                record.consentDecisionId(), record.sourceClockEvidenceRef(), record.revocationEpoch(),
                verifiedAt, expiresAt);
    }

    private record DecisionRow(
            String artifactId, String sourceVersion, String principalId, String operation,
            String purpose, String providerId, String providerVersion, ProcessingBoundary boundary,
            String region, ProviderDataRetention retention, long revocationEpoch, Instant expiresAt,
            Instant revokedAt) {
        boolean matches(
                MediaSourceAuthorizationContracts.Request request,
                MediaSourceAuthorizationContracts.Evidence evidence) {
            return artifactId.equals(request.artifactId())
                    && sourceVersion.equals(request.sourceVersion().value())
                    && principalId.equals(request.principalId())
                    && operation.equals(request.operation())
                    && purpose.equals(request.purpose())
                    && providerId.equals(request.providerId())
                    && providerVersion.equals(request.providerVersion())
                    && boundary == request.processingBoundary()
                    && region.equals(request.processingRegion())
                    && retention == request.providerRetention()
                    && revocationEpoch == evidence.revocationEpoch()
                    && artifactId.equals(evidence.artifactId());
        }
    }

    private DecisionRow readDecisionForUpdate(String tenantId, String decisionId) {
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement("""
                     SELECT artifact_id,source_version,principal_id,operation,purpose,provider_id,
                            provider_version,processing_boundary,processing_region,provider_retention,
                            revocation_epoch,expires_at,revoked_at
                       FROM media_source_rights_decisions
                      WHERE tenant_id=? AND decision_id=? FOR UPDATE
                     """)) {
            statement.setString(1, tenantId);
            statement.setString(2, decisionId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) return null;
                long revoked = row.getLong("revoked_at");
                Instant revokedAt = row.wasNull() ? null : Instant.ofEpochMilli(revoked);
                return new DecisionRow(
                        row.getString("artifact_id"), row.getString("source_version"),
                        row.getString("principal_id"), row.getString("operation"),
                        row.getString("purpose"), row.getString("provider_id"),
                        row.getString("provider_version"),
                        ProcessingBoundary.valueOf(row.getString("processing_boundary")),
                        row.getString("processing_region"),
                        ProviderDataRetention.valueOf(row.getString("provider_retention")),
                        row.getLong("revocation_epoch"),
                        Instant.ofEpochMilli(row.getLong("expires_at")),
                        revokedAt);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Media source-rights decision read is unavailable", failure);
        }
    }

    private PolicyDecisionRecord evaluatePolicy(
            MediaSourceAuthorizationContracts.Request request, SourceRecord record) {
        if (policyEngine == null) return null;
        String correlationId = UUID.randomUUID().toString();
        PrincipalIdentity principal = new PrincipalIdentity(
                request.tenantId(), request.principalId(), null, Set.of(), Instant.now());
        PolicyEvaluationRequest evaluation = PolicyEvaluationRequest.builder()
                .principalId(request.principalId())
                .tenantId(request.tenantId())
                .actionClass("CALL_EXTERNAL")
                .targetType("MEDIA_SOURCE_ARTIFACT")
                .targetId(request.artifactId())
                .criticality("HIGH")
                .reversibility("IRREVERSIBLE")
                .attributes(policyAttributes(request, record))
                .correlationId(correlationId)
                .verifiedContext(VerifiedPolicyContext.from(principal, correlationId))
                .build();
        CompletionStage<PolicyDecisionRecord> stage;
        try {
            stage = policyEngine.evaluate(evaluation);
            if (stage == null) return null;
            return stage.toCompletableFuture().get(
                    POLICY_TIMEOUT.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException | TimeoutException | RuntimeException failure) {
            return null;
        }
    }

    private static Map<String, String> policyAttributes(
            MediaSourceAuthorizationContracts.Request request, SourceRecord record) {
        java.util.Map<String, String> attributes = new java.util.LinkedHashMap<>();
        attributes.put("operation", request.operation());
        attributes.put("sourceVersion", request.sourceVersion().value());
        attributes.put("purpose", request.purpose());
        attributes.put("provenanceRef", record.provenanceRef());
        if (!record.consentDecisionId().isBlank()) {
            attributes.put("consentReference", record.consentDecisionId());
        } else {
            attributes.put("consentDisposition", record.humanConsentDisposition().name());
        }
        attributes.put("revocationEpoch", Long.toString(record.revocationEpoch()));
        return Map.copyOf(attributes);
    }

    private static boolean authoritativeAllow(
            PolicyDecisionRecord decision, MediaSourceAuthorizationContracts.Request request) {
        if (decision.outcome() != PolicyDecisionOutcome.ALLOW || !decision.isAuthoritative()
                || decision.policyVersion() == null || decision.policyVersion().isBlank()) {
            return false;
        }
        var context = decision.context();
        return context != null && context.isTrusted()
                && context.principalId().equals(request.principalId())
                && context.tenantId().equals(request.tenantId());
    }

    private static MediaSourceAuthorizationContracts.Decision decision(
            MediaSourceAuthorizationContracts.Status status) {
        return new MediaSourceAuthorizationContracts.Decision(status, null);
    }

    @Override
    public boolean ready() {
        if (closed.get() || policyEngine == null || !state.ready()) return false;
        try {
            if (!policyEngine.isOpen()) return false;
        } catch (RuntimeException unavailable) {
            return false;
        }
        try (Connection connection = state.connection();
             PreparedStatement records = connection.prepareStatement(
                     "SELECT tenant_id FROM media_source_records WHERE 1=0");
             PreparedStatement decisions = connection.prepareStatement(
                     "SELECT tenant_id FROM media_source_rights_decisions WHERE 1=0");
             var recordResult = records.executeQuery();
             var decisionResult = decisions.executeQuery()) {
            return true;
        } catch (Exception failure) {
            return false;
        }
    }

    @Override
    public boolean productionEligible() {
        if (closed.get() || policyEngine == null || !state.productionEligible()) return false;
        try { return policyEngine.isOpen(); }
        catch (RuntimeException unavailable) { return false; }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        state.release();
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media source authorization authority is closed");
        if (!state.configured()) {
            throw new IllegalStateException("Media source authorization authority is not configured");
        }
    }
}
