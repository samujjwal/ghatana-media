package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaJobResultSanitizer;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobAttemptStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.StartedJobAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStoreConflictException;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptStart;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.RecoveryCursor;
import com.ghatana.media.runtime.MediaLifecycleEvent;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL-backed idempotent and optimistic Media processing job store.
 *
 * @doc.type class
 * @doc.purpose Provide Postgresql Media Job Store behavior
 * @doc.layer product
 * @doc.pattern Repository
 */
public final class PostgresqlMediaJobStore implements MediaJobStore {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    @Override public String storeId() { return "postgresql"; }

    @Override
    public ProcessingJob create(ProcessingJob job, String submissionDigest) {
        ensureOpen();
        java.util.Objects.requireNonNull(job, "job");
        if (submissionDigest == null || !submissionDigest.isBlank()
                && !submissionDigest.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Media submission digest must be a lowercase SHA-256 value");
        }
        ProcessingJob persistable = sanitizeForPersistence(job);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                ProcessingJob existing = byRequest(connection, persistable.tenantId(), persistable.requestId(), true);
                if (existing != null) {
                    verifyRequestIdentity(existing, persistable,
                            submissionDigest(connection, persistable.tenantId(), persistable.requestId()), submissionDigest);
                    connection.commit();
                    return existing;
                }
                try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO media_processing_jobs "
                                + "(tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,"
                                + "started_at,completed_at,result_json,failure_code,version,expected_artifact_version,"
                                + "submission_digest,request_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
                    bind(statement, persistable);
                    statement.setString(16, submissionDigest.isBlank()
                            ? persistable.requestFingerprint() : submissionDigest);
                    statement.setString(17, persistable.requestFingerprint());
                    statement.executeUpdate();
                }
                PostgresqlMediaOutboxPublicationSource.append(connection,
                        new PostgresqlMediaOutboxPublicationSource.MediaLifecycleEventRow(
                                stableEventId("media.job.accepted", persistable.tenantId(), persistable.requestId()),
                                persistable.tenantId(), persistable.principalId(), "MEDIA_JOB_ACCEPTED",
                                Map.of("jobId", persistable.jobId(), "requestId", persistable.requestId(),
                                        "artifactId", persistable.artifactId(), "jobType", persistable.jobType().name(),
                                        "providerId", persistable.providerId(), "status", persistable.status().name()),
                                persistable.createdAt(), persistable.requestId()), state);
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof SQLException sql && "23505".equals(sql.getSQLState())) {
                    ProcessingJob existing = findByRequest(persistable.tenantId(), persistable.requestId());
                    if (existing != null) {
                        verifyRequestIdentity(existing, persistable,
                                findSubmissionDigest(persistable.tenantId(), persistable.requestId()), submissionDigest);
                        return existing;
                    }
                }
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("create Media job", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media job transaction", failure);
        }
    }

    @Override
    public ProcessingJob update(ProcessingJob expected, ProcessingJob updated) {
        ensureOpen();
        validateUpdate(expected, updated);
        requireMutableTransition(expected, updated);
        ProcessingJob persistable = sanitizeForPersistence(updated);
        String sql = "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,"
                + "result_json=?,failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=? "
                + "AND COALESCE(expected_artifact_version,'')=?";
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    statement.setString(1, persistable.providerId());
                    statement.setString(2, persistable.status().name());
                    nullableLong(statement, 3, persistable.startedAt());
                    nullableLong(statement, 4, persistable.completedAt());
                    statement.setString(5, json(persistable.result()));
                    statement.setString(6, persistable.failureCode());
                    statement.setLong(7, persistable.version());
                    statement.setString(8, expected.tenantId());
                    statement.setString(9, expected.jobId());
                    statement.setLong(10, expected.version());
                    statement.setString(11, expected.expectedArtifactVersion());
                    if (statement.executeUpdate() != 1) {
                        throw new MediaJobStoreConflictException("Media job version changed concurrently");
                    }
                }
                if (terminal(persistable.status())) {
                    Instant occurredAt = persistable.completedAt() == null ? Instant.now() : persistable.completedAt();
                    PostgresqlMediaOutboxPublicationSource.append(connection,
                            new PostgresqlMediaOutboxPublicationSource.MediaLifecycleEventRow(
                                    stableEventId("media.job." + persistable.status().name(), persistable.tenantId(),
                                            persistable.jobId() + ":" + persistable.version()),
                                    persistable.tenantId(), persistable.principalId(),
                                    "MEDIA_JOB_" + persistable.status().name(),
                                    Map.of("jobId", persistable.jobId(), "requestId", persistable.requestId(),
                                            "artifactId", persistable.artifactId(), "jobType", persistable.jobType().name(),
                                            "providerId", persistable.providerId(), "status", persistable.status().name(),
                                            "failureCode", persistable.failureCode()), occurredAt, persistable.requestId()), state);
                }
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("update Media job", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media job update transaction", failure);
        }
    }

    @Override
    public ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated) {
        ensureOpen();
        java.util.Objects.requireNonNull(lease, "lease");
        validateUpdate(expected, updated);
        requireMutableTransition(expected, updated);
        if (!lease.tenantId().equals(expected.tenantId()) || !lease.jobId().equals(expected.jobId())) {
            throw new IllegalArgumentException("Media job lease identity is invalid");
        }
        ProcessingJob persistable = sanitizeForPersistence(updated);
        String sql = "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,"
                + "result_json=?,failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=? "
                + "AND COALESCE(expected_artifact_version,'')=? "
                + "AND lease_owner=? AND lease_token=? AND lease_expires_at>?";
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    statement.setString(1, persistable.providerId());
                    statement.setString(2, persistable.status().name());
                    nullableLong(statement, 3, persistable.startedAt());
                    nullableLong(statement, 4, persistable.completedAt());
                    statement.setString(5, json(persistable.result()));
                    statement.setString(6, persistable.failureCode());
                    statement.setLong(7, persistable.version());
                    statement.setString(8, expected.tenantId());
                    statement.setString(9, expected.jobId());
                    statement.setLong(10, expected.version());
                    statement.setString(11, expected.expectedArtifactVersion());
                    statement.setString(12, lease.ownerId());
                    statement.setLong(13, lease.fencingToken());
                    statement.setLong(14, System.currentTimeMillis());
                    if (statement.executeUpdate() != 1) {
                        throw new MediaJobStoreConflictException("Media job lease fence or version changed concurrently");
                    }
                }
                if (terminal(persistable.status())) {
                    Instant occurredAt = persistable.completedAt() == null ? Instant.now() : persistable.completedAt();
                    PostgresqlMediaOutboxPublicationSource.append(connection,
                            new PostgresqlMediaOutboxPublicationSource.MediaLifecycleEventRow(
                                    stableEventId("media.job." + persistable.status().name(), persistable.tenantId(),
                                            persistable.jobId() + ":" + persistable.version()),
                                    persistable.tenantId(), persistable.principalId(),
                                    "MEDIA_JOB_" + persistable.status().name(),
                                    Map.of("jobId", persistable.jobId(), "requestId", persistable.requestId(),
                                            "artifactId", persistable.artifactId(), "jobType", persistable.jobType().name(),
                                            "providerId", persistable.providerId(), "status", persistable.status().name(),
                                            "failureCode", persistable.failureCode()), occurredAt, persistable.requestId()), state);
                }
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("update fenced Media job", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open fenced Media job update transaction", failure);
        }
    }

    @Override
    public Optional<ProcessingJob> find(String tenantId, String jobId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,started_at,completed_at,"
                             + "result_json,failure_code,version,expected_artifact_version,COALESCE(NULLIF(submission_digest,''),request_fingerprint) AS job_fingerprint "
                + "FROM media_processing_jobs "
                             + "WHERE tenant_id=? AND job_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? Optional.of(read(tenantId, jobId, result)) : Optional.empty();
            }
        } catch (SQLException failure) {
            throw databaseFailure("find Media job", failure);
        }
    }

    @Override
    public List<ProcessingJob> list(String tenantId, int limit) {
        ensureOpen();
        if (limit < 1 || limit > 1_000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        List<ProcessingJob> values = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,started_at,"
                             + "completed_at,result_json,failure_code,version,expected_artifact_version,COALESCE(NULLIF(submission_digest,''),request_fingerprint) AS job_fingerprint "
                + "FROM media_processing_jobs "
                             + "WHERE tenant_id=? ORDER BY created_at DESC,job_id LIMIT ?")) {
            statement.setString(1, tenantId);
            statement.setInt(2, limit);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) values.add(read(tenantId, result.getString("job_id"), result));
            }
            return List.copyOf(values);
        } catch (SQLException failure) {
            throw databaseFailure("list Media jobs", failure);
        }
    }

    @Override
    public JobLease claim(ProcessingJob expected, String ownerId, Instant expiresAt) {
        ensureOpen();
        java.util.Objects.requireNonNull(expected, "expected");
        if (ownerId == null || ownerId.isBlank()) throw new IllegalArgumentException("ownerId is required");
        if (expiresAt == null || !expiresAt.isAfter(Instant.now())) {
            throw new IllegalArgumentException("lease expiry must be in the future");
        }
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try (PreparedStatement select = connection.prepareStatement(
                    "SELECT status,version,lease_owner,lease_token,lease_expires_at "
                            + "FROM media_processing_jobs WHERE tenant_id=? AND job_id=? FOR UPDATE")) {
                select.setString(1, expected.tenantId());
                select.setString(2, expected.jobId());
                long token;
                try (ResultSet result = select.executeQuery()) {
                    if (!result.next()
                            || result.getLong("version") != expected.version()
                            || terminal(JobStatus.valueOf(result.getString("status")))) {
                        throw new IllegalStateException("Media job cannot be leased from stale state");
                    }
                    Long priorExpiry = result.getObject("lease_expires_at") == null
                            ? null : result.getLong("lease_expires_at");
                    String priorOwner = result.getString("lease_owner");
                    if (priorExpiry != null && priorExpiry > System.currentTimeMillis()
                            && priorOwner != null && !ownerId.equals(priorOwner)) {
                        throw new IllegalStateException("Media job is leased by another worker");
                    }
                    token = Math.addExact(result.getLong("lease_token"), 1L);
                }
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET lease_owner=?,lease_token=?,lease_expires_at=? "
                                + "WHERE tenant_id=? AND job_id=? AND version=?")) {
                    update.setString(1, ownerId);
                    update.setLong(2, token);
                    update.setLong(3, expiresAt.toEpochMilli());
                    update.setString(4, expected.tenantId());
                    update.setString(5, expected.jobId());
                    update.setLong(6, expected.version());
                    if (update.executeUpdate() != 1) {
                        throw new IllegalStateException("Media job changed while claiming its worker lease");
                    }
                }
                connection.commit();
                return new JobLease(expected.tenantId(), expected.jobId(), ownerId, token, expiresAt);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("claim Media job worker lease", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media job lease transaction", failure);
        }
    }

    @Override
    public boolean leaseValid(JobLease lease) {
        ensureOpen();
        if (lease == null || !lease.expiresAt().isAfter(Instant.now())) return false;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT status FROM media_processing_jobs WHERE tenant_id=? AND job_id=? "
                             + "AND lease_owner=? AND lease_token=? AND lease_expires_at>?")) {
            statement.setString(1, lease.tenantId());
            statement.setString(2, lease.jobId());
            statement.setString(3, lease.ownerId());
            statement.setLong(4, lease.fencingToken());
            statement.setLong(5, System.currentTimeMillis());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() && !terminal(JobStatus.valueOf(result.getString("status")));
            }
        } catch (SQLException failure) {
            throw databaseFailure("verify Media job worker lease", failure);
        }
    }

    @Override
    public void release(JobLease lease) {
        ensureOpen();
        if (lease == null) return;
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "UPDATE media_processing_jobs SET lease_owner=NULL,lease_expires_at=NULL "
                             + "WHERE tenant_id=? AND job_id=? AND lease_owner=? AND lease_token=?")) {
            statement.setString(1, lease.tenantId());
            statement.setString(2, lease.jobId());
            statement.setString(3, lease.ownerId());
            statement.setLong(4, lease.fencingToken());
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw databaseFailure("release Media job worker lease", failure);
        }
    }

    @Override
    public List<ProcessingJob> recoverable(int limit) {
        return recoverableAfter(limit, null);
    }

    @Override
    public List<ProcessingJob> recoverableAfter(int limit, RecoveryCursor cursor) {
        ensureOpen();
        if (limit < 1 || limit > 1_000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        List<ProcessingJob> values = new ArrayList<>();
        String after = cursor == null ? "" : "AND (created_at>? OR (created_at=? AND tenant_id>?) "
                + "OR (created_at=? AND tenant_id=? AND job_id>?)) ";
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,"
                             + "created_at,started_at,completed_at,result_json,failure_code,version,expected_artifact_version,"
                             + "COALESCE(NULLIF(submission_digest,''),request_fingerprint) AS job_fingerprint "
                             + "FROM media_processing_jobs WHERE status IN ('ACCEPTED','RUNNING') "
                             + "AND (lease_expires_at IS NULL OR lease_expires_at<=?) "
                             + after + "ORDER BY created_at,tenant_id,job_id LIMIT ?")) {
            int parameter = 1;
            statement.setLong(parameter++, System.currentTimeMillis());
            if (cursor != null) {
                long createdAt = cursor.createdAt().toEpochMilli();
                statement.setLong(parameter++, createdAt);
                statement.setLong(parameter++, createdAt);
                statement.setString(parameter++, cursor.tenantId());
                statement.setLong(parameter++, createdAt);
                statement.setString(parameter++, cursor.tenantId());
                statement.setString(parameter++, cursor.jobId());
            }
            statement.setInt(parameter, limit);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    values.add(read(result.getString("tenant_id"), result.getString("job_id"), result));
                }
            }
            return List.copyOf(values);
        } catch (SQLException failure) {
            throw databaseFailure("list recoverable Media jobs", failure);
        }
    }

    @Override
    public AttemptStart startAttempt(
            ProcessingJob accepted, ProcessingJob running, JobLease lease,
            int attemptNumber, String requestFingerprint) {
        ensureOpen();
        java.util.Objects.requireNonNull(accepted, "accepted");
        java.util.Objects.requireNonNull(running, "running");
        java.util.Objects.requireNonNull(lease, "lease");
        if (!accepted.tenantId().equals(lease.tenantId()) || !accepted.jobId().equals(lease.jobId())
                || running.status() != JobStatus.RUNNING || running.version() != accepted.version() + 1
                || !running.tenantId().equals(accepted.tenantId()) || !running.jobId().equals(accepted.jobId())
                || !running.requestId().equals(accepted.requestId())
                || !running.principalId().equals(accepted.principalId())
                || !running.artifactId().equals(accepted.artifactId())
                || running.jobType() != accepted.jobType()
                || !running.providerId().equals(accepted.providerId())
                || !running.expectedArtifactVersion().equals(accepted.expectedArtifactVersion())) {
            throw new IllegalArgumentException("attempt lease identity does not match job");
        }
        if (attemptNumber < 1 || requestFingerprint == null || !requestFingerprint.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("attempt number and canonical request fingerprint are required");
        }
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement lock = connection.prepareStatement(
                        "SELECT status,version,lease_owner,lease_token,lease_expires_at FROM media_processing_jobs "
                                + "WHERE tenant_id=? AND job_id=? FOR UPDATE")) {
                    lock.setString(1, accepted.tenantId());
                    lock.setString(2, accepted.jobId());
                    try (ResultSet row = lock.executeQuery()) {
                        if (!row.next() || row.getLong("version") != accepted.version()
                                || !"ACCEPTED".equals(row.getString("status"))
                                || !lease.ownerId().equals(row.getString("lease_owner"))
                                || lease.fencingToken() != row.getLong("lease_token")
                                || row.getLong("lease_expires_at") <= System.currentTimeMillis()) {
                            throw new IllegalStateException("stale Media attempt fence");
                        }
                    }
                }
                try (PreparedStatement updateJob = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET status='RUNNING',started_at=?,completed_at=NULL,"
                                + "result_json='{}',failure_code='',version=? WHERE tenant_id=? AND job_id=? "
                                + "AND status='ACCEPTED' AND version=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?")) {
                    updateJob.setLong(1, running.startedAt() == null ? System.currentTimeMillis() : running.startedAt().toEpochMilli());
                    updateJob.setLong(2, running.version());
                    updateJob.setString(3, accepted.tenantId());
                    updateJob.setString(4, accepted.jobId());
                    updateJob.setLong(5, accepted.version());
                    updateJob.setString(6, lease.ownerId());
                    updateJob.setLong(7, lease.fencingToken());
                    updateJob.setLong(8, System.currentTimeMillis());
                    if (updateJob.executeUpdate() != 1) throw new IllegalStateException("stale Media start-attempt job fence");
                }
                ProcessingAttempt attempt = new ProcessingAttempt(
                        accepted.tenantId(), accepted.jobId(), accepted.requestId(), attemptNumber,
                        lease.fencingToken(), requestFingerprint, accepted.providerId(), "", "",
                        AttemptFinality.UNKNOWN, "", "", null);
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO media_processing_attempts (tenant_id,job_id,attempt_number,request_id,provider_id,"
                                + "request_fingerprint,lease_owner,fencing_token,state,provider_operation_id,provider_receipt_id,"
                                + "result_json,result_digest,provenance_json,observation_json,created_at,updated_at,observed_at) "
                                + "VALUES (?,?,?,?,?,?,?,?,'DISPATCH_INTENDED',NULL,NULL,'{}',NULL,'{}','{}',?,?,NULL)")) {
                    insert.setString(1, attempt.tenantId());
                    insert.setString(2, attempt.jobId());
                    insert.setInt(3, attempt.attemptNumber());
                    insert.setString(4, attempt.requestId());
                    insert.setString(5, attempt.providerId());
                    insert.setString(6, attempt.requestFingerprint());
                    insert.setString(7, lease.ownerId());
                    insert.setLong(8, lease.fencingToken());
                    insert.setLong(9, System.currentTimeMillis());
                    insert.setLong(10, System.currentTimeMillis());
                    insert.executeUpdate();
                }
                Map<String, Object> payload = Map.of(
                        "jobId", attempt.jobId(), "requestId", attempt.requestId(),
                        "attemptNumber", attempt.attemptNumber(), "fencingToken", attempt.fencingToken(),
                        "providerId", attempt.providerId(), "state", "DISPATCH_INTENDED");
                insertOutbox(connection, new MediaLifecycleEvent(
                        "media:attempt-dispatch:" + attempt.jobId() + ":" + attempt.attemptNumber(),
                        "media.job.attempt.dispatch_intended", attempt.tenantId(), accepted.principalId(),
                        attempt.requestId(), attempt.requestId(), "job", attempt.jobId(), running.version(),
                        "INTERNAL", Instant.now(), payload));
                connection.commit();
                return new AttemptStart(running, attempt);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("atomically start fenced Media attempt", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open atomic Media attempt transaction", failure);
        }
    }

    @Override
    public long countByStatus(JobStatus status) {
        ensureOpen();
        java.util.Objects.requireNonNull(status, "status");
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_jobs WHERE status=?")) {
            statement.setString(1, status.name());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getLong(1) : 0L;
            }
        } catch (SQLException failure) {
            throw databaseFailure("count Media jobs by status", failure);
        }
    }

    @Override
    public long countOverdueLeases(Instant now) {
        ensureOpen();
        java.util.Objects.requireNonNull(now, "now");
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_jobs "
                             + "WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?")) {
            statement.setLong(1, now.toEpochMilli());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getLong(1) : 0L;
            }
        } catch (SQLException failure) {
            throw databaseFailure("count overdue Media job leases", failure);
        }
    }

    @Override
    public StartedJobAttempt startAttempt(ProcessingJob expected, String ownerId, Instant expiresAt, String providerId) {
        ensureOpen();
        if (ownerId == null || ownerId.isBlank()) throw new IllegalArgumentException("ownerId is required");
        if (providerId == null || providerId.isBlank()) throw new IllegalArgumentException("providerId is required");
        if (expiresAt == null || !expiresAt.isAfter(Instant.now())) throw new IllegalArgumentException("lease expiry must be in the future");
        ProcessingJob running = new ProcessingJob(expected.jobId(), expected.requestId(), expected.tenantId(),
                expected.principalId(), expected.artifactId(), expected.jobType(), providerId, JobStatus.RUNNING,
                expected.createdAt(), Instant.now(), null, Map.of(), "", expected.version() + 1,
                expected.expectedArtifactVersion(), expected.requestFingerprint());
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                long token;
                try (PreparedStatement select = connection.prepareStatement(
                        "SELECT status,version,lease_owner,lease_token,lease_expires_at FROM media_processing_jobs "
                                + "WHERE tenant_id=? AND job_id=? FOR UPDATE")) {
                    select.setString(1, expected.tenantId());
                    select.setString(2, expected.jobId());
                    try (ResultSet result = select.executeQuery()) {
                        if (!result.next() || result.getLong("version") != expected.version()
                                || !JobStatus.ACCEPTED.name().equals(result.getString("status"))) {
                            throw new IllegalStateException("Media job cannot start from stale state");
                        }
                        Long priorExpiry = result.getObject("lease_expires_at") == null
                                ? null : result.getLong("lease_expires_at");
                        String priorOwner = result.getString("lease_owner");
                        if (priorExpiry != null && priorExpiry > System.currentTimeMillis()
                                && priorOwner != null && !ownerId.equals(priorOwner)) {
                            throw new IllegalStateException("Media job is leased by another worker");
                        }
                        token = Math.addExact(result.getLong("lease_token"), 1L);
                    }
                }
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET provider_id=?,status='RUNNING',started_at=?,version=?,"
                                + "lease_owner=?,lease_token=?,lease_expires_at=? WHERE tenant_id=? AND job_id=? "
                                + "AND version=? AND status='ACCEPTED' AND COALESCE(expected_artifact_version,'')=?")) {
                    update.setString(1, providerId);
                    update.setLong(2, running.startedAt().toEpochMilli());
                    update.setLong(3, running.version());
                    update.setString(4, ownerId);
                    update.setLong(5, token);
                    update.setLong(6, expiresAt.toEpochMilli());
                    update.setString(7, expected.tenantId());
                    update.setString(8, expected.jobId());
                    update.setLong(9, expected.version());
                    update.setString(10, expected.expectedArtifactVersion());
                    if (update.executeUpdate() != 1) throw new IllegalStateException("Media job changed while starting provider attempt");
                }
                int attemptNumber;
                try (PreparedStatement next = connection.prepareStatement(
                        "SELECT COALESCE(MAX(attempt_number),0)+1 FROM media_processing_job_attempts WHERE tenant_id=? AND job_id=?")) {
                    next.setString(1, expected.tenantId());
                    next.setString(2, expected.jobId());
                    try (ResultSet row = next.executeQuery()) {
                        row.next();
                        attemptNumber = row.getInt(1);
                    }
                }
                JobLease lease = new JobLease(expected.tenantId(), expected.jobId(), ownerId, token, expiresAt);
                JobAttempt attempt = new JobAttempt(expected.tenantId(), expected.jobId(), attemptNumber, providerId,
                        expected.requestId(), token, JobAttemptStatus.DISPATCH_INTENT, running.startedAt(), null, "");
                insertAttemptAndIntent(connection, attempt);
                connection.commit();
                return new StartedJobAttempt(running, lease, attempt);
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("atomically start Media provider attempt", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media provider start transaction", failure);
        }
    }

    @Override
    public ProcessingAttempt recordProviderReceipt(
            ProcessingAttempt attempt, JobLease lease, String providerOperationId, String providerReceiptId) {
        ensureOpen();
        java.util.Objects.requireNonNull(attempt, "attempt");
        java.util.Objects.requireNonNull(lease, "lease");
        if (!attempt.tenantId().equals(lease.tenantId()) || !attempt.jobId().equals(lease.jobId())
                || attempt.fencingToken() != lease.fencingToken()) {
            throw new IllegalArgumentException("provider receipt lease identity does not match attempt");
        }
        if (providerOperationId == null || providerOperationId.isBlank()
                || providerReceiptId == null || providerReceiptId.isBlank()) {
            throw new IllegalArgumentException("provider operation and receipt IDs are required");
        }
        String sql = "UPDATE media_processing_attempts a SET provider_operation_id=?,provider_receipt_id=?,updated_at=? "
                + "FROM media_processing_jobs j WHERE a.tenant_id=? AND a.job_id=? AND a.attempt_number=? "
                + "AND a.fencing_token=? AND a.request_id=? AND a.provider_id=? AND a.request_fingerprint=? "
                + "AND a.lease_owner=? AND a.state='DISPATCH_INTENDED' "
                + "AND a.provider_operation_id IS NULL AND a.provider_receipt_id IS NULL "
                + "AND j.tenant_id=a.tenant_id AND j.job_id=a.job_id "
                + "AND j.lease_owner=? AND j.lease_token=? AND j.lease_expires_at>?";
        try (Connection connection = state.connection(); PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, providerOperationId);
            statement.setString(2, providerReceiptId);
            statement.setLong(3, System.currentTimeMillis());
            statement.setString(4, attempt.tenantId());
            statement.setString(5, attempt.jobId());
            statement.setInt(6, attempt.attemptNumber());
            statement.setLong(7, attempt.fencingToken());
            statement.setString(8, attempt.requestId());
            statement.setString(9, attempt.providerId());
            statement.setString(10, attempt.requestFingerprint());
            statement.setString(11, lease.ownerId());
            statement.setString(12, lease.ownerId());
            statement.setLong(13, lease.fencingToken());
            statement.setLong(14, System.currentTimeMillis());
            if (statement.executeUpdate() != 1) throw new IllegalStateException("stale Media attempt receipt fence");
            return new ProcessingAttempt(attempt.tenantId(), attempt.jobId(), attempt.requestId(),
                    attempt.attemptNumber(), attempt.fencingToken(), attempt.requestFingerprint(), attempt.providerId(),
                    providerOperationId, providerReceiptId, AttemptFinality.UNKNOWN, "", "", null);
        } catch (SQLException failure) {
            throw databaseFailure("persist provider attempt receipt", failure);
        }
    }

    @Override
    public ProcessingJob commitFinalOutcome(
            ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob terminal,
            ProviderAttemptObservation observation, MediaLifecycleEvent lifecycleEvent) {
        ensureOpen();
        validateUpdate(expected, terminal);
        if (!terminal(terminal.status())) throw new IllegalArgumentException("final outcome requires a terminal job state");
        if (observation == null || attempt == null || lifecycleEvent == null
                || !observation.query().equals(attempt.query())
                || !lifecycleEvent.tenantId().equals(expected.tenantId())
                || !lifecycleEvent.aggregateId().equals(expected.jobId())
                || lifecycleEvent.aggregateVersion() != terminal.version()) {
            throw new IllegalArgumentException("Media final outcome identity does not match job attempt");
        }
        boolean compatible = switch (observation.finality()) {
            case SUCCEEDED -> terminal.status() == JobStatus.COMPLETED
                    || (terminal.status() == JobStatus.FAILED
                    && "RESULT_GOVERNANCE_FAILED".equals(terminal.failureCode()));
            case FAILED, NO_EFFECT_PROVEN -> terminal.status() == JobStatus.FAILED;
            case UNKNOWN -> terminal.status() == JobStatus.OUTCOME_UNKNOWN;
        };
        if (!compatible) throw new IllegalArgumentException("provider finality is incompatible with terminal job status");
        ProcessingJob persistable = sanitizeForPersistence(terminal);
        String resultJson = json(persistable.result());
        String resultJsonFromObservation = json(observation.result());
        String resultDigest = sha256(resultJsonFromObservation);
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                String stateName = switch (observation.finality()) {
                    case SUCCEEDED -> "SUCCEEDED";
                    case FAILED -> "FAILED";
                    case NO_EFFECT_PROVEN -> "NO_EFFECT_PROVEN";
                    case UNKNOWN -> "OUTCOME_UNKNOWN";
                };
                try (PreparedStatement updateAttempt = connection.prepareStatement(
                        "UPDATE media_processing_attempts SET state=?,result_json=?,result_digest=?,provenance_json=?,"
                                + "observation_json=?,observed_at=?,updated_at=? WHERE tenant_id=? AND job_id=? "
                                + "AND attempt_number=? AND fencing_token=? AND provider_operation_id=? AND provider_receipt_id=? "
                                + "AND state IN ('DISPATCH_INTENDED','OUTCOME_UNKNOWN')")) {
                    updateAttempt.setString(1, stateName);
                    updateAttempt.setString(2, resultJsonFromObservation);
                    updateAttempt.setString(3, observation.result().isEmpty() ? null : resultDigest);
                    updateAttempt.setString(4, json(Map.of("providerId", attempt.providerId(),
                            "requestFingerprint", attempt.requestFingerprint(), "resultDigest", resultDigest,
                            "provenanceDigest", observation.provenanceDigest())));
                    updateAttempt.setString(5, json(observation));
                    updateAttempt.setLong(6, observation.observedAt().toEpochMilli());
                    updateAttempt.setLong(7, now);
                    updateAttempt.setString(8, attempt.tenantId());
                    updateAttempt.setString(9, attempt.jobId());
                    updateAttempt.setInt(10, attempt.attemptNumber());
                    updateAttempt.setLong(11, attempt.fencingToken());
                    updateAttempt.setString(12, observation.query().providerOperationId());
                    updateAttempt.setString(13, observation.query().providerReceiptId());
                    if (updateAttempt.executeUpdate() != 1) throw new IllegalStateException("Media attempt finality fence changed");
                }
                String jobSql = "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,"
                        + "result_json=?,failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=? "
                        + "AND COALESCE(expected_artifact_version,'')=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?";
                try (PreparedStatement updateJob = connection.prepareStatement(jobSql)) {
                    updateJob.setString(1, persistable.providerId());
                    updateJob.setString(2, persistable.status().name());
                    nullableLong(updateJob, 3, persistable.startedAt());
                    nullableLong(updateJob, 4, persistable.completedAt());
                    updateJob.setString(5, resultJson);
                    updateJob.setString(6, persistable.failureCode());
                    updateJob.setLong(7, persistable.version());
                    updateJob.setString(8, expected.tenantId());
                    updateJob.setString(9, expected.jobId());
                    updateJob.setLong(10, expected.version());
                    updateJob.setString(11, expected.expectedArtifactVersion());
                    updateJob.setString(12, attemptLeaseOwner(connection, attempt));
                    updateJob.setLong(13, attempt.fencingToken());
                    updateJob.setLong(14, System.currentTimeMillis());
                    if (updateJob.executeUpdate() != 1) throw new IllegalStateException("Media job finality fence changed");
                }
                insertOutbox(connection, lifecycleEvent);
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("commit atomic Media final outcome", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media final outcome transaction", failure);
        }
    }

    @Override
    public JobAttempt beginAttempt(JobAttempt attempt) {
        ensureOpen();
        java.util.Objects.requireNonNull(attempt, "attempt");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                insertAttemptAndIntent(connection, attempt);
                connection.commit();
                return attempt;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("persist Media provider dispatch intent", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open Media provider dispatch transaction", failure);
        }
    }

    private void insertAttemptAndIntent(Connection connection, JobAttempt attempt) throws SQLException {
        try (PreparedStatement lease = connection.prepareStatement(
                "SELECT 1 FROM media_processing_jobs WHERE tenant_id=? AND job_id=? AND request_id=? "
                        + "AND status='RUNNING' AND lease_token=? AND lease_owner IS NOT NULL "
                        + "AND lease_expires_at>? FOR UPDATE")) {
            lease.setString(1, attempt.tenantId());
            lease.setString(2, attempt.jobId());
            lease.setString(3, attempt.requestId());
            lease.setLong(4, attempt.fencingToken());
            lease.setLong(5, System.currentTimeMillis());
            try (ResultSet result = lease.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Media attempt lost its worker fencing lease");
            }
        }
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_processing_job_attempts (tenant_id,job_id,attempt_number,provider_id,request_id,"
                        + "fencing_token,status,created_at,completed_at,outcome_code) VALUES (?,?,?,?,?,?,?,?,?,?)")) {
            bindAttempt(insert, attempt);
            insert.executeUpdate();
        }
        try (PreparedStatement intent = connection.prepareStatement(
                "INSERT INTO media_job_dispatch_intents (tenant_id,job_id,attempt_number,provider_id,request_id,fencing_token,created_at) "
                        + "VALUES (?,?,?,?,?,?,?)")) {
            intent.setString(1, attempt.tenantId());
            intent.setString(2, attempt.jobId());
            intent.setInt(3, attempt.attemptNumber());
            intent.setString(4, attempt.providerId());
            intent.setString(5, attempt.requestId());
            intent.setLong(6, attempt.fencingToken());
            intent.setLong(7, attempt.createdAt().toEpochMilli());
            intent.executeUpdate();
        }
        PostgresqlMediaOutboxPublicationSource.append(connection,
                new PostgresqlMediaOutboxPublicationSource.MediaLifecycleEventRow(
                        stableEventId("media.job.dispatch", attempt.tenantId(), attempt.jobId() + ":" + attempt.attemptNumber()),
                        attempt.tenantId(), attempt.tenantId(), "MEDIA_JOB_DISPATCH_INTENT",
                        Map.of("jobId", attempt.jobId(), "attemptNumber", attempt.attemptNumber(),
                                "providerId", attempt.providerId(), "requestId", attempt.requestId(),
                                "fencingToken", attempt.fencingToken()),
                        attempt.createdAt(), attempt.requestId()), state);
    }

    @Override
    public void finishAttempt(JobAttempt attempt, JobAttemptStatus status, Instant completedAt, String outcomeCode) {
        ensureOpen();
        if (status == JobAttemptStatus.DISPATCH_INTENT || status == JobAttemptStatus.RUNNING) {
            throw new IllegalArgumentException("attempt completion requires a terminal provider outcome");
        }
        try (Connection connection = state.connection(); PreparedStatement update = connection.prepareStatement(
                "UPDATE media_processing_job_attempts SET status=?,completed_at=?,outcome_code=? "
                        + "WHERE tenant_id=? AND job_id=? AND attempt_number=? AND fencing_token=? "
                        + "AND status IN ('DISPATCH_INTENT','RUNNING')")) {
            update.setString(1, status.name());
            update.setLong(2, (completedAt == null ? Instant.now() : completedAt).toEpochMilli());
            update.setString(3, outcomeCode == null ? "" : outcomeCode);
            update.setString(4, attempt.tenantId());
            update.setString(5, attempt.jobId());
            update.setInt(6, attempt.attemptNumber());
            update.setLong(7, attempt.fencingToken());
            if (update.executeUpdate() != 1) throw new IllegalStateException("Media attempt is stale or already final");
        } catch (SQLException failure) {
            throw databaseFailure("finish Media provider attempt", failure);
        }
    }

    @Override
    public ProcessingJob markOutcomeUnknown(
            ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob unknown,
            Map<String, Object> observation, MediaLifecycleEvent lifecycleEvent) {
        ensureOpen();
        validateUpdate(expected, unknown);
        if (unknown.status() != JobStatus.OUTCOME_UNKNOWN || attempt == null || lifecycleEvent == null) {
            throw new IllegalArgumentException("unknown outcome requires an attempt and OUTCOME_UNKNOWN job");
        }
        if (!expected.tenantId().equals(attempt.tenantId()) || !expected.jobId().equals(attempt.jobId())
                || !expected.requestId().equals(attempt.requestId())
                || lifecycleEvent.aggregateVersion() != unknown.version()) {
            throw new IllegalArgumentException("unknown outcome identity does not match job attempt");
        }
        ProcessingJob persistable = sanitizeForPersistence(unknown);
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement updateAttempt = connection.prepareStatement(
                        "UPDATE media_processing_attempts SET state='OUTCOME_UNKNOWN',observation_json=?,observed_at=?,updated_at=? "
                                + "WHERE tenant_id=? AND job_id=? AND attempt_number=? AND fencing_token=? "
                                + "AND state IN ('DISPATCH_INTENDED','OUTCOME_UNKNOWN')")) {
                    updateAttempt.setString(1, json(observation == null ? Map.of() : observation));
                    updateAttempt.setLong(2, now);
                    updateAttempt.setLong(3, now);
                    updateAttempt.setString(4, attempt.tenantId());
                    updateAttempt.setString(5, attempt.jobId());
                    updateAttempt.setInt(6, attempt.attemptNumber());
                    updateAttempt.setLong(7, attempt.fencingToken());
                    if (updateAttempt.executeUpdate() != 1) throw new IllegalStateException("Media attempt fence changed");
                }
                try (PreparedStatement updateJob = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,result_json=?,"
                                + "failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=? "
                                + "AND COALESCE(expected_artifact_version,'')=? AND lease_owner=? AND lease_token=? "
                                + "AND lease_expires_at>?")) {
                    updateJob.setString(1, persistable.providerId());
                    updateJob.setString(2, persistable.status().name());
                    nullableLong(updateJob, 3, persistable.startedAt());
                    nullableLong(updateJob, 4, persistable.completedAt());
                    updateJob.setString(5, json(persistable.result()));
                    updateJob.setString(6, persistable.failureCode());
                    updateJob.setLong(7, persistable.version());
                    updateJob.setString(8, expected.tenantId());
                    updateJob.setString(9, expected.jobId());
                    updateJob.setLong(10, expected.version());
                    updateJob.setString(11, expected.expectedArtifactVersion());
                    updateJob.setString(12, attemptLeaseOwner(connection, attempt));
                    updateJob.setLong(13, attempt.fencingToken());
                    updateJob.setLong(14, now);
                    if (updateJob.executeUpdate() != 1) throw new IllegalStateException("Media job fence changed");
                }
                insertOutbox(connection, lifecycleEvent);
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("persist unknown Media provider outcome", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open unknown Media outcome transaction", failure);
        }
    }

    @Override
    public ProcessingJob markPreDispatchNoEffect(
            ProcessingJob expected, ProcessingAttempt attempt, ProcessingJob failed,
            MediaLifecycleEvent lifecycleEvent) {
        ensureOpen();
        validateUpdate(expected, failed);
        if (failed.status() != JobStatus.FAILED || attempt == null || lifecycleEvent == null
                || !lifecycleEvent.tenantId().equals(expected.tenantId())
                || !lifecycleEvent.aggregateId().equals(expected.jobId())
                || lifecycleEvent.aggregateVersion() != failed.version()) {
            throw new IllegalArgumentException("pre-dispatch finality identity does not match job attempt");
        }
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement updateAttempt = connection.prepareStatement(
                        "UPDATE media_processing_attempts SET state='NO_EFFECT_PROVEN',"
                                + "observation_json=?,observed_at=?,updated_at=? WHERE tenant_id=? AND job_id=? "
                                + "AND attempt_number=? AND fencing_token=? AND state='DISPATCH_INTENDED' "
                                + "AND provider_operation_id IS NULL AND provider_receipt_id IS NULL")) {
                    updateAttempt.setString(1, json(Map.of("finality", "NO_EFFECT_PROVEN", "reason", "POLICY_DENIED")));
                    updateAttempt.setLong(2, now);
                    updateAttempt.setLong(3, now);
                    updateAttempt.setString(4, attempt.tenantId());
                    updateAttempt.setString(5, attempt.jobId());
                    updateAttempt.setInt(6, attempt.attemptNumber());
                    updateAttempt.setLong(7, attempt.fencingToken());
                    if (updateAttempt.executeUpdate() != 1) throw new IllegalStateException("Media pre-dispatch attempt fence changed");
                }
                ProcessingJob persistable = sanitizeForPersistence(failed);
                try (PreparedStatement updateJob = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET status=?,started_at=?,completed_at=?,result_json=?,failure_code=?,version=? "
                                + "WHERE tenant_id=? AND job_id=? AND version=? AND lease_owner=? AND lease_token=? AND lease_expires_at>?")) {
                    updateJob.setString(1, persistable.status().name());
                    nullableLong(updateJob, 2, persistable.startedAt());
                    nullableLong(updateJob, 3, persistable.completedAt());
                    updateJob.setString(4, json(persistable.result()));
                    updateJob.setString(5, persistable.failureCode());
                    updateJob.setLong(6, persistable.version());
                    updateJob.setString(7, expected.tenantId());
                    updateJob.setString(8, expected.jobId());
                    updateJob.setLong(9, expected.version());
                    updateJob.setString(10, attemptLeaseOwner(connection, attempt));
                    updateJob.setLong(11, attempt.fencingToken());
                    updateJob.setLong(12, now);
                    if (updateJob.executeUpdate() != 1) throw new IllegalStateException("Media pre-dispatch job fence changed");
                }
                insertOutbox(connection, lifecycleEvent);
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("persist pre-dispatch Media denial", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open pre-dispatch Media denial transaction", failure);
        }
    }

    @Override
    public ProcessingJob reconcileExpired(
            ProcessingJob expected, ProcessingJob terminal, MediaLifecycleEvent lifecycleEvent) {
        ensureOpen();
        validateUpdate(expected, terminal);
        if (!terminal(terminal.status()) || lifecycleEvent == null
                || !expected.tenantId().equals(lifecycleEvent.tenantId())
                || !expected.jobId().equals(lifecycleEvent.aggregateId())
                || lifecycleEvent.aggregateVersion() != terminal.version()) {
            throw new IllegalArgumentException("expired-job reconciliation event does not match terminal job");
        }
        ProcessingJob persistable = sanitizeForPersistence(terminal);
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                try (PreparedStatement attemptLock = connection.prepareStatement(
                        "SELECT attempt_number,state FROM media_processing_attempts WHERE tenant_id=? AND job_id=? "
                                + "ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE")) {
                    attemptLock.setString(1, expected.tenantId());
                    attemptLock.setString(2, expected.jobId());
                    try (ResultSet row = attemptLock.executeQuery()) {
                        if (row.next()) {
                            String attemptState = row.getString("state");
                            if ("SUCCEEDED".equals(attemptState) || "FAILED".equals(attemptState)
                                    || "NO_EFFECT_PROVEN".equals(attemptState)) {
                                throw new IllegalStateException("durable provider finality requires exact job reconciliation");
                            }
                            try (PreparedStatement updateAttempt = connection.prepareStatement(
                                    "UPDATE media_processing_attempts SET state='OUTCOME_UNKNOWN',"
                                            + "observation_json=?,observed_at=?,updated_at=? WHERE tenant_id=? AND job_id=? "
                                            + "AND attempt_number=? AND state IN ('DISPATCH_INTENDED','OUTCOME_UNKNOWN')")) {
                                updateAttempt.setString(1, json(Map.of(
                                        "finality", "UNKNOWN", "source", "recovery", "observedAt", now)));
                                updateAttempt.setLong(2, now);
                                updateAttempt.setLong(3, now);
                                updateAttempt.setString(4, expected.tenantId());
                                updateAttempt.setString(5, expected.jobId());
                                updateAttempt.setInt(6, row.getInt("attempt_number"));
                                if (updateAttempt.executeUpdate() != 1) {
                                    throw new IllegalStateException("Media attempt recovery state changed");
                                }
                            }
                        } else if (expected.status() == JobStatus.RUNNING
                                && terminal.status() != JobStatus.OUTCOME_UNKNOWN) {
                            throw new IllegalArgumentException("running job without an attempt must remain unknown");
                        }
                    }
                }
                try (PreparedStatement updateJob = connection.prepareStatement(
                        "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,result_json=?,"
                                + "failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=? "
                                + "AND COALESCE(expected_artifact_version,'')=? "
                                + "AND (lease_expires_at IS NULL OR lease_expires_at<=?)")) {
                    updateJob.setString(1, persistable.providerId());
                    updateJob.setString(2, persistable.status().name());
                    nullableLong(updateJob, 3, persistable.startedAt());
                    nullableLong(updateJob, 4, persistable.completedAt());
                    updateJob.setString(5, json(persistable.result()));
                    updateJob.setString(6, persistable.failureCode());
                    updateJob.setLong(7, persistable.version());
                    updateJob.setString(8, expected.tenantId());
                    updateJob.setString(9, expected.jobId());
                    updateJob.setLong(10, expected.version());
                    updateJob.setString(11, expected.expectedArtifactVersion());
                    updateJob.setLong(12, now);
                    if (updateJob.executeUpdate() != 1) throw new IllegalStateException("Media recovery job fence changed");
                }
                insertOutbox(connection, lifecycleEvent);
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw databaseFailure("reconcile expired Media job", (SQLException) failure);
            }
        } catch (SQLException failure) {
            throw databaseFailure("open expired Media reconciliation transaction", failure);
        }
    }

    private String attemptLeaseOwner(Connection connection, ProcessingAttempt attempt) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT lease_owner FROM media_processing_attempts WHERE tenant_id=? AND job_id=? "
                        + "AND attempt_number=? AND fencing_token=?")) {
            statement.setString(1, attempt.tenantId());
            statement.setString(2, attempt.jobId());
            statement.setInt(3, attempt.attemptNumber());
            statement.setLong(4, attempt.fencingToken());
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) throw new IllegalStateException("Media attempt is missing");
                return row.getString("lease_owner");
            }
        }
    }

    private void insertOutbox(Connection connection, MediaLifecycleEvent event) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO media_processing_lifecycle_outbox (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,"
                        + "event_type,payload_json,classification,created_at,published_at,attempts,last_error) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL)")) {
            statement.setString(1, event.eventId());
            statement.setString(2, event.tenantId());
            statement.setString(3, event.aggregateType());
            statement.setString(4, event.aggregateId());
            statement.setLong(5, event.aggregateVersion());
            statement.setString(6, event.eventType());
            statement.setString(7, json(event));
            statement.setString(8, event.classification());
            statement.setLong(9, event.occurredAt().toEpochMilli());
            statement.executeUpdate();
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    @Override
    public Optional<JobAttempt> latestAttempt(String tenantId, String jobId) {
        ensureOpen();
        try (Connection connection = state.connection(); PreparedStatement statement = connection.prepareStatement(
                "SELECT attempt_number,provider_id,request_id,fencing_token,status,created_at,completed_at,outcome_code "
                        + "FROM media_processing_job_attempts WHERE tenant_id=? AND job_id=? "
                        + "ORDER BY attempt_number DESC LIMIT 1")) {
            statement.setString(1, tenantId);
            statement.setString(2, jobId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) return Optional.empty();
                Long completed = result.getObject("completed_at") == null ? null : result.getLong("completed_at");
                return Optional.of(new JobAttempt(tenantId, jobId, result.getInt("attempt_number"),
                        result.getString("provider_id"), result.getString("request_id"),
                        result.getLong("fencing_token"), JobAttemptStatus.valueOf(result.getString("status")),
                        Instant.ofEpochMilli(result.getLong("created_at")),
                        completed == null ? null : Instant.ofEpochMilli(completed), result.getString("outcome_code")));
            }
        } catch (SQLException failure) {
            throw databaseFailure("read exact Media provider attempt", failure);
        }
    }

    @Override public boolean durable() { return true; }
    @Override public boolean productionEligible() { return state.productionEligible(); }
    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }

    private ProcessingJob byRequest(Connection connection, String tenantId, String requestId, boolean lock)
            throws SQLException {
        String sql = "SELECT job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,started_at,"
                + "completed_at,result_json,failure_code,version,expected_artifact_version,COALESCE(NULLIF(submission_digest,''),request_fingerprint) AS job_fingerprint "
                + "FROM media_processing_jobs "
                + "WHERE tenant_id=? AND request_id=?" + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, tenantId);
            statement.setString(2, requestId);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? read(tenantId, result.getString("job_id"), result) : null;
            }
        }
    }

    private ProcessingJob findByRequest(String tenantId, String requestId) {
        try (Connection connection = state.connection()) {
            return byRequest(connection, tenantId, requestId, false);
        } catch (SQLException failure) {
            throw databaseFailure("reconcile Media job request", failure);
        }
    }

    private String submissionDigest(Connection connection, String tenantId, String requestId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT submission_digest FROM media_processing_jobs WHERE tenant_id=? AND request_id=?")) {
            statement.setString(1, tenantId);
            statement.setString(2, requestId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) throw new IllegalStateException("Media request digest row disappeared");
                return result.getString("submission_digest");
            }
        }
    }

    private String findSubmissionDigest(String tenantId, String requestId) {
        try (Connection connection = state.connection()) {
            return submissionDigest(connection, tenantId, requestId);
        } catch (SQLException failure) {
            throw databaseFailure("reconcile Media request digest", failure);
        }
    }

    private ProcessingJob read(String tenantId, String jobId, ResultSet result) throws SQLException {
        Long started = result.getObject("started_at") == null ? null : result.getLong("started_at");
        Long completed = result.getObject("completed_at") == null ? null : result.getLong("completed_at");
        return new ProcessingJob(
                jobId,
                result.getString("request_id"),
                tenantId,
                result.getString("principal_id"),
                result.getString("artifact_id"),
                JobType.valueOf(result.getString("job_type")),
                result.getString("provider_id"),
                JobStatus.valueOf(result.getString("status")),
                Instant.ofEpochMilli(result.getLong("created_at")),
                started == null ? null : Instant.ofEpochMilli(started),
                completed == null ? null : Instant.ofEpochMilli(completed),
                objectMap(result.getString("result_json")),
                result.getString("failure_code"),
                result.getLong("version"),
                result.getString("expected_artifact_version"),
                result.getString("job_fingerprint"));
    }

    private void bind(PreparedStatement statement, ProcessingJob job) throws SQLException {
        statement.setString(1, job.tenantId());
        statement.setString(2, job.jobId());
        statement.setString(3, job.requestId());
        statement.setString(4, job.principalId());
        statement.setString(5, job.artifactId());
        statement.setString(6, job.jobType().name());
        statement.setString(7, job.providerId());
        statement.setString(8, job.status().name());
        statement.setLong(9, job.createdAt().toEpochMilli());
        nullableLong(statement, 10, job.startedAt());
        nullableLong(statement, 11, job.completedAt());
        statement.setString(12, json(job.result()));
        statement.setString(13, job.failureCode());
        statement.setLong(14, job.version());
        statement.setString(15, job.expectedArtifactVersion());
    }

    private static void bindAttempt(PreparedStatement statement, JobAttempt attempt) throws SQLException {
        statement.setString(1, attempt.tenantId());
        statement.setString(2, attempt.jobId());
        statement.setInt(3, attempt.attemptNumber());
        statement.setString(4, attempt.providerId());
        statement.setString(5, attempt.requestId());
        statement.setLong(6, attempt.fencingToken());
        statement.setString(7, attempt.status().name());
        statement.setLong(8, attempt.createdAt().toEpochMilli());
        nullableLong(statement, 9, attempt.completedAt());
        statement.setString(10, attempt.outcomeCode());
    }

    private static java.util.UUID stableEventId(String kind, String tenantId, String identity) {
        return java.util.UUID.nameUUIDFromBytes((kind + ":" + tenantId + ":" + identity)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static ProcessingJob sanitizeForPersistence(ProcessingJob job) {
        Map<String, Object> sanitized = MediaJobResultSanitizer.sanitize(job.result());
        Instant createdAt = millisecondPrecision(job.createdAt());
        Instant startedAt = millisecondPrecision(job.startedAt());
        Instant completedAt = millisecondPrecision(job.completedAt());
        if (sanitized.equals(job.result())
                && createdAt.equals(job.createdAt())
                && java.util.Objects.equals(startedAt, job.startedAt())
                && java.util.Objects.equals(completedAt, job.completedAt())) {
            return job;
        }
        return new ProcessingJob(
                job.jobId(),
                job.requestId(),
                job.tenantId(),
                job.principalId(),
                job.artifactId(),
                job.jobType(),
                job.providerId(),
                job.status(),
                createdAt,
                startedAt,
                completedAt,
                sanitized,
                job.failureCode(),
                job.version(),
                job.expectedArtifactVersion(),
                job.requestFingerprint());
    }

    private static Instant millisecondPrecision(Instant value) {
        return value == null ? null : Instant.ofEpochMilli(value.toEpochMilli());
    }

    private static void validateUpdate(ProcessingJob expected, ProcessingJob updated) {
        java.util.Objects.requireNonNull(expected, "expected");
        java.util.Objects.requireNonNull(updated, "updated");
        if (!expected.tenantId().equals(updated.tenantId())
                || !expected.jobId().equals(updated.jobId())
                || !expected.requestId().equals(updated.requestId())
                || !expected.principalId().equals(updated.principalId())
                || !expected.artifactId().equals(updated.artifactId())
                || !expected.expectedArtifactVersion().equals(updated.expectedArtifactVersion())
                || expected.jobType() != updated.jobType()
                || updated.version() != expected.version() + 1) {
            throw new IllegalArgumentException("Media job identity/version is invalid");
        }
    }

    /**
     * A terminal durable job state is a recorded fact and must not be rewritten through an
     * unconditional update. Leaving {@code OUTCOME_UNKNOWN} — or proving a different terminal
     * truth — requires the evidence-bound paths ({@code commitFinalOutcome},
     * {@code reconcileExpired}) so provider/attempt evidence is checked and recorded.
     */
    private static void requireMutableTransition(ProcessingJob expected, ProcessingJob updated) {
        if (terminal(expected.status()) && expected.status() != updated.status()) {
            throw new IllegalStateException(
                    "Media terminal job state " + expected.status() + " cannot be rewritten to "
                            + updated.status() + " through an unconditional update");
        }
    }

    private static void verifyRequestIdentity(
            ProcessingJob existing, ProcessingJob requested,
            String existingDigest, String requestedDigest) {
        if (requested.requestFingerprint().isBlank()
                || ((existingDigest == null || existingDigest.isBlank())
                        && existing.requestFingerprint().isBlank())) {
            throw new IllegalStateException(
                    "Media request has no semantic fingerprint; replay safety cannot be established");
        }
        if (!existing.principalId().equals(requested.principalId())
                || !existing.artifactId().equals(requested.artifactId())
                || !existing.expectedArtifactVersion().equals(requested.expectedArtifactVersion())
                || existing.jobType() != requested.jobType()
                || !java.util.Objects.equals(existingDigest, requestedDigest)) {
            throw new IllegalStateException("Media request ID was reused for a different submission");
        }
    }

    private static boolean terminal(JobStatus status) {
        return status == JobStatus.COMPLETED || status == JobStatus.FAILED
                || status == JobStatus.CANCELLED || status == JobStatus.OUTCOME_UNKNOWN;
    }

    private String json(Object value) {
        try { return state.mapper().writeValueAsString(value); }
        catch (Exception failure) { throw new IllegalArgumentException("Media job result is not serializable", failure); }
    }

    private Map<String, Object> objectMap(String json) {
        try { return state.mapper().readValue(json, new TypeReference<>() { }); }
        catch (Exception failure) { throw new IllegalStateException("Stored Media job result is malformed", failure); }
    }

    private static void nullableLong(PreparedStatement statement, int index, Instant value) throws SQLException {
        if (value == null) statement.setNull(index, java.sql.Types.BIGINT);
        else statement.setLong(index, value.toEpochMilli());
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media job store is closed");
        if (!state.configured()) throw new IllegalStateException("Media AWS/PostgreSQL providers are not configured");
    }

    private static void rollback(Connection connection, Exception failure) {
        try { connection.rollback(); } catch (SQLException rollbackFailure) { failure.addSuppressed(rollbackFailure); }
    }

    private static IllegalStateException databaseFailure(String operation, SQLException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }
}
