package com.ghatana.media.runtime;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * DEV_ONLY consumer-facing channel for the public Media lifecycle ABI ({@code media.lifecycle-event.v1}).
 *
 * <p>The feed is the durable channel the transactional outbox relay publishes into. {@link Feed#append} returning
 * normally means the entry is committed and visible to consumers: that, and only that, is the "consumer channel
 * confirmed" fact the relay may mark an outbox row published on. It is never job finality; a job's state is only
 * ever established by the job store readback.</p>
 *
 * <p>Delivery is at-least-once. An outbox row that was appended but not marked (crash, lost acknowledgement) is
 * appended again with a higher {@code deliveryNo}; consumers dedupe by {@code event.eventRef()}. Cursors are
 * strictly increasing per feed, so a consumer's own cursor is its only position: nothing is stored per consumer.</p>
 */
public final class MediaDevLifecycleFeedContracts {
    public static final int MAX_PAGE = 200;

    private MediaDevLifecycleFeedContracts() { }

    /** One delivered entry: the public event plus delivery metadata. {@code deliveryNo} is 1 for the first append. */
    public record Entry(long cursor, int deliveryNo, MediaPublicLifecycleEvent event) {
        public Entry {
            if (cursor < 1) throw new IllegalArgumentException("cursor must be positive");
            if (deliveryNo < 1) throw new IllegalArgumentException("deliveryNo must be positive");
            Objects.requireNonNull(event, "event");
        }
    }

    public record Page(List<Entry> entries, long nextCursor) {
        public Page { entries = List.copyOf(entries); }
    }

    public interface Feed extends AutoCloseable {
        boolean ready();

        /**
         * Commits one entry for the tenant. {@code outboxEventId} is the transactional outbox identity (a redelivery
         * of the same outbox row gets the next {@code deliveryNo}); {@code rawAggregateId} is kept server-side only,
         * to resolve the redacted aggregate reference for the authoritative readback.
         */
        Entry append(String tenantId, String outboxEventId, String rawAggregateId, MediaPublicLifecycleEvent event);

        /** Entries of this tenant with cursor greater than {@code afterCursor}, oldest first, at most {@code limit}. */
        Page read(String tenantId, long afterCursor, int limit);

        /** The raw aggregate id behind a redacted aggregate reference of this tenant; empty when unknown. */
        Optional<String> resolveAggregateId(String tenantId, String aggregateType, String aggregateRef);

        @Override default void close() { }
    }

    public interface FeedFactory {
        String factoryId();

        /** Fails closed unless the environment is the DEV profile with dev identity enabled. */
        Feed createDevOnly(Map<String, String> environment);
    }
}
