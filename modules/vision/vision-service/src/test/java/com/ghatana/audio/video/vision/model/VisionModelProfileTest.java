package com.ghatana.audio.video.vision.model;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class VisionModelProfileTest {
    @TempDir Path directory;

    @Test void acceptsPinnedProfileAndRechecksBytes() throws Exception {
        byte[] bytes = {1, 2, 3, 4};
        Files.write(directory.resolve("yolov8n.onnx"), bytes);
        Map<String, String> env = env(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        VisionModelProfile profile = VisionModelProfile.fromEnvironment(env);
        assertEquals("1.0", profile.version());
        assertEquals(VisionModelProfile.Device.CPU, profile.device());
        profile.verifyUnchanged();
        Files.write(profile.modelFile(), new byte[] {9});
        assertEquals(VisionModelProfile.UnavailableReason.MODEL_DIGEST_MISMATCH,
                assertThrows(VisionModelProfile.VisionProviderUnavailableException.class,
                        profile::verifyUnchanged).reason());
    }

    @Test void missingModelFailsClosed() {
        assertEquals(VisionModelProfile.UnavailableReason.MODEL_FILE_UNAVAILABLE,
                assertThrows(VisionModelProfile.VisionProviderUnavailableException.class,
                        () -> VisionModelProfile.fromEnvironment(env("0".repeat(64)))).reason());
    }

    @Test void digestMismatchFailsClosed() throws Exception {
        Files.write(directory.resolve("yolov8n.onnx"), new byte[] {1});
        assertEquals(VisionModelProfile.UnavailableReason.MODEL_DIGEST_MISMATCH,
                assertThrows(VisionModelProfile.VisionProviderUnavailableException.class,
                        () -> VisionModelProfile.fromEnvironment(env("0".repeat(64)))).reason());
    }

    @Test void missingVersionLicenseClassesAndDeviceAreRejected() throws Exception {
        Files.write(directory.resolve("yolov8n.onnx"), new byte[] {1});
        Map<String, String> base = env(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(new byte[] {1})));
        for (String key : new String[] {"VISION_MODEL_VERSION", "VISION_MODEL_LICENSE", "VISION_MODEL_CLASSES", "VISION_MODEL_DEVICE"}) {
            var bad = new java.util.HashMap<>(base);
            bad.remove(key);
            assertThrows(IllegalArgumentException.class, () -> VisionModelProfile.fromEnvironment(bad), key);
        }
    }

    private Map<String, String> env(String digest) {
        return Map.of("VISION_MODEL_PATH", directory.toString(), "VISION_MODEL_NAME", "yolov8n",
                "VISION_MODEL_VERSION", "1.0", "VISION_MODEL_SHA256", digest,
                "VISION_MODEL_LICENSE", "UNVERIFIED_OPERATOR_DECLARATION",
                "VISION_MODEL_CLASSES", "person,car", "VISION_MODEL_DEVICE", "CPU");
    }
}
