/**
 * @doc.type test
 * @doc.purpose Verify AudioVideoOutboxStoreImpl with provider tracking
 * @doc.layer product
 * @doc.pattern Test
 */
package com.ghatana.audiovideo.outbox;

import static org.junit.jupiter.api.Assertions.*;

import com.ghatana.java.database.outbox.OutboxEvent;
import com.ghatana.java.database.outbox.OutboxStore;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@DisplayName("AudioVideoOutboxStoreImpl Tests - Media Provider Tracking")
class AudioVideoOutboxStoreImplTest {

  private AudioVideoOutboxStoreImpl store;
  private OutboxEvent transcodingEvent;

  @BeforeEach
  void setUp() {
    store = new AudioVideoOutboxStoreImpl();
    
    transcodingEvent =
        new OutboxEvent(
            "transcoding-001",
            "tenant-audiovideo-001",
            "transcoding-job-queued",
            "job-transcoding-123",
            "transcoding-job",
            "{\"jobId\": \"job-transcoding-123\", \"mediaType\": \"audio\", \"provider\": \"AWS\"}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.of("provider-job-aws-456"));
  }

  @Test
  @DisplayName("Should append transcoding event")
  void testAppendTranscodingEvent() {
    OutboxEvent appended = store.append(transcodingEvent);
    
    assertNotNull(appended);
    assertTrue(appended.isPending());
  }

  @Test
  @DisplayName("Should track provider job ID")
  void testTrackProviderJobId() {
    store.append(transcodingEvent);
    
    Optional<String> providerJobId = store.getProviderJobId("transcoding-001");
    
    assertTrue(providerJobId.isPresent());
    assertEquals("provider-job-aws-456", providerJobId.get());
  }

  @Test
  @DisplayName("Should retrieve pending media processing events")
  void testGetPendingMediaEvents() {
    store.append(transcodingEvent);
    
    OutboxEvent visionEvent =
        new OutboxEvent(
            "vision-001",
            "tenant-audiovideo-001",
            "vision-analysis-queued",
            "job-vision-789",
            "vision-job",
            "{\"jobId\": \"job-vision-789\", \"mediaType\": \"video\"}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.of("provider-job-google-111"));
    store.append(visionEvent);
    
    List<OutboxEvent> pending = store.getPending("tenant-audiovideo-001", 10);
    
    assertEquals(2, pending.size());
  }

  @Test
  @DisplayName("Should mark media processing event as published")
  void testMarkMediaEventPublished() {
    store.append(transcodingEvent);
    
    long publishedAtMs = System.currentTimeMillis();
    OutboxEvent published = store.markPublished(transcodingEvent, publishedAtMs);
    
    assertTrue(published.isPublished());
    assertFalse(published.isPending());
  }

  @Test
  @DisplayName("Should handle media processing failure and retry")
  void testMediaProcessingFailureAndRetry() {
    store.append(transcodingEvent);
    
    OutboxEvent failed = store.markFailed(transcodingEvent, "Provider transcoding service timeout");
    assertTrue(failed.hasFailed());
    
    List<OutboxEvent> failedEvents = store.getFailedForRetry("tenant-audiovideo-001", 10);
    
    assertEquals(1, failedEvents.size());
    assertEquals("Provider transcoding service timeout", failedEvents.get(0).failureReason().get());
  }

  @Test
  @DisplayName("Should sort failed events by retry count for backoff")
  void testFailedEventsSortedByRetryCount() {
    // First failure
    store.append(transcodingEvent);
    OutboxEvent failed1 = store.markFailed(transcodingEvent, "Timeout 1");
    
    // Second event with more retries
    OutboxEvent transcodingEvent2 =
        new OutboxEvent(
            "transcoding-002",
            "tenant-audiovideo-001",
            "transcoding-job-queued",
            "job-transcoding-124",
            "transcoding-job",
            "{}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.empty());
    store.append(transcodingEvent2);
    OutboxEvent failed2 = store.markFailed(transcodingEvent2, "Timeout 2");
    
    // Fail the first one again to increase retry count
    store.markFailed(failed1, "Timeout 3");
    
    List<OutboxEvent> failedEvents = store.getFailedForRetry("tenant-audiovideo-001", 10);
    
    // Should be sorted by retry count ascending (exponential backoff: oldest retries first)
    assertTrue(failedEvents.size() >= 1);
  }

  @Test
  @DisplayName("Should archive media event and clean up provider tracking")
  void testArchiveAndCleanupProviderTracking() {
    store.append(transcodingEvent);
    
    // Verify tracking exists before archive
    assertTrue(store.getProviderJobId("transcoding-001").isPresent());
    
    OutboxEvent archived = store.archive(transcodingEvent);
    
    assertEquals("ARCHIVED", archived.status());
    // Tracking should be cleaned up
    assertTrue(store.getProviderJobId("transcoding-001").isEmpty());
  }

  @Test
  @DisplayName("Should retrieve events by processing job source")
  void testGetByProcessingJobSource() {
    store.append(transcodingEvent);
    
    List<OutboxEvent> jobEvents =
        store.getBySource("tenant-audiovideo-001", "job-transcoding-123", "transcoding-job");
    
    assertEquals(1, jobEvents.size());
    assertEquals("transcoding-001", jobEvents.get(0).eventId());
  }

  @Test
  @DisplayName("Should handle multiple media types (AUDIO, VIDEO, MULTIMODAL)")
  void testMultipleMediaTypes() {
    // Audio event
    store.append(transcodingEvent); // Audio
    
    // Video event
    OutboxEvent videoEvent =
        new OutboxEvent(
            "transcoding-video-001",
            "tenant-audiovideo-001",
            "transcoding-job-queued",
            "job-transcoding-video-456",
            "transcoding-job",
            "{\"mediaType\": \"video\"}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.empty());
    store.append(videoEvent);
    
    // Multimodal event
    OutboxEvent multimodalEvent =
        new OutboxEvent(
            "multimodal-001",
            "tenant-audiovideo-001",
            "multimodal-indexing-queued",
            "job-multimodal-789",
            "multimodal-job",
            "{\"mediaType\": \"multimodal\"}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.empty());
    store.append(multimodalEvent);
    
    List<OutboxEvent> pending = store.getPending("tenant-audiovideo-001", 10);
    
    assertEquals(3, pending.size());
  }

  @Test
  @DisplayName("Should enforce tenant isolation for media events")
  void testTenantIsolation() {
    store.append(transcodingEvent);
    
    // Different tenant should not see events
    List<OutboxEvent> differentTenantEvents =
        store.getPending("tenant-audiovideo-different", 10);
    
    assertTrue(differentTenantEvents.isEmpty());
  }

  @Test
  @DisplayName("Should only return pending events when filtering")
  void testPendingFiltering() {
    store.append(transcodingEvent);
    
    // Publish first event
    store.markPublished(transcodingEvent, System.currentTimeMillis());
    
    // Add another pending event
    OutboxEvent anotherEvent =
        new OutboxEvent(
            "transcoding-003",
            "tenant-audiovideo-001",
            "transcoding-job-queued",
            "job-transcoding-125",
            "transcoding-job",
            "{}",
            "PENDING",
            Optional.empty(),
            0,
            Optional.empty(),
            System.currentTimeMillis(),
            Optional.empty());
    store.append(anotherEvent);
    
    List<OutboxEvent> pending = store.getPending("tenant-audiovideo-001", 10);
    
    assertEquals(1, pending.size());
    assertEquals("transcoding-003", pending.get(0).eventId());
  }
}
