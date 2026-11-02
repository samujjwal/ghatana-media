package com.ghatana.audio.video.vision.video;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Fully pinned, server-owned prerequisites for the fixed Whisper OCI worker. */
record WhisperWorkerServerConfig(String profileId, String imageDigest, Path modelRoot,
        String modelRevision, String modelSha256, String bundleSha256, Set<String> locales,
        Path journalDirectory) {
    private static final Set<String> MODEL_ASSETS = Set.of(
            "encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx",
            "mel_filters.npz", "multilingual.tiktoken");
    private static final String PREFIX = "MEDIA_OCI_BROKER_WHISPER_";

    WhisperWorkerServerConfig {
        if (profileId == null || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("Whisper profile ID is invalid");
        }
        if (imageDigest == null || !imageDigest.matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Whisper image must be digest-pinned");
        }
        if (modelRevision == null || !modelRevision.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("Whisper model revision is invalid");
        }
        if (modelSha256 == null || !modelSha256.matches("[0-9a-f]{64}")
                || bundleSha256 == null || !bundleSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Whisper model digest pins are invalid");
        }
        locales = Set.copyOf(locales);
        if (locales.isEmpty() || locales.stream().anyMatch(locale -> !MediaOciBrokerPolicyLocale.valid(locale))) {
            throw new IllegalArgumentException("Whisper locales are invalid");
        }
    }

    /**
     * Loads all required server pins and verifies the exact four-file model bundle.
     * The journal directory is only checked here; its MAC, encryption and process
     * lock are validated by MediaOciBrokerWhisperJournal when opened.
     */
    static Optional<WhisperWorkerServerConfig> load(Map<String, String> environment,
            Set<String> allowedImages) {
        try {
            String profile = environment.get(PREFIX + "PROFILE_ID");
            String image = environment.get(PREFIX + "IMAGE");
            String revision = environment.get(PREFIX + "MODEL_REVISION");
            String modelSha = environment.get(PREFIX + "MODEL_SHA256");
            String bundleSha = environment.get(PREFIX + "MODEL_BUNDLE_SHA256");
            String localeText = environment.get(PREFIX + "LOCALES");
            String modelPath = environment.get(PREFIX + "MODEL_ROOT");
            String journalPath = environment.get(PREFIX + "JOURNAL_DIR");
            if (blank(profile) || blank(image) || blank(revision) || blank(modelSha) || blank(bundleSha)
                    || blank(localeText) || blank(modelPath) || blank(journalPath)
                    || !allowedImages.contains(image)) return Optional.empty();
            Path root = validateModelRoot(Path.of(modelPath), modelSha, bundleSha);
            Path journal = validateJournalDirectory(Path.of(journalPath));
            Set<String> locales = java.util.Arrays.stream(localeText.split(",", -1))
                    .map(String::trim).collect(java.util.stream.Collectors.toUnmodifiableSet());
            return Optional.of(new WhisperWorkerServerConfig(profile, image, root, revision,
                    modelSha, bundleSha, locales, journal));
        } catch (IOException | RuntimeException invalidOrUnavailable) {
            return Optional.empty();
        }
    }

    static String bundleSha256(Path modelRoot) throws IOException {
        Path root = validateDirectory(modelRoot, "model bundle");
        try (var entries = Files.list(root)) {
            Set<String> names = entries.map(path -> path.getFileName().toString())
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
            if (!names.equals(MODEL_ASSETS)) throw new IOException("Model bundle file set is not exact");
        }
        ByteArrayOutputStream manifest = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(manifest)) {
            for (String name : MODEL_ASSETS.stream().sorted().toList()) {
                Path file = root.resolve(name);
                validateRegularFile(file);
                byte[] digest = sha256(file);
                byte[] nameBytes = name.getBytes(StandardCharsets.UTF_8);
                out.writeInt(nameBytes.length);
                out.write(nameBytes);
                out.writeLong(Files.size(file));
                out.write(digest);
            }
        }
        return HexFormat.of().formatHex(sha256(manifest.toByteArray()));
    }

    static Path validateModelRoot(Path root, String expectedModelSha, String expectedBundleSha)
            throws IOException {
        Path canonicalRoot = validateDirectory(root, "model bundle");
        if (expectedModelSha == null || !expectedModelSha.matches("[0-9a-f]{64}")
                || expectedBundleSha == null || !expectedBundleSha.matches("[0-9a-f]{64}")) {
            throw new IOException("Whisper model pins are invalid");
        }
        Path encoder = canonicalRoot.resolve("encoder_model_quantized.onnx");
        validateRegularFile(encoder);
        if (!expectedModelSha.equals(HexFormat.of().formatHex(sha256(encoder)))) {
            throw new IOException("Whisper encoder does not match its server pin");
        }
        String bundle = bundleSha256(canonicalRoot);
        if (!MessageDigest.isEqual(bundle.getBytes(StandardCharsets.US_ASCII),
                expectedBundleSha.getBytes(StandardCharsets.US_ASCII))) {
            throw new IOException("Whisper model bundle does not match its server pin");
        }
        return canonicalRoot;
    }

    private static Path validateJournalDirectory(Path path) throws IOException {
        Path directory = validateDirectory(path, "journal");
        try {
            if (!Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS)
                    .equals(PosixFilePermissions.fromString("rwx------"))) {
                throw new IOException("Whisper journal directory must be owner-only");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Whisper journal requires POSIX permissions", unsupported);
        }
        return directory;
    }

    private static Path validateDirectory(Path path, String description) throws IOException {
        if (path == null || !path.isAbsolute() || Files.isSymbolicLink(path)
                || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Whisper " + description + " must be an absolute non-symlink directory");
        }
        Path real = path.toRealPath();
        String text = real.toString();
        if (text.contains(",") || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
            throw new IOException("Whisper " + description + " path contains an OCI mount delimiter");
        }
        return real;
    }

    private static void validateRegularFile(Path path) throws IOException {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Whisper model assets must be regular non-symlink files");
        }
    }

    private static byte[] sha256(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) if (count > 0) digest.update(buffer, 0, count);
            }
            return digest.digest();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static byte[] sha256(byte[] bytes) {
        try { return MessageDigest.getInstance("SHA-256").digest(bytes); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    /** Locale helper kept local so loading has no dependency on caller contracts. */
    private static final class MediaOciBrokerPolicyLocale {
        private static boolean valid(String locale) {
            if (locale == null || locale.isBlank() || locale.length() > 35 || !locale.equals(locale.trim())) return false;
            try {
                java.util.Locale parsed = new java.util.Locale.Builder().setLanguageTag(locale).build();
                return !parsed.getLanguage().isBlank() && !"und".equals(parsed.toLanguageTag())
                        && locale.equals(parsed.toLanguageTag());
            } catch (java.util.IllformedLocaleException invalid) { return false; }
        }
    }
}
