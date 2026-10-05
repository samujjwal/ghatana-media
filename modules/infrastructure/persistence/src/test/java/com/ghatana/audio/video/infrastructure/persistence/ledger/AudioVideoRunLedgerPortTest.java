package com.ghatana.audio.video.infrastructure.persistence.ledger;

import static org.assertj.core.api.Assertions.*;

import com.ghatana.testing.activej.EventloopTestBase;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * @doc.type class
 * @doc.purpose Tests for audio-video run ledger port and adapter
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("AudioVideoRunLedgerPort Tests")
class AudioVideoRunLedgerPortTest extends EventloopTestBase {

  private AudioVideoRunLedgerPort port;
  private InMemoryAudioVideoRunLedgerAdapter adapter;
  private static final String TENANT_ID = "tenant-123";
  private static final String ACTOR_ID = "actor-456";
  private static final String SESSION_ID = "session-789";
  private static final String MEDIA_ARTIFACT_ID = "media-001";
  private static final String TRACE_ID = "trace-abc";

  @BeforeEach
  void setUp() {
    adapter = new InMemoryAudioVideoRunLedgerAdapter();
    port = adapter;
  }

  @Test
  @DisplayName("Item 279: Should record run start with required fields")
  void testRecordRunStart() {
    Instant now = Instant.now();
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-001")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(now)
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunStart(entry));

