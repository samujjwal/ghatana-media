package com.ghatana.media.vision;

import com.ghatana.media.common.ImageData;
import com.ghatana.media.config.VisionConfig;
import com.ghatana.media.vision.api.DetectionModelInfo;
import com.ghatana.media.vision.api.GovernedVisionEngine;
import com.ghatana.media.vision.api.VisionCapabilities;
import com.ghatana.media.vision.api.VisionEngine;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.EnumSet;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GovernedVisionEngineCapabilityTest {
    @Test
    void advertisesOnlyComposedCapabilities() {
        VisionEngine delegate = mock(VisionEngine.class);
        when(delegate.capabilities()).thenReturn(VisionCapabilities.objectDetectionOnly());
        GovernedVisionEngine governed = new GovernedVisionEngine(delegate, config(false));

        assertThat(governed.capabilities().supported())
                .containsExactly(VisionCapabilities.Capability.OBJECT_DETECTION);
        assertThatThrownBy(() -> governed.caption(image()))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void enablesClassificationOnlyWhenDelegateAdvertisesIt() {
        VisionEngine delegate = mock(VisionEngine.class);
        when(delegate.capabilities()).thenReturn(new VisionCapabilities(EnumSet.of(
                VisionCapabilities.Capability.OBJECT_DETECTION,
                VisionCapabilities.Capability.CLASSIFICATION)));
        GovernedVisionEngine governed = new GovernedVisionEngine(delegate, config(true));

        assertThat(governed.capabilities().supports(VisionCapabilities.Capability.CLASSIFICATION)).isTrue();
    }

    @Test
    void rejectsModelSwitchAwayFromOwnedModel() {
        VisionEngine delegate = mock(VisionEngine.class);
        when(delegate.capabilities()).thenReturn(VisionCapabilities.objectDetectionOnly());
        when(delegate.getActiveModel()).thenReturn(new DetectionModelInfo(
                "owned-model", "Owned", "1", new String[0], 1, true, 32, 32, Optional.empty()));
        GovernedVisionEngine governed = new GovernedVisionEngine(delegate, config(false));

        assertThatThrownBy(() -> governed.loadModel("other-model"))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    private static VisionConfig config(boolean classification) {
        return VisionConfig.builder()
                .modelId("owned-model")
                .modelType("test")
                .timeout(Duration.ofSeconds(1))
                .inputSize(32)
                .enableClassification(classification)
                .maxMemoryBytes(1024 * 1024)
                .build();
    }

    private static ImageData image() {
        return ImageData.builder()
                .data(new byte[] {1, 2, 3})
                .width(1)
                .height(1)
                .format(com.ghatana.media.common.ImageFormat.RAW)
                .build();
    }
}
