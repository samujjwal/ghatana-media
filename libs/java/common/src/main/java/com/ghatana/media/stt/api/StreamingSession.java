package com.ghatana.media.stt.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.ProcessingError;

import java.util.function.Consumer;

/**
 * Streaming transcription session for real-time audio.
 *
 * @doc.type interface
 * @doc.purpose Real-time STT streaming session contract
 * @doc.layer platform
 * @doc.pattern ServiceInterface
 */
public interface StreamingSession extends AutoCloseable {
    void feedAudio(AudioChunk chunk);

    void onTranscription(Consumer<StreamingTranscription> callback);

    void onError(Consumer<ProcessingError> callback);

    void endStream();

    boolean isActive();

    @Override
    void close();
}
