package com.ghatana.tts.service;

import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.tts.api.TtsEngine;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class PersistentTtsServiceNotAdmittedTest {
    @Test
    void notAdmittedGenerationDoesNotPersistAnAudioOrFailureArtifact() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        AudioFileService files = mock(AudioFileService.class);
        TtsEngine engine = mock(TtsEngine.class);
        when(library.getTtsEngine()).thenReturn(engine);
        when(engine.synthesize(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any()))
                .thenThrow(new UnsupportedOperationException("NOT_ADMITTED: no synthesis provider"));
        PersistentTtsService service = new PersistentTtsService(
                library, files, new SimpleMeterRegistry());

        try {
            service.synthesizeAndPersist(
                    "tenant", UUID.randomUUID(), "fixture text", Optional.empty(), 1.0f, 1.0f, null)
                    .toCompletableFuture().join();
        } catch (RuntimeException expected) {
            // NOT_ADMITTED is surfaced to the caller and must not create either artifact kind.
        }

        verifyNoInteractions(files);
    }
}
