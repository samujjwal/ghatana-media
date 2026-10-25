package com.ghatana.audio.video.vision.yolo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.audio.video.vision.model.VisionModelProfile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class YoloV8AdapterAdmissionTest {
    @TempDir Path modelDirectory;

    @Test void directInitializationRejectsProfileMetadataBeforeAnyNativeModelLoad() throws Exception {
        byte[] bytes = "not-a-real-onnx-model".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(modelDirectory.resolve("model.onnx"), bytes);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        var profile = VisionModelProfile.fromEnvironment(Map.of(
                "VISION_MODEL_PATH", modelDirectory.toString(),
                "VISION_MODEL_NAME", "model",
                "VISION_MODEL_VERSION", "1.0",
                "VISION_MODEL_SHA256", digest,
                "VISION_MODEL_LICENSE", "OPERATOR_SAYS_LICENSED",
                "VISION_MODEL_CLASSES", String.join(",", YoloV8Adapter.supportedClassLabels()),
                "VISION_MODEL_DEVICE", "CPU"));
        var adapter = new YoloV8Adapter(profile.modelDirectory(), 0.5, 0.4);
        try {
            assertThatThrownBy(() -> adapter.initialize(profile))
                    .isInstanceOfSatisfying(VisionModelProfile.VisionProviderUnavailableException.class,
                            failure -> assertThat(failure.reason())
                                    .isEqualTo(VisionModelProfile.UnavailableReason.PROVIDER_NOT_ADMITTED));
            assertThat(adapter.isInitialized()).isFalse();
        } finally {
            adapter.close();
        }
    }
}
