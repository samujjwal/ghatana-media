package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * Server-side admission policy for the authenticated OCI broker. Every check is
 * enforced inside the broker process; callers supply only the bounded launch
 * description. Images must be digest-pinned AND on the operator's allowlist,
 * uid/gid must equal the operator-pinned worker identity, worker arguments are
 * a fixed codec shape (no URLs, escapes, or dangerous ffmpeg options), the
 * source must be an owned regular file inside the source root whose bytes match
 * the claimed digest, and each request carries a fresh timestamp and a nonce
 * that has never been seen in its still-valid acceptance window.
 */
final class MediaOciBrokerPolicy {

    static final int MAX_NONCE_CACHE = 65_536;
    static final long MAX_REQUEST_SKEW_MS = Duration.ofMinutes(5).toMillis();
    static final int MAX_ARG_LENGTH = 512;

    private static final Set<String> INPUT_FORMATS = Set.of("mov", "matroska", "avi", "webm");
    static final int MAX_WHISPER_INPUT_BYTES = 4 * 1024 * 1024;
    static final int MAX_WHISPER_RESPONSE_BYTES = 1024 * 1024;
    static final long MAX_VISION_SOURCE_BYTES = 500L * 1024 * 1024;
    static final long MAX_VISION_OUTPUT_BYTES = 512L * 1024 * 1024;
    static final long MAX_VISION_FRAME_BYTES = 32L * 1024 * 1024;
    static final long MAX_VISION_AUDIO_BYTES = 16_000L * 2L * 300L;
    static final int MAX_VISION_OUTPUT_FILES = 10_000;

    private MediaOciBrokerPolicy() { }

