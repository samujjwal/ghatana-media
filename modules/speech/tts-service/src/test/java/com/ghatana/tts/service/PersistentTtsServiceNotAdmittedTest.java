package com.ghatana.tts.service;

import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.tts.engine.TtsSynthesisEngine;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class PersistentTtsServiceNotAdmittedTest {
    @Test
    void notAdmittedGenerationDoesNotPersistAnAudioOrFailureArtifact() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        AudioFileService files = mock(AudioFileService.class);
        PersistentTtsService service = new PersistentTtsService(
                library, files, new SimpleMeterRegistry());

        assertThatThrownBy(() -> service.synthesizeAndPersist(
                "tenant", UUID.randomUUID(), "fixture text", Optional.empty(), 1.0f, 1.0f, null)
                .toCompletableFuture().join())
                .isInstanceOf(java.util.concurrent.CompletionException.class)
                .hasCauseInstanceOf(TtsSynthesisEngine.SynthesisException.class)
                .cause()
                .satisfies(cause -> assertThat(((TtsSynthesisEngine.SynthesisException) cause).reason())
                        .isEqualTo(TtsSynthesisEngine.FailureReason.NOT_ADMITTED));

        verifyNoInteractions(library, files);
    }
}
