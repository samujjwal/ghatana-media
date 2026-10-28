package com.ghatana.media.stt.engine.onnx;

import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Fast policy-only checks; no model bytes, ONNX session or device required. */
class WhisperOnnxThreadPolicyTest {
    @Test
    void defaultPreservesHistoricalOrtBehavior() {
        assertThat(WhisperOnnxThreadPolicy.intraOpThreads(Map.of(), 4)).isZero();
        assertThat(WhisperOnnxThreadPolicy.intraOpThreads(
                Map.of(WhisperOnnxThreadPolicy.INTRA_OP_THREADS_ENV, ""), 4)).isZero();
    }

    @Test
    void acceptsOnlyExactPositiveHostBoundedCpuThreadCounts() {
        assertThat(WhisperOnnxThreadPolicy.intraOpThreads(
                Map.of(WhisperOnnxThreadPolicy.INTRA_OP_THREADS_ENV, "1"), 4)).isEqualTo(1);
        assertThat(WhisperOnnxThreadPolicy.intraOpThreads(
                Map.of(WhisperOnnxThreadPolicy.INTRA_OP_THREADS_ENV, "4"), 4)).isEqualTo(4);
        assertThat(WhisperOnnxThreadPolicy.intraOpThreads(
                Map.of(WhisperOnnxThreadPolicy.INTRA_OP_THREADS_ENV, "32"), 64)).isEqualTo(32);
    }

    @Test
    void rejectsOversubscriptionAndMalformedInputBeforeOpeningOnnxSession() {
        for (String unsafe : new String[]{"0", "-1", "5", "33", "999", "1.5", " 2",
                "2 ", "+2", "auto", "01", "99999999999999"}) {
            assertThatThrownBy(() -> WhisperOnnxThreadPolicy.intraOpThreads(
                    Map.of(WhisperOnnxThreadPolicy.INTRA_OP_THREADS_ENV, unsafe), 4))
                    .as("unsafe value %s", unsafe)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> WhisperOnnxThreadPolicy.intraOpThreads(Map.of(), 0))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
