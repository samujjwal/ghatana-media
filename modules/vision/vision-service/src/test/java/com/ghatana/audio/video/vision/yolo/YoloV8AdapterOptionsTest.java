package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.audio.video.vision.model.DetectionOptions;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class YoloV8AdapterOptionsTest {
    @Test
    void explicitRequestThresholdsOverrideAdapterDefaultsAndOmittedFieldsUseDefaults() {
        var adapter = new YoloV8Adapter(Path.of("unused"), 0.65, 0.25);

        assertThat(adapter.confidenceThresholdFor(DetectionOptions.defaults())).isEqualTo(0.65);
        assertThat(adapter.nmsThresholdFor(DetectionOptions.defaults())).isEqualTo(0.25);

        DetectionOptions request = DetectionOptions.builder()
                .confidenceThreshold(0.2)
                .nmsThreshold(0.7)
                .build();
        assertThat(adapter.confidenceThresholdFor(request)).isEqualTo(0.2);
        assertThat(adapter.nmsThresholdFor(request)).isEqualTo(0.7);
    }

    @Test
    void requestThresholdsAreBoundedAndRejectNan() {
        DetectionOptions bounded = DetectionOptions.builder()
                .confidenceThreshold(-1.0)
                .nmsThreshold(2.0)
                .build();
        assertThat(bounded.getConfidenceThreshold()).isZero();
        assertThat(bounded.getNmsThreshold()).isEqualTo(1.0);
        assertThatThrownBy(() -> DetectionOptions.builder().confidenceThreshold(Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> DetectionOptions.builder().nmsThreshold(Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void explicitlySetDefaultRemainsDistinctFromAnOmittedThreshold() {
        DetectionOptions omitted = DetectionOptions.defaults();
        DetectionOptions explicit = DetectionOptions.builder().confidenceThreshold(0.5).build();

        assertThat(omitted.isConfidenceThresholdSpecified()).isFalse();
        assertThat(explicit.isConfidenceThresholdSpecified()).isTrue();
        assertThat(explicit).isNotEqualTo(omitted);
    }
}