    /** Operator-pinned server policy; all values come from broker-owned configuration. */
    record Policy(
            Set<String> allowedImageDigests,
            long workerUid,
            long workerGid,
            Path sourceRoot,
            Path outputRoot,
            Path stageRoot,
            WhisperProfile whisperProfile,
            WhisperWorkerServerConfig whisperWorkerConfig,
            VisionProfile visionProfile) {
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot, WhisperProfile whisperProfile) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, null, whisperProfile, null, null);
        }
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot, WhisperProfile whisperProfile,
                WhisperWorkerServerConfig whisperWorkerConfig) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, null,
                    whisperProfile, whisperWorkerConfig, null);
        }
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot, WhisperProfile whisperProfile,
                WhisperWorkerServerConfig whisperWorkerConfig, VisionProfile visionProfile) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, null,
                    whisperProfile, whisperWorkerConfig, visionProfile);
        }
        Policy(Set<String> allowedImageDigests, long workerUid, long workerGid,
                Path sourceRoot, Path outputRoot) {
            this(allowedImageDigests, workerUid, workerGid, sourceRoot, outputRoot, null, null, null, null);
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

    /** Bounded replay window: fail closed at capacity instead of forgetting a live nonce. */
    static final class NonceReplayGuard {
        private final Map<String, Long> seen = new LinkedHashMap<>();
        private final Set<String> active = new HashSet<>();
        private final PriorityQueue<NonceEntry> expiryQueue = new PriorityQueue<>(
                java.util.Comparator.comparingLong(NonceEntry::expiresAtMs));

        private final MediaOciBrokerNonceJournal journal;
        private long clockHighWaterMs;

        NonceReplayGuard() {
            this(null);
        }

        NonceReplayGuard(MediaOciBrokerNonceJournal journal) {
            this.journal = journal;
        }

        synchronized boolean admit(String nonce, long timestampMs, long now) throws java.io.IOException {
            if (nonce == null || nonce.length() < 16 || nonce.length() > 128
                    || timestampMs < 0 || now < 0) return false;
            long skew = now >= timestampMs ? now - timestampMs : timestampMs - now;
            if (skew > MAX_REQUEST_SKEW_MS) return false;
            if (journal != null) return journal.reserve(nonce, timestampMs, now);
            if (now < clockHighWaterMs) return false;
            clockHighWaterMs = now;
            if (seen.containsKey(nonce)) return false;
            expireActive(now);
            if (active.size() >= MAX_NONCE_CACHE) return false;
            seen.put(nonce, timestampMs);
            active.add(nonce);
            expiryQueue.add(new NonceEntry(nonce, timestampMs, expiry(timestampMs)));
            return true;
        }

        private void expireActive(long now) {
            while (!expiryQueue.isEmpty() && isExpired(expiryQueue.peek().timestampMs(), now)) {
                NonceEntry expired = expiryQueue.remove();
                active.remove(expired.nonce());
                seen.remove(expired.nonce());
            }
        }

        private static boolean isExpired(long timestampMs, long now) {
            return now >= timestampMs && now - timestampMs > MAX_REQUEST_SKEW_MS;
        }

        private static long expiry(long timestampMs) {
            return timestampMs > Long.MAX_VALUE - MAX_REQUEST_SKEW_MS
                    ? Long.MAX_VALUE : timestampMs + MAX_REQUEST_SKEW_MS;
        }

        private record NonceEntry(String nonce, long timestampMs, long expiresAtMs) { }
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
        // Source-only host broker probe: one read-only file input, file protocol
        // only, null muxer to stdout. No output path or arbitrary filter is admitted.
        if (args.equals(List.of("-nostdin", "-protocol_whitelist", "file", "-i",
                "/source/input", "-f", "null", "-"))) return true;
        // Narrow fixture-worker plans used by the OCI boundary suite.
        if (args.size() == 8 && args.get(0).equals("-nostdin")
                && args.get(1).equals("-hide_banner") && args.get(2).equals("-loglevel")
                && args.get(3).equals("error") && args.get(4).equals("-i")
                && args.get(5).equals("/source/input")
                && (args.get(6).equals("-y") || args.get(6).equals("-n"))) {
            return outputFile(args.get(7));
        }
        if (singleFrameArgsAllowed(args) || audioDemuxArgsAllowed(args)) return true;
        // Production VideoFrameExtractor frame extraction plan, including its bounded
        // select/scale filter and fixed output format/options.
        if (args.size() != 34 || !args.subList(0, 16).equals(List.of(
                "-nostdin", "-v", "info", "-copyts", "-protocol_whitelist", "file",
                "-max_alloc", "268435456", "-max_pixels", args.get(9), "-threads", "2",
                "-filter_threads", "1", "-f", args.get(15)))
                || !args.get(9).equals("16000000")
                || !INPUT_FORMATS.contains(args.get(15)) || !args.get(16).equals("-i")
                || !args.get(17).equals("/source/input") || !args.get(18).equals("-map")
                || !args.get(19).equals("0:v:0") || !args.get(20).equals("-threads")
                || !args.get(21).equals("2") || !args.get(22).equals("-vf")
                || !safeFrameFilter(args.get(23)) || !args.get(24).equals("-fps_mode")
                || !args.get(25).equals("passthrough") || !args.get(26).equals("-enc_time_base")
                || !args.get(27).equals("demux") || !args.get(28).equals("-frames:v")
                || !positiveInt(args.get(29), 10_000) || !args.get(30).equals("-q:v")
                || !positiveInt(args.get(31), 31) || !outputPattern(args.get(32))
                || !args.get(33).equals("-n")) return false;
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
        return path != null && (path.matches("/output/frame\\.(?:jpg|jpeg|png|bmp|tiff)")
                || path.equals("/output/audio.pcm"));
    }

    private static boolean outputPattern(String path) {
        return path != null && path.matches("/output/frame_%04d\\.(?:jpg|jpeg|png|bmp|tiff)");
    }

    private static boolean singleFrameArgsAllowed(List<String> args) {
        if (args.size() != 25 || !args.subList(0, 11).equals(List.of(
                "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", args.get(6),
                "-max_alloc", "268435456", "-max_pixels", "16000000"))
                || !INPUT_FORMATS.contains(args.get(6)) || !args.get(11).equals("-ss")
                || !args.get(12).matches("[0-9]{1,13}\\.[0-9]{3}")
                || !args.get(13).equals("-i") || !args.get(14).equals("/source/input")
                || !args.get(15).equals("-frames:v") || !args.get(16).equals("1")
                || !args.get(17).equals("-vf")
                || !args.get(18).equals("scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease")
                || !args.get(19).equals("-q:v") || !args.get(20).equals("2")
                || !args.get(21).equals("-fs") || !args.get(22).equals(Long.toString(MAX_VISION_FRAME_BYTES))
                || !outputFile(args.get(23)) || !args.get(24).equals("-n")) return false;
        return true;
    }

    private static boolean audioDemuxArgsAllowed(List<String> args) {
        if (args.size() != 30 || !args.subList(0, 12).equals(List.of(
                "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-max_alloc",
                "268435456", "-threads", "2", "-i", "/source/input", "-map"))
                || !args.get(12).matches("0:(?:0|[1-9][0-9]{0,4})")
                || !args.subList(13, 27).equals(List.of("-vn", "-sn", "-dn", "-threads", "2",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "-fs"))
                || !args.get(27).equals(Long.toString(MAX_VISION_AUDIO_BYTES))
                || !args.get(28).equals("/output/audio.pcm") || !args.get(29).equals("-n")) return false;
        return true;
    }

    static boolean outputLimitAllowed(String executable, List<String> args, long limit) {
        if (limit <= 0 || limit > MAX_VISION_OUTPUT_BYTES || !"ffmpeg".equals(executable)) return false;
        if (args != null && args.contains("/output/audio.pcm")) return limit <= MAX_VISION_AUDIO_BYTES;
        if (args != null && args.stream().anyMatch(value -> value.matches("/output/frame\\.(?:jpg|jpeg|png|bmp|tiff)"))) {
            return limit <= MAX_VISION_FRAME_BYTES;
        }
        return true;
    }

    static boolean outputBindingAllowed(String output, List<String> args) {
        boolean workerWritesFile = args != null && args.stream().anyMatch(value -> value.startsWith("/output/"));
        return workerWritesFile == (output != null);
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
        // A digest is meaningful only when it is bound to a source file. Do not
        // accept detached caller claims on source-free probes.
        if (source == null) return sourceSha256 == null;
        if (sourceSha256 == null || !sourceSha256.matches("[0-9a-f]{64}")) return false;
        Path literal = Path.of(source);
        if (!pathHasNoSymlinkComponents(literal, policy.sourceRoot())) return false;
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
        if (Files.size(resolved) <= 0 || Files.size(resolved) > MAX_VISION_SOURCE_BYTES) return false;
        String actual = sha256File(resolved);
        return MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                sourceSha256.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    static boolean outputAllowed(Policy policy, String output) throws IOException {
        if (output == null) return true;
        Path literal = Path.of(output);
        if (!pathHasNoSymlinkComponents(literal, policy.outputRoot())) return false;
        Path resolved = literal.toRealPath();
        if (!resolved.getParent().equals(policy.outputRoot())
                || !resolved.getFileName().toString().matches("media-vision-output-[a-f0-9-]{36}")
                || !Files.isDirectory(resolved, LinkOption.NOFOLLOW_LINKS)
                || Files.isSymbolicLink(resolved)
                || !unixIdentityMatches(resolved, policy.workerUid(), policy.workerGid())
                || unixMode(resolved) != 02770 || !Files.isWritable(resolved)) return false;
        try (var entries = Files.list(resolved)) { return entries.findAny().isEmpty(); }
    }

    static Path validateSharedOutputRoot(Path configured, long workerUid, long workerGid) throws IOException {
        if (configured == null || Files.isSymbolicLink(configured)
                || !Files.isDirectory(configured, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Broker output root must be a real worker-owned directory");
        }
        Path root = configured.toRealPath();
        if (!unixIdentityMatches(root, workerUid, workerGid) || unixMode(root) != 02750) {
            throw new IOException("Broker output root must be worker-owned with dedicated shared-group mode 02750");
        }
        return root;
    }

    private static boolean unixIdentityMatches(Path path, long uid, long gid) throws IOException {
        try {
            Object owner = Files.getAttribute(path, "unix:uid", LinkOption.NOFOLLOW_LINKS);
            Object group = Files.getAttribute(path, "unix:gid", LinkOption.NOFOLLOW_LINKS);
            return owner instanceof Number ownerNumber && group instanceof Number groupNumber
                    && ownerNumber.longValue() == uid && groupNumber.longValue() == gid;
        } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
            throw new IOException("Broker output ownership cannot be verified", unsupported);
        }
    }

    private static int unixMode(Path path) throws IOException {
        try {
            Object mode = Files.getAttribute(path, "unix:mode", LinkOption.NOFOLLOW_LINKS);
            return mode instanceof Number number ? number.intValue() & 07777 : -1;
        } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
            throw new IOException("Broker output permissions cannot be verified", unsupported);
        }
    }

    /** Reject aliases in every path component, including a symlinked parent directory. */
    private static boolean pathHasNoSymlinkComponents(Path literal, Path trustedRoot) throws IOException {
        Path normalized = literal.toAbsolutePath().normalize();
        Path current = normalized.getRoot();
        if (current == null) return false;
        boolean insideTrustedRoot = false;
        for (Path component : normalized) {
            current = current.resolve(component);
            // macOS commonly exposes /var as an alias for /private/var. Allow
            // such leading aliases while reaching the already-canonical root,
            // then reject every symlink in the caller-controlled suffix.
            if (insideTrustedRoot && Files.isSymbolicLink(current)) return false;
            Path physical = current.toRealPath();
            if (physical.equals(trustedRoot)) insideTrustedRoot = true;
            current = physical;
        }
        return insideTrustedRoot && current.startsWith(trustedRoot);
    }

    /** Credential material must never be group/other readable. */
    static boolean ownerOnlyFile(Path file) throws IOException {
        if (file == null || Files.isSymbolicLink(file)
                || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) return false;
        try {
            Set<java.nio.file.attribute.PosixFilePermission> perms =
                    Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS);
            return perms.equals(PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException unsupported) {
            return false;
        }
    }

    static String sha256File(Path file) throws IOException {
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
