package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.CanonicalAudioFormat;

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

    /**
     * Declares the provider's actual encoded stream format before the first chunk.
     *
     * <p>The default preserves source compatibility for existing providers. Consumers that need
     * to verify a wire format may reject a stream that does not make this declaration.
     */
    default void onAudioFormat(CanonicalAudioFormat format) { }

    void onChunk(AudioChunk chunk);
}
