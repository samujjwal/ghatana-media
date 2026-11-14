package com.ghatana.stt.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Runs the locally built whisper.cpp {@code whisper-cli} (MIT) against a verified ggml weight file as one bounded
 * process: argument array only (never a shell), cleared environment, no stdin, wall-clock deadline, cooperative
 * cancellation, bounded stdout and a watched output-size ceiling. Audio is staged into a private temporary
 * directory that is always removed. Tool diagnostics are never surfaced.
 */
public final class LocalWhisperCppRunner {
    static final int MAX_INPUT_BYTES = 4 * 1024 * 1024;
    static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    public record Config(Path executable, Path modelFile, String modelSha256, int threads, Duration maxTimeout) {
        public Config {
            Objects.requireNonNull(executable, "executable");
            Objects.requireNonNull(modelFile, "modelFile");
            if (!modelSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("modelSha256");
            if (threads < 1 || threads > 64) throw new IllegalArgumentException("threads must be 1-64");
            if (maxTimeout.isNegative() || maxTimeout.isZero()) throw new IllegalArgumentException("maxTimeout");
        }
    }

    public record Segment(long startMillis, long endMillis, String text) { }

    public record Transcription(String text, List<Segment> segments, String language, String modelSha256,
                                long elapsedMillis) { }

    private final Config config;

    public LocalWhisperCppRunner(Config config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    /**
     * Builds a runner only when the executable exists, is executable, and matches the manifest's pinned
     * executable digest when the manifest declares one. Returns null when the runtime is not usable.
     */
    public static LocalWhisperCppRunner forVerified(LocalModelManifest manifest, Path modelFile, Path executable,
                                                    int threads, Duration maxTimeout) {
        if (executable == null || !executable.isAbsolute()
                || !Files.isRegularFile(executable, LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(executable)) {
            return null;
        }
        LocalModelManifest.RuntimeBinding binding = manifest.runtime();
        if (binding == null || !"whisper.cpp".equals(binding.name())) return null;
        try {
            if (!binding.executableSha256().isEmpty()
                    && !binding.executableSha256().equals(LocalModelManifest.sha256(executable))) {
                return null;
            }
        } catch (IOException unreadable) {
            return null;
        }
        return new LocalWhisperCppRunner(new Config(executable.toAbsolutePath().normalize(), modelFile,
                manifest.first(LocalModelManifest.FileRole.WEIGHTS).sha256(), threads, maxTimeout));
    }

    public Transcription transcribe(byte[] wav, String language, Duration budget,
                                    BoundedProcessRunner.CancellationToken cancellation) throws LocalSpeechException {
        Objects.requireNonNull(wav, "wav");
        if (wav.length < 44 || wav.length > MAX_INPUT_BYTES || !isRiffWave(wav)) {
            throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT,
                    "input must be a RIFF/WAVE file of at most " + MAX_INPUT_BYTES + " bytes");
        }
        if (language == null || !language.matches("[a-z]{2,3}")) {
            throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT,
                    "language must be an explicit 2-3 letter tag; auto-detection is not admitted");
        }
        if (budget.isNegative() || budget.isZero()) {
            throw new LocalSpeechException(LocalSpeechException.Code.TIMEOUT, "no time budget remains");
        }
        Duration timeout = budget.compareTo(config.maxTimeout()) < 0 ? budget : config.maxTimeout();
        Path work = null;
        long started = System.nanoTime();
        try {
            work = Files.createTempDirectory("media-whisper-");
            Path input = work.resolve("input.wav");
            Path outputBase = work.resolve("out");
            Path outputJson = work.resolve("out.json");
            Files.write(input, wav);
            List<String> command = List.of(config.executable().toString(),
                    "-m", config.modelFile().toString(), "-f", input.toString(),
                    "-l", language, "-t", Integer.toString(config.threads()),
                    "-np", "-oj", "-of", outputBase.toString());
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, work,
                    Map.of("PATH", "/usr/bin:/bin", "LC_ALL", "C.UTF-8",
                            "LD_LIBRARY_PATH", config.executable().getParent().toString()),
                    timeout, 64 * 1024, 64 * 1024, cancellation, outputJson, MAX_JSON_BYTES);
            switch (result.end()) {
                case TIMED_OUT -> throw new LocalSpeechException(LocalSpeechException.Code.TIMEOUT,
                        "whisper.cpp exceeded its time budget");
                case CANCELLED -> throw new LocalSpeechException(LocalSpeechException.Code.CANCELLED,
                        "whisper.cpp invocation was cancelled");
                case STDOUT_OVERFLOW, WATCHED_FILE_TOO_LARGE -> throw new LocalSpeechException(
                        LocalSpeechException.Code.OUTPUT_TOO_LARGE, "whisper.cpp output exceeded its ceiling");
                case EXITED -> { }
            }
            if (result.exitCode() != 0) {
                throw new LocalSpeechException(LocalSpeechException.Code.PROCESS_FAILED,
                        "whisper.cpp exited with code " + result.exitCode());
            }
            if (!Files.isRegularFile(outputJson, LinkOption.NOFOLLOW_LINKS) || Files.size(outputJson) > MAX_JSON_BYTES) {
                throw new LocalSpeechException(LocalSpeechException.Code.OUTPUT_INVALID, "no bounded JSON output");
            }
            return parse(Files.readAllBytes(outputJson), language,
                    Duration.ofNanos(System.nanoTime() - started).toMillis());
        } catch (IOException failure) {
            throw new LocalSpeechException(LocalSpeechException.Code.RUNTIME_UNAVAILABLE,
                    "whisper.cpp could not be started or staged");
        } finally {
            if (work != null) deleteTree(work);
        }
    }

