package com.ghatana.media.runtime;

/** Durable lifecycle outbox drain discovered by the Media runtime. */
public interface MediaLifecycleOutboxSource extends AutoCloseable {
    /** Publishes at most {@code limit} rows and returns confirmed acknowledgements. */
    int publishConfirmed(MediaLifecycleEventPublisher publisher, int limit);

    @Override default void close() { }
}
