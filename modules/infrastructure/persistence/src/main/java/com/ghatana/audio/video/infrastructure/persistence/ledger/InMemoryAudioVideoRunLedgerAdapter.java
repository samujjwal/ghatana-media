package com.ghatana.audio.video.infrastructure.persistence.ledger;

import io.activej.promise.Promise;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

/**
 * @doc.type class
 * @doc.purpose Thread-safe in-memory adapter for audio-video run ledger
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class InMemoryAudioVideoRunLedgerAdapter implements AudioVideoRunLedgerPort {

  private static final org.slf4j.Logger logger =
      org.slf4j.LoggerFactory.getLogger(InMemoryAudioVideoRunLedgerAdapter.class);

  private final CopyOnWriteArrayList<AudioVideoRunLedgerEntry> entries;

  public InMemoryAudioVideoRunLedgerAdapter() {
    this.entries = new CopyOnWriteArrayList<>();
  }

  @Override
  public Promise<Void> recordRunStart(AudioVideoRunLedgerEntry entry) {
    Objects.requireNonNull(entry, "entry must not be null");
    try {
      entries.add(entry);
      logger.debug("Recorded run start: runId={}, sessionId={}", entry.runId(), entry.sessionId());
      return Promise.complete();
    } catch (Exception e) {
      logger.warn("Failed to record run start: {}", e.getMessage());
      return Promise.complete();
    }
  }

  @Override
  public Promise<Void> recordRunCompletion(AudioVideoRunLedgerEntry entry) {
    Objects.requireNonNull(entry, "entry must not be null");
    try {
      entries.add(entry);
      logger.debug(
          "Recorded run completion: runId={}, state={}, duration={}ms",
          entry.runId(),
          entry.state(),
          entry.getEndedAt()
              .map(ended -> ended.toEpochMilli() - entry.startedAt().toEpochMilli())
              .orElse(-1L));
      return Promise.complete();
    } catch (Exception e) {
      logger.warn("Failed to record run completion: {}", e.getMessage());
      return Promise.complete();
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryByTenant(String tenantId, Instant from, Instant to) {
    Objects.requireNonNull(tenantId, "tenantId must not be null");
    Objects.requireNonNull(from, "from must not be null");
    Objects.requireNonNull(to, "to must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.tenantId().equals(tenantId))
              .filter(e -> !e.startedAt().isBefore(from) && !e.startedAt().isAfter(to))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query runs by tenant: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryBySession(String sessionId) {
    Objects.requireNonNull(sessionId, "sessionId must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.sessionId().equals(sessionId))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query runs by session: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryByMediaArtifact(String mediaArtifactId) {
    Objects.requireNonNull(mediaArtifactId, "mediaArtifactId must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.mediaArtifactId().equals(mediaArtifactId))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query runs by media artifact: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryByState(
      String tenantId, AudioVideoRunLedgerEntry.RunState state, Instant from, Instant to) {
    Objects.requireNonNull(tenantId, "tenantId must not be null");
    Objects.requireNonNull(state, "state must not be null");
    Objects.requireNonNull(from, "from must not be null");
    Objects.requireNonNull(to, "to must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.tenantId().equals(tenantId))
              .filter(e -> e.state() == state)
              .filter(e -> !e.startedAt().isBefore(from) && !e.startedAt().isAfter(to))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query runs by state: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryErrors(String tenantId, Instant from, Instant to) {
    Objects.requireNonNull(tenantId, "tenantId must not be null");
    Objects.requireNonNull(from, "from must not be null");
    Objects.requireNonNull(to, "to must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.tenantId().equals(tenantId))
              .filter(
                  e ->
                      e.state() == AudioVideoRunLedgerEntry.RunState.FAILED
                          || e.state() == AudioVideoRunLedgerEntry.RunState.REQUIRES_REVIEW)
              .filter(e -> !e.startedAt().isBefore(from) && !e.startedAt().isAfter(to))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query errors: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  @Override
  public Promise<List<AudioVideoRunLedgerEntry>> queryByProvider(
      String tenantId, String providerKey, Instant from, Instant to) {
    Objects.requireNonNull(tenantId, "tenantId must not be null");
    Objects.requireNonNull(providerKey, "providerKey must not be null");
    Objects.requireNonNull(from, "from must not be null");
    Objects.requireNonNull(to, "to must not be null");

    try {
      List<AudioVideoRunLedgerEntry> result =
          entries.stream()
              .filter(e -> e.tenantId().equals(tenantId))
              .filter(e -> providerKey.equals(e.providerKey()))
              .filter(e -> !e.startedAt().isBefore(from) && !e.startedAt().isAfter(to))
              .collect(Collectors.toList());
      return Promise.of(result);
    } catch (Exception e) {
      logger.warn("Failed to query runs by provider: {}", e.getMessage());
      return Promise.of(new ArrayList<>());
    }
  }

  // Test helpers
  public void clear() {
    entries.clear();
  }

  public int size() {
    return entries.size();
  }

  public List<AudioVideoRunLedgerEntry> allEntries() {
    return new ArrayList<>(entries);
  }
}
