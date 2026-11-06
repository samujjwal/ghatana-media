package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.ProcessingError;
import com.ghatana.media.stt.api.StreamingSession;
import com.ghatana.media.stt.api.StreamingTranscription;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperStreamingLifecycleTest {
    @Test
    void closingAbandonedSessionReleasesBufferedAudioAndCallbacks() throws Exception {
        Class<?> type = Class.forName(WhisperOnnxEngine.class.getName() + "$WhisperStreamingSession");
        Constructor<?> constructor = type.getDeclaredConstructors()[0];
        constructor.setAccessible(true);
        StreamingSession session = (StreamingSession) constructor.newInstance(null, null, null);

        session.feedAudio(new AudioChunk(new byte[] {1, 2, 3}, 0, false, 1L));
        Field bufferField = type.getDeclaredField("buffer");
        bufferField.setAccessible(true);
        assertThat((List<?>) bufferField.get(session)).hasSize(1);
        Field transcriptField = type.getDeclaredField("accumulatedText");
        transcriptField.setAccessible(true);
        ((StringBuilder) transcriptField.get(session)).append("partial transcript");
        session.onTranscription(ignored -> {});
        session.onError((ProcessingError ignored) -> {});

        session.close();
        session.close();

        Consumer<StreamingTranscription> lateTranscription = ignored -> {};
        Consumer<ProcessingError> lateError = ignored -> {};
        session.onTranscription(lateTranscription);
        session.onError(lateError);

        assertThat((List<?>) bufferField.get(session)).isEmpty();
        assertThat(transcriptField.get(session).toString()).isEmpty();
        assertThat(callback(type, "transcriptionCallback", session)).isNull();
        assertThat(callback(type, "errorCallback", session)).isNull();
        assertThat(session.isActive()).isFalse();
    }

    private static Object callback(Class<?> type, String name, Object session) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return ((java.util.concurrent.atomic.AtomicReference<?>) field.get(session)).get();
    }
}
