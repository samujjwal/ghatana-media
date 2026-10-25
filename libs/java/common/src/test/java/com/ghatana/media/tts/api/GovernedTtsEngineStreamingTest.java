package com.ghatana.media.tts.api;

import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.CanonicalAudioFormat;
import com.ghatana.media.config.TtsConfig;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GovernedTtsEngineStreamingTest {

    @Test
    void streamingDeclaresActualCanonicalFormatBeforeFirstChunk() throws Exception {
        TtsEngine delegate = mock(TtsEngine.class);
        AudioData audio = new AudioData(new byte[] {1, 2, 3, 4}, 22_050, 1, 16,
                null, AudioFormat.PCM);
        when(delegate.synthesize(anyString(), any())).thenReturn(audio);
        TtsConfig config = TtsConfig.builder()
                .defaultVoiceId("voice-test")
                .availableVoices(List.of("voice-test"))
                .enableStreaming(true)
                .build();
        GovernedTtsEngine engine = new GovernedTtsEngine(delegate, config);
        List<String> events = new CopyOnWriteArrayList<>();
        TtsStreamSink sink = new TtsStreamSink() {
            @Override public boolean isReady() { return true; }
            @Override public boolean isCancelled() { return false; }
            @Override public void awaitReady() { }
            @Override public void onAudioFormat(CanonicalAudioFormat format) {
                events.add("format:" + format);
            }
            @Override public void onChunk(AudioChunk chunk) { events.add("chunk"); }
        };

        try {
            TtsStreamingSession session = engine.startStreaming(
                    "hello", SynthesisOptions.builder().outputFormat(AudioFormat.PCM).build(), sink);
            session.completion().get(1, TimeUnit.SECONDS);

            assertThat(events).containsExactly(
                    "format:" + audio.canonicalFormat(),
                    "chunk");
        } finally {
            engine.close();
        }
    }
}
