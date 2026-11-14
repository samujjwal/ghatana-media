package com.ghatana.tts.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * Runs Kokoro-82M (Apache-2.0, no voice cloning) through the repository's {@code kokoro_synth.py} sidecar as one
 * bounded process: argument array only (never a shell), cleared environment, offline hub access, no stdin, a
 * wall-clock deadline, cooperative cancellation and an output-size ceiling. Text is passed through a private
 * temporary file, never on the command line. Only voice packs listed in the verified manifest can be selected; no
 * voice embedding can be supplied by a caller.
 */
public final class LocalKokoroSynthesizer {
    public static final int MAX_TEXT_CHARS = 2_000;
    static final long MAX_WAV_BYTES = 8L * 1024 * 1024;
    private static final String SIDECAR_SHA_UNSET = "";

    public record Config(Path python, Path script, Path modelDir, Set<String> voices, String modelSha256,
                         Duration maxTimeout) {
        public Config {
            Objects.requireNonNull(python, "python");
            Objects.requireNonNull(script, "script");
            Objects.requireNonNull(modelDir, "modelDir");
            voices = Set.copyOf(voices);
            if (voices.isEmpty()) throw new IllegalArgumentException("no voices");
            if (!modelSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("modelSha256");
        }
    }

    public record Synthesis(byte[] wav, int sampleRate, long samples, String voice, String modelSha256,
                            long elapsedMillis) {
        @Override public byte[] wav() { return wav.clone(); }
        public long durationMillis() { return samples * 1000 / sampleRate; }
    }

    private final Config config;

    public LocalKokoroSynthesizer(Config config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    /**
     * Builds a synthesizer only when the interpreter and sidecar exist and, if the manifest pins a sidecar digest,
     * the script on disk matches it. Returns null when the runtime is unusable.
     */
    public static LocalKokoroSynthesizer forVerified(LocalModelManifest manifest, Path modelDir, Path python,
                                                     Path script, Duration maxTimeout) {
        if (python == null || script == null || !python.isAbsolute() || !script.isAbsolute()
                || !Files.isExecutable(python) || !Files.isRegularFile(script, LinkOption.NOFOLLOW_LINKS)) return null;
        LocalModelManifest.RuntimeBinding binding = manifest.runtime();
        if (binding == null || !"kokoro".equals(binding.name())) return null;
        try {
            if (!binding.executableSha256().isEmpty()
                    && !binding.executableSha256().equals(LocalModelManifest.sha256(script))) return null;
        } catch (IOException unreadable) {
            return null;
        }
        Set<String> voices = new TreeSet<>();
        for (LocalModelManifest.FileEntry entry : manifest.files()) {
            if (entry.role() == LocalModelManifest.FileRole.VOICE && entry.path().startsWith("voices/")
                    && entry.path().endsWith(".pt")) {
                voices.add(entry.path().substring("voices/".length(), entry.path().length() - 3));
            }
        }
        if (voices.isEmpty()) return null;
        return new LocalKokoroSynthesizer(new Config(python.toAbsolutePath().normalize(),
                script.toAbsolutePath().normalize(), modelDir.toAbsolutePath().normalize(), voices,
                manifest.first(LocalModelManifest.FileRole.WEIGHTS).sha256(), maxTimeout));
    }

    public Set<String> voices() { return config.voices(); }

    public Synthesis synthesize(String text, String voice, double speed, Duration budget,
                                BoundedProcessRunner.CancellationToken cancellation) throws LocalTtsException {
        if (text == null || text.isBlank() || text.length() > MAX_TEXT_CHARS) {
            throw new LocalTtsException(LocalTtsException.Code.INVALID_INPUT,
                    "text must be 1-" + MAX_TEXT_CHARS + " characters");
        }
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == 0 || (c < 0x20 && c != '\n' && c != '\t' && c != '\r')) {
                throw new LocalTtsException(LocalTtsException.Code.INVALID_INPUT, "text contains a control character");
            }
        }
        if (voice == null || !config.voices().contains(voice)) {
            throw new LocalTtsException(LocalTtsException.Code.VOICE_NOT_ADMITTED,
                    "voice is not part of the verified model installation");
        }
        if (!Double.isFinite(speed) || speed < 0.5 || speed > 2.0) {
            throw new LocalTtsException(LocalTtsException.Code.INVALID_INPUT, "speed must be within [0.5, 2.0]");
        }
        if (budget.isNegative() || budget.isZero()) {
            throw new LocalTtsException(LocalTtsException.Code.TIMEOUT, "no time budget remains");
        }
        Duration timeout = budget.compareTo(config.maxTimeout()) < 0 ? budget : config.maxTimeout();
        Path work = null;
        long started = System.nanoTime();
        try {
            work = Files.createTempDirectory("media-kokoro-");
            Path textFile = work.resolve("in.txt");
            Path out = work.resolve("out.wav");
            Files.writeString(textFile, text, StandardCharsets.UTF_8);
            List<String> command = List.of(config.python().toString(), "-I", config.script().toString(),
                    "--model-dir", config.modelDir().toString(), "--voice", voice,
                    "--speed", Double.toString(speed), "--lang", "a",
                    "--text-file", textFile.toString(), "--out", out.toString());
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, work,
                    Map.of("PATH", "/usr/bin:/bin", "HOME", work.toString(), "LC_ALL", "C.UTF-8",
                            "HF_HUB_OFFLINE", "1", "TRANSFORMERS_OFFLINE", "1", "XDG_CACHE_HOME", work.toString(),
                            "TORCH_HOME", work.toString(), "PYTHONDONTWRITEBYTECODE", "1",
                            "CUDA_VISIBLE_DEVICES", "", "OMP_NUM_THREADS", "4"),
                    timeout, 16 * 1024, 64 * 1024, cancellation, out, MAX_WAV_BYTES);
            switch (result.end()) {
                case TIMED_OUT -> throw new LocalTtsException(LocalTtsException.Code.TIMEOUT,
                        "Kokoro synthesis exceeded its time budget");
                case CANCELLED -> throw new LocalTtsException(LocalTtsException.Code.CANCELLED,
                        "Kokoro synthesis was cancelled");
                case STDOUT_OVERFLOW, WATCHED_FILE_TOO_LARGE -> throw new LocalTtsException(
                        LocalTtsException.Code.OUTPUT_TOO_LARGE, "Kokoro output exceeded its ceiling");
                case EXITED -> { }
            }
            if (result.exitCode() != 0) {
                throw new LocalTtsException(LocalTtsException.Code.PROCESS_FAILED,
                        "Kokoro sidecar exited with code " + result.exitCode());
            }
            if (!Files.isRegularFile(out, LinkOption.NOFOLLOW_LINKS) || Files.size(out) > MAX_WAV_BYTES) {
                throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID, "no bounded WAV output");
            }
            byte[] wav = Files.readAllBytes(out);
            long[] shape = validate(wav);
            return new Synthesis(wav, (int) shape[0], shape[1], voice, config.modelSha256(),
                    Duration.ofNanos(System.nanoTime() - started).toMillis());
        } catch (IOException failure) {
            throw new LocalTtsException(LocalTtsException.Code.RUNTIME_UNAVAILABLE,
                    "Kokoro sidecar could not be started or staged");
        } finally {
            if (work != null) deleteTree(work);
        }
    }

    /** Independent readback: must be a mono 24 kHz 16-bit PCM WAV with at least one sample. */
    static long[] validate(byte[] wav) throws LocalTtsException {
        try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            AudioFormat format = stream.getFormat();
            long frames = stream.getFrameLength();
            if (!AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding()) || format.getChannels() != 1
                    || format.getSampleSizeInBits() != 16 || format.isBigEndian()
                    || Math.round(format.getSampleRate()) != 24_000 || frames < 1) {
                throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID,
                        "synthesized audio is not mono 24 kHz PCM16");
            }
            return new long[]{24_000, frames};
        } catch (LocalTtsException typed) {
            throw typed;
        } catch (Exception invalid) {
            throw new LocalTtsException(LocalTtsException.Code.OUTPUT_INVALID, "synthesized audio is not a valid WAV");
        }
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
