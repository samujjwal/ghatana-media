package com.ghatana.audio.video.vision.grpc;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProductionVisionGrpcServiceAdmissionTest {
    @TempDir Path modelDirectory;

    @Test void operatorLicenseMetadataAndPinnedModelBytesDoNotAdmitProductionProvider() throws Exception {
        byte[] bytes = "test-only-not-an-onnx-model".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(modelDirectory.resolve("model.onnx"), bytes);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        Map<String, String> environment = Map.of(
                "VISION_MODEL_PATH", modelDirectory.toString(),
                "VISION_MODEL_NAME", "model",
                "VISION_MODEL_VERSION", "1.0",
                "VISION_MODEL_SHA256", digest,
                "VISION_MODEL_LICENSE", "OPERATOR_SAYS_LICENSED",
                "VISION_MODEL_CLASSES", String.join(",", YoloV8Adapter.supportedClassLabels()),
                "VISION_MODEL_DEVICE", "CPU");

        assertThatThrownBy(() -> ProductionVisionGrpcService.compose(environment))
                .isInstanceOfSatisfying(VisionModelProfile.VisionProviderUnavailableException.class,
                        failure -> org.assertj.core.api.Assertions.assertThat(failure.reason())
                                .isEqualTo(VisionModelProfile.UnavailableReason.PROVIDER_NOT_ADMITTED));
    }
}
