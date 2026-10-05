/**
 * @doc.type class
 * @doc.purpose Test utilities for audio-video failure scenarios
 * @doc.layer platform
 * @doc.pattern Testing, Utility
 */
package com.ghatana.media.test;

import com.ghatana.media.common.*;
import com.ghatana.media.stt.api.*;
import com.ghatana.media.tts.api.*;
import com.ghatana.media.validation.ValidationFramework;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import io.activej.promise.Promise;

/**
 * Test utilities for comprehensive audio-video failure scenario testing.
 *
 * <p>Addresses AV-001: Provides test doubles and failure injectors for
 * comprehensive failure scenario testing including:
 * <ul>
 *   <li>Network failures and timeouts</li>
 *   <li>Resource exhaustion</li>
 *   <li>Partial failures and degradation</li>
 *   <li>Concurrent access scenarios</li>
 * </ul></p>
 *
 * @since 2026-03-27
 */
public final class AudioVideoTestUtils {

    private AudioVideoTestUtils() {} // Utility class 

    /**
     * Creates a failing STT engine for testing error handling.
     *
     * @param failureRate rate 0.0-1.0 of operations that should fail
     * @param exceptionType type of exception to throw
     */
    public static SttEngine createFailingSttEngine(double failureRate, 
                                                    Class<? extends Exception> exceptionType) {
        return new FailingSttEngine(failureRate, exceptionType); 
    }

    /**
     * Creates a slow STT engine for testing timeouts.
     *
     * @param delayMs delay per operation in milliseconds
     */
    public static SttEngine createSlowSttEngine(long delayMs) { 
        return new SlowSttEngine(delayMs); 
    }

    /**
     * Creates a resource-exhausting engine for testing resource limits.
     *
     * @param maxConcurrent max concurrent operations before failing
     */
    public static SttEngine createResourceExhaustedEngine(int maxConcurrent) { 
        return new ResourceExhaustedSttEngine(maxConcurrent); 
    }

