package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecyclePublicationReceipt;
import com.ghatana.media.runtime.MediaLifecycleOutboxSource;
import com.ghatana.media.runtime.MediaLifecyclePublicationOutcomeUnknownException;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.time.Duration;
import java.time.Instant;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.DoubleSupplier;

/** Publishes outbox events using fenced claims, bounded backoff, and terminal dead-lettering. */
public final class PostgresqlMediaLifecycleOutboxSource implements MediaLifecycleOutboxSource {
    private static final String CANONICAL_JOB_ACCEPTED_EVENT_TYPE = "media.job.accepted";
    private static final Duration DEFAULT_CLAIM_LEASE = Duration.ofMinutes(2);
    private static final Duration DEFAULT_RETRY_BASE = Duration.ofSeconds(5);
    private static final Duration DEFAULT_RETRY_MAX = Duration.ofMinutes(15);
    private static final int DEFAULT_MAX_ATTEMPTS = 12;

    private final MediaAwsPostgresqlRuntimeState state;
    private final String claimOwner = "media-outbox-" + UUID.randomUUID();
    private final int maxAttempts;
    private final Duration claimLease;
    private final Duration retryBase;
    private final Duration retryMax;
    private final DoubleSupplier jitterSample;
    private final List<String> publishableEventTypes;
    private final AtomicBoolean closed = new AtomicBoolean();

    public record BatchResult(int attempted, int published, int failed) { }

    public PostgresqlMediaLifecycleOutboxSource() {
        this(integerProperty("media.lifecycle.outbox.maxAttempts", DEFAULT_MAX_ATTEMPTS),
                DEFAULT_CLAIM_LEASE, DEFAULT_RETRY_BASE, DEFAULT_RETRY_MAX,
                () -> ThreadLocalRandom.current().nextDouble(), List.of(CANONICAL_JOB_ACCEPTED_EVENT_TYPE));
    }

    /** Package-private timing seam for deterministic H2 reliability tests. */
    PostgresqlMediaLifecycleOutboxSource(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax) {
        this(maxAttempts, claimLease, retryBase, retryMax,
                () -> ThreadLocalRandom.current().nextDouble(), List.of(CANONICAL_JOB_ACCEPTED_EVENT_TYPE));
    }

    /** Package-private jitter seam for deterministic retry-policy tests. */
    PostgresqlMediaLifecycleOutboxSource(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax,
            DoubleSupplier jitterSample) {
        this(maxAttempts, claimLease, retryBase, retryMax, jitterSample,
                List.of(CANONICAL_JOB_ACCEPTED_EVENT_TYPE));
    }

    /** Test-only event-type seam for isolated claim/retry fixtures; production uses the no-arg canonical allowlist. */
    PostgresqlMediaLifecycleOutboxSource(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax,
            DoubleSupplier jitterSample, List<String> publishableEventTypes) {
        if (maxAttempts < 1 || maxAttempts > 100) throw new IllegalArgumentException("maxAttempts must be 1..100");
        this.maxAttempts = maxAttempts;
        this.claimLease = positive(claimLease, "claimLease");
        if (this.claimLease.toMillis() < 1) {
            throw new IllegalArgumentException("claimLease must be at least one millisecond");
        }
        this.retryBase = positive(retryBase, "retryBase");
        this.retryMax = positive(retryMax, "retryMax");
        if (retryMax.compareTo(retryBase) < 0) throw new IllegalArgumentException("retryMax must be >= retryBase");
        if (retryBase.toMillis() < 1 || retryMax.toMillis() < 1) {
            throw new IllegalArgumentException("retry bounds must be at least one millisecond");
        }
        this.jitterSample = java.util.Objects.requireNonNull(jitterSample, "jitterSample");
        this.publishableEventTypes = List.copyOf(java.util.Objects.requireNonNull(
                publishableEventTypes, "publishableEventTypes").stream()
                .map(type -> {
                    if (type == null || type.isBlank() || type.length() > 255
                            || type.chars().anyMatch(Character::isISOControl)) {
                        throw new IllegalArgumentException("publishable event types must be bounded and nonblank");
                    }
                    return type;
                }).distinct().sorted().toList());
        if (this.publishableEventTypes.isEmpty()) {
            throw new IllegalArgumentException("at least one publishable event type is required");
        }
        // Do not acquire the shared provider lifecycle until construction is known to
        // succeed. Invalid configuration must not leak a reference to the singleton.
        this.state = MediaAwsPostgresqlRuntimeState.acquire();
    }

