package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;

/**
 * Backpressure and cancellation boundary for streaming TTS output.
 *
 * @doc.type interface
 * @doc.purpose Allows providers to wait for downstream demand and stop on cancellation
 * @doc.layer platform
 * @doc.pattern Sink
 */
public interface TtsStreamSink {

    boolean isReady();

    boolean isCancelled();

    /** Blocks until ready or cancelled. */
    void awaitReady() throws InterruptedException;

    void onChunk(AudioChunk chunk);
}
