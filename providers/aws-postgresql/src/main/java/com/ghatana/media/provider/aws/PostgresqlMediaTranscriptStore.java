package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptPrincipalConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevisionConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDerivedCapability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptCapabilityResult;
import com.ghatana.media.runtime.MediaTranscriptContracts;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** PostgreSQL-backed append-only transcript revisions, with candidate-only authority provenance. */
public final class PostgresqlMediaTranscriptStore implements MediaTranscriptStore {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public TranscriptRevision append(TranscriptDraft draft) {
        return append(draft, 0);
    }

    @Override
    public TranscriptRevision append(TranscriptDraft draft, int expectedLatestRevision) {
        ensureOpen();
        java.util.Objects.requireNonNull(draft, "draft");
        if (expectedLatestRevision < 0) {
            throw new IllegalArgumentException("expectedLatestRevision cannot be negative");
        }
        // There is no authoritative rights/profile lookup in this checkout. Never write production output.
        if (state.productionEligible()) {
            throw new UnsupportedOperationException("Transcript rights and profile admission is pending");
        }
        if (MediaTranscriptContracts.UNBOUND_PURPOSE_REF.equals(draft.purposeRef())
                || MediaTranscriptContracts.UNRESOLVED_PROCESSING_PURPOSE.equals(draft.processingPurpose())) {
            throw new IllegalArgumentException("Transcript purpose reference and effective processing purpose must be bound");
        }
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                validateSourceJobConsent(connection, draft);
                TranscriptRevision latest = latest(connection, draft.tenantId(), draft.transcriptId(), true);
                if (latest != null && sameDraft(latest.draft(), draft)) {
                    connection.commit();
                    return latest;
                }
                if (latest != null && !latest.draft().principalId().equals(draft.principalId())) {
                    throw new TranscriptPrincipalConflictException();
                }
                int actualLatestRevision = latest == null ? 0 : latest.revision();
                if (expectedLatestRevision != actualLatestRevision) {
                    throw new TranscriptRevisionConflictException(expectedLatestRevision, actualLatestRevision);
                }
                int revision = actualLatestRevision + 1;
                long now = System.currentTimeMillis();
                try (PreparedStatement insert = connection.prepareStatement("""
                        INSERT INTO media_transcript_revisions
                          (tenant_id,transcript_id,revision,principal_id,source_artifact_id,
                           source_artifact_version,source_sha256,job_id,profile_id,provider_id,model_id,
                           language,timebase,transcript_text,consent_decision_id,purpose_ref,processing_purpose,
                           rights_decision_id,
                           policy_version,admission_status,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CANDIDATE',?)
                        """)) {
                    bind(insert, draft, revision, now);
                    insert.executeUpdate();
                }
                connection.commit();
                return new TranscriptRevision(draft, revision, now, "CANDIDATE");
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                if (isUniqueViolation((SQLException) failure)) {
                    return resolveConcurrentAppend(draft, expectedLatestRevision, (SQLException) failure);
                }
                throw dbFailure("append transcript revision", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw dbFailure("open transcript transaction", failure);
        }
    }

    private static void validateSourceJobConsent(Connection connection, TranscriptDraft draft) throws SQLException {
        try (PreparedStatement source = connection.prepareStatement("""
                SELECT 1 FROM media_artifacts
                 WHERE tenant_id=? AND artifact_id=? AND principal_id=? AND sha256=?
                   AND 'sha256:' || sha256=? AND expires_at>? AND scan_status='CLEAN'
                """)) {
            source.setString(1, draft.tenantId()); source.setString(2, draft.sourceArtifactId());
            source.setString(3, draft.principalId()); source.setString(4, draft.sourceSha256());
            source.setString(5, draft.sourceVersion()); source.setLong(6, System.currentTimeMillis());
            try (ResultSet result = source.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Transcript source is missing, stale, or not admitted");
            }
        }
        try (PreparedStatement job = connection.prepareStatement("""
                SELECT 1 FROM media_processing_jobs
                 WHERE tenant_id=? AND job_id=? AND principal_id=? AND artifact_id=?
                   AND expected_artifact_version=? AND provider_id=? AND status='COMPLETED' FOR UPDATE
                """)) {
            job.setString(1, draft.tenantId()); job.setString(2, draft.jobId());
            job.setString(3, draft.principalId()); job.setString(4, draft.sourceArtifactId());
            job.setString(5, draft.sourceVersion()); job.setString(6, draft.providerId());
            try (ResultSet result = job.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Transcript job does not match tenant, principal, source, version, provider, or completion state");
            }
        }
        try (PreparedStatement consent = connection.prepareStatement("""
                SELECT purposes_csv,revoked_at,expires_at FROM media_consents
                 WHERE tenant_id=? AND consent_id=? AND principal_id=? FOR UPDATE
                """)) {
            consent.setString(1, draft.tenantId()); consent.setString(2, draft.consentDecisionId());
            consent.setString(3, draft.principalId());
            try (ResultSet result = consent.executeQuery()) {
                if (!result.next() || result.getObject("revoked_at") != null
                        || (result.getObject("expires_at") != null
                        && result.getLong("expires_at") <= System.currentTimeMillis())) {
                    throw new IllegalStateException("Transcript consent is missing, revoked, or expired");
                }
                if (!csvContains(result.getString("purposes_csv"), draft.processingPurpose())) {
                    throw new IllegalStateException("Transcript processing purpose is not permitted by consent");
                }
            }
        }
    }

