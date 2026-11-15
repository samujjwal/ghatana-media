package com.ghatana.media.integration;

import tools.jackson.databind.JsonNode;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.CRC32;

import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static org.assertj.core.api.Assertions.assertThat;

/** J-29 helpers: real FFmpeg-generated PCM, the binary frame codec and a resume-aware streaming client. */
final class MediaDevLiveSessionSupport {
    static final int SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz
    static final int FRAME_BYTES = SAMPLES_PER_FRAME * 2;

    private MediaDevLiveSessionSupport() { }

    /** Signed 16-bit mono 48 kHz PCM of a sine mixed with seeded pink noise, produced by the real FFmpeg. */
    static byte[] generatePcm(int seed, int frames) throws Exception {
        double seconds = frames * SAMPLES_PER_FRAME / 48_000.0;
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error",
                "-f", "lavfi", "-i", "sine=frequency=" + (200 + 7 * seed) + ":sample_rate=48000:duration=" + (seconds + 0.5),
                "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:seed=" + (1000 + seed) + ":amplitude=0.25:duration=" + (seconds + 0.5),
                "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0,aformat=sample_fmts=s16:channel_layouts=mono",
                "-f", "s16le", "-ac", "1", "-ar", "48000", "-").redirectErrorStream(false).start();
        byte[] all = process.getInputStream().readAllBytes();
        byte[] err = process.getErrorStream().readAllBytes();
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as("ffmpeg: " + new String(err, StandardCharsets.UTF_8)).isZero();
        assertThat(all.length).as("generated PCM covers the requested frames").isGreaterThanOrEqualTo(frames * FRAME_BYTES);
        return java.util.Arrays.copyOf(all, frames * FRAME_BYTES);
    }

    static byte[] record(long sequence, long pts, byte[] payload) {
        CRC32 crc = new CRC32();
        crc.update(payload);
        return ByteBuffer.allocate(24 + payload.length).order(ByteOrder.BIG_ENDIAN).putLong(sequence).putLong(pts)
                .putInt(payload.length).putInt((int) crc.getValue()).put(payload).array();
    }

    /** What FFmpeg decodes from the stored WAV bytes, as raw s16le mono 48 kHz. */
    static byte[] decodeWav(byte[] wav, Path work, String name) throws Exception {
        Path file = work.resolve(name + ".wav");
        Files.write(file, wav);
        Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-i", file.toString(), "-f", "s16le", "-acodec",
                "pcm_s16le", "-ac", "1", "-ar", "48000", "-").redirectErrorStream(false).start();
        byte[] out = process.getInputStream().readAllBytes();
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).isZero();
        Files.deleteIfExists(file);
        return out;
    }

    /** A streaming client that survives drops: it always resumes from the server's acknowledged prefix. */
    static final class Client {
        final int port;
        final String tenant;
        final String token;
        final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
        String sessionId;
        final List<Long> batchNanos = new ArrayList<>();
        final AtomicInteger backpressure = new AtomicInteger();
        final AtomicInteger networkErrors = new AtomicInteger();
        final AtomicInteger batches = new AtomicInteger();

        Client(int port, String tenant, String token) {
            this.port = port;
            this.tenant = tenant;
            this.token = token;
        }

        HttpResponse<String> call(String method, String path, byte[] body, String contentType) throws IOException, InterruptedException {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                    .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant);
            if (body != null) request.header("Content-Type", contentType);
            request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
            return http.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }

        JsonNode open(String requestId, String consentArtifactId, String consentVersion, String scope, int window, int leaseSeconds,
                      long startPts) throws Exception {
            String body = JSON.writeValueAsString(Map.of("requestId", requestId,
                    "consent", Map.of("artifactId", consentArtifactId, "artifactVersionId", consentVersion, "scope", scope),
                    "format", Map.of("sampleRate", 48_000, "channels", 1, "samplesPerFrame", SAMPLES_PER_FRAME),
                    "startPtsSamples", startPts, "reorderWindowFrames", window, "leaseSeconds", leaseSeconds));
            HttpResponse<String> response = call("POST", "/dev/v1/live-sessions", body.getBytes(StandardCharsets.UTF_8), "application/json");
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            JsonNode view = JSON.readTree(response.body());
            sessionId = view.path("sessionId").asString();
            return view;
        }

        JsonNode state() throws Exception {
            HttpResponse<String> response = call("GET", "/dev/v1/live-sessions/" + sessionId, null, null);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
            return JSON.readTree(response.body());
        }

        /** Frames [from, to) of the stream as one request body, pairs swapped by a seeded shuffle of small blocks. */
        byte[] body(byte[] pcm, long startPts, int from, int to, long seed) {
            List<Integer> order = new ArrayList<>();
            for (int i = from; i < to; i++) order.add(i);
            Random random = new Random(seed);
            for (int base = 0; base + 4 <= order.size(); base += 4) {
                if (random.nextInt(10) < 4) Collections.shuffle(order.subList(base, base + 4), random);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            for (int seq : order) {
                out.writeBytes(record(seq, startPts + (long) seq * SAMPLES_PER_FRAME,
                        java.util.Arrays.copyOfRange(pcm, seq * FRAME_BYTES, (seq + 1) * FRAME_BYTES)));
            }
            return out.toByteArray();
        }

        HttpResponse<String> post(byte[] body) throws Exception {
            long started = System.nanoTime();
            HttpResponse<String> response = call("POST", "/dev/v1/live-sessions/" + sessionId + "/frames", body, "application/octet-stream");
            synchronized (batchNanos) { batchNanos.add(System.nanoTime() - started); }
            batches.incrementAndGet();
            return response;
        }

        /**
         * Streams every frame, resuming from the acknowledged prefix after any drop or retryable refusal. A terminal
         * refusal (410) or an unknown session (404) is returned to the caller, never retried.
         */
        HttpResponse<String> stream(byte[] pcm, long startPts, int batch, long paceMillis, long seed, Duration budget) throws Exception {
            int total = pcm.length / FRAME_BYTES;
            long deadline = System.nanoTime() + budget.toNanos();
            int acked = (int) state().path("ackedThroughSequence").asLong();
            while (acked < total - 1) {
                if (System.nanoTime() > deadline) throw new AssertionError("streaming budget exhausted at ack " + acked);
                int from = acked + 1;
                int to = Math.min(total, from + batch);
                long tick = System.nanoTime();
                try {
                    HttpResponse<String> response = post(body(pcm, startPts, from, to, seed + from));
                    if (response.statusCode() == 200) {
                        acked = (int) JSON.readTree(response.body()).path("session").path("ackedThroughSequence").asLong();
                    } else if (response.statusCode() == 429 || response.statusCode() == 503) {
                        backpressure.incrementAndGet();
                        Thread.sleep(100);
                        acked = (int) state().path("ackedThroughSequence").asLong();
                    } else {
                        return response; // typed terminal outcome: 404 / 410 / 4xx
                    }
                } catch (IOException dropped) {
                    networkErrors.incrementAndGet();
                    Thread.sleep(250);
                    try { acked = (int) state().path("ackedThroughSequence").asLong(); }
                    catch (IOException stillDown) { /* retried by the loop */ }
                }
                long wait = paceMillis - (System.nanoTime() - tick) / 1_000_000;
                if (paceMillis > 0 && wait > 0) Thread.sleep(wait);
            }
            return null;
        }

        HttpResponse<String> eos(int finalSequence) throws Exception {
            return call("POST", "/dev/v1/live-sessions/" + sessionId + "/eos",
                    ("{\"finalSequence\":" + finalSequence + "}").getBytes(StandardCharsets.UTF_8), "application/json");
        }
    }

    static double percentile(List<Long> nanos, double p) {
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        if (sorted.isEmpty()) return 0;
        return sorted.get(Math.min(sorted.size() - 1, (int) Math.ceil(p * sorted.size()) - 1)) / 1_000_000.0;
    }
}
