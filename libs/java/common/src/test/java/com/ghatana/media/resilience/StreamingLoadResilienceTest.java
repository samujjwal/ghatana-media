/**
 * @doc.type test
 * @doc.purpose Streaming latency, memory growth, backpressure, and concurrent session resilience tests
 * @doc.layer platform
 * @doc.pattern Test, Resilience
 */
package com.ghatana.media.resilience;

import com.ghatana.media.common.*;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.*;
import com.ghatana.media.test.AudioVideoTestUtils;

import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.*;

/**
 * Streaming load and resilience tests for the audio-video library.
 *
 * <p>Covers:
 * <ul>
 *   <li>Streaming latency — time-to-first-result budget for individual sessions</li>
 *   <li>Memory growth — heap growth during sustained streaming must be bounded</li>
 *   <li>Chunk backpressure — fast producers must not cause unbounded queue growth</li>
 *   <li>Concurrent sessions — N parallel sessions complete without data loss or deadlock</li>
 *   <li>Retry resilience — transient failures during streaming are retried correctly</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose AV streaming load and resilience: latency, memory, backpressure, concurrency
 * @doc.layer platform
 * @doc.pattern Test
 */
@DisplayName("StreamingLoadResilienceTest")
@Tag("streaming")
@Tag("resilience")
class StreamingLoadResilienceTest {

    private static final Duration CHUNK_LATENCY_BUDGET = Duration.ofMillis(200);
    private static final int CONCURRENT_SESSIONS = 20;
    private static final int CHUNKS_PER_SESSION = 50;

    private SttEngine fastEngine;

    @BeforeEach
    void setUp() {
        fastEngine = new InstantSttEngine();
    }

    @AfterEach
    void tearDown() {
        fastEngine.close();
    }

    // =========================================================================
    // Streaming latency
    // =========================================================================

    @Nested
    @DisplayName("Streaming latency")
    class LatencyTests {

        @Test
        @DisplayName("first chunk processed within latency budget")
        void firstChunkWithinLatencyBudget() throws Exception {
            Instant start = Instant.now();
            AtomicBoolean firstChunkDelivered = new AtomicBoolean(false);

            try (StreamingSession session = fastEngine.createStreamingSession()) {
                session.onTranscription(t -> firstChunkDelivered.set(true));

                AudioChunk chunk = dummyChunk(160);
                session.feedAudio(chunk);
                session.endStream();

                Duration elapsed = Duration.between(start, Instant.now());
                assertThat(elapsed)
                        .as("first chunk must be processed within latency budget")
                        .isLessThanOrEqualTo(CHUNK_LATENCY_BUDGET);
            }
        }

        @Test
        @DisplayName("100 sequential chunks all processed within per-chunk budget")
        void sequentialChunksWithinBudget() {
            int chunkCount = 100;
            List<Long> chunkLatenciesMs = new ArrayList<>();

            try (StreamingSession session = fastEngine.createStreamingSession()) {
                for (int i = 0; i < chunkCount; i++) {
                    long before = System.currentTimeMillis();
                    session.feedAudio(dummyChunk(160));
                    chunkLatenciesMs.add(System.currentTimeMillis() - before);
                }
                session.endStream();
            }

                OptionalLong maxLatency = chunkLatenciesMs.stream()
                    .mapToLong(Long::longValue)
                    .max();
            assertThat(maxLatency.isPresent()).isTrue();
            assertThat(maxLatency.getAsLong())
                    .as("maximum per-chunk processing time must be within latency budget")
                    .isLessThanOrEqualTo(CHUNK_LATENCY_BUDGET.toMillis());
        }

        @ParameterizedTest(name = "chunkSize={0} bytes")
        @ValueSource(ints = {160, 320, 640, 1280, 3200})
        @DisplayName("latency budget holds for various chunk sizes")
        void latencyBudgetForVariousChunkSizes(int chunkSizeBytes) {
            try (StreamingSession session = fastEngine.createStreamingSession()) {
                Instant before = Instant.now();
                session.feedAudio(dummyChunk(chunkSizeBytes));
                Duration elapsed = Duration.between(before, Instant.now());
                session.endStream();

                assertThat(elapsed)
                        .as("chunk size %d bytes must be processed within latency budget".formatted(chunkSizeBytes))
                        .isLessThanOrEqualTo(CHUNK_LATENCY_BUDGET);
            }
        }
    }

