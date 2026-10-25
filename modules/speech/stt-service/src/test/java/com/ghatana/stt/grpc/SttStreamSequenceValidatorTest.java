package com.ghatana.stt.grpc;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SttStreamSequenceValidatorTest {
    @Test
    void acceptsContiguousClientSequenceAndLegacyServerSequence() {
        SttStreamSequenceValidator sequenced = new SttStreamSequenceValidator("client-session");
        assertThat(sequenced.accept("client-session", 1, 16_000, 0, 320)).isEqualTo(1);
        assertThat(sequenced.accept("client-session", 2, 16_000, 20, 320)).isEqualTo(2);

        SttStreamSequenceValidator legacy = new SttStreamSequenceValidator("legacy-session");
        assertThat(legacy.accept("", 0, 16_000, 0, 2)).isEqualTo(1);
        assertThat(legacy.accept("", 0, 16_000, 1, 2)).isEqualTo(2);
    }

    @Test
    void rejectsDuplicateOutOfOrderAndGapWithoutAdvancingCursor() {
        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");
        assertThat(validator.accept("session", 1, 16_000, 0, 2)).isEqualTo(1);
        assertInvalid(validator, 1, "STT_STREAM_SEQUENCE_DUPLICATE");
        assertInvalid(validator, 3, "STT_STREAM_SEQUENCE_GAP");
        assertThat(validator.lastSequence()).isEqualTo(1);
    }

    @Test
    void rejectsResumeWithoutRuntimeStoreAndIdentityOrClockChanges() {
        assertThatThrownBy(() -> new SttStreamSequenceValidator("session")
                .accept("session", 4, 16_000, 0, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_STREAM_RESUME_NOT_ADMITTED");
                });

        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");
        validator.accept("session", 1, 16_000, 10, 2);
        assertInvalid(validator, 2, "STT_STREAM_SESSION_MISMATCH", "other", 16_000, 20);
        assertInvalid(validator, 2, "STT_STREAM_SAMPLE_RATE_CHANGED", "session", 48_000, 20);
        assertInvalid(validator, 2, "STT_STREAM_TIMESTAMP_INVALID", "session", 16_000, 9);
    }

    private static void assertInvalid(SttStreamSequenceValidator validator, long sequence, String message) {
        assertInvalid(validator, sequence, message, "session", 16_000, sequence * 10);
    }

    private static void assertInvalid(
            SttStreamSequenceValidator validator, long sequence, String message,
            String sessionId, int sampleRate, long timestamp) {
        assertThatThrownBy(() -> validator.accept(sessionId, sequence, sampleRate, timestamp, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.INVALID);
                    assertThat(failure).hasMessageContaining(message);
                });
    }
}
