package com.ghatana.media.integration;

import org.testcontainers.containers.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Shared helpers for the J-04 (authorized voice synthesis) real-process journeys: the real Kokoro environment,
 * independent FFmpeg/FFprobe decoding of the registered bytes and artifact-count readback from PostgreSQL. Nothing
 * here stubs a provider, rights decision or store.
 */
final class MediaDevVoiceJourneySupport {
    static final String SENTENCE = "The quick brown fox jumps over the lazy dog.";

    private MediaDevVoiceJourneySupport() { }

    static Path modelRoot() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        return configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
    }

    /** Real Kokoro environment (python venv + sidecar script) over the given model root. */
    static Map<String, String> kokoroEnvironment(Path modelRoot) {
        Path script = Path.of(System.getProperty("user.dir")).toAbsolutePath().resolve("tools/model-runtimes/kokoro_synth.py");
        Path search = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(script) && search.getParent() != null) {
            search = search.getParent();
            script = search.resolve("tools/model-runtimes/kokoro_synth.py");
        }
        return Map.of("MEDIA_LOCAL_MODEL_ROOT", modelRoot.toString(),
                "MEDIA_KOKORO_PYTHON", modelRoot().resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString());
    }

    static String ffmpeg() { return tool("MEDIA_DEV_RENDER_FFMPEG", "GHATANA_MEDIA_FFMPEG", "MEDIA_FFMPEG"); }

    static String ffprobe() { return tool("MEDIA_DEV_RENDER_FFPROBE", "GHATANA_MEDIA_FFPROBE", "MEDIA_FFPROBE"); }

    private static String tool(String... names) {
        for (String name : names) {
            String value = System.getenv(name);
            if (value != null && !value.isBlank()) return value;
        }
        return null;
    }

    /** ffprobe's own reading of the bytes: streams and container, as JSON. */
    static JsonNode probe(byte[] bytes, String extension) throws Exception {
        Path file = Files.createTempFile("media-voice-probe-", "." + extension);
        try {
            Files.write(file, bytes);
            Process process = new ProcessBuilder(ffprobe(), "-v", "error", "-show_streams", "-show_format",
                    "-of", "json", file.toString()).redirectErrorStream(false).start();
            byte[] out = process.getInputStream().readAllBytes();
            byte[] err = process.getErrorStream().readAllBytes();
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("ffprobe stderr: " + new String(err, StandardCharsets.UTF_8)).isZero();
            return JSON.readTree(new String(out, StandardCharsets.UTF_8));
        } finally {
            Files.deleteIfExists(file);
        }
    }

    static JsonNode stream(JsonNode probe, String codecType) {
        for (JsonNode stream : probe.path("streams")) {
            if (codecType.equals(stream.path("codec_type").asString())) return stream;
        }
        return null;
    }

    /** Decoded signed 16-bit mono PCM from the audio stream (FFmpeg decode, not the producer's own bookkeeping). */
    record Decoded(int samples, double rms, int peak) { }

    static Decoded decode(byte[] bytes, String extension) throws Exception {
        Path file = Files.createTempFile("media-voice-decode-", "." + extension);
        try {
            Files.write(file, bytes);
            Process process = new ProcessBuilder(ffmpeg(), "-v", "error", "-i", file.toString(), "-vn", "-ac", "1",
                    "-ar", "24000", "-f", "s16le", "-").redirectErrorStream(false).start();
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            process.getInputStream().transferTo(pcm);
            byte[] err = process.getErrorStream().readAllBytes();
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("ffmpeg decode stderr: " + new String(err, StandardCharsets.UTF_8)).isZero();
            byte[] raw = pcm.toByteArray();
            int samples = raw.length / 2;
            double sum = 0;
            int peak = 0;
            for (int i = 0; i < samples; i++) {
                int value = (short) ((raw[2 * i] & 0xff) | (raw[2 * i + 1] << 8));
                sum += (double) value * value;
                peak = Math.max(peak, Math.abs(value));
            }
            return new Decoded(samples, samples == 0 ? 0 : Math.sqrt(sum / samples), peak);
        } finally {
            Files.deleteIfExists(file);
        }
    }

    /** Count of durable artifact rows of one content type owned by the principal. */
    static int countArtifacts(PostgreSQLContainer<?> postgres, String tenant, String principal, String contentType)
            throws Exception {
        try (var connection = DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT count(*) FROM media_artifacts WHERE tenant_id=? AND principal_id=? AND content_type=?")) {
            statement.setString(1, tenant);
            statement.setString(2, principal);
            statement.setString(3, contentType);
            try (var row = statement.executeQuery()) {
                row.next();
                return row.getInt(1);
            }
        }
    }

    /** Child processes of the launcher whose command line names the Kokoro sidecar script. */
    static List<ProcessHandle> kokoroWorkers(Process launcher) {
        List<ProcessHandle> workers = new ArrayList<>();
        launcher.toHandle().descendants().forEach(handle -> {
            String command = handle.info().commandLine().orElse("");
            if (command.contains("kokoro_synth.py")) workers.add(handle);
        });
        return workers;
    }

    /** About 25 seconds of speech on this host: long enough to kill the worker or the launcher mid-synthesis. */
    static String longText() {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 14; i++) {
            text.append("Sentence number ").append(i + 1).append(" of the long synthesis request is spoken here. ");
        }
        return text.toString().trim();
    }

    /** Mono 16-bit tone WAV, used only as a clearly synthetic stand-in reference artifact. */
    static byte[] toneWav(int sampleRate, int seconds) {
        int samples = sampleRate * seconds;
        java.nio.ByteBuffer wav = java.nio.ByteBuffer.allocate(44 + samples * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples * 2);
        for (int i = 0; i < samples; i++) {
            wav.putShort((short) Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / (double) sampleRate)));
        }
        return wav.array();
    }

    static Map<String, Object> time(long ticks, String clock) {
        return Map.of("ticks", Long.toString(ticks), "rateNumerator", "24", "rateDenominator", "1", "clock", clock);
    }

    /** story ticks (24 per second) that fit inside the audio, matching the Explorer's adapter. */
    static long ticksFor(long durationMillis) {
        return Math.max(1, durationMillis * 24 / 1000);
    }
}
