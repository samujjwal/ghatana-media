package com.ghatana.tts.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class PersistentTtsServiceControlValidationTest {
    private final AudioVideoLibrary library = mock(AudioVideoLibrary.class);
    private final AudioFileService files = mock(AudioFileService.class);
    private final PersistentTtsService service = new PersistentTtsService(library, files, new SimpleMeterRegistry());

    @Test
    void directServiceRejectsNonFiniteOutOfRangeAndUnqualifiedEffectsBeforeWork() {
        assertRejected(Float.NaN, 1.0f, IllegalArgumentException.class);
        assertRejected(0.25f, 1.0f, IllegalArgumentException.class);
        assertRejected(1.5f, 1.0f, UnsupportedOperationException.class);
        assertRejected(1.0f, 1.5f, UnsupportedOperationException.class);
        verifyNoInteractions(library, files);
    }

    private void assertRejected(float speed, float pitch, Class<? extends Throwable> error) {
        assertThatThrownBy(() -> service.synthesizeAndPersist(
                "tenant", UUID.randomUUID(), "text", Optional.empty(), speed, pitch, null))
                .isInstanceOf(error);
    }
}
