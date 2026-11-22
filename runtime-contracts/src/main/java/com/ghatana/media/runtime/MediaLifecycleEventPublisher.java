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
    default MediaLifecyclePublicationReceipt publishWithReceipt(MediaLifecycleEvent event) {
        publish(event);
        throw new MediaLifecyclePublicationOutcomeUnknownException(
                "Lifecycle publisher did not return an exact durable append receipt");
    }
    default MediaLifecyclePublicationReceipt publishWithReceipt(
            MediaLifecycleEvent event, boolean exactReadbackRequired) {
        if (exactReadbackRequired) {
            throw new MediaLifecyclePublicationOutcomeUnknownException(
                    "Lifecycle publisher cannot reconcile the prior append before replay");
        }
        return publishWithReceipt(event);
    }
    @Override default void close() { }
}
