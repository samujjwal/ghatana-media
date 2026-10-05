package com.ghatana.audio.video.infrastructure.persistence.ledger;

import io.activej.promise.Promise;
import java.time.Instant;
import java.util.List;

/**
 * @doc.type interface
 * @doc.purpose Port for recording audio-video run events to ledger
 * @doc.layer product
 * @doc.pattern PortAdapter
 */
public interface AudioVideoRunLedgerPort {

  /**
   * Record the start of an audio-video processing run.
   */
  Promise<Void> recordRunStart(AudioVideoRunLedgerEntry entry);

  /**
   * Record the completion of an audio-video processing run.
   */
  Promise<Void> recordRunCompletion(AudioVideoRunLedgerEntry entry);

  /**
   * Query runs by tenant within time range.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryByTenant(String tenantId, Instant from, Instant to);

  /**
   * Query runs by session ID.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryBySession(String sessionId);

  /**
   * Query runs by media artifact ID.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryByMediaArtifact(String mediaArtifactId);

  /**
   * Query runs by processing state.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryByState(
      String tenantId, AudioVideoRunLedgerEntry.RunState state, Instant from, Instant to);

  /**
   * Query runs with errors.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryErrors(String tenantId, Instant from, Instant to);

  /**
   * Query runs by provider.
   */
  Promise<List<AudioVideoRunLedgerEntry>> queryByProvider(
      String tenantId, String providerKey, Instant from, Instant to);
}