    /**
     * Waits for async operation with timeout.
     *
     * @param future the future to wait for
     * @param timeout timeout duration
     * @param <T> return type
     * @return the result
     * @throws TimeoutException if operation times out
     */
    public static <T> T awaitWithTimeout(CompletableFuture<T> future, Duration timeout) 
            throws TimeoutException, ExecutionException, InterruptedException {
        return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS); 
    }

    /**
     * Simulates network latency.
     *
     * @param duration duration to sleep
     */
    public static void simulateLatency(Duration duration) { 
        try {
            Thread.sleep(duration.toMillis()); 
        } catch (InterruptedException e) { 
            Thread.currentThread().interrupt(); 
            throw new RuntimeException("Interrupted during latency simulation", e); 
        }
    }

    /**
     * STT Engine that fails at a specified rate.
     */
    private static class FailingSttEngine implements SttEngine {
        private final double failureRate;
        private final Class<? extends Exception> exceptionType;
        private final AtomicInteger callCount = new AtomicInteger(0); 
        private final AtomicBoolean closed = new AtomicBoolean(false); 

        FailingSttEngine(double failureRate, Class<? extends Exception> exceptionType) { 
            this.failureRate = failureRate;
            this.exceptionType = exceptionType;
        }

        @Override
        public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) { 
            ensureOpen(); 
            ValidationFramework.validateAudio(audio); 
            int call = callCount.incrementAndGet(); 
            if (shouldFail(call)) { 
                throw new RuntimeException("Simulated failure", createException()); 
            }
            return new TranscriptionResult( 
                "test", 0.9, List.of(), List.of(), Duration.ofMillis(100), "en", "test-model" 
            );
        }

        @Override
        public Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) { 
            return Promise.ofBlocking(java.util.concurrent.Executors.newSingleThreadExecutor(), 
                () -> transcribe(audio, options)); 
        }

        @Override
        public StreamingSession createStreamingSession() { 
            return createStreamingSession(null); 
        }

        @Override
        public StreamingSession createStreamingSession(UserProfile profile) { 
            ensureOpen(); 
            return new FailingStreamingSession(failureRate, exceptionType); 
        }

        @Override
        public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) { 
            return new UserProfile(profileId, "Test", Locale.ENGLISH, List.of(), new byte[0]); 
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
            return List.of(new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        }

        @Override
        public void loadModel(String modelId) {} 

        @Override
        public ModelInfo getActiveModel() { 
            return new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false); 
        }

        @Override
        public void warmup() {} 

        @Override
        public void close() { closed.set(true); } 

        @Override
        public EngineStatus getStatus() { 
            return new EngineStatus( 
                closed.get() ? EngineStatus.State.CLOSED : EngineStatus.State.READY, 
                "test", "1.0", 0, null
            );
        }

        @Override
        public EngineMetrics getMetrics() { 
            return new EngineMetrics(callCount.get(), (int)(callCount.get() * failureRate), 100, 0, 0); 
        }

        private void ensureOpen() { 
            if (closed.get()) throw new IllegalStateException("Engine closed");
        }

        private boolean shouldFail(int callNumber) { 
            return (callNumber % (int)(1.0 / failureRate)) == 0; 
        }

        private Exception createException() { 
            try {
                return exceptionType.getDeclaredConstructor(String.class).newInstance("Simulated");
            } catch (Exception e) { 
                return new RuntimeException("Simulated");
            }
        }
    }

    /**
     * Slow STT Engine for timeout testing.
     */
    private static class SlowSttEngine implements SttEngine {
        private final long delayMs;

        SlowSttEngine(long delayMs) { this.delayMs = delayMs; } 

        @Override
        public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) { 
            simulateLatency(Duration.ofMillis(delayMs)); 
            return new TranscriptionResult( 
                "slow result", 0.9, List.of(), List.of(), Duration.ofMillis(delayMs), "en", "test-model" 
            );
        }

        @Override
        public Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) { 
            return Promise.ofBlocking(java.util.concurrent.Executors.newSingleThreadExecutor(), 
                () -> transcribe(audio, options)); 
        }

        @Override
        public StreamingSession createStreamingSession() { return new DummyStreamingSession(); } 

        @Override
        public StreamingSession createStreamingSession(UserProfile profile) { return new DummyStreamingSession(); } 

        @Override
        public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) { 
            return new UserProfile(profileId, "Test", Locale.ENGLISH, List.of(), new byte[0]); 
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
            return List.of(new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        }

        @Override
        public void loadModel(String modelId) {} 

        @Override
        public ModelInfo getActiveModel() { 
            return new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false); 
        }

        @Override
        public void warmup() {} 

        @Override
        public void close() {} 

        @Override
        public EngineStatus getStatus() { 
            return new EngineStatus(EngineStatus.State.READY, "test", "1.0", 0, null); 
        }

        @Override
        public EngineMetrics getMetrics() { 
            return new EngineMetrics(0, 0, delayMs, 0, 0); 
        }
    }

    /**
     * Resource-exhausted engine for testing resource limits.
     */
    private static class ResourceExhaustedSttEngine implements SttEngine {
        private final Semaphore semaphore;

        ResourceExhaustedSttEngine(int maxConcurrent) { 
            this.semaphore = new Semaphore(maxConcurrent); 
        }

        @Override
        public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) { 
            if (!semaphore.tryAcquire()) { 
                throw new RuntimeException("Resource exhausted: max concurrent operations reached");
            }
            try {
                return new TranscriptionResult( 
                    "result", 0.9, List.of(), List.of(), Duration.ofMillis(100), "en", "test-model" 
                );
            } finally {
                semaphore.release(); 
            }
        }

        @Override
        public Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) { 
            return Promise.ofBlocking(java.util.concurrent.Executors.newSingleThreadExecutor(), 
                () -> transcribe(audio, options)); 
        }

        @Override
        public StreamingSession createStreamingSession() { return new DummyStreamingSession(); } 

        @Override
        public StreamingSession createStreamingSession(UserProfile profile) { return new DummyStreamingSession(); } 

        @Override
        public UserProfile createProfile(String profileId, List<AudioData> enrollmentAudio) { 
            return new UserProfile(profileId, "Test", Locale.ENGLISH, List.of(), new byte[0]); 
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
            return List.of(new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        }

        @Override
        public void loadModel(String modelId) {} 

        @Override
        public ModelInfo getActiveModel() { 
            return new ModelInfo("test", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false); 
        }

        @Override
        public void warmup() {} 

        @Override
        public void close() {} 

        @Override
        public EngineStatus getStatus() { 
            return new EngineStatus(EngineStatus.State.READY, "test", "1.0", 0, null); 
        }

        @Override
        public EngineMetrics getMetrics() { 
            return new EngineMetrics(0, 0, 100, semaphore.getQueueLength(), 0); 
        }
    }

    /**
     * Failing streaming session for testing.
     */
    private static class FailingStreamingSession implements StreamingSession {
        private final double failureRate;
        private final Class<? extends Exception> exceptionType;
        private final AtomicInteger chunkCount = new AtomicInteger(0); 

        FailingStreamingSession(double failureRate, Class<? extends Exception> exceptionType) { 
            this.failureRate = failureRate;
            this.exceptionType = exceptionType;
        }

        @Override
        public void feedAudio(AudioChunk chunk) { 
            int count = chunkCount.incrementAndGet(); 
            if ((count % (int)(1.0 / failureRate)) == 0) { 
                throw new RuntimeException("Simulated streaming failure");
            }
        }

        @Override
        public void onTranscription(Consumer<StreamingTranscription> callback) { 
            callback.accept(new StreamingTranscription("test", false, 0.9, List.of())); 
        }

        @Override
        public void onError(Consumer<ProcessingError> callback) { 
            callback.accept(new ProcessingError("Simulated error", ProcessingError.ErrorCategory.INTERNAL, true)); 
        }

        @Override
        public void endStream() {} 

        @Override
        public boolean isActive() { return true; } 

        @Override
        public void close() {} 
    }

    /**
     * Dummy streaming session.
     */
    private static class DummyStreamingSession implements StreamingSession {
        @Override
        public void feedAudio(AudioChunk chunk) {} 

        @Override
        public void onTranscription(Consumer<StreamingTranscription> callback) {} 

        @Override
        public void onError(Consumer<ProcessingError> callback) {} 

        @Override
        public void endStream() {} 

        @Override
        public boolean isActive() { return true; } 

        @Override
        public void close() {} 
    }
}
