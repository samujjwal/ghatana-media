package com.ghatana.media.tts.api;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

class SynthesisOptionsTest {

    private static final double[] NON_FINITE = {
            Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY
    };

    @Test
    void directConstructionRejectsNonFiniteSpeedPitchAndVolume() {
        for (double value : NON_FINITE) {
            assertThatIllegalArgumentException().isThrownBy(() -> direct(value, 1.0, 1.0));
            assertThatIllegalArgumentException().isThrownBy(() -> direct(1.0, value, 1.0));
            assertThatIllegalArgumentException().isThrownBy(() -> direct(1.0, 1.0, value));
        }
    }

    @Test
    void builderRejectsNonFiniteSpeedPitchAndVolume() {
        for (double value : NON_FINITE) {
            assertThatIllegalArgumentException().isThrownBy(() -> SynthesisOptions.builder().speed(value));
            assertThatIllegalArgumentException().isThrownBy(() -> SynthesisOptions.builder().pitch(value));
            assertThatIllegalArgumentException().isThrownBy(() -> SynthesisOptions.builder().volume(value));
        }
    }

    @Test
    void builderRetainsFiniteClampingAndAcceptedBounds() {
        SynthesisOptions lower = SynthesisOptions.builder()
                .speed(0.5).pitch(0.5).volume(0.0).build();
        SynthesisOptions upper = SynthesisOptions.builder()
                .speed(2.0).pitch(2.0).volume(2.0).build();
        SynthesisOptions clamped = SynthesisOptions.builder()
                .speed(0.1).pitch(3.0).volume(-1.0).build();

        assertThat(lower.speed()).isEqualTo(0.5);
        assertThat(lower.pitch()).isEqualTo(0.5);
        assertThat(lower.volume()).isEqualTo(0.0);
        assertThat(upper.speed()).isEqualTo(2.0);
        assertThat(upper.pitch()).isEqualTo(2.0);
        assertThat(upper.volume()).isEqualTo(2.0);
        assertThat(clamped.speed()).isEqualTo(0.5);
        assertThat(clamped.pitch()).isEqualTo(2.0);
        assertThat(clamped.volume()).isEqualTo(0.0);
    }

    private static SynthesisOptions direct(double speed, double pitch, double volume) {
        return new SynthesisOptions(null, speed, pitch, volume, null, null, 22050, null, null);
    }
}
