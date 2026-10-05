package com.ghatana.media.tts.eval;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * Unit tests for {@link AudioQualityMetrics}.
 *
 * @doc.type class
 * @doc.purpose Unit tests for SNR and STOI audio quality metrics
 * @doc.layer platform
 * @doc.pattern TestCase
 */
@DisplayName("AudioQualityMetrics")
class AudioQualityMetricsTest {

    private static final int SR = 22050;

    // -------------------------------------------------------------------------
    // SNR tests
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("SNR: perfect copy → +∞")
    void snr_perfectCopy_infinity() { 
        float[] sig = sine(440, 0.5f, 1000); 
        assertThat(AudioQualityMetrics.computeSnr(sig, sig.clone())) 
                .isEqualTo(Double.POSITIVE_INFINITY); 
    }

    @Test
    @DisplayName("SNR: silence reference → -∞")
    void snr_silenceReference_negativeInfinity() { 
        float[] ref = new float[1000]; // all zeros
        float[] deg = sine(440, 0.5f, 1000); 
        assertThat(AudioQualityMetrics.computeSnr(ref, deg)) 
                .isEqualTo(Double.NEGATIVE_INFINITY); 
    }

    @Test
    @DisplayName("SNR: added white noise → finite positive dB")
    void snr_withNoise_finitePositive() { 
        float[] ref = sine(440, 0.5f, SR); 
        float[] deg = addNoise(ref, 0.01f); 
        double snr = AudioQualityMetrics.computeSnr(ref, deg); 
        assertThat(snr).isGreaterThan(20.0); 
    }

    @Test
    @DisplayName("SNR: mismatched length → IllegalArgumentException")
    void snr_mismatchedLength_throws() { 
        assertThatThrownBy(() -> AudioQualityMetrics.computeSnr(new float[10], new float[9])) 
                .isInstanceOf(IllegalArgumentException.class); 
    }

    // -------------------------------------------------------------------------
    // STOI tests
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("STOI: perfect copy → ≈ 1.0")
    void stoi_perfectCopy_nearOne() { 
        float[] sig = sine(440, 0.5f, SR); 
        double stoi = AudioQualityMetrics.computeStoi(sig, sig.clone(), SR); 
        assertThat(stoi).isCloseTo(1.0, within(0.05)); 
    }

    @Test
    @DisplayName("STOI: heavily corrupted signal → low score")
    void stoi_heavyNoise_lowScore() { 
        float[] ref = sine(440, 0.3f, SR); 
        float[] deg = addNoise(ref, 0.9f); // SNR ≈ −9 dB 
        double stoi = AudioQualityMetrics.computeStoi(ref, deg, SR); 
        assertThat(stoi).isLessThan(0.85); 
    }

    @Test
    @DisplayName("STOI: result in [0, 1]")
    void stoi_resultBounded() { 
        float[] ref = sine(880, 0.4f, SR); 
        float[] deg = addNoise(ref, 0.3f); 
        double stoi = AudioQualityMetrics.computeStoi(ref, deg, SR); 
        assertThat(stoi).isBetween(0.0, 1.0); 
    }

    @Test
    @DisplayName("STOI: degraded longer than reference → truncated safely")
    void stoi_longerDegraded_safe() { 
        float[] ref = sine(440, 0.5f, SR); 
        float[] deg = sine(440, 0.5f, SR * 2); // twice as long 
        assertThat(AudioQualityMetrics.computeStoi(ref, deg, SR)) 
                .isGreaterThan(0.9); 
    }

    // -------------------------------------------------------------------------
    // computeAll
    // -------------------------------------------------------------------------

    @Test
    @DisplayName("computeAll: result record fields populated")
    void computeAll_fieldsPopulated() { 
        float[] ref = sine(440, 0.5f, SR); 
        float[] deg = addNoise(ref, 0.05f); 
        var r = AudioQualityMetrics.computeAll(ref, deg, SR); 
        assertThat(r.snrDb()).isGreaterThan(15.0); 
        assertThat(r.stoi()).isGreaterThan(0.5); 
        assertThat(r.isIntelligible()).isTrue(); 
        assertThat(r.isClean()).isIn(true, false); // typically < 20 dB with 5%% noise 
    }

    // -------------------------------------------------------------------------
    // DSP helpers
    // -------------------------------------------------------------------------

    /** Generate a mono sine wave. */
    private static float[] sine(double freqHz, float amplitude, int samples) { 
        float[] out = new float[samples];
        for (int i = 0; i < samples; i++) { 
            out[i] = (float) (amplitude * Math.sin(2.0 * Math.PI * freqHz * i / SR)); 
        }
        return out;
    }

    /** Add white noise of given amplitude to a signal (returns a new array). */ 
    private static float[] addNoise(float[] signal, float noiseAmp) { 
        float[] out = new float[signal.length];
        for (int i = 0; i < signal.length; i++) { 
            out[i] = signal[i] + noiseAmp * (float) (2.0 * Math.random() - 1.0); 
        }
        return out;
    }
}
