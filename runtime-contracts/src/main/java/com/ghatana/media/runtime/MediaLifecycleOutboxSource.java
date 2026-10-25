package com.ghatana.media.runtime;

import java.time.Instant;

/** Durable lifecycle outbox drain discovered by the Media runtime. */
public interface MediaLifecycleOutboxSource extends AutoCloseable {
    /** Publishes at most {@code limit} rows and returns confirmed acknowledgements. */
    int publishConfirmed(MediaLifecycleEventPublisher publisher, int limit);

    /**
     * Counts unpublished, non-dead-lettered rows whose durable claim lease has expired.
     * Implementations without a read-only aggregate query keep this unsupported so callers
     * can report unknown instead of interpreting a missing measurement as zero.
     */
    default long countOverdueClaims(Instant now) {
        throw new UnsupportedOperationException("Durable outbox lease counts are not supported");
    }

    @Override default void close() { }
}
