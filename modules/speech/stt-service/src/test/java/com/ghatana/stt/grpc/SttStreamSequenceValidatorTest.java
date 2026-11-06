package com.ghatana.stt.grpc;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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
    void concurrentDuplicateChunksHaveExactlyOneCursorWinner() throws Exception {
        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("concurrent-session");
        int callers = 16;
        var ready = new CountDownLatch(callers);
        var start = new CountDownLatch(1);
        var accepted = new AtomicInteger();
        var rejectedAsDuplicate = new AtomicInteger();
        List<Future<?>> workers = new ArrayList<>(callers);

        try (var pool = Executors.newFixedThreadPool(callers)) {
            for (int index = 0; index < callers; index++) {
                workers.add(pool.submit(() -> {
                    ready.countDown();
                    if (!start.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("concurrent sequence test start timed out");
                    }
                    try {
                        validator.accept("concurrent-session", 1, 16_000, 0, 320);
                        accepted.incrementAndGet();
                    } catch (SttStreamSequenceValidator.StreamInputException duplicate) {
                        if (duplicate.failure() != SttStreamSequenceValidator.Failure.INVALID
                                || !duplicate.getMessage().contains("STT_STREAM_SEQUENCE_DUPLICATE")) {
                            throw duplicate;
                        }
                        rejectedAsDuplicate.incrementAndGet();
                    }
                    return null;
                }));
            }
            if (!ready.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent sequence workers did not become ready");
            }
            start.countDown();
            for (Future<?> worker : workers) worker.get(10, TimeUnit.SECONDS);
        }

        assertThat(accepted).hasValue(1);
        assertThat(rejectedAsDuplicate).hasValue(callers - 1);
        assertThat(validator.lastSequence()).isEqualTo(1);
    }

    @Test
    void rejectsResumeWithoutRuntimeStoreAndIdentityOrClockChanges() {
        SttStreamSequenceValidator resumeFence = new SttStreamSequenceValidator("session");
        assertThatThrownBy(() -> resumeFence.accept("session", 4, 16_000, 0, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_STREAM_RESUME_NOT_ADMITTED");
                });
        // A rejected resume attempt has no state effect; corrected first input is still accepted.
        assertThat(resumeFence.lastSequence()).isZero();
        assertThat(resumeFence.accept("session", 1, 16_000, 0, 2)).isEqualTo(1);

        SttStreamSequenceValidator reconnect = new SttStreamSequenceValidator("session");
        assertThatThrownBy(() -> reconnect.accept("session", 2, 16_000, 20, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_STREAM_RESUME_NOT_ADMITTED");
                });
        assertThat(reconnect.lastSequence()).isZero();

        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");
        validator.accept("session", 1, 16_000, 10, 2);
        assertInvalid(validator, 2, "STT_STREAM_SESSION_MISMATCH", "other", 16_000, 20);
        assertInvalid(validator, 2, "STT_STREAM_SAMPLE_RATE_CHANGED", "session", 48_000, 20);
        assertInvalid(validator, 2, "STT_STREAM_TIMESTAMP_INVALID", "session", 16_000, 9);
        // Rejected identity, clock, and PTS candidates must not poison the next valid chunk.
        // In particular, the lower rejected PTS must not become the validator's last clock.
        assertThat(validator.accept("session", 2, 16_000, 10, 2)).isEqualTo(2);
        assertThat(validator.lastSequence()).isEqualTo(2);
    }

    @Test
    void enforcesFiveMinutePcmSampleBudgetWithoutAdvancingSequenceOnFailure() {
        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");
        int maxChunk = 1_048_576;
        long sequence = 1;
        long accepted = 0;
        while (accepted + maxChunk <= 8_000L * 2 * 300) {
            assertThat(validator.accept("session", sequence++, 8_000, sequence, maxChunk))
                    .isEqualTo(sequence - 1);
            accepted += maxChunk;
        }
        int remainder = (int) (8_000L * 2 * 300 - accepted);
        assertThat(remainder).isPositive().isEven();
        assertThat(validator.accept("session", sequence++, 8_000, sequence, remainder))
                .isEqualTo(sequence - 1);
        long rejectedSequence = sequence;
        assertThatThrownBy(() -> validator.accept("session", rejectedSequence, 8_000, rejectedSequence, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_STREAM_DURATION_LIMIT");
                });
        assertThat(validator.lastSequence()).isEqualTo(sequence - 1);
    }

    @Test
    void boundsSourceTimestampAndChunkEndToTheFiveMinuteWindow() {
        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");

        // At 16 kHz, 320 bytes are 10 ms. This chunk ends exactly at the five-minute
        // boundary and is accepted.
        assertThat(validator.accept("session", 1, 16_000, 299_990, 320)).isEqualTo(1);

        // The next source PTS would put its PCM beyond the bounded media window. Rejection
        // must not consume sequence 2, so the caller's corrected retry remains possible.
        assertThatThrownBy(() -> validator.accept("session", 2, 16_000, 300_000, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.NOT_ADMITTED);
                    assertThat(failure).hasMessageContaining("STT_STREAM_TIMESTAMP_DURATION_LIMIT");
                });
        assertThat(validator.lastSequence()).isEqualTo(1);
        assertThat(validator.accept("session", 2, 16_000, 299_990, 2)).isEqualTo(2);
    }

    @Test
    void rejectsTimestampBeyondRepresentableSampleClock() {
        SttStreamSequenceValidator validator = new SttStreamSequenceValidator("session");
        long impossibleTimestamp = Long.MAX_VALUE;
        assertThatThrownBy(() -> validator.accept("session", 1, 8_000, impossibleTimestamp, 2))
                .isInstanceOfSatisfying(SttStreamSequenceValidator.StreamInputException.class, failure -> {
                    assertThat(failure.failure()).isEqualTo(SttStreamSequenceValidator.Failure.INVALID);
                    assertThat(failure).hasMessageContaining("STT_STREAM_TIMESTAMP_LIMIT");
                });
        assertThat(validator.lastSequence()).isZero();
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
