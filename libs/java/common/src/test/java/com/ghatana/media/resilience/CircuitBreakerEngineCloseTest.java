package com.ghatana.media.resilience;

import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.vision.api.VisionEngine;
import com.ghatana.resilience.CircuitBreaker;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class CircuitBreakerEngineCloseTest {

    @Test
    void successfulCloseClosesEachProviderExactlyOnce() {
        SttEngine stt = mock(SttEngine.class);
        TtsEngine tts = mock(TtsEngine.class);
        VisionEngine vision = mock(VisionEngine.class);

        CircuitBreakerSttEngine sttWrapper = new CircuitBreakerSttEngine(stt, null, breaker("close-stt-again"));
        sttWrapper.close();
        sttWrapper.close();

        CircuitBreakerTtsEngine ttsWrapper = new CircuitBreakerTtsEngine(tts, null, breaker("close-tts"));
        ttsWrapper.close();
        ttsWrapper.close();

        CircuitBreakerVisionEngine visionWrapper =
                new CircuitBreakerVisionEngine(vision, null, breaker("close-vision"));
        visionWrapper.close();
        visionWrapper.close();

        verify(stt).close();
        verify(tts).close();
        verify(vision).close();
    }

    @Test
    void failedProviderCloseCanBeRetriedAndThenBecomesIdempotent() throws Exception {
        SttEngine stt = mock(SttEngine.class);
        doThrow(new IllegalStateException("native close failed")).doNothing().when(stt).close();
        CircuitBreakerSttEngine wrapper = new CircuitBreakerSttEngine(stt, null, breaker("retry-close-stt"));

        org.assertj.core.api.Assertions.assertThatThrownBy(wrapper::close)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("native close failed");
        wrapper.close();
        wrapper.close();

        verify(stt, org.mockito.Mockito.times(2)).close();
    }

    @Test
    void failedTtsAndVisionCloseCanBeRetriedAndThenBecomeIdempotent() {
        TtsEngine tts = mock(TtsEngine.class);
        doThrow(new IllegalStateException("native close failed")).doNothing().when(tts).close();
        CircuitBreakerTtsEngine ttsWrapper = new CircuitBreakerTtsEngine(tts, null, breaker("retry-close-tts"));

        org.assertj.core.api.Assertions.assertThatThrownBy(ttsWrapper::close)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("native close failed");
        ttsWrapper.close();
        ttsWrapper.close();

        VisionEngine vision = mock(VisionEngine.class);
        doThrow(new IllegalStateException("native close failed")).doNothing().when(vision).close();
        CircuitBreakerVisionEngine visionWrapper =
                new CircuitBreakerVisionEngine(vision, null, breaker("retry-close-vision"));

        org.assertj.core.api.Assertions.assertThatThrownBy(visionWrapper::close)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("native close failed");
        visionWrapper.close();
        visionWrapper.close();

        verify(tts, org.mockito.Mockito.times(2)).close();
        verify(vision, org.mockito.Mockito.times(2)).close();
    }

    private static CircuitBreaker breaker(String name) {
        return CircuitBreaker.builder(name)
                .failureThreshold(2)
                .resetTimeout(Duration.ofSeconds(1))
                .build();
    }
}