    Transcription parse(byte[] json, String language, long elapsedMillis) throws LocalSpeechException {
        try {
            JsonNode root = JSON.readTree(json);
            JsonNode items = root.get("transcription");
            if (items == null || !items.isArray()) {
                throw new LocalSpeechException(LocalSpeechException.Code.OUTPUT_INVALID, "no transcription array");
            }
            List<Segment> segments = new ArrayList<>();
            StringBuilder text = new StringBuilder();
            long previousEnd = 0;
            for (JsonNode item : items) {
                long from = item.path("offsets").path("from").asLong(-1);
                long to = item.path("offsets").path("to").asLong(-1);
                String part = item.path("text").asString("");
                if (from < 0 || to < from || from < previousEnd - 1) {
                    throw new LocalSpeechException(LocalSpeechException.Code.OUTPUT_INVALID, "invalid segment offsets");
                }
                previousEnd = to;
                String trimmed = part.strip();
                if (trimmed.isEmpty()) continue;
                segments.add(new Segment(from, to, trimmed));
                if (text.length() > 0) text.append(' ');
                text.append(trimmed);
                if (text.length() > 128 * 1024) {
                    throw new LocalSpeechException(LocalSpeechException.Code.OUTPUT_TOO_LARGE, "transcript too long");
                }
            }
            return new Transcription(text.toString(), List.copyOf(segments), language, config.modelSha256(),
                    elapsedMillis);
        } catch (LocalSpeechException typed) {
            throw typed;
        } catch (RuntimeException malformed) {
            throw new LocalSpeechException(LocalSpeechException.Code.OUTPUT_INVALID, "output JSON is malformed");
        }
    }

    static boolean isRiffWave(byte[] bytes) {
        return bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'A' && bytes[10] == 'V' && bytes[11] == 'E';
    }

    private static void deleteTree(Path root) {
        try (DirectoryStream<Path> children = Files.newDirectoryStream(root)) {
            for (Path child : children) Files.deleteIfExists(child);
            Files.deleteIfExists(root);
        } catch (IOException ignored) {
            // temporary staging only; the OS temp cleaner owns any leftover
        }
    }
}
