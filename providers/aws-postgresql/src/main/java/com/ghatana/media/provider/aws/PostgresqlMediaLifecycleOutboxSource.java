package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecycleEventPublisher;
import com.ghatana.media.runtime.MediaLifecycleOutboxSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.DoubleSupplier;

/** Publishes outbox events using fenced claims, bounded backoff, and terminal dead-lettering. */
public final class PostgresqlMediaLifecycleOutboxSource implements MediaLifecycleOutboxSource {
    private static final Duration DEFAULT_CLAIM_LEASE = Duration.ofMinutes(2);
    private static final Duration DEFAULT_RETRY_BASE = Duration.ofSeconds(5);
    private static final Duration DEFAULT_RETRY_MAX = Duration.ofMinutes(15);
    private static final int DEFAULT_MAX_ATTEMPTS = 12;

    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final String claimOwner = "media-outbox-" + UUID.randomUUID();
    private final int maxAttempts;
    private final Duration claimLease;
    private final Duration retryBase;
    private final Duration retryMax;
    private final DoubleSupplier jitterSample;
    private final AtomicBoolean closed = new AtomicBoolean();

    public record BatchResult(int attempted, int published, int failed) { }

    public PostgresqlMediaLifecycleOutboxSource() {
        this(integerProperty("media.lifecycle.outbox.maxAttempts", DEFAULT_MAX_ATTEMPTS),
                DEFAULT_CLAIM_LEASE, DEFAULT_RETRY_BASE, DEFAULT_RETRY_MAX,
                () -> ThreadLocalRandom.current().nextDouble());
    }

    /** Package-private timing seam for deterministic H2 reliability tests. */
    PostgresqlMediaLifecycleOutboxSource(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax) {
        this(maxAttempts, claimLease, retryBase, retryMax,
                () -> ThreadLocalRandom.current().nextDouble());
    }

    /** Package-private jitter seam for deterministic retry-policy tests. */
    PostgresqlMediaLifecycleOutboxSource(
            int maxAttempts, Duration claimLease, Duration retryBase, Duration retryMax,
            DoubleSupplier jitterSample) {
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
    }

    public BatchResult publishPending(MediaLifecycleEventPublisher publisher, int limit) {
        if (closed.get()) throw new IllegalStateException("Media outbox source is closed");
        if (publisher == null || !publisher.ready()) return new BatchResult(0, 0, 0);
        if (limit < 1 || limit > 1_000) throw new IllegalArgumentException("limit must be between 1 and 1000");
        List<String> ids = eligibleIds(limit);
        int attempted = 0;
        int published = 0;
        int failed = 0;
        for (String id : ids) {
            Claim claim = claim(id);
            if (claim == null) continue;
            attempted++;
            try {
                MediaLifecycleEvent event = state.mapper().readValue(claim.payload(), MediaLifecycleEvent.class);
                publisher.publish(event);
                if (acknowledge(claim)) published++;
                else failed++;
            } catch (Exception failure) {
                recordFailure(claim, failure);
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
                             + "AND dead_lettered_at IS NULL AND next_attempt_at<=? "
                             + "AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at<=?) "
                             + "ORDER BY created_at,event_id LIMIT ?")) {
            query.setLong(1, now);
            query.setLong(2, now);
            query.setInt(3, limit);
            List<String> ids = new ArrayList<>();
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) ids.add(rows.getString(1));
            }
            return List.copyOf(ids);
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to list eligible Media lifecycle events", failure);
        }
    }

    /** Claim is committed before any network I/O; claim_token fences expired owners. */
    private Claim claim(String eventId) {
        long now = System.currentTimeMillis();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                String payload;
                long priorToken;
                int attempts;
                try (PreparedStatement query = connection.prepareStatement(
                        "SELECT payload_json,claim_token,attempts FROM media_processing_lifecycle_outbox "
                                + "WHERE event_id=? AND published_at IS NULL AND dead_lettered_at IS NULL "
                                + "AND next_attempt_at<=? AND (claim_owner IS NULL OR claim_expires_at IS NULL "
                                + "OR claim_expires_at<=?) FOR UPDATE SKIP LOCKED")) {
                    query.setString(1, eventId);
                    query.setLong(2, now);
                    query.setLong(3, now);
                    try (ResultSet row = query.executeQuery()) {
                        if (!row.next()) {
                            connection.commit();
                            return null;
                        }
                        payload = row.getString("payload_json");
                        priorToken = row.getLong("claim_token");
                        attempts = row.getInt("attempts");
                    }
                }
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
                return new Claim(eventId, payload, token, attempts);
            } catch (SQLException | RuntimeException failure) {
                rollback(connection, failure);
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Unable to claim Media lifecycle event", failure);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to open Media lifecycle claim transaction", failure);
        }
    }

    private boolean acknowledge(Claim claim) {
        try (Connection connection = state.connection();
             PreparedStatement ack = connection.prepareStatement(
                     "UPDATE media_processing_lifecycle_outbox SET published_at=?,attempts=attempts+1,last_error=NULL,"
                             + "claim_owner=NULL,claim_expires_at=NULL,next_attempt_at=0 "
                             + "WHERE event_id=? AND published_at IS NULL AND claim_owner=? AND claim_token=? "
                             + "AND claim_expires_at>?")) {
            long now = System.currentTimeMillis();
            ack.setLong(1, now);
            ack.setString(2, claim.eventId());
            ack.setString(3, claimOwner);
            ack.setLong(4, claim.token());
            ack.setLong(5, now);
            return ack.executeUpdate() == 1;
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to acknowledge Media lifecycle event", failure);
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

    private record Claim(String eventId, String payload, long token, int attempts) { }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
