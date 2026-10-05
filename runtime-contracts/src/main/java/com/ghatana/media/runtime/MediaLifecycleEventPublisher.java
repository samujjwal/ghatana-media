package com.ghatana.media.runtime;

/**
 * Event Plane publication boundary for neutral Media lifecycle facts.
 *
 * @doc.type interface
 * @doc.purpose Define the Media Lifecycle Event Publisher contract
 * @doc.layer product
 * @doc.pattern Observer
 */
public interface MediaLifecycleEventPublisher extends AutoCloseable {
    String publisherId();
    boolean ready();
    boolean productionEligible();
    void publish(MediaLifecycleEvent event);
    @Override default void close() { }
}
