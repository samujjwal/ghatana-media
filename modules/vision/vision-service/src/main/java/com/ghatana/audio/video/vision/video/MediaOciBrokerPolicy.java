package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Server-side admission policy for the authenticated OCI broker. Every check is
 * enforced inside the broker process; callers supply only the bounded launch
 * description. Images must be digest-pinned AND on the operator's allowlist,
 * uid/gid must equal the operator-pinned worker identity, worker arguments are
 * a fixed codec shape (no URLs, escapes, or dangerous ffmpeg options), the
 * source must be an owned regular file inside the source root whose bytes match
 * the claimed digest, and each request carries a fresh timestamp and a nonce
 * that has never been seen before.
 */
final class MediaOciBrokerPolicy {

    static final int MAX_NONCE_CACHE = 65_536;
    static final long MAX_REQUEST_SKEW_MS = Duration.ofMinutes(5).toMillis();
    static final int MAX_ARG_LENGTH = 512;

    private static final Set<String> INPUT_FORMATS = Set.of("mov", "matroska", "avi", "webm");
    static final int MAX_WHISPER_INPUT_BYTES = 4 * 1024 * 1024;
    static final int MAX_WHISPER_RESPONSE_BYTES = 1024 * 1024;

    private MediaOciBrokerPolicy() { }

