package com.ghatana.tts.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Encodes the synthesizer's PCM16 WAV into a compressed delivery encoding through FFmpeg as one bounded process:
 * argument array only (never a shell), cleared environment, no stdin, a wall-clock deadline, cooperative
 * cancellation and an output-size ceiling. The encoder output is then independently read back by a second bounded
 * FFmpeg decode pass (a truncated or non-decodable file is {@link LocalTtsException.Code#OUTPUT_INVALID}) and its
 * container signature is checked, so a success is never reported for audio that was not produced and decodable.
 *
 * <p>Supported compressed encodings: {@code MP3} (libmp3lame) and {@code OGG_OPUS} (libopus). Whether this host can
 * produce them depends on the configured FFmpeg build; {@link #verifyCodecs()} probes it once.</p>
 */
public final class LocalAudioEncoder {
    public static final long MAX_ENCODED_BYTES = 8L * 1024 * 1024;
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(15);

    /** Requested delivery encoding and the typed facts about what it produces. */
    public enum Encoding {
        LINEAR16("audio/wav", "wav", false), WAV("audio/wav", "wav", false),
        MP3("audio/mpeg", "mp3", true), OGG_OPUS("audio/ogg", "ogg", true);

        private final String contentType;
        private final String extension;
        private final boolean transcoded;

        Encoding(String contentType, String extension, boolean transcoded) {
            this.contentType = contentType;
            this.extension = extension;
            this.transcoded = transcoded;
        }

        public String contentType() { return contentType; }
        public String extension() { return extension; }
        public boolean transcoded() { return transcoded; }

        public static Optional<Encoding> parse(String value) {
            if (value == null) return Optional.empty();
            try { return Optional.of(valueOf(value)); }
            catch (IllegalArgumentException unknown) { return Optional.empty(); }
        }
    }

    public record Encoded(byte[] bytes, Encoding encoding, long elapsedMillis) {
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    private final Path ffmpeg;
    private final Duration maxTimeout;
    private volatile Set<Encoding> codecs;

    /** Returns null when {@code ffmpeg} is not an absolute, executable regular file. */
    public static LocalAudioEncoder forExecutable(Path ffmpeg, Duration maxTimeout) {
        if (ffmpeg == null || !ffmpeg.isAbsolute() || !Files.isExecutable(ffmpeg)
                || !Files.isRegularFile(ffmpeg)) return null;
        return new LocalAudioEncoder(ffmpeg.normalize(), maxTimeout);
    }

    private LocalAudioEncoder(Path ffmpeg, Duration maxTimeout) {
        this.ffmpeg = Objects.requireNonNull(ffmpeg, "ffmpeg");
        this.maxTimeout = Objects.requireNonNull(maxTimeout, "maxTimeout");
    }

    /** The compressed encodings this FFmpeg build can actually produce (probed once, empty when it cannot run). */
    public Set<Encoding> verifyCodecs() {
        Set<Encoding> known = codecs;
        if (known != null) return known;
        Path work = null;
        try {
            work = Files.createTempDirectory("media-ffmpeg-probe-");
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                    List.of(ffmpeg.toString(), "-hide_banner", "-encoders"), work, environment(work),
                    PROBE_TIMEOUT, 256 * 1024, 16 * 1024, () -> false, null, 0);
            Set<Encoding> found = new java.util.LinkedHashSet<>();
            if (result.end() == BoundedProcessRunner.End.EXITED && result.exitCode() == 0) {
                String listing = new String(result.stdout(), java.nio.charset.StandardCharsets.UTF_8);
                if (listing.contains("libmp3lame")) found.add(Encoding.MP3);
                if (listing.contains("libopus")) found.add(Encoding.OGG_OPUS);
            }
            known = Set.copyOf(found);
        } catch (IOException | RuntimeException unavailable) {
            known = Set.of();
        } finally {
            if (work != null) deleteTree(work);
        }
        codecs = known;
        return known;
    }

    /** Converts the verified 24 kHz PCM16 WAV into {@code encoding}; a WAV request returns the input unchanged. */
    public Encoded encode(byte[] wav, Encoding encoding, Duration budget,
                          BoundedProcessRunner.CancellationToken cancellation) throws LocalTtsException {
        Objects.requireNonNull(wav, "wav");
        Objects.requireNonNull(encoding, "encoding");
        if (!encoding.transcoded()) return new Encoded(wav, encoding, 0);
        if (!verifyCodecs().contains(encoding)) {
            throw new LocalTtsException(LocalTtsException.Code.ENCODING_NOT_SUPPORTED,
                    encoding + " is not supported by the configured FFmpeg build");
        }
        if (budget.isNegative() || budget.isZero()) {
            throw new LocalTtsException(LocalTtsException.Code.TIMEOUT, "no time budget remains");
        }
        Duration timeout = budget.compareTo(maxTimeout) < 0 ? budget : maxTimeout;
        long started = System.nanoTime();
        Path work = null;
        try {
            work = Files.createTempDirectory("media-ffmpeg-enc-");
            Path in = work.resolve("in.wav");
            Path out = work.resolve("out." + encoding.extension());
            Files.write(in, wav);
            List<String> command = switch (encoding) {
                case MP3 -> List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", in.toString(), "-vn", "-map_metadata", "-1", "-ac", "1", "-c:a", "libmp3lame",
                        "-b:a", "96k", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "mp3", out.toString());
                case OGG_OPUS -> List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", in.toString(), "-vn", "-map_metadata", "-1", "-ac", "1", "-c:a", "libopus",
                        "-b:a", "48k", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "ogg", out.toString());
                default -> throw new IllegalStateException("not a transcoded encoding");
            };
            finish(BoundedProcessRunner.run(command, work, environment(work), timeout, 16 * 1024, 64 * 1024,
                    cancellation, out, MAX_ENCODED_BYTES), "FFmpeg encoding", false);
            if (!Files.isRegularFile(out, LinkOption.NOFOLLOW_LINKS) || Files.size(out) < 1
                    || Files.size(out) > MAX_ENCODED_BYTES) {
                throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID, "no bounded encoded output");
            }
            byte[] bytes = Files.readAllBytes(out);
            requireSignature(bytes, encoding);
            // Independent readback: the produced file must decode end to end.
            Duration remaining = timeout.minus(Duration.ofNanos(System.nanoTime() - started));
            if (remaining.isNegative() || remaining.isZero()) remaining = Duration.ofSeconds(5);
            finish(BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error",
                    "-i", out.toString(), "-f", "null", "-"), work, environment(work), remaining, 16 * 1024,
                    64 * 1024, cancellation, null, 0), "FFmpeg decode verification", true);
            return new Encoded(bytes, encoding, Duration.ofNanos(System.nanoTime() - started).toMillis());
        } catch (IOException failure) {
            throw new LocalTtsException(LocalTtsException.Code.RUNTIME_UNAVAILABLE,
                    "FFmpeg could not be started or staged");
        } finally {
            if (work != null) deleteTree(work);
        }
    }

    private static void finish(BoundedProcessRunner.Result result, String what, boolean strictStderr)
            throws LocalTtsException {
        switch (result.end()) {
            case TIMED_OUT -> throw new LocalTtsException(LocalTtsException.Code.TIMEOUT,
                    what + " exceeded its time budget");
            case CANCELLED -> throw new LocalTtsException(LocalTtsException.Code.CANCELLED, what + " was cancelled");
            case STDOUT_OVERFLOW, WATCHED_FILE_TOO_LARGE -> throw new LocalTtsException(
                    LocalTtsException.Code.OUTPUT_TOO_LARGE, what + " output exceeded its ceiling");
            case EXITED -> { }
        }
        if (result.exitCode() != 0) {
            throw new LocalTtsException(LocalTtsException.Code.PROCESS_FAILED,
                    what + " exited with code " + result.exitCode());
        }
        if (strictStderr && result.stderrBytes() > 0) {
            throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID, what + " reported a stream error");
        }
    }

    private static void requireSignature(byte[] bytes, Encoding encoding) throws LocalTtsException {
        boolean valid = switch (encoding) {
            case MP3 -> bytes.length > 4 && ((bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3')
                    || ((bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xE0) == 0xE0));
            case OGG_OPUS -> bytes.length > 4 && bytes[0] == 'O' && bytes[1] == 'g' && bytes[2] == 'g'
                    && bytes[3] == 'S';
            default -> true;
        };
        if (!valid) {
            throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID,
                    "encoded output does not carry the " + encoding + " container signature");
        }
    }

    private static Map<String, String> environment(Path work) {
        return Map.of("PATH", "/usr/bin:/bin", "HOME", work.toString(), "LC_ALL", "C.UTF-8");
    }

    private static void deleteTree(Path root) {
        try (DirectoryStream<Path> children = Files.newDirectoryStream(root)) {
            for (Path child : children) Files.deleteIfExists(child);
            Files.deleteIfExists(root);
        } catch (IOException ignored) {
            // temporary staging only
        }
    }
}
