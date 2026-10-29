package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptPrincipalConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevisionConflictException;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptAttemptBinding;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDerivedCapability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptCapabilityResult;
import com.ghatana.media.runtime.MediaTranscriptContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaLifecycleEvent;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import tools.jackson.databind.JsonNode;

/** PostgreSQL-backed append-only transcript revisions, with candidate-only authority provenance. */
public final class PostgresqlMediaTranscriptStore implements MediaTranscriptStore {
    private static final int MAX_TRANSCRIPT_TEXT_CODE_POINTS = 1_000_000;
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
        validateTranscriptText(draft);
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
                           policy_version,admission_status,created_at,timing_availability,segments_json)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CANDIDATE',?,?,?)
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

    /**
     * Persists a candidate only when its content is an exact projection of the named durable,
     * successful provider attempt. Rights/provider admission remains candidate-only.
     */
    @Override
    public TranscriptRevision appendFromSuccessfulAttempt(TranscriptDraft draft, int expectedLatestRevision,
            int attemptNumber, long fencingToken, String requestFingerprint, String transcriptVersionRef) {
        ensureOpen();
        java.util.Objects.requireNonNull(draft, "draft");
        validateTranscriptText(draft);
        requireNonBlank(requestFingerprint, "requestFingerprint");
        requireNonBlank(transcriptVersionRef, "transcriptVersionRef");
        if (attemptNumber <= 0 || fencingToken <= 0 || expectedLatestRevision < 0
                || !requestFingerprint.matches("[0-9a-f]{64}")
                || transcriptVersionRef.codePointCount(0, transcriptVersionRef.length()) > 384) {
            throw new IllegalArgumentException("Transcript attempt binding is malformed or does not identify this candidate");
        }
        boolean productionAdmission = state.productionEligible();
        if (MediaTranscriptContracts.UNBOUND_PURPOSE_REF.equals(draft.purposeRef())
                || MediaTranscriptContracts.UNRESOLVED_PROCESSING_PURPOSE.equals(draft.processingPurpose())) {
            throw new IllegalArgumentException("Transcript purpose reference and effective processing purpose must be bound");
        }
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                validateSourceJobConsent(connection, draft);
                AttemptBinding binding = validateAttempt(connection, draft, attemptNumber, fencingToken,
                        requestFingerprint, transcriptVersionRef);
                if (productionAdmission) {
                    verifyProductionSourceRights(connection, draft);
                }
                String admissionStatus = productionAdmission ? "ADMITTED" : "CANDIDATE";
                TranscriptRevision latest = latest(connection, draft.tenantId(), draft.transcriptId(), true);
                if (latest != null && sameDraft(latest.draft(), draft)) {
                    AttemptBinding existing = binding(connection, draft.tenantId(), draft.transcriptId(), latest.revision());
                    if (binding.equals(existing)) {
                        connection.commit();
                        return latest;
                    }
                    throw new TranscriptRevisionConflictException(expectedLatestRevision, latest.revision());
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
                           rights_decision_id,policy_version,admission_status,created_at,
                           timing_availability,segments_json)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """)) {
                    bind(insert, draft, revision, now, admissionStatus);
                    insert.executeUpdate();
                }
                try (PreparedStatement insertBinding = connection.prepareStatement("""
                        INSERT INTO media_transcript_attempt_bindings
                          (tenant_id,transcript_id,transcript_revision,job_id,attempt_number,fencing_token,
                           provider_id,provider_operation_id,provider_receipt_id,request_fingerprint,
                           source_artifact_version_ref,transcript_version_ref,result_digest)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """)) {
                    insertBinding.setString(1, draft.tenantId()); insertBinding.setString(2, draft.transcriptId());
                    insertBinding.setInt(3, revision); insertBinding.setString(4, draft.jobId());
                    insertBinding.setInt(5, attemptNumber); insertBinding.setLong(6, fencingToken);
                    insertBinding.setString(7, draft.providerId()); insertBinding.setString(8, binding.providerOperationId());
                    insertBinding.setString(9, binding.providerReceiptId()); insertBinding.setString(10, requestFingerprint);
                    insertBinding.setString(11, draft.sourceVersion()); insertBinding.setString(12, transcriptVersionRef);
                    insertBinding.setString(13, binding.resultDigest()); insertBinding.executeUpdate();
                }
                insertRevisionOutbox(connection, draft, revision, now);
                connection.commit();
                return new TranscriptRevision(draft, revision, now, admissionStatus);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                if (isUniqueViolation((SQLException) failure)) {
                    return resolveConcurrentAttemptAppend(draft, expectedLatestRevision, attemptNumber, fencingToken,
                            requestFingerprint, transcriptVersionRef, (SQLException) failure);
                }
                throw dbFailure("append transcript revision from provider attempt", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw dbFailure("open transcript attempt-binding transaction", failure);
        }
    }

    /** Durable association readback; it exposes identifiers and digests, never transcript content. */
    AttemptBinding attemptBinding(String tenantId, String transcriptId, int revision) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            return binding(connection, tenantId, transcriptId, revision);
        } catch (SQLException failure) {
            throw dbFailure("read transcript attempt binding", failure);
        }
    }

    public record AttemptBinding(String jobId, int attemptNumber, long fencingToken, String providerId,
            String providerOperationId, String providerReceiptId, String requestFingerprint,
            String sourceArtifactVersionRef, String transcriptVersionRef, String resultDigest) { }

    @Override
    public TranscriptAttemptBinding readAttemptBinding(String tenantId, String principalId,
            String transcriptId, int revision) {
        ensureOpen();
        requireNonBlank(tenantId, "tenantId");
        requireNonBlank(principalId, "principalId");
        requireNonBlank(transcriptId, "transcriptId");
        if (revision <= 0) throw new IllegalArgumentException("revision must be positive");
        try (Connection connection = state.connection(); PreparedStatement query = connection.prepareStatement("""
                SELECT b.job_id,b.attempt_number,b.fencing_token,b.provider_id,b.provider_operation_id,
                       b.provider_receipt_id,b.request_fingerprint,b.source_artifact_version_ref,
                       b.transcript_version_ref,b.result_digest
                  FROM media_transcript_attempt_bindings b
                  JOIN media_transcript_revisions r
                    ON r.tenant_id=b.tenant_id AND r.transcript_id=b.transcript_id
                   AND r.revision=b.transcript_revision
                  JOIN media_processing_attempts a
                    ON a.tenant_id=b.tenant_id AND a.job_id=b.job_id
                   AND a.attempt_number=b.attempt_number
                 WHERE b.tenant_id=? AND r.principal_id=? AND b.transcript_id=? AND b.transcript_revision=?
                   AND r.job_id=b.job_id AND r.provider_id=b.provider_id
                   AND r.source_artifact_version=b.source_artifact_version_ref
                   AND a.state='SUCCEEDED' AND a.fencing_token=b.fencing_token
                   AND a.provider_id=b.provider_id AND a.provider_operation_id=b.provider_operation_id
                   AND a.provider_receipt_id=b.provider_receipt_id
                   AND a.request_fingerprint=b.request_fingerprint AND a.result_digest=b.result_digest
                """)) {
            query.setString(1, tenantId);
            query.setString(2, principalId);
            query.setString(3, transcriptId);
            query.setInt(4, revision);
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) {
                    throw new IllegalStateException("Transcript attempt binding is unavailable for requested identity or revision");
                }
                return new TranscriptAttemptBinding(row.getString("job_id"), row.getInt("attempt_number"),
                        row.getLong("fencing_token"), row.getString("provider_id"),
                        row.getString("provider_operation_id"), row.getString("provider_receipt_id"),
                        row.getString("request_fingerprint"), row.getString("source_artifact_version_ref"),
                        row.getString("transcript_version_ref"), row.getString("result_digest"));
            }
        } catch (SQLException failure) {
            throw dbFailure("read scoped transcript attempt binding", failure);
        }
    }

    private AttemptBinding validateAttempt(Connection connection, TranscriptDraft draft, int attemptNumber,
            long fencingToken, String requestFingerprint, String transcriptVersionRef) throws SQLException {
        try (PreparedStatement query = connection.prepareStatement("""
                SELECT a.provider_id,a.provider_operation_id,a.provider_receipt_id,a.request_fingerprint,
                       a.fencing_token,a.state,a.result_json,a.result_digest,
                       j.provider_id AS job_provider,j.status AS job_status,j.job_type,j.artifact_id,j.expected_artifact_version,
                       j.principal_id,j.stt_request_snapshot
                  FROM media_processing_attempts a JOIN media_processing_jobs j
                    ON j.tenant_id=a.tenant_id AND j.job_id=a.job_id
                 WHERE a.tenant_id=? AND a.job_id=? AND a.attempt_number=? FOR UPDATE OF a,j
                """)) {
            query.setString(1, draft.tenantId()); query.setString(2, draft.jobId()); query.setInt(3, attemptNumber);
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) throw new IllegalStateException("Successful durable provider attempt is missing");
                String operation = row.getString("provider_operation_id");
                String receipt = row.getString("provider_receipt_id");
                String resultJson = row.getString("result_json");
                String resultDigest = row.getString("result_digest");
                String provider = row.getString("provider_id");
                if (!"SUCCEEDED".equals(row.getString("state")) || blank(operation) || blank(receipt)
                        || row.getLong("fencing_token") != fencingToken
                        || !requestFingerprint.equals(row.getString("request_fingerprint"))
                        || !draft.providerId().equals(provider) || !provider.equals(row.getString("job_provider"))
                        || !"COMPLETED".equals(row.getString("job_status"))
                        || !"SPEECH_TO_TEXT".equals(row.getString("job_type"))
                        || !draft.sourceArtifactId().equals(row.getString("artifact_id"))
                        || !draft.sourceVersion().equals(row.getString("expected_artifact_version"))
                        || !draft.principalId().equals(row.getString("principal_id"))) {
                    throw new IllegalStateException("Provider attempt does not exactly match candidate tenant, job, provider, source, fingerprint, or fence");
                }
                String computedDigest = sha256(resultJson);
                if (resultDigest == null || !resultDigest.equals(computedDigest)) {
                    throw new IllegalStateException("Provider attempt result digest is missing or inconsistent");
                }
                JsonNode root = state.mapper().readTree(resultJson);
                JsonNode observations = root == null ? null : root.get("semanticObservations");
                JsonNode response = observations == null ? null : observations.get("transcriptResponse");
                JsonNode glossary = observations == null ? null : observations.get("glossaryApplication");
                String sttSnapshotJson = row.getString("stt_request_snapshot");
                String observedFingerprint = observations == null ? null : text(observations, "requestFingerprint");
                if (!requestFingerprint.equals(observedFingerprint)
                        || !validSemanticObservations(observations)
                        || !validGlossary(glossary)
                        || response == null
                        || !validTranscriptResponse(response)
                        || !draft.sourceVersion().equals(text(response, "sourceArtifactVersionRef"))
                        || !requestFingerprint.equals(text(response, "requestFingerprint"))
                        || !transcriptVersionRef.equals(text(response, "transcriptVersionRef"))
                        || !draft.text().equals(text(response, "transcriptText"))
                        || !text(glossary, "disposition").equals(text(response, "glossaryDisposition"))) {
                    throw new IllegalStateException("Candidate transcript is not an exact projection of the persisted provider result");
                }
                // NULL means legacy/unknown, never omission. Unknown request context cannot prove binding.
                if (sttSnapshotJson == null) {
                    throw new IllegalStateException("Transcript request snapshot is unknown for this legacy job");
                }
                // 4 KiB admits worst-case JSON escaping for the 384-codepoint glossary string plus keys/version.
                if (sttSnapshotJson.length() > 4_096) {
                    throw new IllegalStateException("Transcript request snapshot exceeds its persisted size bound");
                }
                JsonNode snapshot = state.mapper().readTree(sttSnapshotJson);
                String requestedGlossary = text(snapshot, "customGlossaryRef");
                String disposition = text(glossary, "disposition");
                String appliedGlossary = text(glossary, "exactGlossaryRef");
                if (!validSttSnapshot(snapshot)
                        || "APPLIED".equals(disposition) && !java.util.Objects.equals(requestedGlossary, appliedGlossary)
                        || "NOT_REQUESTED".equals(disposition) && requestedGlossary != null) {
                    throw new IllegalStateException("Transcript glossary observation does not match the retained request snapshot");
                }
                if (MediaRuntimeContracts.SttSubmissionSnapshot.AUTHORIZED_VERSION.equals(
                        text(snapshot, "version"))
                        && (!draft.rightsDecisionId().equals(text(snapshot, "rightsDecisionId"))
                        || !draft.policyVersion().equals(text(snapshot, "policyVersion"))
                        || !draft.consentDecisionId().equals(text(snapshot, "consentDecisionId"))
                        || blank(text(snapshot, "policyDecisionId")))) {
                    throw new IllegalStateException(
                            "Transcript authority references do not match the immutable job authorization snapshot");
                }
                return new AttemptBinding(draft.jobId(), attemptNumber, fencingToken, provider, operation, receipt,
                        requestFingerprint, draft.sourceVersion(), transcriptVersionRef, resultDigest);
            } catch (tools.jackson.core.JacksonException malformed) {
                throw new IllegalStateException("Provider attempt result is malformed", malformed);
            }
        }
    }

    /**
     * Production ADMITTED writes are allowed only while the durable authority evidence is still
     * current inside this commit boundary: the authorized STT snapshot's rights decision must
     * exist unrevoked and unexpired, match this exact source/job/provider, and carry the same
     * revocation epoch as the still-live source record. Anything else fails the transaction.
     */
    private void verifyProductionSourceRights(Connection connection, TranscriptDraft draft) throws SQLException {
        String snapshotJson;
        try (PreparedStatement job = connection.prepareStatement("""
                SELECT stt_request_snapshot FROM media_processing_jobs
                 WHERE tenant_id=? AND job_id=? AND status='COMPLETED' FOR UPDATE
                """)) {
            job.setString(1, draft.tenantId()); job.setString(2, draft.jobId());
            try (ResultSet result = job.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Production transcript job is missing");
                snapshotJson = result.getString(1);
            }
        }
        final JsonNode snapshot;
        try {
            snapshot = snapshotJson == null ? null : state.mapper().readTree(snapshotJson);
        } catch (tools.jackson.core.JacksonException malformed) {
            throw new IllegalStateException("Production STT job authorization snapshot is malformed", malformed);
        }
        if (!validSttSnapshot(snapshot)
                || !MediaRuntimeContracts.SttSubmissionSnapshot.AUTHORIZED_VERSION.equals(text(snapshot, "version"))
                || !draft.rightsDecisionId().equals(text(snapshot, "rightsDecisionId"))
                || !draft.consentDecisionId().equals(text(snapshot, "consentDecisionId"))
                || !draft.policyVersion().equals(text(snapshot, "policyVersion"))) {
            throw new IllegalStateException(
                    "Production transcript requires an authorized STT job snapshot matching this draft");
        }
        long snapshotEpoch = snapshot.get("revocationEpoch").longValue();
        long now = System.currentTimeMillis();
        long decisionEpoch;
        try (PreparedStatement decision = connection.prepareStatement("""
                SELECT artifact_id,source_version,principal_id,operation,provider_id,revocation_epoch,
                       expires_at,revoked_at
                  FROM media_source_rights_decisions
                 WHERE tenant_id=? AND decision_id=? FOR UPDATE
                """)) {
            decision.setString(1, draft.tenantId()); decision.setString(2, draft.rightsDecisionId());
            try (ResultSet row = decision.executeQuery()) {
                if (!row.next()
                        || row.getObject("revoked_at") != null
                        || row.getLong("expires_at") <= now
                        || !draft.sourceArtifactId().equals(row.getString("artifact_id"))
                        || !draft.sourceVersion().equals(row.getString("source_version"))
                        || !draft.principalId().equals(row.getString("principal_id"))
                        || !"SPEECH_TO_TEXT".equals(row.getString("operation"))
                        || !draft.providerId().equals(row.getString("provider_id"))) {
                    throw new IllegalStateException(
                            "Production transcript rights decision is missing, revoked, expired, or mismatched");
                }
                decisionEpoch = row.getLong("revocation_epoch");
            }
        }
        if (decisionEpoch != snapshotEpoch) {
            throw new IllegalStateException("Production transcript rights decision epoch does not match the job snapshot");
        }
        try (PreparedStatement record = connection.prepareStatement("""
                SELECT revocation_epoch,expires_at,revoked_at FROM media_source_records
                 WHERE tenant_id=? AND artifact_id=? AND source_version=? FOR UPDATE
                """)) {
            record.setString(1, draft.tenantId()); record.setString(2, draft.sourceArtifactId());
            record.setString(3, draft.sourceVersion());
            try (ResultSet row = record.executeQuery()) {
                if (!row.next()
                        || row.getObject("revoked_at") != null
                        || row.getLong("expires_at") <= now
                        || row.getLong("revocation_epoch") != snapshotEpoch) {
                    throw new IllegalStateException(
                            "Production transcript source rights are missing, revoked, expired, or stale");
                }
            }
        }
    }

    private static AttemptBinding binding(Connection connection, String tenantId, String transcriptId, int revision)
            throws SQLException {
        try (PreparedStatement query = connection.prepareStatement("""
                SELECT job_id,attempt_number,fencing_token,provider_id,provider_operation_id,provider_receipt_id,
                       request_fingerprint,source_artifact_version_ref,transcript_version_ref,result_digest
                  FROM media_transcript_attempt_bindings
                 WHERE tenant_id=? AND transcript_id=? AND transcript_revision=?
                """)) {
            query.setString(1, tenantId); query.setString(2, transcriptId); query.setInt(3, revision);
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) throw new IllegalStateException("Transcript attempt binding is missing");
                return new AttemptBinding(row.getString("job_id"), row.getInt("attempt_number"),
                        row.getLong("fencing_token"), row.getString("provider_id"),
                        row.getString("provider_operation_id"), row.getString("provider_receipt_id"),
                        row.getString("request_fingerprint"), row.getString("source_artifact_version_ref"),
                        row.getString("transcript_version_ref"), row.getString("result_digest"));
            }
        }
    }

    /** Content-free transcript revision event is committed atomically with its candidate revision. */
    private void insertRevisionOutbox(Connection connection, TranscriptDraft draft, int revision, long now)
            throws SQLException {
        String identity = draft.tenantId() + "\u0000" + draft.transcriptId() + "\u0000" + revision;
        String eventId = "media:transcript-revision:" + sha256(identity);
        MediaLifecycleEvent event = new MediaLifecycleEvent(
                eventId,
                "media.transcript.revision.created",
                draft.tenantId(),
                draft.principalId(),
                draft.jobId(),
                draft.jobId(),
                "transcript",
                draft.transcriptId(),
                revision,
                "RESTRICTED",
                java.time.Instant.ofEpochMilli(now),
                java.util.Map.of(
                        "transcriptId", draft.transcriptId(),
                        "revision", revision,
                        "sourceArtifactId", draft.sourceArtifactId(),
                        "sourceArtifactVersion", draft.sourceVersion(),
                        "providerId", draft.providerId(),
                        "modelId", draft.modelId(),
                        "language", draft.language(),
                        "rightsDecisionId", draft.rightsDecisionId(),
                        "policyVersion", draft.policyVersion(),
                        "processingPurpose", draft.processingPurpose()));
        final String payload;
        try {
            payload = state.mapper().writeValueAsString(event);
        } catch (Exception failure) {
            throw new IllegalArgumentException("Transcript lifecycle event is not serializable", failure);
        }
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_processing_lifecycle_outbox
                  (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,
                   payload_json,classification,created_at,published_at,attempts,last_error)
                VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL)
                """)) {
            insert.setString(1, event.eventId());
            insert.setString(2, event.tenantId());
            insert.setString(3, event.aggregateType());
            insert.setString(4, event.aggregateId());
            insert.setLong(5, event.aggregateVersion());
            insert.setString(6, event.eventType());
            insert.setString(7, payload);
            insert.setString(8, event.classification());
            insert.setLong(9, now);
            insert.executeUpdate();
        }
    }

    private TranscriptRevision resolveConcurrentAttemptAppend(TranscriptDraft draft, int expectedLatestRevision,
            int attemptNumber, long fencingToken, String requestFingerprint, String transcriptVersionRef,
            SQLException insertFailure) {
        try (Connection connection = state.connection()) {
            TranscriptRevision latest = latest(connection, draft.tenantId(), draft.transcriptId(), false);
            if (latest == null) throw dbFailure("resolve concurrent transcript attempt append", insertFailure);
            if (!latest.draft().principalId().equals(draft.principalId())) throw new TranscriptPrincipalConflictException();
            if (sameDraft(latest.draft(), draft)) {
                try {
                    AttemptBinding actual = binding(connection, draft.tenantId(), draft.transcriptId(), latest.revision());
                    if (actual.jobId().equals(draft.jobId()) && actual.attemptNumber() == attemptNumber
                            && actual.fencingToken() == fencingToken && actual.providerId().equals(draft.providerId())
                            && actual.requestFingerprint().equals(requestFingerprint)
                            && actual.sourceArtifactVersionRef().equals(draft.sourceVersion())
                            && actual.transcriptVersionRef().equals(transcriptVersionRef)) return latest;
                } catch (IllegalStateException missingBinding) {
                    // A legacy, unbound candidate won the unique insert race; it cannot satisfy this retry.
                }
            }
            throw new TranscriptRevisionConflictException(expectedLatestRevision, latest.revision());
        } catch (SQLException readFailure) {
            readFailure.addSuppressed(insertFailure);
            throw dbFailure("resolve concurrent transcript attempt append", readFailure);
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isString() ? value.stringValue() : null;
    }
    private static boolean validGlossary(JsonNode glossary) {
        if (glossary == null || !glossary.isObject() || hasExtraProperties(glossary, java.util.Set.of("disposition", "exactGlossaryRef"))) return false;
        String disposition = text(glossary, "disposition");
        if (!"APPLIED".equals(disposition) && !"NOT_REQUESTED".equals(disposition)) return false;
        if ("APPLIED".equals(disposition)) {
            String ref = text(glossary, "exactGlossaryRef");
            return validOpaqueRef(ref);
        }
        return glossary.get("exactGlossaryRef") == null;
    }
    private static boolean validSemanticObservations(JsonNode observations) {
        if (observations == null || !observations.isObject()
                || hasExtraProperties(observations, java.util.Set.of(
                        "requestFingerprint", "glossaryApplication", "transcriptResponse",
                        "fillerRetakeCandidateObservations"))) return false;
        // Filler candidate observation shape/source-time semantics are not admitted yet.
        // Keep rejecting them even though request-option presence is now retained.
        return observations.get("fillerRetakeCandidateObservations") == null;
    }
    private static boolean validTranscriptResponse(JsonNode response) {
        if (!response.isObject() || hasExtraProperties(response, java.util.Set.of("sourceArtifactVersionRef",
                "requestFingerprint", "transcriptVersionRef", "glossaryDisposition", "transcriptText"))) return false;
        String source = text(response, "sourceArtifactVersionRef");
        String fingerprint = text(response, "requestFingerprint");
        String version = text(response, "transcriptVersionRef");
        String disposition = text(response, "glossaryDisposition");
        JsonNode transcript = response.get("transcriptText");
        return validOpaqueRef(source) && fingerprint != null && fingerprint.matches("[0-9a-f]{64}")
                && validOpaqueRef(version)
                && ("APPLIED".equals(disposition) || "NOT_REQUESTED".equals(disposition))
                && transcript != null && transcript.isString()
                && transcript.stringValue().codePointCount(0, transcript.stringValue().length())
                        <= MAX_TRANSCRIPT_TEXT_CODE_POINTS;
    }
    private static void validateTranscriptText(TranscriptDraft draft) {
        if (draft.text().codePointCount(0, draft.text().length()) > MAX_TRANSCRIPT_TEXT_CODE_POINTS) {
            throw new IllegalArgumentException("Transcript text exceeds the PDP maximum length");
        }
    }
    private static boolean validOpaqueRef(String value) {
        return value != null && !value.isBlank() && value.codePointCount(0, value.length()) <= 384;
    }
    private static boolean validSttSnapshot(JsonNode snapshot) {
        if (snapshot == null || !snapshot.isObject()) return false;
        String version = text(snapshot, "version");
        boolean authorized = MediaRuntimeContracts.SttSubmissionSnapshot.AUTHORIZED_VERSION.equals(version);
        java.util.Set<String> fields = authorized
                ? java.util.Set.of("version", "customGlossaryRef", "fillerRetakeCandidates",
                        "rightsDecisionId", "policyDecisionId", "policyVersion", "consentDecisionId",
                        "sourceClockEvidenceRef", "revocationEpoch")
                : java.util.Set.of("version", "customGlossaryRef", "fillerRetakeCandidates");
        if (hasExtraProperties(snapshot, fields)
                || !MediaRuntimeContracts.SttSubmissionSnapshot.VERSION.equals(version) && !authorized) return false;
        JsonNode glossary = snapshot.get("customGlossaryRef");
        JsonNode filler = snapshot.get("fillerRetakeCandidates");
        boolean baseValid = glossary != null && (glossary.isNull()
                || glossary.isString() && validOpaqueRef(glossary.stringValue()))
                && filler != null && (filler.isNull() || filler.isBoolean());
        if (!baseValid || !authorized) return baseValid;
        JsonNode epoch = snapshot.get("revocationEpoch");
        return validOpaqueRef(text(snapshot, "rightsDecisionId"))
                && validOpaqueRef(text(snapshot, "policyDecisionId"))
                && validOpaqueRef(text(snapshot, "policyVersion"))
                && validOpaqueRef(text(snapshot, "consentDecisionId"))
                && validOpaqueRef(text(snapshot, "sourceClockEvidenceRef"))
                && epoch != null && epoch.isIntegralNumber() && epoch.longValue() >= 0;
    }
    private static boolean hasExtraProperties(JsonNode node, java.util.Set<String> allowed) {
        java.util.Iterator<String> fields = node.properties().stream().map(java.util.Map.Entry::getKey).iterator();
        while (fields.hasNext()) if (!allowed.contains(fields.next())) return true;
        return false;
    }
    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private static String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private void validateSourceJobConsent(Connection connection, TranscriptDraft draft) throws SQLException {
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
        String sttSnapshot;
        try (PreparedStatement job = connection.prepareStatement("""
                SELECT stt_request_snapshot FROM media_processing_jobs
                 WHERE tenant_id=? AND job_id=? AND principal_id=? AND artifact_id=?
                   AND expected_artifact_version=? AND provider_id=? AND status='COMPLETED' FOR UPDATE
                """)) {
            job.setString(1, draft.tenantId()); job.setString(2, draft.jobId());
            job.setString(3, draft.principalId()); job.setString(4, draft.sourceArtifactId());
            job.setString(5, draft.sourceVersion()); job.setString(6, draft.providerId());
            try (ResultSet result = job.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Transcript job does not match tenant, principal, source, version, provider, or completion state");
                sttSnapshot = result.getString("stt_request_snapshot");
            }
        }
        if ("NOT_APPLICABLE_HUMAN_CONSENT".equals(draft.consentDecisionId())) {
            try {
                JsonNode snapshot = sttSnapshot == null ? null : state.mapper().readTree(sttSnapshot);
                if (!validSttSnapshot(snapshot)
                        || !MediaRuntimeContracts.SttSubmissionSnapshot.AUTHORIZED_VERSION.equals(
                                text(snapshot, "version"))
                        || !draft.rightsDecisionId().equals(text(snapshot, "rightsDecisionId"))
                        || !draft.policyVersion().equals(text(snapshot, "policyVersion"))
                        || !draft.consentDecisionId().equals(text(snapshot, "consentDecisionId"))
                        || blank(text(snapshot, "policyDecisionId"))) {
                    throw new IllegalStateException(
                            "Nonhuman consent disposition is not bound to an authorized STT job snapshot");
                }
            } catch (tools.jackson.core.JacksonException malformed) {
                throw new IllegalStateException("STT job authorization snapshot is malformed", malformed);
            }
            return;
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

    private TranscriptRevision latest(Connection connection, String tenant, String transcript, boolean lock)
            throws SQLException {
        String sql = "SELECT * FROM media_transcript_revisions WHERE tenant_id=? AND transcript_id=? "
                + "ORDER BY revision DESC LIMIT 1" + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement query = connection.prepareStatement(sql)) {
            query.setString(1, tenant); query.setString(2, transcript);
            try (ResultSet row = query.executeQuery()) { return row.next() ? read(row) : null; }
        }
    }

    private TranscriptRevision read(ResultSet row) throws SQLException {
        String segmentsJson = row.getString("segments_json");
        List<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment> segments;
        try {
            segments = MediaTranscriptContracts.segmentsFromParameterValue(
                    segmentsJson == null || segmentsJson.isBlank() ? null
                            : state.mapper().readValue(segmentsJson,
                                    new tools.jackson.core.type.TypeReference<List<Map<String, Object>>>() { }));
        } catch (Exception malformed) {
            throw new SQLException("stored transcript segments are malformed", malformed);
        }
        TranscriptDraft draft = new TranscriptDraft(row.getString("tenant_id"), row.getString("principal_id"),
                row.getString("transcript_id"), row.getString("source_artifact_id"),
                row.getString("source_artifact_version"), row.getString("source_sha256"), row.getString("job_id"),
                row.getString("profile_id"), row.getString("provider_id"), row.getString("model_id"),
                row.getString("language"), row.getString("timebase"), row.getString("transcript_text"),
                row.getString("consent_decision_id"), row.getString("rights_decision_id"), row.getString("policy_version"),
                row.getString("purpose_ref"), row.getString("processing_purpose"), segments);
        return new TranscriptRevision(draft, row.getInt("revision"), row.getLong("created_at"),
                row.getString("admission_status"));
    }

    private static boolean sameDraft(TranscriptDraft a, TranscriptDraft b) {
        return a.equals(b);
    }

    private static void requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    }

    private void bind(PreparedStatement s, TranscriptDraft d, int revision, long now) throws SQLException {
        bindFields(s, d, revision);
        s.setLong(20,now);
        s.setString(21, d.timingAvailability().name());
        s.setString(22, segmentsJson(d));
    }

    private void bind(PreparedStatement s, TranscriptDraft d, int revision, long now,
            String admissionStatus) throws SQLException {
        bindFields(s, d, revision);
        s.setString(20,admissionStatus); s.setLong(21,now);
        s.setString(22, d.timingAvailability().name());
        s.setString(23, segmentsJson(d));
    }

    private String segmentsJson(TranscriptDraft draft) throws SQLException {
        try {
            return state.mapper().writeValueAsString(
                    MediaTranscriptContracts.segmentsToParametersValue(draft.segments()));
        } catch (Exception unwritable) {
            throw new SQLException("transcript segments are not JSON serializable", unwritable);
        }
    }

    private static void bindFields(PreparedStatement s, TranscriptDraft d, int revision) throws SQLException {
        s.setString(1,d.tenantId()); s.setString(2,d.transcriptId()); s.setInt(3,revision); s.setString(4,d.principalId());
        s.setString(5,d.sourceArtifactId()); s.setString(6,d.sourceVersion()); s.setString(7,d.sourceSha256());
        s.setString(8,d.jobId()); s.setString(9,d.profileId()); s.setString(10,d.providerId()); s.setString(11,d.modelId());
        s.setString(12,d.language()); s.setString(13,d.timebase()); s.setString(14,d.text());
        s.setString(15,d.consentDecisionId()); s.setString(16,d.purposeRef());
        s.setString(17,d.processingPurpose()); s.setString(18,d.rightsDecisionId());
        s.setString(19,d.policyVersion());
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
    @Override public boolean ready() { return !closed.get() && state.ready(); }
    @Override public boolean productionEligible() { return !closed.get() && state.productionEligible(); }
    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }
}