    /** Operator-pinned server policy; all values come from broker-owned configuration. */
    record Policy(
            Set<String> allowedImageDigests,
            long workerUid,
            long workerGid,
            Path sourceRoot,
            Path outputRoot,
            WhisperProfile whisperProfile,
            WhisperWorkerServerConfig whisperWorkerConfig,
            VisionProfile visionProfile) {
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot, WhisperProfile whisperProfile) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, whisperProfile, null, null);
        }
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot, WhisperProfile whisperProfile,
                WhisperWorkerServerConfig whisperWorkerConfig) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot,
                    whisperProfile, whisperWorkerConfig, null);
        }
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, null, null, null);
        }
    }

    /** One broker-owned FFmpeg toolchain. The immutable image digest binds the actual binaries. */
    record VisionProfile(String profileId, String imageDigest, String toolchainVersion) {
        VisionProfile {
            if (profileId == null || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                    || imageDigest == null || !imageDigest.matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
                    || toolchainVersion == null || !toolchainVersion.matches("[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}")) {
                throw new IllegalArgumentException("Vision worker profile pins are invalid");
            }
        }
    }

    static Optional<VisionProfile> loadVisionProfile(Map<String, String> environment,
                                                       Set<String> allowedImages) {
        String profileId = environment.get("MEDIA_OCI_BROKER_VISION_PROFILE_ID");
        String image = environment.get("MEDIA_OCI_BROKER_VISION_IMAGE");
        String version = environment.get("MEDIA_OCI_BROKER_VISION_TOOLCHAIN_VERSION");
        if (profileId == null || image == null || version == null) return Optional.empty();
        try {
            VisionProfile profile = new VisionProfile(profileId, image, version);
            return allowedImages.contains(image) ? Optional.of(profile) : Optional.empty();
        } catch (RuntimeException invalid) {
            return Optional.empty();
        }
    }

    static boolean visionImageAllowed(Policy policy, String image) {
        VisionProfile profile = policy.visionProfile();
        return profile != null && profile.imageDigest().equals(image)
                && imageAllowed(policy, image);
    }

    /** Broker-owned pin for one fixed Whisper worker profile. No request field can alter it. */
    record WhisperProfile(String profileId, String imageDigest, String modelSha256,
                          Set<String> locales) {
        WhisperProfile {
            if (profileId == null || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                    || imageDigest == null || !imageDigest.matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
                    || modelSha256 == null || !modelSha256.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("Whisper worker profile pins are invalid");
            }
            locales = Set.copyOf(locales);
            if (locales.isEmpty() || locales.stream().anyMatch(locale -> !validLocale(locale))) {
                throw new IllegalArgumentException("Whisper profile requires a bounded locale allowlist");
            }
        }
    }

    /** Loads only immutable server-owned profile identity; missing fields leave compute not admitted. */
    static Optional<WhisperProfile> loadWhisperProfile(Map<String, String> environment,
                                                       Set<String> allowedImages) {
        String profileId = environment.get("MEDIA_OCI_BROKER_WHISPER_PROFILE_ID");
        String image = environment.get("MEDIA_OCI_BROKER_WHISPER_IMAGE");
        String modelSha256 = environment.get("MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256");
        String locales = environment.get("MEDIA_OCI_BROKER_WHISPER_LOCALES");
        if (profileId == null || image == null || modelSha256 == null || locales == null) return Optional.empty();
        try {
            Set<String> localeSet = java.util.Arrays.stream(locales.split(",", -1))
                    .map(String::trim).collect(java.util.stream.Collectors.toUnmodifiableSet());
            WhisperProfile profile = new WhisperProfile(profileId, image, modelSha256, localeSet);
            return allowedImages.contains(image) ? Optional.of(profile) : Optional.empty();
        } catch (RuntimeException invalid) {
            return Optional.empty();
        }
    }

    /** Bounded replay window: each nonce is valid at most once inside a timestamp skew. */
    static final class NonceReplayGuard {
        private final Map<String, Boolean> seen = new LinkedHashMap<>() {
            @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                return size() > MAX_NONCE_CACHE;
            }
        };

        synchronized boolean admit(String nonce, long timestampMs, long now) {
            if (Math.abs(now - timestampMs) > MAX_REQUEST_SKEW_MS) return false;
            return nonce != null && nonce.length() >= 16 && nonce.length() <= 128
                    && seen.putIfAbsent(nonce, Boolean.TRUE) == null;
        }
    }

    /** The caller-described worker must be exactly one server-approved shape. */
    static boolean imageAllowed(Policy policy, String image) {
        return image != null && policy.allowedImageDigests().contains(image);
    }

    static boolean workerIdentityAllowed(Policy policy, long uid, long gid) {
        return uid == policy.workerUid() && gid == policy.workerGid();
    }

    static boolean whisperProfileAllowed(Policy policy, String profileId, String locale) {
        WhisperProfile profile = policy.whisperProfile();
        return profile != null && profile.profileId().equals(profileId)
                && locale != null && profile.locales().contains(locale);
    }

    static boolean whisperImageAllowed(Policy policy, String image) {
        WhisperProfile profile = policy.whisperProfile();
        return profile != null && profile.imageDigest().equals(image)
                && imageAllowed(policy, image);
    }

    static boolean whisperInputAllowed(byte[] wav, String sourceSha256) {
        if (wav == null || wav.length == 0 || wav.length > MAX_WHISPER_INPUT_BYTES
                || sourceSha256 == null || !sourceSha256.matches("[0-9a-f]{64}")) return false;
        try {
            String actual = java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(wav));
            return MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                    sourceSha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static boolean validLocale(String locale) {
        if (locale == null || locale.isBlank() || locale.length() > 35 || !locale.equals(locale.trim())) return false;
        try {
            java.util.Locale parsed = new java.util.Locale.Builder().setLanguageTag(locale).build();
            return !parsed.getLanguage().isBlank() && !"und".equals(parsed.toLanguageTag())
                    && parsed.toLanguageTag().equals(locale);
        } catch (java.util.IllformedLocaleException invalid) {
            return false;
        }
    }

    /** Exact argument grammar for the extractor's FFmpeg and FFprobe launch plans. */
    static boolean workerArgsAllowed(String executable, List<String> args) {
        if (executable == null || args == null || args.isEmpty() || args.size() > 64) return false;
        for (String arg : args) {
            if (arg == null || arg.isBlank() || arg.length() > MAX_ARG_LENGTH
                    || arg.chars().anyMatch(Character::isISOControl)
                    || arg.contains("://") || arg.contains("..")) return false;
        }
        return switch (executable) {
            case "ffmpeg" -> ffmpegArgsAllowed(args);
            case "ffprobe" -> ffprobeArgsAllowed(args);
            default -> false;
        };
    }

    private static boolean ffmpegArgsAllowed(List<String> args) {
        // Narrow fixture-worker plan used by the OCI boundary suite.
        if (args.size() == 8 && args.get(0).equals("-nostdin")
                && args.get(1).equals("-hide_banner") && args.get(2).equals("-loglevel")
                && args.get(3).equals("error") && args.get(4).equals("-i")
                && args.get(5).equals("/source/input")
                && (args.get(6).equals("-y") || args.get(6).equals("-n"))) {
            return outputFile(args.get(7));
        }
        // Production VideoFrameExtractor frame extraction plan, including its bounded
        // select/scale filter and fixed output format/options.
        if (args.size() != 32 || !args.subList(0, 16).equals(List.of(
                "-nostdin", "-v", "info", "-copyts", "-protocol_whitelist", "file",
                "-max_alloc", "268435456", "-max_pixels", args.get(9), "-threads", "2",
                "-filter_threads", "1", "-f", args.get(15)))
                || !args.get(9).equals("16000000")
                || !INPUT_FORMATS.contains(args.get(15)) || !args.get(16).equals("-i")
                || !args.get(17).equals("/source/input") || !args.get(18).equals("-threads")
                || !args.get(19).equals("2") || !args.get(20).equals("-vf")
                || !safeFrameFilter(args.get(21)) || !args.get(22).equals("-fps_mode")
                || !args.get(23).equals("passthrough") || !args.get(24).equals("-enc_time_base")
                || !args.get(25).equals("demux") || !args.get(26).equals("-frames:v")
                || !positiveInt(args.get(27), 10_000) || !args.get(28).equals("-q:v")
                || !positiveInt(args.get(29), 31) || !outputPattern(args.get(30))
                || !args.get(31).equals("-n")) return false;
        return true;
    }

    private static boolean ffprobeArgsAllowed(List<String> args) {
        if (args.size() != 15) return false;
        if (!args.subList(0, 4).equals(List.of("-v", "error", "-protocol_whitelist", "file"))
                || !args.get(4).equals("-f") || !INPUT_FORMATS.contains(args.get(5))
                || !args.get(6).equals("-max_alloc") || !args.get(7).equals("268435456")
                || !args.get(8).equals("-select_streams") || !args.get(10).equals("-show_entries")
                || !args.get(12).equals("-of")
                || !args.get(13).equals("default=noprint_wrappers=1")
                || !args.get(14).equals("/source/input")) return false;
        String stream = args.get(9);
        boolean audio = stream.equals("a:0")
                && args.get(11).equals("stream=index,time_base,start_pts,sample_rate,channels,duration_ts");
        boolean video = stream.equals("v:0")
                && args.get(11).equals("stream=width,height,duration,nb_frames,r_frame_rate,time_base");
        return audio || video;
    }

    private static boolean safeFrameFilter(String filter) {
        if (filter == null || filter.length() > MAX_ARG_LENGTH) return false;
        String selection = "select='isnan\\(prev_selected_t\\)\\+gte\\(t-prev_selected_t,1/"
                + "(?:[1-9]|[1-5][0-9]|60)\\)',showinfo,";
        String defaultScale = "scale='min\\(4096,iw\\)':'min\\(4096,ih\\)':force_original_aspect_ratio=decrease";
        if (filter.matches(selection + defaultScale)) return true;
        java.util.regex.Matcher dimensions = java.util.regex.Pattern.compile(
                selection + "scale=([1-9][0-9]{0,3}):([1-9][0-9]{0,3})").matcher(filter);
        if (!dimensions.matches()) return false;
        try {
            int width = Integer.parseInt(dimensions.group(1));
            int height = Integer.parseInt(dimensions.group(2));
            return width <= 8192 && height <= 8192 && (long) width * height <= 16_000_000L;
        } catch (NumberFormatException invalid) {
            return false;
        }
    }

    private static boolean outputFile(String path) {
        return path != null && path.matches("/output/[A-Za-z0-9_.-]{1,180}")
                && !path.equals("/output/.") && !path.equals("/output/..");
    }

    private static boolean outputPattern(String path) {
        return path != null && path.matches("/output/frame_%04d\\.(?:jpg|jpeg|png|bmp|tiff)");
    }

    private static boolean positiveInt(String value, int maximum) {
        if (value == null || !value.matches("[1-9][0-9]{0,7}")) return false;
        try { return Integer.parseInt(value) <= maximum; }
        catch (NumberFormatException invalid) { return false; }
    }

    /**
     * The source must be an unlinked regular file inside the source root, owned by the
     * pinned worker uid/gid, with bytes matching the digest the caller pinned at submit.
     */
    static boolean sourceAllowed(Policy policy, String source, String sourceSha256)
            throws IOException {
        if (source == null) return true;
        if (sourceSha256 == null || !sourceSha256.matches("[0-9a-f]{64}")) return false;
        Path literal = Path.of(source);
        if (Files.isSymbolicLink(literal)) return false;
        Path resolved = literal.toRealPath();
        if (!resolved.startsWith(policy.sourceRoot()) || !Files.isRegularFile(resolved)) {
            return false;
        }
        try {
            Object uid = Files.getAttribute(resolved, "unix:uid", LinkOption.NOFOLLOW_LINKS);
            Object gid = Files.getAttribute(resolved, "unix:gid", LinkOption.NOFOLLOW_LINKS);
            if (!(uid instanceof Number ownerUid) || !(gid instanceof Number ownerGid)
                    || ownerUid.longValue() != policy.workerUid()
                    || ownerGid.longValue() != policy.workerGid()) {
                return false;
            }
        } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
            return false;
        }
        String actual = sha256File(resolved);
        return MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                sourceSha256.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    static boolean outputAllowed(Policy policy, String output) throws IOException {
        if (output == null) return true;
        Path literal = Path.of(output);
        if (Files.isSymbolicLink(literal)) return false;
        Path resolved = literal.toRealPath();
        return resolved.startsWith(policy.outputRoot()) && Files.isDirectory(resolved);
    }

    /** Credential material must never be group/other readable. */
    static boolean ownerOnlyFile(Path file) throws IOException {
        try {
            Set<java.nio.file.attribute.PosixFilePermission> perms =
                    Files.getPosixFilePermissions(file);
            return perms.equals(PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException unsupported) {
            return false;
        }
    }

    private static String sha256File(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var in = Files.newInputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