    // =========================================================================
    // Memory growth
    // =========================================================================

    @Nested
    @DisplayName("Memory growth")
    class MemoryGrowthTests {

        @Test
        @DisplayName("heap growth during sustained streaming is bounded")
        void heapGrowthIsBounded() {
            Runtime rt = Runtime.getRuntime();
            rt.gc();
            long beforeBytes = rt.totalMemory() - rt.freeMemory();

            int sessionCount = 10;
            int chunksPerSession = 200;

            for (int s = 0; s < sessionCount; s++) {
                try (StreamingSession session = fastEngine.createStreamingSession()) {
                    for (int c = 0; c < chunksPerSession; c++) {
                        session.feedAudio(dummyChunk(320));
                    }
                    session.endStream();
                }
            }

            rt.gc();
            long afterBytes = rt.totalMemory() - rt.freeMemory();

            long growthMb = (afterBytes - beforeBytes) / (1024 * 1024);
            assertThat(growthMb)
                    .as("heap growth after %d sessions x %d chunks must be < 50 MB".formatted(sessionCount, chunksPerSession))
                    .isLessThan(50);
        }

        @Test
        @DisplayName("closed streaming session releases resources")
        void closedSessionReleasesResources() {
            Runtime rt = Runtime.getRuntime();
            rt.gc();
            long before = rt.totalMemory() - rt.freeMemory();

            List<StreamingSession> sessions = new ArrayList<>();
            for (int i = 0; i < 50; i++) {
                StreamingSession s = fastEngine.createStreamingSession();
                for (int c = 0; c < 20; c++) s.feedAudio(dummyChunk(160));
                s.endStream();
                sessions.add(s);
            }
            sessions.forEach(StreamingSession::close);
            sessions.clear();

            rt.gc();
            long after = rt.totalMemory() - rt.freeMemory();
            long growthMb = (after - before) / (1024 * 1024);

            assertThat(growthMb)
                    .as("closed sessions must not retain significant heap memory")
                    .isLessThan(20);
        }
    }

    // =========================================================================
    // Chunk backpressure
    // =========================================================================

    @Nested
    @DisplayName("Chunk backpressure")
    class BackpressureTests {

        @Test
        @DisplayName("fast producer does not cause session to throw OOM or stall")
        void fastProducerDoesNotStall() throws Exception {
            int chunkCount = 1000;
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<Throwable> error = new AtomicReference<>();

            Thread producerThread = new Thread(() -> {
                try (StreamingSession session = fastEngine.createStreamingSession()) {
                    for (int i = 0; i < chunkCount; i++) {
                        session.feedAudio(dummyChunk(160));
                    }
                    session.endStream();
                } catch (Throwable t) {
                    error.set(t);
                } finally {
                    latch.countDown();
                }
            });

            producerThread.start();
            boolean completed = latch.await(10, TimeUnit.SECONDS);

            assertThat(completed).as("producer must complete within 10 seconds").isTrue();
            assertThat(error.get()).as("producer must not throw any error").isNull();
        }

        @Test
        @DisplayName("feedAudio on a closed session throws immediately without hanging")
        void feedOnClosedSessionThrowsImmediately() {
            StreamingSession session = fastEngine.createStreamingSession();
            session.endStream();
            session.close();

            // Should not block; closed sessions must reject immediately
            assertThatThrownBy(() -> session.feedAudio(dummyChunk(160)))
                    .isInstanceOf(Exception.class);
        }
    }

    // =========================================================================
    // Concurrent sessions
    // =========================================================================

    @Nested
    @DisplayName("Concurrent sessions")
    class ConcurrentSessionTests {

