package com.ghatana.audio.video.multimodal.engine;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResultDetectionSnapshotTest {
    @Test
    void frameResultSnapshotsDetectionsAndExposesAnImmutableList() {
        DetectionResult original = detection("person");
        DetectionResult addedLater = detection("car");
        List<DetectionResult> input = new ArrayList<>(List.of(original));

        FrameResult result = new FrameResult(1, 100L, input);
        input.clear();
        input.add(addedLater);

        assertThat(result.getDetections()).containsExactly(original);
        assertThatThrownBy(() -> result.getDetections().add(addedLater))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void temporalAlignmentSnapshotsDetectionsAndExposesAnImmutableList() {
        DetectionResult original = detection("person");
        DetectionResult addedLater = detection("car");
        List<DetectionResult> input = new ArrayList<>(List.of(original));

        TemporalAlignment result = new TemporalAlignment(100L, 1, "hello", input);
        input.clear();
        input.add(addedLater);

        assertThat(result.getDetections()).containsExactly(original);
        assertThatThrownBy(() -> result.getDetections().add(addedLater))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    private static DetectionResult detection(String name) {
        return new DetectionResult(name, 0.9, 0, 0, 10, 10);
    }
}
