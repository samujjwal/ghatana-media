package com.ghatana.media.stt.engine.native_whisper;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.ProcessingError;
import com.ghatana.media.stt.api.StreamingSession;
import com.ghatana.media.stt.api.StreamingTranscription;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperCppStreamingLifecycleTest {
    @Test
    void closingAbandonedSessionReleasesBufferedAudioAndCallbacksWithoutLoadingNativeAdapter()
            throws Exception {
        // Initializing the static nested session does not initialize WhisperCppAdapter's
        // outer class, whose static initializer loads the optional native library.
        Class<?> type = Class.forName(
                "com.ghatana.media.stt.engine.native_whisper.WhisperCppAdapter$WhisperStreamingSession");
        Constructor<?> constructor = type.getDeclaredConstructors()[0];
        constructor.setAccessible(true);
        StreamingSession session = (StreamingSession) constructor.newInstance(null, null, null);

        session.feedAudio(new AudioChunk(new byte[] {1, 2, 3}, 0, false, 1L));
        Field bufferField = type.getDeclaredField("buffer");
        bufferField.setAccessible(true);
        assertThat((List<?>) bufferField.get(session)).hasSize(1);

        AtomicBoolean transcriptionCalled = new AtomicBoolean();
        AtomicBoolean errorCalled = new AtomicBoolean();
        session.onTranscription((StreamingTranscription ignored) -> transcriptionCalled.set(true));
        session.onError((ProcessingError ignored) -> errorCalled.set(true));

        session.close();
        session.close();

        session.onTranscription((StreamingTranscription ignored) -> transcriptionCalled.set(true));
        session.onError((ProcessingError ignored) -> errorCalled.set(true));

        assertThat((List<?>) bufferField.get(session)).isEmpty();
        assertThat(callback(type, "transcriptionCallback", session)).isNull();
        assertThat(callback(type, "errorCallback", session)).isNull();
        assertThat(session.isActive()).isFalse();
        assertThat(transcriptionCalled).isFalse();
        assertThat(errorCalled).isFalse();
    }

    private static Object callback(Class<?> type, String name, Object session) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return ((AtomicReference<?>) field.get(session)).get();
    }
}
