package com.ghatana.media.stt.engine.onnx;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.doReturn;

class WhisperOnnxCancellationTest {
    @Test
    void nullTimeoutUsesTheEngineDefaultAndExplicitTimeoutIsPreserved() {
        assertThat(WhisperOnnxEngine.effectiveTimeout(null)).isEqualTo(Duration.ofSeconds(30));
        assertThat(WhisperOnnxEngine.effectiveTimeout(Duration.ofSeconds(9)))
                .isEqualTo(Duration.ofSeconds(9));
    }

    @Test
    void preCancelledSignalStopsBeforeAnyInvocationIsStarted() {
        WhisperOnnxEngine.CancellationSignal cancelled = new WhisperOnnxEngine.CancellationSignal() {
            @Override public boolean cancelled() { return true; }
            @Override public AutoCloseable onCancel(Runnable callback) {
                callback.run();
                return () -> { };
            }
        };

        assertThatThrownBy(() -> WhisperOnnxEngine.checkActive(null, cancelled))
                .isInstanceOf(CancellationException.class);
    }

    @Test
    void pcmConversionAndSilenceScanningObserveCancellationAtBoundedIntervals() {
        AtomicInteger conversionChecks = new AtomicInteger();
        assertThatThrownBy(() -> WhisperOnnxEngine.bytesToFloats(
                new byte[8_192], 16, null, cancelAfter(conversionChecks, 2)))
                .isInstanceOf(CancellationException.class);
        assertThat(conversionChecks.get()).isEqualTo(3);

        AtomicInteger silenceChecks = new AtomicInteger();
        assertThatThrownBy(() -> WhisperOnnxEngine.isExactlySilent(
                new float[4_096], null, cancelAfter(silenceChecks, 2)))
                .isInstanceOf(CancellationException.class);
        assertThat(silenceChecks.get()).isEqualTo(3);
    }

    @Test
    void referenceMelCalculationChecksCancellationAtFrameBoundaries() {
        float[][] filters = new float[80][201];
        AtomicInteger checks = new AtomicInteger();

        assertThatThrownBy(() -> WhisperOnnxEngine.computeReferenceMelSpectrogram(
                new float[480_000], filters, null, cancelAfter(checks, 939)))
                .isInstanceOf(CancellationException.class);
        assertThat(checks.get()).isEqualTo(940);
    }

    @Test
    void timeoutTerminatesOnlyItsRunAndClosesTheOwnedOptionsExactlyOnce() {
        AtomicInteger terminated = new AtomicInteger();
        AtomicInteger closed = new AtomicInteger();
        var first = new WhisperOnnxEngine.InvocationControl(terminated::incrementAndGet, closed::incrementAndGet);
        var second = new WhisperOnnxEngine.InvocationControl(() -> { }, () -> { });
        ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        ScheduledFuture<?> future = mock(ScheduledFuture.class);
        doReturn(future).when(scheduler).schedule(any(Runnable.class), eq(7L), eq(TimeUnit.NANOSECONDS));

        ScheduledFuture<?> scheduled = WhisperOnnxEngine.scheduleTimeout(Duration.ofNanos(7), first, scheduler);
        ArgumentCaptor<Runnable> callback = ArgumentCaptor.forClass(Runnable.class);
        verify(scheduler).schedule(callback.capture(), eq(7L), eq(TimeUnit.NANOSECONDS));
        callback.getValue().run();

        assertThat((Object) scheduled).isSameAs(future);
        assertThatThrownBy(() -> first.throwIfCancelled(false))
                .hasMessageContaining("exceeded its timeout");
        assertThatCode(() -> second.throwIfCancelled(false)).doesNotThrowAnyException();
        first.close();
        first.cancel(WhisperOnnxEngine.CancellationReason.CANCELLED);
        first.close();

        assertThat(terminated).hasValue(1);
        assertThat(closed).hasValue(1);
    }

    @Test
    void cancellationPropagatesToItsRunControlAndDoesNotTouchAnotherInvocation() {
        AtomicInteger firstTerminated = new AtomicInteger();
        AtomicInteger secondTerminated = new AtomicInteger();
        var first = new WhisperOnnxEngine.InvocationControl(firstTerminated::incrementAndGet, () -> { });
        var second = new WhisperOnnxEngine.InvocationControl(secondTerminated::incrementAndGet, () -> { });

        first.cancel(WhisperOnnxEngine.CancellationReason.CANCELLED);

        assertThatThrownBy(() -> first.throwIfCancelled(false)).isInstanceOf(CancellationException.class);
        assertThatCode(() -> second.throwIfCancelled(false)).doesNotThrowAnyException();
        assertThat(firstTerminated).hasValue(1);
        assertThat(secondTerminated).hasValue(0);
        first.close();
        second.close();
    }

    private static WhisperOnnxEngine.CancellationSignal cancelAfter(AtomicInteger checks, int allowedChecks) {
        return new WhisperOnnxEngine.CancellationSignal() {
            @Override public boolean cancelled() { return checks.incrementAndGet() > allowedChecks; }
            @Override public AutoCloseable onCancel(Runnable callback) { return () -> { }; }
        };
    }
}
