package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Entry;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Page;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import tools.jackson.core.type.TypeReference;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.MAX_PAGE;

/** Durable DEV_ONLY lifecycle feed over V043. A committed insert is the channel confirmation the relay waits for. */
public final class PostgresqlMediaDevLifecycleFeed implements Feed {
    private final MediaAwsPostgresqlRuntimeState state;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaDevLifecycleFeed() { this(MediaAwsPostgresqlRuntimeState.acquire()); }

    PostgresqlMediaDevLifecycleFeed(MediaAwsPostgresqlRuntimeState state) {
        this.state = Objects.requireNonNull(state, "state");
    }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override
    public Entry append(String tenantId, String outboxEventId, String rawAggregateId, MediaPublicLifecycleEvent event) {
        ensureOpen();
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(outboxEventId, "outboxEventId");
        Objects.requireNonNull(rawAggregateId, "rawAggregateId");
        Objects.requireNonNull(event, "event");
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                int deliveryNo;
                try (PreparedStatement count = connection.prepareStatement(
                        "SELECT COALESCE(MAX(delivery_no),0) FROM media_dev_lifecycle_feed "
                                + "WHERE tenant_id=? AND outbox_event_id=?")) {
                    count.setString(1, tenantId);
                    count.setString(2, outboxEventId);
                    try (ResultSet rows = count.executeQuery()) {
                        rows.next();
                        deliveryNo = Math.addExact(rows.getInt(1), 1);
                    }
                }
                long cursor;
                try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO media_dev_lifecycle_feed (tenant_id,outbox_event_id,delivery_no,event_ref,event_type,"
                                + "aggregate_type,aggregate_ref,aggregate_id,aggregate_version,public_json,appended_at) "
                                + "VALUES (?,?,?,?,?,?,?,?,?,?,?)", java.sql.Statement.RETURN_GENERATED_KEYS)) {
                    insert.setString(1, tenantId);
                    insert.setString(2, outboxEventId);
                    insert.setInt(3, deliveryNo);
                    insert.setString(4, event.eventRef());
                    insert.setString(5, event.eventType().wireName());
                    insert.setString(6, event.aggregateType());
                    insert.setString(7, event.aggregateRef());
                    insert.setString(8, rawAggregateId);
                    insert.setLong(9, event.aggregateVersion());
                    insert.setString(10, state.mapper().writeValueAsString(event.toPayload()));
                    insert.setLong(11, System.currentTimeMillis());
                    insert.executeUpdate();
                    try (ResultSet keys = insert.getGeneratedKeys()) {
                        if (!keys.next()) throw new SQLException("lifecycle feed cursor was not generated");
                        cursor = keys.getLong(1);
                    }
                }
                connection.commit();
                return new Entry(cursor, deliveryNo, event);
            } catch (SQLException | RuntimeException failure) {
                try { connection.rollback(); } catch (SQLException rollback) { failure.addSuppressed(rollback); }
                if (failure instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Unable to append Media lifecycle feed entry", failure);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to open Media lifecycle feed transaction", failure);
        }
    }

    @Override
    public Page read(String tenantId, long afterCursor, int limit) {
        ensureOpen();
        Objects.requireNonNull(tenantId, "tenantId");
        if (afterCursor < 0) throw new IllegalArgumentException("afterCursor must not be negative");
        if (limit < 1 || limit > MAX_PAGE) throw new IllegalArgumentException("limit must be 1.." + MAX_PAGE);
        try (Connection connection = state.connection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT feed_seq,delivery_no,public_json FROM media_dev_lifecycle_feed "
                             + "WHERE tenant_id=? AND feed_seq>? ORDER BY feed_seq LIMIT ?")) {
            query.setString(1, tenantId);
            query.setLong(2, afterCursor);
            query.setInt(3, limit);
            List<Entry> entries = new ArrayList<>();
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) {
                    Map<String, Object> payload = state.mapper().readValue(
                            rows.getString("public_json"), new TypeReference<>() { });
                    entries.add(new Entry(rows.getLong("feed_seq"), rows.getInt("delivery_no"),
                            MediaPublicLifecycleEvent.fromPayload(payload)));
                }
            }
            return new Page(entries, entries.isEmpty() ? afterCursor : entries.getLast().cursor());
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to read Media lifecycle feed", failure);
        }
    }

    @Override
    public Optional<String> resolveAggregateId(String tenantId, String aggregateType, String aggregateRef) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT aggregate_id FROM media_dev_lifecycle_feed WHERE tenant_id=? AND aggregate_type=? "
                             + "AND aggregate_ref=? ORDER BY feed_seq LIMIT 1")) {
            query.setString(1, tenantId);
            query.setString(2, aggregateType);
            query.setString(3, aggregateRef);
            try (ResultSet rows = query.executeQuery()) {
                return rows.next() ? Optional.of(rows.getString(1)) : Optional.empty();
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Unable to resolve Media lifecycle aggregate", failure);
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("Media lifecycle feed is closed");
    }

    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }
}