    private static boolean csvContains(String csv, String expected) {
        if (csv == null || expected == null) return false;
        String normalized = expected.trim().toLowerCase(java.util.Locale.ROOT);
        if (normalized.isEmpty()) return false;
        for (String value : csv.split(",", -1)) {
            String allowed = value.trim().toLowerCase(java.util.Locale.ROOT);
            if ("*".equals(allowed) || normalized.equals(allowed)) return true;
        }
        return false;
    }

    @Override
    public List<TranscriptRevision> revisions(String tenantId, String principalId, String transcriptId) {
        ensureOpen();
        requireNonBlank(tenantId, "tenantId");
        requireNonBlank(principalId, "principalId");
        requireNonBlank(transcriptId, "transcriptId");
        List<TranscriptRevision> values = new ArrayList<>();
        try (Connection connection = state.connection(); PreparedStatement query = connection.prepareStatement("""
                SELECT * FROM media_transcript_revisions
                 WHERE tenant_id=? AND principal_id=? AND transcript_id=? ORDER BY revision
                """)) {
            query.setString(1, tenantId); query.setString(2, principalId); query.setString(3, transcriptId);
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) values.add(read(rows));
            }
            return List.copyOf(values);
        } catch (SQLException failure) {
            throw dbFailure("read transcript revisions", failure);
        }
    }

    @Override
    public TranscriptCapabilityResult capability(TranscriptDerivedCapability capability) {
        ensureOpen();
        return MediaTranscriptContracts.unavailableCapability(capability);
    }

    /** Tenant-only readback is retained for source compatibility and fails closed. */
    @Override
    @Deprecated
    public List<TranscriptRevision> revisions(String tenantId, String transcriptId) {
        throw new UnsupportedOperationException("Principal-scoped transcript readback is required");
    }

    private TranscriptRevision resolveConcurrentAppend(
            TranscriptDraft draft, int expectedLatestRevision, SQLException insertFailure) {
        try (Connection connection = state.connection()) {
            TranscriptRevision latest = latest(connection, draft.tenantId(), draft.transcriptId(), false);
            if (latest == null) throw dbFailure("resolve concurrent transcript append", insertFailure);
            if (!latest.draft().principalId().equals(draft.principalId())) {
                throw new TranscriptPrincipalConflictException();
            }
            if (sameDraft(latest.draft(), draft)) return latest;
            throw new TranscriptRevisionConflictException(expectedLatestRevision, latest.revision());
        } catch (SQLException readFailure) {
            readFailure.addSuppressed(insertFailure);
            throw dbFailure("resolve concurrent transcript append", readFailure);
        }
    }

    private static boolean isUniqueViolation(SQLException failure) {
        for (SQLException current = failure; current != null; current = current.getNextException()) {
            if ("23505".equals(current.getSQLState())) return true;
        }
        return false;
    }

    private static TranscriptRevision latest(Connection connection, String tenant, String transcript, boolean lock)
            throws SQLException {
        String sql = "SELECT * FROM media_transcript_revisions WHERE tenant_id=? AND transcript_id=? "
                + "ORDER BY revision DESC LIMIT 1" + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement query = connection.prepareStatement(sql)) {
            query.setString(1, tenant); query.setString(2, transcript);
            try (ResultSet row = query.executeQuery()) { return row.next() ? read(row) : null; }
        }
    }

    private static TranscriptRevision read(ResultSet row) throws SQLException {
        TranscriptDraft draft = new TranscriptDraft(row.getString("tenant_id"), row.getString("principal_id"),
                row.getString("transcript_id"), row.getString("source_artifact_id"),
                row.getString("source_artifact_version"), row.getString("source_sha256"), row.getString("job_id"),
                row.getString("profile_id"), row.getString("provider_id"), row.getString("model_id"),
                row.getString("language"), row.getString("timebase"), row.getString("transcript_text"),
                row.getString("consent_decision_id"), row.getString("rights_decision_id"), row.getString("policy_version"),
                row.getString("purpose_ref"), row.getString("processing_purpose"));
        return new TranscriptRevision(draft, row.getInt("revision"), row.getLong("created_at"),
                row.getString("admission_status"));
    }

    private static boolean sameDraft(TranscriptDraft a, TranscriptDraft b) {
        return a.equals(b);
    }

    private static void requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }

    private static void bind(PreparedStatement s, TranscriptDraft d, int revision, long now) throws SQLException {
        s.setString(1,d.tenantId()); s.setString(2,d.transcriptId()); s.setInt(3,revision); s.setString(4,d.principalId());
        s.setString(5,d.sourceArtifactId()); s.setString(6,d.sourceVersion()); s.setString(7,d.sourceSha256());
        s.setString(8,d.jobId()); s.setString(9,d.profileId()); s.setString(10,d.providerId()); s.setString(11,d.modelId());
        s.setString(12,d.language()); s.setString(13,d.timebase()); s.setString(14,d.text());
        s.setString(15,d.consentDecisionId()); s.setString(16,d.purposeRef());
        s.setString(17,d.processingPurpose()); s.setString(18,d.rightsDecisionId());
        s.setString(19,d.policyVersion()); s.setLong(20,now);
    }

    private static void rollback(Connection c, Throwable failure) {
        try { c.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }
    private static IllegalStateException dbFailure(String action, SQLException cause) {
        return new IllegalStateException("Failed to " + action, cause);
    }
    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Transcript store is closed");
    }
    @Override public boolean productionEligible() { return false; }
    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }
}
