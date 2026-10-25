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

        UUID userId = UUID.randomUUID();
        assertNotAdmitted(service, userId);
        // The compatibility API has no request key or durable job identity. A replay is denied
        // independently; it cannot claim to reuse a prior output or register a second artifact.
        assertNotAdmitted(service, userId);

        verifyNoInteractions(library, files);
    }

    @Test
    void synthesisResultKeepsItsAudioBytesImmutable() {
        byte[] source = new byte[] {1, 2, 3};
        PersistentTtsService.SynthesisResult result = new PersistentTtsService.SynthesisResult(
                UUID.randomUUID(), source, 22_050, 1, 1, 1, 16, "PCM_S16LE");

        source[0] = 9;
        byte[] exposed = result.audioData();
        exposed[1] = 9;

        assertThat(result.audioData()).containsExactly(1, 2, 3);
    }

    private static void assertNotAdmitted(PersistentTtsService service, UUID userId) {
        assertThatThrownBy(() -> service.synthesizeAndPersist(
                "tenant", userId, "fixture text", Optional.empty(), 1.0f, 1.0f, null)
                .toCompletableFuture().join())
                .isInstanceOf(java.util.concurrent.CompletionException.class)
                .hasCauseInstanceOf(TtsSynthesisEngine.SynthesisException.class)
                .cause()
                .satisfies(cause -> assertThat(((TtsSynthesisEngine.SynthesisException) cause).reason())
                        .isEqualTo(TtsSynthesisEngine.FailureReason.NOT_ADMITTED));
    }
}