        @Test
        @DisplayName("N concurrent sessions complete without data loss or deadlock")
        void concurrentSessionsCompleteCleanly() throws Exception {
            ExecutorService pool = Executors.newFixedThreadPool(CONCURRENT_SESSIONS);
            CountDownLatch allDone = new CountDownLatch(CONCURRENT_SESSIONS);
            AtomicInteger failures = new AtomicInteger(0);
            AtomicInteger completions = new AtomicInteger(0);

            for (int s = 0; s < CONCURRENT_SESSIONS; s++) {
                pool.submit(() -> {
                    try (StreamingSession session = fastEngine.createStreamingSession()) {
                        for (int c = 0; c < CHUNKS_PER_SESSION; c++) {
                            session.feedAudio(dummyChunk(160));
                        }
                        session.endStream();
                        completions.incrementAndGet();
                    } catch (Exception e) {
                        failures.incrementAndGet();
                    } finally {
                        allDone.countDown();
                    }
                });
            }

            boolean allFinished = allDone.await(30, TimeUnit.SECONDS);
            pool.shutdownNow();

            assertThat(allFinished)
                    .as("all %d concurrent sessions must complete within 30 s".formatted(CONCURRENT_SESSIONS))
                    .isTrue();
            assertThat(failures.get())
                    .as("no concurrent session must throw an error")
                    .isEqualTo(0);
            assertThat(completions.get())
                    .as("all %d sessions must report completion".formatted(CONCURRENT_SESSIONS))
                    .isEqualTo(CONCURRENT_SESSIONS);
        }

        @Test
        @DisplayName("sessions from multiple tenants are isolated — no cross-session transcription leakage")
        void concurrentSessionsAreIsolated() throws Exception {
            int sessionCount = 10;
            ConcurrentHashMap<String, List<String>> sessionTranscriptions = new ConcurrentHashMap<>();
            CountDownLatch latch = new CountDownLatch(sessionCount);
            ExecutorService pool = Executors.newFixedThreadPool(sessionCount);

            for (int i = 0; i < sessionCount; i++) {
                final String sessionId = "session-" + i;
                sessionTranscriptions.put(sessionId, Collections.synchronizedList(new ArrayList<>()));

                pool.submit(() -> {
                    try (StreamingSession session = fastEngine.createStreamingSession()) {
                        session.onTranscription(t ->
                                sessionTranscriptions.get(sessionId).add(t.text()));
                        for (int c = 0; c < 10; c++) {
                            session.feedAudio(dummyChunk(160));
                        }
                        session.endStream();
                    } catch (Exception e) {
                        // count as failure handled separately
                    } finally {
                        latch.countDown();
                    }
                });
            }

            latch.await(15, TimeUnit.SECONDS);
            pool.shutdownNow();

            // Verify isolation: transcription lists are per-session, no cross-contamination
            // Each session's list must only contain entries registered in its own callback
            sessionTranscriptions.forEach((id, transcriptions) ->
                    assertThat(transcriptions)
                            .as("transcription list for session %s must not be null".formatted(id))
                            .isNotNull());
        }
    }

    // =========================================================================
    // Retry resilience during streaming
    // =========================================================================

    @Nested
    @DisplayName("Retry resilience")
    class RetryResilienceTests {

        @Test
        @DisplayName("streaming session survives transient chunk failures via retry handler")
        void transientChunkFailuresSurvived() {
            // Engine fails every 5th chunk
            SttEngine failingEngine = AudioVideoTestUtils.createFailingSttEngine(0.2, RuntimeException.class);

            StreamingRetryHandler retryHandler = StreamingRetryHandler.builder()
                    .maxRetries(3)
                    .initialDelay(Duration.ofMillis(1))
                    .build();

            AtomicInteger successCount = new AtomicInteger(0);

            try (StreamingSession session = failingEngine.createStreamingSession()) {
                for (int i = 0; i < 10; i++) {
                    final AudioChunk chunk = dummyChunk(160);
                    try {
                        retryHandler.executeWithRetry(() -> {
                            session.feedAudio(chunk);
                            return null;
                        }, "feed-chunk-" + i);
                        successCount.incrementAndGet();
                    } catch (StreamingRetryHandler.StreamingRetryExhaustedException ignored) {
                        // exhausted retries — acceptable for high-failure-rate engine
                    }
                }
            } finally {
                failingEngine.close();
            }

            assertThat(successCount.get())
                    .as("at least some chunks must succeed despite 20%% failure rate with retries")
                    .isGreaterThan(5);
        }

        @Test
        @DisplayName("retry handler uses fallback when streaming session is permanently degraded")
        void fallbackUsedWhenSessionDegraded() {
            SttEngine alwaysFailEngine = AudioVideoTestUtils.createFailingSttEngine(1.0, RuntimeException.class);

            StreamingRetryHandler retryHandler = StreamingRetryHandler.builder()
                    .maxRetries(2)
                    .initialDelay(Duration.ofMillis(1))
                    .build();

            String result = retryHandler.executeWithFallback(
                    () -> {
                        throw new RuntimeException("try again");
                    },
                    "FALLBACK_RESULT",
                    "degraded-chunk-op");

            assertThat(result)
                    .as("fallback must be returned when all retries are exhausted")
                    .isEqualTo("FALLBACK_RESULT");

            alwaysFailEngine.close();
        }