    public BatchResult publishPending(MediaLifecycleEventPublisher publisher, int limit) {
        if (closed.get()) throw new IllegalStateException("Media outbox source is closed");
        if (limit < 1 || limit > 1_000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        if (publisher == null || !publisher.ready()) return new BatchResult(0, 0, 0);
        List<String> ids = eligibleIds(limit);
        int attempted = 0;
        int published = 0;
        int failed = 0;
        for (String id : ids) {
            Claim claim = claim(id);
            if (claim == null) continue;
            attempted++;
            MediaLifecycleEvent event;
            try {
                event = state.mapper().readValue(claim.payload(), MediaLifecycleEvent.class);
                validatePayloadMatchesClaim(claim, event);
            } catch (Exception failure) {
                recordFailure(claim, failure);
                failed++;
                continue;
            }
            MediaLifecyclePublicationReceipt receipt;
            try {
                receipt = publisher.publishWithReceipt(event, claim.exactReadbackRequired());
                if (receipt == null) {
                    throw new MediaLifecyclePublicationOutcomeUnknownException(
                            "Lifecycle publisher returned no append receipt");
                }
                validateReceiptMatchesClaim(claim, receipt);
            } catch (MediaLifecyclePublicationOutcomeUnknownException unknown) {
                recordUnknown(claim, unknown);
                failed++;
                continue;
            } catch (Exception failure) {
                recordFailure(claim, failure);
                failed++;
                continue;
            }
            try {
                if (acknowledge(claim, receipt)) published++;
                else failed++;
            } catch (Exception acknowledgementFailure) {
                // Leave the durable claim untouched. If this process died or the ACK update
                // failed after append, lease recovery will retain UNKNOWN instead of POSTing again.
                failed++;
            }
        }
        return new BatchResult(attempted, published, failed);
    }

    @Override
    public int publishConfirmed(MediaLifecycleEventPublisher publisher, int limit) {
        return publishPending(publisher, limit).published();
    }

    @Override
    public long countOverdueClaims(Instant now) {
        ensureOpen();
        java.util.Objects.requireNonNull(now, "now");
        try (Connection connection = state.connection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT COUNT(*) FROM media_processing_lifecycle_outbox "
                             + "WHERE published_at IS NULL AND dead_lettered_at IS NULL "
                             + "AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL "
                             + "AND claim_expires_at<=?")) {
            query.setLong(1, now.toEpochMilli());
            try (ResultSet rows = query.executeQuery()) {
                return rows.next() ? rows.getLong(1) : 0L;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to count overdue Media outbox claims", failure);
        }
    }

    private List<String> eligibleIds(int limit) {
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT event_id FROM media_processing_lifecycle_outbox WHERE published_at IS NULL "
                             + "AND dead_lettered_at IS NULL AND event_type IN (" + eventTypePlaceholders() + ") "
                             + "AND next_attempt_at<=? "
                             + "AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at<=?) "
                             + "ORDER BY created_at,event_id LIMIT ?")) {
            int parameter = 1;
            for (String eventType : publishableEventTypes) query.setString(parameter++, eventType);
            query.setLong(parameter++, now);
            query.setLong(parameter++, now);
            query.setInt(parameter, limit);
            List<String> ids = new ArrayList<>();
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) ids.add(rows.getString(1));
            }
            return List.copyOf(ids);
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to list eligible Media lifecycle events", failure);
        }
    }

    /** Claim is committed before I/O; any prior attempt requires exact lookup before another append. */
    private Claim claim(String eventId) {
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                String payload;
                String tenantId;
                String aggregateType;
                String aggregateId;
                long aggregateVersion;
                String eventType;
                String classification;
                long createdAt;
                long priorToken;
                int attempts;
                String priorClaimOwner;
                Long priorClaimExpiresAt;
                try (PreparedStatement query = connection.prepareStatement(
                        "SELECT payload_json,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,"
                                + "classification,created_at,claim_token,attempts,claim_owner,claim_expires_at "
                                + "FROM media_processing_lifecycle_outbox "
                                + "WHERE event_id=? AND event_type IN (" + eventTypePlaceholders() + ") "
                                + "AND published_at IS NULL AND dead_lettered_at IS NULL "
                                + "AND next_attempt_at<=? AND (claim_owner IS NULL OR claim_expires_at IS NULL "
                                + "OR claim_expires_at<=?) FOR UPDATE SKIP LOCKED")) {
                    int parameter = 1;
                    query.setString(parameter++, eventId);
                    for (String publishableEventType : publishableEventTypes) {
                        query.setString(parameter++, publishableEventType);
                    }
                    query.setLong(parameter++, now);
                    query.setLong(parameter, now);
                    try (ResultSet row = query.executeQuery()) {
                        if (!row.next()) {
                            connection.commit();
                            return null;
                        }
                        payload = row.getString("payload_json");
                        tenantId = row.getString("tenant_id");
                        aggregateType = row.getString("aggregate_type");
                        aggregateId = row.getString("aggregate_id");
                        aggregateVersion = row.getLong("aggregate_version");
                        eventType = row.getString("event_type");
                        classification = row.getString("classification");
                        createdAt = row.getLong("created_at");
                        priorToken = row.getLong("claim_token");
                        attempts = row.getInt("attempts");
                        priorClaimOwner = row.getString("claim_owner");
                        long expiresAt = row.getLong("claim_expires_at");
                        priorClaimExpiresAt = row.wasNull() ? null : expiresAt;
                    }
                }
                boolean exactReadbackRequired = attempts > 0 || (priorClaimOwner != null
                        && (priorClaimExpiresAt == null || priorClaimExpiresAt <= now));
                // The acknowledgement path increments this persisted INTEGER only after
                // broker acceptance. Refuse to publish a row whose count cannot be
                // advanced, otherwise the broker effect could succeed while the durable
                // acknowledgement rolls back on integer overflow.
                if (attempts == Integer.MAX_VALUE) {
                    throw new ArithmeticException("Media lifecycle outbox attempt counter exhausted");
                }
                // claim_token is the durable fencing generation. Never allow signed BIGINT
                // overflow to wrap it negative and potentially make an old generation current.
                long token = Math.addExact(priorToken, 1L);
                // The lease deadline is also persisted as a signed BIGINT epoch-millis value.
                // A wrapped deadline would make this committed claim immediately reclaimable.
                long claimExpiresAt = Math.addExact(now, claimLease.toMillis());
                try (PreparedStatement update = connection.prepareStatement(
                        "UPDATE media_processing_lifecycle_outbox SET claim_owner=?,claim_token=?,claim_expires_at=? "
                                + "WHERE event_id=? AND claim_token=? AND published_at IS NULL AND dead_lettered_at IS NULL")) {
                    update.setString(1, claimOwner);
                    update.setLong(2, token);
                    update.setLong(3, claimExpiresAt);
                    update.setString(4, eventId);
                    update.setLong(5, priorToken);
                    if (update.executeUpdate() != 1) {
                        connection.commit();
                        return null;
                    }
                }
                connection.commit();
                return new Claim(eventId, payload, tenantId, aggregateType, aggregateId, aggregateVersion,
                        eventType, classification, createdAt, token, attempts, exactReadbackRequired);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Unable to claim Media lifecycle event", failure);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to open Media lifecycle claim transaction", failure);
        }
    }

    /** The payload is authoritative for publication; denormalized row fields must agree before dispatch. */
    private void validatePayloadMatchesClaim(Claim claim, MediaLifecycleEvent event) {
        if (!claim.eventId().equals(event.eventId())
                || !claim.tenantId().equals(event.tenantId())
                || !claim.aggregateType().equals(event.aggregateType())
                || !claim.aggregateId().equals(event.aggregateId())
                || claim.aggregateVersion() != event.aggregateVersion()
                || !claim.eventType().equals(event.eventType())
                || !claim.classification().equals(event.classification())
                || claim.createdAt() != event.occurredAt().toEpochMilli()) {
            throw new IllegalStateException("Media lifecycle outbox payload identity does not match its row");
        }
        if (CANONICAL_JOB_ACCEPTED_EVENT_TYPE.equals(event.eventType())) {
            String expectedEventId = "media:media.job.accepted:" + event.aggregateId() + ":" + event.aggregateVersion();
            Map<String, Object> expectedAttributes = Map.of(
                    "jobId", event.aggregateId(),
                    "operationRef", "media.operation-slice.submit-job",
                    "admissionState", "ACCEPTED");
            if (!event.eventId().equals(expectedEventId)
                    || !event.aggregateType().equals("processing-job")
                    || !event.attributes().equals(expectedAttributes)
                    || !java.util.Set.of("INTERNAL", "CONFIDENTIAL", "RESTRICTED")
                            .contains(event.classification())) {
                throw new IllegalStateException("Canonical accepted event does not match its owner-defined payload");
            }
            String requiredClassification = requiredAcceptedEventClassification(event);
            if (!requiredClassification.equals(event.classification())) {
                throw new IllegalStateException(
                        "Canonical accepted event classification is weaker than its source artifact classification");
            }
        }
    }

    private String requiredAcceptedEventClassification(MediaLifecycleEvent event) {
        String sourceClassification;
        try (Connection connection = state.connection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT artifact.classification FROM media_processing_jobs job "
                             + "JOIN media_artifacts artifact ON artifact.tenant_id=job.tenant_id "
                             + "AND artifact.artifact_id=job.artifact_id "
                             + "WHERE job.tenant_id=? AND job.job_id=?")) {
            query.setString(1, event.tenantId());
            query.setString(2, event.aggregateId());
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) {
                    throw new IllegalStateException(
                            "Canonical accepted event has no retained source artifact classification");
                }
                sourceClassification = row.getString("classification");
            }
        } catch (SQLException failure) {
            throw new IllegalStateException(
                    "Unable to read source artifact classification for canonical accepted event", failure);
        }
        if (sourceClassification == null || sourceClassification.isBlank()) {
            throw new IllegalStateException("Source artifact classification is missing for accepted event");
        }
        DataClassification source;
        try {
            source = DataClassification.valueOf(sourceClassification);
        } catch (IllegalArgumentException invalidClassification) {
            throw new IllegalStateException(
                    "Source artifact classification is unrecognized for accepted event", invalidClassification);
        }
        return source.isAtLeast(DataClassification.INTERNAL)
                ? source.name() : DataClassification.INTERNAL.name();
    }

    private String eventTypePlaceholders() {
        return String.join(",", java.util.Collections.nCopies(publishableEventTypes.size(), "?"));
    }

    private static void validateReceiptMatchesClaim(
            Claim claim, MediaLifecyclePublicationReceipt receipt) {
        if (!claim.eventId().equals(receipt.eventId())
                || !MediaLifecyclePublicationReceipt.stableStoredEventId(claim.eventId())
                .equals(receipt.storedEventId())) {
            throw new MediaLifecyclePublicationOutcomeUnknownException(
                    "Event Plane receipt identity does not match the claimed Media event");
        }
    }

    private boolean acknowledge(Claim claim, MediaLifecyclePublicationReceipt receipt) {
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                long now = System.currentTimeMillis();
                try (PreparedStatement ack = connection.prepareStatement(
                        "UPDATE media_processing_lifecycle_outbox SET published_at=?,event_plane_stored_event_id=?,"
                                + "event_plane_stream_id=?,event_plane_offset=?,attempts=attempts+1,last_error=NULL,"
                                + "claim_owner=NULL,claim_expires_at=NULL,next_attempt_at=0 "
                                + "WHERE event_id=? AND published_at IS NULL AND claim_owner=? AND claim_token=? "
                                + "AND claim_expires_at>?")) {
                    ack.setLong(1, now);
                    ack.setString(2, receipt.storedEventId());
                    ack.setString(3, receipt.streamId());
                    ack.setString(4, receipt.offset());
                    ack.setString(5, claim.eventId());
                    ack.setString(6, claimOwner);
                    ack.setLong(7, claim.token());
                    ack.setLong(8, now);
                    if (ack.executeUpdate() != 1) {
                        connection.rollback();
                        return false;
                    }
                }
                advanceTenantCursor(connection, claim.tenantId(), receipt, now);
                connection.commit();
                return true;
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Unable to acknowledge Media lifecycle event", failure);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to acknowledge Media lifecycle event", failure);
        }
    }

    private void advanceTenantCursor(
            Connection connection, String tenantId, MediaLifecyclePublicationReceipt receipt, long now)
            throws SQLException {
        try (PreparedStatement query = connection.prepareStatement(
                "SELECT last_offset FROM media_processing_lifecycle_event_plane_cursor "
                        + "WHERE tenant_id=? FOR UPDATE")) {
            query.setString(1, tenantId);
            try (ResultSet row = query.executeQuery()) {
                if (row.next()) {
                    updateCursorIfAhead(connection, tenantId, receipt, now, row.getString("last_offset"));
                    return;
                }
            }
        }

        Savepoint insertAttempt = connection.setSavepoint();
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_processing_lifecycle_event_plane_cursor "
                        + "(tenant_id,last_offset,last_stream_id,last_event_id,last_stored_event_id,updated_at) "
                        + "VALUES(?,?,?,?,?,?)")) {
            insert.setString(1, tenantId);
            insert.setString(2, receipt.offset());
            insert.setString(3, receipt.streamId());
            insert.setString(4, receipt.eventId());
            insert.setString(5, receipt.storedEventId());
            insert.setLong(6, now);
            insert.executeUpdate();
        } catch (SQLException concurrentInsert) {
            connection.rollback(insertAttempt);
            if (!"23505".equals(concurrentInsert.getSQLState())) throw concurrentInsert;
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT last_offset FROM media_processing_lifecycle_event_plane_cursor "
                            + "WHERE tenant_id=? FOR UPDATE")) {
                query.setString(1, tenantId);
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) throw concurrentInsert;
                    updateCursorIfAhead(connection, tenantId, receipt, now, row.getString("last_offset"));
                }
            }
        }
    }

    private void updateCursorIfAhead(
            Connection connection, String tenantId, MediaLifecyclePublicationReceipt receipt,
            long now, String lastOffset) throws SQLException {
        if (new BigInteger(receipt.offset()).compareTo(new BigInteger(lastOffset)) <= 0) return;
        try (PreparedStatement update = connection.prepareStatement(
                "UPDATE media_processing_lifecycle_event_plane_cursor SET last_offset=?,last_stream_id=?,"
                        + "last_event_id=?,last_stored_event_id=?,updated_at=? WHERE tenant_id=?")) {
            update.setString(1, receipt.offset());
            update.setString(2, receipt.streamId());
            update.setString(3, receipt.eventId());
            update.setString(4, receipt.storedEventId());
            update.setLong(5, now);
            update.setString(6, tenantId);
            if (update.executeUpdate() != 1) {
                throw new SQLException("Event Plane tenant cursor disappeared during ACK");
            }
        }
    }

    private void recordUnknown(Claim claim, Exception failure) {
        long now = System.currentTimeMillis();
        String reason = failure.getClass().getSimpleName();
        if (reason.length() > 255) reason = reason.substring(0, 255);
        try (Connection connection = state.connection();
             PreparedStatement unknown = connection.prepareStatement(
                     "UPDATE media_processing_lifecycle_outbox SET attempts=attempts+1,last_error=?,"
                             + "dead_lettered_at=?,dead_letter_reason='OUTCOME_UNKNOWN',claim_owner=NULL,"
                             + "claim_expires_at=NULL,next_attempt_at=0 "
                             + "WHERE event_id=? AND published_at IS NULL AND claim_owner=? AND claim_token=? "
                             + "AND claim_expires_at>?")) {
            unknown.setString(1, reason);
            unknown.setLong(2, now);
            unknown.setString(3, claim.eventId());
            unknown.setString(4, claimOwner);
            unknown.setLong(5, claim.token());
            unknown.setLong(6, now);
            unknown.executeUpdate(); // A replaced claim's owner cannot persist its stale observation.
        } catch (SQLException storeFailure) {
            throw new IllegalStateException("Unable to persist unknown Media lifecycle append outcome", storeFailure);
        }
    }

    private void recordFailure(Claim claim, Exception failure) {
        long now = System.currentTimeMillis();
        int nextAttempt = claim.attempts() + 1;
        boolean dead = nextAttempt >= maxAttempts;
        String errorType = failure.getClass().getSimpleName();
        if (errorType.length() > 255) errorType = errorType.substring(0, 255);
        long nextAt = dead ? 0 : retryAtMillis(now, retryDelayMillis(claim.attempts()));
        try (Connection connection = state.connection();
             PreparedStatement retry = connection.prepareStatement(
                     "UPDATE media_processing_lifecycle_outbox SET attempts=?,last_error=?,next_attempt_at=?,"
                             + "dead_lettered_at=?,dead_letter_reason=?,claim_owner=NULL,claim_expires_at=NULL "
                             + "WHERE event_id=? AND published_at IS NULL AND claim_owner=? AND claim_token=? "
                             + "AND claim_expires_at>?")) {
            retry.setInt(1, nextAttempt);
            retry.setString(2, errorType);
            retry.setLong(3, nextAt);
            if (dead) retry.setLong(4, now); else retry.setNull(4, java.sql.Types.BIGINT);
            if (dead) retry.setString(5, errorType); else retry.setNull(5, java.sql.Types.VARCHAR);
            retry.setString(6, claim.eventId());
            retry.setString(7, claimOwner);
            retry.setLong(8, claim.token());
            retry.setLong(9, now);
            retry.executeUpdate(); // zero rows means this worker's claim expired and was replaced.
        } catch (SQLException storeFailure) {
            throw new IllegalStateException("Unable to persist Media lifecycle retry", storeFailure);
        }
    }

    private long retryDelayMillis(int attemptsSoFar) {
        return cappedJitteredRetryDelayMillis(
                attemptsSoFar, retryBase.toMillis(), retryMax.toMillis(), jitterSample.getAsDouble());
    }

    /** Reject a retry deadline that cannot be represented by the persisted epoch-millis column. */
    static long retryAtMillis(long nowEpochMillis, long delayMillis) {
        if (delayMillis < 1) throw new IllegalArgumentException("retry delay must be positive");
        return Math.addExact(nowEpochMillis, delayMillis);
    }

    static long cappedJitteredRetryDelayMillis(
            int attemptsSoFar, long retryBaseMillis, long retryMaxMillis, double sample) {
        if (retryBaseMillis <= 0 || retryMaxMillis <= 0 || retryBaseMillis > retryMaxMillis) {
            throw new IllegalArgumentException("retry bounds must be positive and retryBaseMillis <= retryMaxMillis");
        }
        if (!Double.isFinite(sample) || sample < 0.0 || sample >= 1.0) {
            throw new IllegalArgumentException("jitter sample must be in [0, 1)");
        }
        int shift = Math.min(Math.max(attemptsSoFar, 0), 62);
        long multiplier = 1L << shift;
        long ceiling = multiplier > retryMaxMillis / retryBaseMillis
                ? retryMaxMillis : Math.min(retryMaxMillis, retryBaseMillis * multiplier);
        long selected = (long) Math.floor(sample * (double) ceiling);
        if (selected >= ceiling) selected = ceiling - 1;
        return selected + 1;
    }

    private static int integerProperty(String property, int fallback) {
        String configured = System.getProperty(property, "").trim();
        if (configured.isEmpty()) return fallback;
        try {
            int value = Integer.parseInt(configured);
            if (value < 1 || value > 100) throw new IllegalArgumentException(property + " must be 1..100");
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(property + " must be an integer", failure);
        }
    }

    private static Duration positive(Duration value, String field) {
        if (value == null || value.isNegative() || value.isZero()) throw new IllegalArgumentException(field + " must be positive");
        return value;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media lifecycle outbox source is closed");
    }

    private static void rollback(Connection connection, Throwable original) {
        try { connection.rollback(); } catch (SQLException failure) { original.addSuppressed(failure); }
    }

    private record Claim(String eventId, String payload, String tenantId, String aggregateType,
            String aggregateId, long aggregateVersion, String eventType, String classification, long createdAt,
            long token, int attempts, boolean exactReadbackRequired) { }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
