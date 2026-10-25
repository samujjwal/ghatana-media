package com.ghatana.audio.video.vision.model;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Verified local metadata for the one YOLO ONNX model that the Vision service may initialize.
 *
 * <p>The declared license value is untrusted operator metadata, not license approval or provider
 * admission. A profile proves local file digest and metadata consistency only; it does not authorize
 * production initialization.
 */
public record VisionModelProfile(
        String modelId,
        String version,
        Path modelDirectory,
        Path modelFile,
        String sha256,
        String licenseId,
        List<String> classLabels,
        Device device,
        long sizeBytes) {

    private static final long MAX_MODEL_BYTES = 2L * 1024 * 1024 * 1024;

    public VisionModelProfile {
        modelId = required(modelId, "modelId");
        version = required(version, "version");
        modelDirectory = Objects.requireNonNull(modelDirectory, "modelDirectory")
                .toAbsolutePath().normalize();
        modelFile = Objects.requireNonNull(modelFile, "modelFile")
                .toAbsolutePath().normalize();
        sha256 = required(sha256, "sha256").toLowerCase();
        licenseId = required(licenseId, "licenseId");
        classLabels = List.copyOf(Objects.requireNonNull(classLabels, "classLabels"));
        device = Objects.requireNonNull(device, "device");
        if (!sha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("sha256 must contain exactly 64 hexadecimal characters");
        }
        if (classLabels.isEmpty() || classLabels.stream().anyMatch(String::isBlank)
                || classLabels.stream().distinct().count() != classLabels.size()) {
            throw new IllegalArgumentException("classLabels must be non-empty, unique, and non-blank");
        }
        if (sizeBytes <= 0 || sizeBytes > MAX_MODEL_BYTES) {
            throw new IllegalArgumentException("model size must be between 1 byte and 2 GiB");
        }
    }

    public static VisionModelProfile fromEnvironment(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        String configuredDirectory = environment.getOrDefault(
                "VISION_MODEL_PATH",
                Path.of(System.getProperty("user.home"), ".ghatana", "models", "vision").toString());
        Path modelDirectory = Path.of(required(configuredDirectory, "VISION_MODEL_PATH"))
                .toAbsolutePath().normalize();
        if (!Files.isDirectory(modelDirectory) || !Files.isReadable(modelDirectory)) {
            throw unavailable(
                    UnavailableReason.MODEL_DIRECTORY_UNAVAILABLE,
                    "VISION_MODEL_PATH is unavailable");
        }
        try {
            modelDirectory = modelDirectory.toRealPath();
        } catch (IOException failure) {
            throw unavailable(UnavailableReason.MODEL_DIRECTORY_UNAVAILABLE,
                    "VISION_MODEL_PATH cannot be resolved", failure);
        }

        String modelId = required(environment.getOrDefault("VISION_MODEL_NAME", "yolov8n"),
                "VISION_MODEL_NAME");
        if (modelId.length() > 128 || !modelId.matches("[A-Za-z0-9._-]+")) {
            throw new IllegalArgumentException(
                    "VISION_MODEL_NAME must contain only letters, digits, '.', '_', or '-' and be <= 128 characters");
        }
        String version = required(environment.get("VISION_MODEL_VERSION"), "VISION_MODEL_VERSION");
        String expectedDigest = required(environment.get("VISION_MODEL_SHA256"), "VISION_MODEL_SHA256")
                .toLowerCase();
        if (!expectedDigest.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("VISION_MODEL_SHA256 must contain exactly 64 hexadecimal characters");
        }
        String licenseId = required(environment.get("VISION_MODEL_LICENSE"), "VISION_MODEL_LICENSE");
        if (!licenseId.matches("[A-Za-z0-9][A-Za-z0-9.+:_-]{0,127}")) {
            throw new IllegalArgumentException("VISION_MODEL_LICENSE must be a stable SPDX-style identifier");
        }
        List<String> classes = required(environment.get("VISION_MODEL_CLASSES"), "VISION_MODEL_CLASSES")
                .lines()
                .flatMap(line -> java.util.Arrays.stream(line.split(",")))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .toList();
        if (classes.isEmpty() || classes.stream().distinct().count() != classes.size()) {
            throw new IllegalArgumentException("VISION_MODEL_CLASSES must contain unique class labels");
        }
        String configuredDevice = required(environment.get("VISION_MODEL_DEVICE"), "VISION_MODEL_DEVICE");
        Device device;
        if (configuredDevice.equalsIgnoreCase("cpu")) {
            device = Device.CPU;
        } else {
            throw unavailable(UnavailableReason.DEVICE_NOT_ADMITTED,
                    "Only CPU model execution is admitted by the current Vision provider");
        }

        Path modelFile = modelDirectory.resolve(modelId + ".onnx").normalize();
        if (!modelFile.getParent().equals(modelDirectory)
                || Files.isSymbolicLink(modelFile)
                || !Files.isRegularFile(modelFile, LinkOption.NOFOLLOW_LINKS)
                || !Files.isReadable(modelFile)) {
            throw unavailable(UnavailableReason.MODEL_FILE_UNAVAILABLE,
                    "Configured Vision ONNX model is unavailable");
        }
        try {
            modelFile = modelFile.toRealPath(LinkOption.NOFOLLOW_LINKS);
            long size = Files.size(modelFile);
            if (size <= 0 || size > MAX_MODEL_BYTES) {
                throw unavailable(UnavailableReason.MODEL_FILE_UNAVAILABLE,
                        "Configured Vision model size is outside the supported bound");
            }
            String actualDigest = digest(modelFile);
            if (!MessageDigest.isEqual(
                    HexFormat.of().parseHex(expectedDigest), HexFormat.of().parseHex(actualDigest))) {
                throw unavailable(UnavailableReason.MODEL_DIGEST_MISMATCH,
                        "Configured Vision model digest does not match its pin");
            }
            return new VisionModelProfile(
                    modelId, version, modelDirectory, modelFile, actualDigest, licenseId,
                    classes, device, size);
        } catch (IOException failure) {
            throw unavailable(UnavailableReason.MODEL_FILE_UNAVAILABLE,
                    "Configured Vision model cannot be read", failure);
        }
    }

    /** Re-checks the file immediately before and after native model loading. */
    public void verifyUnchanged() {
        try {
            if (Files.isSymbolicLink(modelFile)
                    || Files.size(modelFile) != sizeBytes
                    || !MessageDigest.isEqual(
                            HexFormat.of().parseHex(sha256), HexFormat.of().parseHex(digest(modelFile)))) {
                throw unavailable(UnavailableReason.MODEL_DIGEST_MISMATCH,
                        "Vision model changed after profile verification");
            }
        } catch (IOException failure) {
            throw unavailable(UnavailableReason.MODEL_FILE_UNAVAILABLE,
                    "Verified Vision model became unavailable", failure);
        }
    }

    private static String digest(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = Files.newInputStream(path)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    digest.update(buffer, 0, read);
                }
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is not available", impossible);
        }
    }

    private static String required(String value, String key) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return value.trim();
    }

    private static VisionProviderUnavailableException unavailable(UnavailableReason reason, String message) {
        return new VisionProviderUnavailableException(reason, message);
    }

    private static VisionProviderUnavailableException unavailable(
            UnavailableReason reason, String message, Throwable cause) {
        return new VisionProviderUnavailableException(reason, message, cause);
    }

    public enum Device { CPU }

    public enum UnavailableReason {
        MODEL_DIRECTORY_UNAVAILABLE,
        MODEL_FILE_UNAVAILABLE,
        MODEL_DIGEST_MISMATCH,
        MODEL_CLASS_MISMATCH,
        DEVICE_NOT_ADMITTED,
        PROVIDER_NOT_ADMITTED,
        NATIVE_INITIALIZATION_FAILED
    }

    public static final class VisionProviderUnavailableException extends IllegalStateException {
        private final UnavailableReason reason;

        public VisionProviderUnavailableException(UnavailableReason reason, String message) {
            super(message);
            this.reason = Objects.requireNonNull(reason, "reason");
        }

        public VisionProviderUnavailableException(
                UnavailableReason reason, String message, Throwable cause) {
            super(message, cause);
            this.reason = Objects.requireNonNull(reason, "reason");
        }

        public UnavailableReason reason() { return reason; }
    }
}
