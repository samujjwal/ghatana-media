package com.ghatana.audio.video.vision.yolo;

import com.ghatana.audio.video.vision.VisionLogCapture;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class YoloV8AdapterLogPrivacyTest {
    @Test
    void nativeLoadFailureLogDoesNotIncludeProviderPathOrThrowable() {
        String pathMarker = "native-provider-path-marker-private";
        try (VisionLogCapture logs = new VisionLogCapture(YoloV8Adapter.class)) {
            YoloV8Adapter.logNativeLibraryLoadFailure(new UnsatisfiedLinkError(pathMarker));

            String output = String.join("\n", logs.messages());
            assertThat(output).contains("Failed to load OpenCV native library (UnsatisfiedLinkError)");
            assertThat(output).doesNotContain(pathMarker);
            assertThat(logs.throwables()).isEmpty();
        }
    }
}
