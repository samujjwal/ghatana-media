package com.ghatana.media.provider.aws;

import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaJobResultSanitizer;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;

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
    public ProcessingJob create(ProcessingJob job) {
        ensureOpen();
        java.util.Objects.requireNonNull(job, "job");
        ProcessingJob persistable = sanitizeForPersistence(job);
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                ProcessingJob existing = byRequest(connection, persistable.tenantId(), persistable.requestId(), true);
                if (existing != null) {
                    verifyRequestIdentity(existing, persistable);
                    connection.commit();
                    return existing;
                }
                try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO media_processing_jobs "
                                + "(tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,"
                                + "started_at,completed_at,result_json,failure_code,version) "
                                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
                    bind(statement, persistable);
                    statement.executeUpdate();
                }
                connection.commit();
                return persistable;
            } catch (RuntimeException | SQLException failure) {
                rollback(connection, failure);
                if (failure instanceof SQLException sql && "23505".equals(sql.getSQLState())) {
                    ProcessingJob existing = findByRequest(persistable.tenantId(), persistable.requestId());
                    if (existing != null) {
                        verifyRequestIdentity(existing, persistable);
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
        ProcessingJob persistable = sanitizeForPersistence(updated);
        String sql = "UPDATE media_processing_jobs SET provider_id=?,status=?,started_at=?,completed_at=?,"
                + "result_json=?,failure_code=?,version=? WHERE tenant_id=? AND job_id=? AND version=?";
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(sql)) {
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
            if (statement.executeUpdate() != 1) {
                throw new IllegalStateException("Media job version changed concurrently");
            }
            return persistable;
        } catch (SQLException failure) {
            throw databaseFailure("update Media job", failure);
        }
    }

    @Override
    public Optional<ProcessingJob> find(String tenantId, String jobId) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT request_id,principal_id,artifact_id,job_type,provider_id,status,created_at,started_at,completed_at,"
                             + "result_json,failure_code,version FROM media_processing_jobs "
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
                             + "completed_at,result_json,failure_code,version FROM media_processing_jobs "
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
        ensureOpen();
        if (limit < 1 || limit > 1_000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        List<ProcessingJob> values = new ArrayList<>();
        try (Connection connection = state.connection();
             PreparedStatement statement = connection.prepareStatement(
                     "SELECT tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,"
                             + "created_at,started_at,completed_at,result_json,failure_code,version "
                             + "FROM media_processing_jobs WHERE status IN ('ACCEPTED','RUNNING') "
                             + "AND (lease_expires_at IS NULL OR lease_expires_at<=?) "
                             + "ORDER BY created_at,tenant_id,job_id LIMIT ?")) {
            statement.setLong(1, System.currentTimeMillis());
            statement.setInt(2, limit);
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
                + "completed_at,result_json,failure_code,version FROM media_processing_jobs "
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
                result.getLong("version"));
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
                job.version());
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
                || expected.jobType() != updated.jobType()
                || updated.version() != expected.version() + 1) {
            throw new IllegalArgumentException("Media job identity/version is invalid");
        }
    }

    private static void verifyRequestIdentity(ProcessingJob existing, ProcessingJob requested) {
        if (!existing.principalId().equals(requested.principalId())
                || !existing.artifactId().equals(requested.artifactId())
                || existing.jobType() != requested.jobType()) {
            throw new IllegalStateException("Media request ID was reused for a different job");
        }
    }

    private static boolean terminal(JobStatus status) {
        return status == JobStatus.COMPLETED || status == JobStatus.FAILED || status == JobStatus.CANCELLED;
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
