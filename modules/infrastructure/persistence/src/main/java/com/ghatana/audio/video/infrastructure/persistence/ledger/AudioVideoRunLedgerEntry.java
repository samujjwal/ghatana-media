package com.ghatana.audio.video.infrastructure.persistence.ledger;

import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * @doc.type record
 * @doc.purpose Immutable record capturing audio-video run events with full lifecycle state
 * @doc.layer product
 * @doc.pattern AudioVideoLedger
 */
public record AudioVideoRunLedgerEntry(
    String runId,
    String sessionId,
    String mediaArtifactId,
    String tenantId,
    String actorId,
    RunState state,
    Instant startedAt,
    Instant endedAt,
    String traceId,
    String audioProcessingJobId,
    String sttJobId,
    String visionJobId,
    Integer processingStepCount,
    String processingStep,
    Long bytesProcessed,
    Integer errorCode,
    String errorMessage,
    Integer retryCount,
    String providerKey,
    Map<String, Object> systemMetadata
) {

  /**
   * Audio-video run lifecycle states.
   */
  public enum RunState {
    QUEUED,
    PROCESSING,
    SUCCEEDED,
    FAILED,
    CANCELLED,
    RETRYING,
    REQUIRES_REVIEW,
    DEGRADED
  }

  /**
   * Compact constructor with validation.
   */
  public AudioVideoRunLedgerEntry {
    Objects.requireNonNull(runId, "runId must not be null");
    Objects.requireNonNull(sessionId, "sessionId must not be null");
    Objects.requireNonNull(mediaArtifactId, "mediaArtifactId must not be null");
    Objects.requireNonNull(tenantId, "tenantId must not be null");
    Objects.requireNonNull(actorId, "actorId must not be null");
    Objects.requireNonNull(state, "state must not be null");
    Objects.requireNonNull(startedAt, "startedAt must not be null");
    Objects.requireNonNull(traceId, "traceId must not be null");

    if (runId.isBlank()) {
      throw new IllegalArgumentException("runId must not be blank");
    }
    if (sessionId.isBlank()) {
      throw new IllegalArgumentException("sessionId must not be blank");
    }
    if (mediaArtifactId.isBlank()) {
      throw new IllegalArgumentException("mediaArtifactId must not be blank");
    }
    if (tenantId.isBlank()) {
      throw new IllegalArgumentException("tenantId must not be blank");
    }
    if (actorId.isBlank()) {
      throw new IllegalArgumentException("actorId must not be blank");
    }
    if (traceId.isBlank()) {
      throw new IllegalArgumentException("traceId must not be blank");
    }

    if (endedAt != null && endedAt.isBefore(startedAt)) {
      throw new IllegalArgumentException("endedAt must be after startedAt");
    }

    if (retryCount != null && retryCount < 0) {
      throw new IllegalArgumentException("retryCount must be non-negative");
    }

    if (bytesProcessed != null && bytesProcessed < 0) {
      throw new IllegalArgumentException("bytesProcessed must be non-negative");
    }

    if (processingStepCount != null && processingStepCount < 0) {
      throw new IllegalArgumentException("processingStepCount must be non-negative");
    }
  }

  /**
   * Create builder for AudioVideoRunLedgerEntry.
   */
  public static Builder builder() {
    return new Builder();
  }

  /**
   * Builder for AudioVideoRunLedgerEntry.
   */
  public static class Builder {
    private String runId;
    private String sessionId;
    private String mediaArtifactId;
    private String tenantId;
    private String actorId;
    private RunState state = RunState.QUEUED;
    private Instant startedAt;
    private Instant endedAt;
    private String traceId;
    private String audioProcessingJobId;
    private String sttJobId;
    private String visionJobId;
    private Integer processingStepCount = 0;
    private String processingStep;
    private Long bytesProcessed = 0L;
    private Integer errorCode;
    private String errorMessage;
    private Integer retryCount = 0;
    private String providerKey;
    private Map<String, Object> systemMetadata = Collections.emptyMap();

    public Builder runId(String runId) {
      this.runId = runId;
      return this;
    }

    public Builder sessionId(String sessionId) {
      this.sessionId = sessionId;
      return this;
    }

    public Builder mediaArtifactId(String mediaArtifactId) {
      this.mediaArtifactId = mediaArtifactId;
      return this;
    }

    public Builder tenantId(String tenantId) {
      this.tenantId = tenantId;
      return this;
    }

    public Builder actorId(String actorId) {
      this.actorId = actorId;
      return this;
    }

    public Builder state(RunState state) {
      this.state = state;
      return this;
    }

    public Builder startedAt(Instant startedAt) {
      this.startedAt = startedAt;
      return this;
    }

    public Builder endedAt(Instant endedAt) {
      this.endedAt = endedAt;
      return this;
    }

    public Builder traceId(String traceId) {
      this.traceId = traceId;
      return this;
    }

    public Builder audioProcessingJobId(String audioProcessingJobId) {
      this.audioProcessingJobId = audioProcessingJobId;
      return this;
    }

    public Builder sttJobId(String sttJobId) {
      this.sttJobId = sttJobId;
      return this;
    }

    public Builder visionJobId(String visionJobId) {
      this.visionJobId = visionJobId;
      return this;
    }

    public Builder processingStepCount(Integer processingStepCount) {
      this.processingStepCount = processingStepCount;
      return this;
    }

    public Builder processingStep(String processingStep) {
      this.processingStep = processingStep;
      return this;
    }

    public Builder bytesProcessed(Long bytesProcessed) {
      this.bytesProcessed = bytesProcessed;
      return this;
    }

    public Builder errorCode(Integer errorCode) {
      this.errorCode = errorCode;
      return this;
    }

    public Builder errorMessage(String errorMessage) {
      this.errorMessage = errorMessage;
      return this;
    }

    public Builder retryCount(Integer retryCount) {
      this.retryCount = retryCount;
      return this;
    }

    public Builder providerKey(String providerKey) {
      this.providerKey = providerKey;
      return this;
    }

    public Builder systemMetadata(Map<String, Object> systemMetadata) {
      this.systemMetadata = systemMetadata != null ? new java.util.HashMap<>(systemMetadata) : Collections.emptyMap();
      return this;
    }

    public AudioVideoRunLedgerEntry build() {
      return new AudioVideoRunLedgerEntry(
          runId,
          sessionId,
          mediaArtifactId,
          tenantId,
          actorId,
          state,
          startedAt,
          endedAt,
          traceId,
          audioProcessingJobId,
          sttJobId,
          visionJobId,
          processingStepCount,
          processingStep,
          bytesProcessed,
          errorCode,
          errorMessage,
          retryCount,
          providerKey,
          systemMetadata
      );
    }
  }

  /**
   * Check if run is in terminal state.
   */
  public boolean isTerminal() {
    return state == RunState.SUCCEEDED || state == RunState.FAILED || state == RunState.CANCELLED;
  }

  /**
   * Get optional error code.
   */
  public Optional<Integer> getErrorCode() {
    return Optional.ofNullable(errorCode);
  }

  /**
   * Get optional error message.
   */
  public Optional<String> getErrorMessage() {
    return Optional.ofNullable(errorMessage);
  }

  /**
   * Get optional audio processing job ID.
   */
  public Optional<String> getAudioProcessingJobId() {
    return Optional.ofNullable(audioProcessingJobId);
  }

  /**
   * Get optional STT job ID.
   */
  public Optional<String> getSttJobId() {
    return Optional.ofNullable(sttJobId);
  }

  /**
   * Get optional vision job ID.
   */
  public Optional<String> getVisionJobId() {
    return Optional.ofNullable(visionJobId);
  }

  /**
   * Get optional processing step.
   */
  public Optional<String> getProcessingStep() {
    return Optional.ofNullable(processingStep);
  }

  /**
   * Get optional provider key.
   */
  public Optional<String> getProviderKey() {
    return Optional.ofNullable(providerKey);
  }

  /**
   * Get optional end time.
   */
  public Optional<Instant> getEndedAt() {
    return Optional.ofNullable(endedAt);
  }
}
