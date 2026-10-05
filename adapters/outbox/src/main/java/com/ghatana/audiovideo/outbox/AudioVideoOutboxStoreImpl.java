/**
 * @doc.type class
 * @doc.purpose Audio-Video implementation of OutboxStore for media processing events
 * @doc.layer product
 * @doc.pattern Adapter
 */
package com.ghatana.audiovideo.outbox;

import static com.ghatana.core.validation.Preconditions.*;

import com.ghatana.java.database.outbox.OutboxEvent;
import com.ghatana.java.database.outbox.OutboxStore;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

/**
 * Audio-Video implementation of OutboxStore.
 *
 * <p>Stores media processing events durably with provider tracking. Supports publishing to
 * external media processing brokers with retry on failure.
 *
 * <p>Event Types:
 * <ul>
 *   <li>transcoding-job-queued - Transcoding job created
 *   <li>transcoding-started - Transcoding in progress
 *   <li>transcoding-completed - Transcoding finished
 *   <li>vision-analysis-queued - Vision analysis job created
 *   <li>vision-analysis-completed - Vision analysis finished
 *   <li>multimodal-indexing-queued - Multimodal indexing started
 *   <li>multimodal-indexing-completed - Multimodal indexing finished
 * </ul>
 *
 * <p>Provider Tracking:
 * <ul>
 *   <li>Provider name (e.g., "AWS MediaConvert", "Google Video AI")
 *   <li>Provider job ID for tracking external job state
 *   <li>Media type (AUDIO, VIDEO, MULTIMODAL)
 *   <li>Processing status propagation to Data Cloud
 * </ul>
 */
@Repository
public class AudioVideoOutboxStoreImpl implements OutboxStore {

  // In-memory store (replace with persistent store in production)
  private final Map<String, OutboxEvent> eventStore = new ConcurrentHashMap<>();
  private final Map<String, List<String>> tenantIndex = new ConcurrentHashMap<>();
  private final Map<String, List<String>> sourceIndex = new ConcurrentHashMap<>();
  private final Map<String, String> providerJobIds = new ConcurrentHashMap<>();

  @Override
  public OutboxEvent append(OutboxEvent event) {
    requireNonNull(event, "event");
    
    // Store event
    eventStore.put(event.eventId(), event);
    
    // Index by tenant for efficient retrieval
    String tenantKey = "tenant:" + event.tenantId();
    tenantIndex.computeIfAbsent(tenantKey, k -> new ArrayList<>()).add(event.eventId());
    
    // Index by source for efficient retrieval (job ID, collection, etc.)
    String sourceKey = "source:" + event.sourceType() + ":" + event.sourceId();
    sourceIndex.computeIfAbsent(sourceKey, k -> new ArrayList<>()).add(event.eventId());
    
    // Extract provider job ID if present in correlation ID or payload
    extractAndTrackProviderJobId(event);
    
    return event;
  }

  @Override
  public List<OutboxEvent> getPending(String tenantId, int limit) {
    requireNonBlank(tenantId, "tenantId");
    
    String tenantKey = "tenant:" + tenantId;
    List<String> eventIds = tenantIndex.getOrDefault(tenantKey, List.of());
    
    return eventIds.stream()
        .map(eventStore::get)
        .filter(event -> event != null && event.isPending())
        .limit(limit)
        .toList();
  }

  @Override
  public OutboxEvent markPublished(OutboxEvent event, long publishedAtMs) {
    requireNonNull(event, "event");
    
    OutboxEvent updated = event.withPublished(publishedAtMs);
    eventStore.put(event.eventId(), updated);
    return updated;
  }

  @Override
  public OutboxEvent markFailed(OutboxEvent event, String failureReason) {
    requireNonNull(event, "event");
    requireNonBlank(failureReason, "failureReason");
    
    OutboxEvent updated = event.withFailure(failureReason);
    eventStore.put(event.eventId(), updated);
    return updated;
  }

  @Override
  public OutboxEvent archive(OutboxEvent event) {
    requireNonNull(event, "event");
    
    OutboxEvent updated = event.withArchived();
    eventStore.put(event.eventId(), updated);
    
    // Clean up provider job ID tracking
    providerJobIds.remove(event.eventId());
    
    return updated;
  }

  @Override
  public List<OutboxEvent> getFailedForRetry(String tenantId, int limit) {
    requireNonBlank(tenantId, "tenantId");
    
    String tenantKey = "tenant:" + tenantId;
    List<String> eventIds = tenantIndex.getOrDefault(tenantKey, List.of());
    
    return eventIds.stream()
        .map(eventStore::get)
        .filter(event -> event != null && event.hasFailed())
        .sorted(
            (e1, e2) -> {
              // Sort by retry count then creation time for exponential backoff
              int retryDiff = Integer.compare(e1.retryCount(), e2.retryCount());
              return retryDiff != 0 ? retryDiff : Long.compare(e1.createdAtMs(), e2.createdAtMs());
            })
        .limit(limit)
        .toList();
  }

  @Override
  public List<OutboxEvent> getBySource(String tenantId, String sourceId, String sourceType) {
    requireNonBlank(tenantId, "tenantId");
    requireNonBlank(sourceId, "sourceId");
    requireNonBlank(sourceType, "sourceType");
    
    String sourceKey = "source:" + sourceType + ":" + sourceId;
    List<String> eventIds = sourceIndex.getOrDefault(sourceKey, List.of());
    
    return eventIds.stream()
        .map(eventStore::get)
        .filter(
            event ->
                event != null
                    && event.tenantId().equals(tenantId)
                    && event.sourceId().equals(sourceId)
                    && event.sourceType().equals(sourceType))
        .toList();
  }

  /**
   * Get provider job ID for external tracking.
   *
   * @param eventId the event ID
   * @return provider job ID if available
   */
  public Optional<String> getProviderJobId(String eventId) {
    return Optional.ofNullable(providerJobIds.get(eventId));
  }

  /**
   * Extract and track provider job ID from event payload.
   *
   * @param event the outbox event
   */
  private void extractAndTrackProviderJobId(OutboxEvent event) {
    // In production, parse event.payload() JSON to extract provider job ID
    // For now, store correlation ID as proxy if present
    if (event.correlationId().isPresent()) {
      providerJobIds.put(event.eventId(), event.correlationId().get());
    }
  }
}
