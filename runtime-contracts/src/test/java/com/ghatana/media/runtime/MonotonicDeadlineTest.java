package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext.MonotonicDeadline;
import com.ghatana.media.runtime.MediaRuntimeContracts;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

class MonotonicDeadlineTest {
    @Test
    void monotonicBudgetExpiresIndependentOfWallClock() {
        AtomicLong nanos = new AtomicLong(10);
        MonotonicDeadline deadline = MonotonicDeadline.after(Duration.ofMillis(4), nanos::get);

        assertThat(deadline.remainingBudgetMillis()).isEqualTo(4);
        nanos.addAndGet(Duration.ofMillis(3).toNanos());
        assertThat(deadline.expired()).isFalse();
        nanos.addAndGet(Duration.ofMillis(1).toNanos());
        assertThat(deadline.expired()).isTrue();
        assertThat(deadline.remainingBudgetMillis()).isZero();
    }

    @Test
    void subMillisecondBudgetRoundsDownToZeroAndIsNeverRenewed() {
        AtomicLong nanos = new AtomicLong(0);
        MonotonicDeadline deadline = MonotonicDeadline.after(Duration.ofNanos(1), nanos::get);
        assertThat(deadline.remainingBudgetMillis()).isZero();
        nanos.incrementAndGet();
        assertThat(deadline.remainingBudgetMillis()).isZero();
    }

    @Test
    void deadlineSubtractionHandlesNanoClockWraparound() {
        AtomicLong nanos = new AtomicLong(Long.MAX_VALUE - 500_000);
        MonotonicDeadline deadline = MonotonicDeadline.after(Duration.ofMillis(2), nanos::get);
        assertThat(deadline.remainingBudgetMillis()).isEqualTo(2);
        nanos.addAndGet(Duration.ofMillis(1).toNanos());
        assertThat(deadline.remainingBudgetMillis()).isEqualTo(1);
        nanos.addAndGet(Duration.ofMillis(1).toNanos());
        assertThat(deadline.expired()).isTrue();
    }

    @Test
    void boundedDeadlineChoosesEarlierCapAcrossNanoClockWraparound() {
        AtomicLong nanos = new AtomicLong(Long.MAX_VALUE - 5);
        MonotonicDeadline parent = MonotonicDeadline.after(Duration.ofNanos(10), nanos::get);
        MonotonicDeadline bounded = parent.boundedBy(Duration.ofNanos(2));

        assertThat(parent.remainingNanos()).isEqualTo(10);
        assertThat(bounded.remainingNanos()).isEqualTo(2);
        nanos.addAndGet(2);
        assertThat(bounded.expired()).isTrue();
        assertThat(parent.expired()).isFalse();
    }

    @Test
    void legacyRemainingBudgetAccessorReturnsZeroAfterMonotonicExpiry() {
        AtomicLong nanos = new AtomicLong(0);
        MonotonicDeadline deadline = MonotonicDeadline.after(Duration.ofNanos(1), nanos::get);
        var artifact = new MediaRuntimeContracts.MediaArtifact("tenant", "principal", "artifact", "a.wav",
                "audio/wav", 1, "a".repeat(64), "object://a", "INTERNAL",
                java.time.Instant.EPOCH, java.time.Instant.MAX, java.util.Map.of());
        var request = new MediaRuntimeContracts.ProcessingJobRequest("request", "tenant", "principal",
                "correlation", "artifact", artifact.version().value(), MediaRuntimeContracts.JobType.SPEECH_TO_TEXT,
                "provider", java.util.Map.of());
        var context = new MediaRuntimeContracts.ProcessingContext(request, artifact,
                new MediaRuntimeContracts.Cancellation(), null, null, null, null,
                java.time.Instant.MAX, deadline);

        nanos.incrementAndGet();
        assertThat(context.remainingBudgetMillis(java.time.Instant.EPOCH)).isZero();
    }

    @Test
    void legacyProcessingContextConstructorKeepsInstantMaxUnbounded() {
        var artifact = new MediaRuntimeContracts.MediaArtifact("tenant", "principal", "artifact", "a.wav",
                "audio/wav", 1, "a".repeat(64), "object://a", "INTERNAL",
                java.time.Instant.EPOCH, java.time.Instant.MAX, java.util.Map.of());
        var request = new MediaRuntimeContracts.ProcessingJobRequest("request", "tenant", "principal",
                "correlation", "artifact", artifact.version().value(), MediaRuntimeContracts.JobType.SPEECH_TO_TEXT,
                "provider", java.util.Map.of());
        var legacyContext = new MediaRuntimeContracts.ProcessingContext(
                request, artifact, new MediaRuntimeContracts.Cancellation());

        assertThat(legacyContext.deadlineBudget().expired()).isFalse();
        assertThat(legacyContext.deadlineBudget().remainingBudgetMillis())
                .isEqualTo(WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS);
    }
}