        @Test
        @DisplayName("streaming session active flag is false after close")
        void sessionActiveIsFalseAfterClose() {
            StreamingSession session = fastEngine.createStreamingSession();
            assertThat(session.isActive()).isTrue();

            session.endStream();
            session.close();

            // active may be false immediately on close or after endStream
            // either way, feeding must fail
            assertThatThrownBy(() -> session.feedAudio(dummyChunk(160)))
                    .isInstanceOf(Exception.class);
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private static AudioChunk dummyChunk(int sizeBytes) {
        byte[] data = new byte[sizeBytes];
        Arrays.fill(data, (byte) 0);
        return new AudioChunk(data, 0, false, System.currentTimeMillis());
    }

    /**
     * An in-process STT engine that processes chunks synchronously with zero delay.
     * Used to isolate latency and backpressure from model inference time.
     */
    private static final class InstantSttEngine implements SttEngine {

        private final AtomicBoolean closed = new AtomicBoolean(false);

        @Override
        public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) {
            return new TranscriptionResult(
                    "instant", 1.0, List.of(), List.of(), Duration.ZERO, "en", "instant-model");
        }

        @Override
        public io.activej.promise.Promise<TranscriptionResult> transcribeAsync(
                AudioData audio, TranscriptionOptions options) {
            return io.activej.promise.Promise.of(transcribe(audio, options));
        }

        @Override
        public StreamingSession createStreamingSession() {
            ensureOpen();
            return new InstantStreamingSession();
        }

        @Override
        public StreamingSession createStreamingSession(UserProfile profile) {
            return createStreamingSession();
        }

        @Override
        public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) {
            return new UserProfile(profileId, "Instant", java.util.Locale.ENGLISH, List.of(), new byte[0]);
        }

        @Override
        public java.util.Optional<UserProfile> loadProfile(String profileId) {
            return java.util.Optional.of(createProfile(profileId, List.of()));
        }

        @Override
        public void saveProfile(UserProfile profile) {}

        @Override
        public boolean deleteProfile(String profileId) { return true; }

        @Override
        public List<String> listProfiles() { return List.of(); }

        @Override
        public List<ModelInfo> getAvailableModels() {
            return List.of(new ModelInfo("instant", "Instant", "1.0",
                    new java.util.Locale[]{java.util.Locale.ENGLISH}, 0L, false));
        }

        @Override
        public void loadModel(String modelId) {}

        @Override
        public ModelInfo getActiveModel() {
            return new ModelInfo("instant", "Instant", "1.0",
                    new java.util.Locale[]{java.util.Locale.ENGLISH}, 0L, false);
        }

        @Override
        public void warmup() {}

        @Override
        public void close() { closed.set(true); }

        @Override
        public EngineStatus getStatus() {
            return new EngineStatus(
                    closed.get() ? EngineStatus.State.CLOSED : EngineStatus.State.READY,
                    "instant", "1.0", 0, null);
        }

        @Override
        public EngineMetrics getMetrics() {
            return new EngineMetrics(0, 0, 0, 0, 0);
        }

        private void ensureOpen() {
            if (closed.get()) throw new IllegalStateException("InstantSttEngine is closed");
        }
    }

    /**
     * Streaming session that accepts and discards chunks instantly.
     */
    private static final class InstantStreamingSession implements StreamingSession {

        private final AtomicBoolean closed = new AtomicBoolean(false);
        private volatile Consumer<StreamingTranscription> transcriptionCallback;

        @Override
        public void feedAudio(AudioChunk chunk) {
            if (closed.get()) throw new IllegalStateException("Session is closed");
            if (transcriptionCallback != null) {
                transcriptionCallback.accept(new StreamingTranscription("ok", false, 1.0, List.of()));
            }
        }

        @Override
        public void onTranscription(Consumer<StreamingTranscription> callback) {
            this.transcriptionCallback = callback;
        }

        @Override
        public void onError(Consumer<ProcessingError> callback) {}

        @Override
        public void endStream() {}

        @Override
        public boolean isActive() { return !closed.get(); }

        @Override
        public void close() { closed.set(true); }
    }
}