    assertThat(adapter.size()).isEqualTo(1);
    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0))
        .satisfies(
            e -> {
              assertThat(e.runId()).isEqualTo("run-001");
              assertThat(e.sessionId()).isEqualTo(SESSION_ID);
              assertThat(e.state()).isEqualTo(AudioVideoRunLedgerEntry.RunState.PROCESSING);
            });
  }

  @Test
  @DisplayName("Item 280: Should record run completion with end time")
  void testRecordRunCompletion() {
    Instant startTime = Instant.now().minusSeconds(60);
    Instant endTime = Instant.now();
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-002")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(startTime)
            .endedAt(endTime)
            .traceId(TRACE_ID)
            .processingStepCount(5)
            .bytesProcessed(1024000L)
            .build();

    runPromise(() -> port.recordRunCompletion(entry));

    assertThat(adapter.size()).isEqualTo(1);
    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    AudioVideoRunLedgerEntry recorded = entries.get(0);
    assertThat(recorded.state()).isEqualTo(AudioVideoRunLedgerEntry.RunState.SUCCEEDED);
    assertThat(recorded.getEndedAt()).isPresent().contains(endTime);
    assertThat(recorded.processingStepCount()).isEqualTo(5);
    assertThat(recorded.bytesProcessed()).isEqualTo(1024000L);
  }

  @Test
  @DisplayName("Item 281: Should capture audio processing job ID")
  void testAudioProcessingJobId() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-003")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .audioProcessingJobId("audio-job-123")
            .build();

    runPromise(() -> port.recordRunStart(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).getAudioProcessingJobId())
        .isPresent()
        .contains("audio-job-123");
  }

  @Test
  @DisplayName("Item 282: Should capture STT job ID")
  void testSttJobId() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-004")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .sttJobId("stt-job-456")
            .build();

    runPromise(() -> port.recordRunStart(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).getSttJobId()).isPresent().contains("stt-job-456");
  }

  @Test
  @DisplayName("Item 283: Should capture vision job ID")
  void testVisionJobId() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-005")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .visionJobId("vision-job-789")
            .build();

    runPromise(() -> port.recordRunStart(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).getVisionJobId()).isPresent().contains("vision-job-789");
  }

  @Test
  @DisplayName("Item 284: Should capture processing step and step count")
  void testProcessingStepTracking() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-006")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .processingStep("audio-encoding")
            .processingStepCount(3)
            .build();

    runPromise(() -> port.recordRunStart(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).getProcessingStep())
        .isPresent()
        .contains("audio-encoding");
    assertThat(entries.get(0).processingStepCount()).isEqualTo(3);
  }

  @Test
  @DisplayName("Item 285: Should track bytes processed")
  void testBytesProcessedTracking() {
    long bytesProcessed = 2048576L;
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-007")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(Instant.now())
            .endedAt(Instant.now().plusSeconds(30))
            .traceId(TRACE_ID)
            .bytesProcessed(bytesProcessed)
            .build();

    runPromise(() -> port.recordRunCompletion(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).bytesProcessed()).isEqualTo(bytesProcessed);
  }

  @Test
  @DisplayName("Item 286: Should capture provider key")
  void testProviderKeyCapture() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-008")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .providerKey("speech-recognition-v2")
            .build();

    runPromise(() -> port.recordRunStart(entry));

    List<AudioVideoRunLedgerEntry> entries = adapter.allEntries();
    assertThat(entries.get(0).getProviderKey())
        .isPresent()
        .contains("speech-recognition-v2");
  }

  @Test
  @DisplayName("Item 287: Should query runs by session")
  void testQueryBySession() {
    AudioVideoRunLedgerEntry entry1 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-009")
            .sessionId(SESSION_ID)
            .mediaArtifactId("media-001")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    AudioVideoRunLedgerEntry entry2 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-010")
            .sessionId("session-other")
            .mediaArtifactId("media-002")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunStart(entry1));
    runPromise(() -> port.recordRunStart(entry2));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryBySession(SESSION_ID));
    assertThat(results).hasSize(1);
    assertThat(results.get(0).sessionId()).isEqualTo(SESSION_ID);
  }

  @Test
  @DisplayName("Item 288: Should query runs by media artifact")
  void testQueryByMediaArtifact() {
    AudioVideoRunLedgerEntry entry1 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-011")
            .sessionId("session-1")
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    AudioVideoRunLedgerEntry entry2 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-012")
            .sessionId("session-2")
            .mediaArtifactId("media-other")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunStart(entry1));
    runPromise(() -> port.recordRunStart(entry2));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryByMediaArtifact(MEDIA_ARTIFACT_ID));
    assertThat(results).hasSize(1);
    assertThat(results.get(0).mediaArtifactId()).isEqualTo(MEDIA_ARTIFACT_ID);
  }

  @Test
  @DisplayName("Item 289: Should query runs by state")
  void testQueryByState() {
    Instant now = Instant.now();
    AudioVideoRunLedgerEntry entry1 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-013")
            .sessionId("session-1")
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(now)
            .traceId(TRACE_ID)
            .build();

    AudioVideoRunLedgerEntry entry2 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-014")
            .sessionId("session-2")
            .mediaArtifactId("media-other")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(now)
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunStart(entry1));
    runPromise(() -> port.recordRunStart(entry2));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryByState(
        TENANT_ID, AudioVideoRunLedgerEntry.RunState.PROCESSING, now.minusSeconds(60), now.plusSeconds(60)));
    assertThat(results).hasSize(1);
    assertThat(results.get(0).state())
        .isEqualTo(AudioVideoRunLedgerEntry.RunState.PROCESSING);
  }

  @Test
  @DisplayName("Item 290: Should query error runs")
  void testQueryErrors() {
    Instant now = Instant.now();
    AudioVideoRunLedgerEntry entry1 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-015")
            .sessionId("session-1")
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.FAILED)
            .startedAt(now.minusSeconds(30))
            .endedAt(now)
            .traceId(TRACE_ID)
            .errorCode(500)
            .errorMessage("Processing failed")
            .build();

    AudioVideoRunLedgerEntry entry2 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-016")
            .sessionId("session-2")
            .mediaArtifactId("media-other")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(now)
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunCompletion(entry1));
    runPromise(() -> port.recordRunCompletion(entry2));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryErrors(TENANT_ID, now.minusSeconds(60), now.plusSeconds(60)));
    assertThat(results).hasSize(1);
    assertThat(results.get(0).state())
        .isEqualTo(AudioVideoRunLedgerEntry.RunState.FAILED);
  }

  @Test
  @DisplayName("Item 291: Should query runs by provider")
  void testQueryByProvider() {
    Instant now = Instant.now();
    AudioVideoRunLedgerEntry entry1 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-017")
            .sessionId("session-1")
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(now)
            .traceId(TRACE_ID)
            .providerKey("google-speech-to-text")
            .build();

    AudioVideoRunLedgerEntry entry2 =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-018")
            .sessionId("session-2")
            .mediaArtifactId("media-other")
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(now)
            .traceId(TRACE_ID)
            .providerKey("azure-speech-to-text")
            .build();

    runPromise(() -> port.recordRunStart(entry1));
    runPromise(() -> port.recordRunStart(entry2));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryByProvider(TENANT_ID, "google-speech-to-text", now.minusSeconds(60), now.plusSeconds(60)));
    assertThat(results).hasSize(1);
    assertThat(results.get(0).providerKey()).isEqualTo("google-speech-to-text");
  }

  @Test
  @DisplayName("Item 292: Should enforce immutability")
  void testImmutability() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-019")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    assertThat(entry).isNotNull();
    assertThat(entry.runId()).isEqualTo("run-019");
  }

  @Test
  @DisplayName("Item 293: Should handle terminal state detection")
  void testTerminalStateDetection() {
    AudioVideoRunLedgerEntry succeeded =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-020")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    AudioVideoRunLedgerEntry processing =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-021")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    assertThat(succeeded.isTerminal()).isTrue();
    assertThat(processing.isTerminal()).isFalse();
  }

  @Test
  @DisplayName("Item 294: Should validate required fields")
  void testRequiredFieldValidation() {
    assertThatThrownBy(
            () ->
                AudioVideoRunLedgerEntry.builder()
                    .sessionId(SESSION_ID)
                    .mediaArtifactId(MEDIA_ARTIFACT_ID)
                    .tenantId(TENANT_ID)
                    .actorId(ACTOR_ID)
                    .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
                    .startedAt(Instant.now())
                    .traceId(TRACE_ID)
                    .build())
        .isInstanceOf(NullPointerException.class);
  }

  @Test
  @DisplayName("Item 295: Should validate field constraints")
  void testFieldConstraintValidation() {
    assertThatThrownBy(
            () ->
                AudioVideoRunLedgerEntry.builder()
                    .runId("run-022")
                    .sessionId(SESSION_ID)
                    .mediaArtifactId(MEDIA_ARTIFACT_ID)
                    .tenantId(TENANT_ID)
                    .actorId(ACTOR_ID)
                    .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
                    .startedAt(Instant.now())
                    .endedAt(Instant.now().minusSeconds(60))
                    .traceId(TRACE_ID)
                    .build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("endedAt must be after startedAt");
  }

  @Test
  @DisplayName("Item 296: Should handle empty query results gracefully")
  void testEmptyQueryResults() {
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryBySession("non-existent"));
    assertThat(results).isEmpty();
  }

  @Test
  @DisplayName("Item 297: Should handle concurrent access")
  void testConcurrentAccess() {
    AudioVideoRunLedgerEntry entry =
        AudioVideoRunLedgerEntry.builder()
            .runId("run-023")
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.PROCESSING)
            .startedAt(Instant.now())
            .traceId(TRACE_ID)
            .build();

    runPromise(() -> port.recordRunStart(entry));
    runPromise(() -> port.recordRunStart(entry));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryBySession(SESSION_ID));
    assertThat(results).hasSize(2);
  }

  @Test
  @DisplayName("Item 298: Should track full lifecycle from start to completion")
  void testFullLifecycleTracking() {
    String runId = "run-024";
    Instant startTime = Instant.now();
    Instant endTime = startTime.plusSeconds(120);

    AudioVideoRunLedgerEntry startEntry =
        AudioVideoRunLedgerEntry.builder()
            .runId(runId)
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.QUEUED)
            .startedAt(startTime)
            .traceId(TRACE_ID)
            .audioProcessingJobId("job-001")
            .processingStepCount(0)
            .build();

    AudioVideoRunLedgerEntry completeEntry =
        AudioVideoRunLedgerEntry.builder()
            .runId(runId)
            .sessionId(SESSION_ID)
            .mediaArtifactId(MEDIA_ARTIFACT_ID)
            .tenantId(TENANT_ID)
            .actorId(ACTOR_ID)
            .state(AudioVideoRunLedgerEntry.RunState.SUCCEEDED)
            .startedAt(startTime)
            .endedAt(endTime)
            .traceId(TRACE_ID)
            .audioProcessingJobId("job-001")
            .processingStepCount(5)
            .bytesProcessed(5242880L)
            .build();

    runPromise(() -> port.recordRunStart(startEntry));
    runPromise(() -> port.recordRunCompletion(completeEntry));
    List<AudioVideoRunLedgerEntry> results = runPromise(() -> port.queryBySession(SESSION_ID));
    assertThat(results).hasSize(2);
    assertThat(results.get(0).state())
        .isEqualTo(AudioVideoRunLedgerEntry.RunState.QUEUED);
    assertThat(results.get(1).state())
        .isEqualTo(AudioVideoRunLedgerEntry.RunState.SUCCEEDED);
  }
}
