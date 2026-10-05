package com.ghatana.media.tts.api;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioChunk;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.EngineMetrics;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.common.InferenceError;
import com.ghatana.media.common.ValidationError;
import com.ghatana.media.config.TtsConfig;
import io.activej.promise.Promise;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Factory for creating governed TTS engine instances.
 *
 * <p>Real ONNX model loading is the canonical path. Synthetic fallback is available only when the
 * caller explicitly sets {@link TtsConfig#allowSyntheticFallback()}; it is degraded test/local
 * behavior and never implements voice cloning or profile persistence. Every returned provider is
 * wrapped by {@link GovernedTtsEngine} for output bounds, voice identity, controlled streaming,
 * and truthful capability enforcement.
 *
 * @doc.type factory
 * @doc.purpose Fail-closed factory for production TTS and explicit local synthetic fallback
 * @doc.layer platform
 * @doc.pattern Factory
 */
public final class TtsEngineFactory {

    private static final Logger LOG = Logger.getLogger(TtsEngineFactory.class.getName());

    private TtsEngineFactory() {}

    public static TtsEngine create(
            TtsConfig config,
            AudioVideoLibrary.LibraryState libraryState) {
        Objects.requireNonNull(config, "config");
        Objects.requireNonNull(libraryState, "libraryState");
        LOG.info("Creating TTS Engine with voice: " + config.defaultVoiceId());

        Path modelPath = resolveVoiceModelPath(config);
        Exception modelFailure = null;
        if (modelPath != null) {
            TtsConfig resolvedConfig = copyWithResolvedModel(config, modelPath);
            try {
                TtsEngine engine = new com.ghatana.media.tts.engine.onnx.PiperOnnxEngine(
                        resolvedConfig,
                        libraryState);
                LOG.info("Successfully loaded ONNX TTS engine from: " + modelPath);
                return new GovernedTtsEngine(engine, resolvedConfig, true);
            } catch (Exception exception) {
                modelFailure = exception;
                LOG.log(Level.WARNING, "Failed to load ONNX TTS engine from " + modelPath, exception);
            }
        }

        if (!config.allowSyntheticFallback()) {
            String message = modelPath == null
                    ? "No TTS voice model was found and synthetic fallback is disabled"
                    : "The configured TTS voice model failed to load and synthetic fallback is disabled";
            throw modelFailure == null
                    ? new IllegalStateException(message)
                    : new IllegalStateException(message, modelFailure);
        }

        libraryState.markUnhealthy("Synthetic TTS fallback active");
        LOG.warning(
                "Using explicitly enabled synthetic TTS fallback. This engine is degraded and must "
                        + "not be used as production synthesis evidence.");
        return new GovernedTtsEngine(new SyntheticTtsEngine(config), config, false);
    }

    private static TtsConfig copyWithResolvedModel(TtsConfig config, Path modelPath) {
        return TtsConfig.builder()
                .voiceModelPath(modelPath)
                .defaultVoiceId(config.defaultVoiceId())
                .availableVoices(config.availableVoices())
                .maxConcurrentRequests(config.maxConcurrentRequests())
                .timeout(config.timeout())
                .useGpu(config.useGpu())
                .sampleRate(config.sampleRate())
                .maxTextLength(config.maxTextLength())
                .enableProsody(config.enableProsody())
                .enableVoiceCloning(config.enableVoiceCloning())
                .enableStreaming(config.enableStreaming())
                .profileStoragePath(config.profileStoragePath())
                .clonedVoicesPath(config.clonedVoicesPath())
                .cloudFallback(config.cloudFallback().orElse(null))
                .allowSyntheticFallback(config.allowSyntheticFallback())
                .maxMemoryBytes(config.maxMemoryBytes())
                .build();
    }

    private static Path resolveVoiceModelPath(TtsConfig config) {
        if (isReadableRegularFile(config.voiceModelPath())) {
            return config.voiceModelPath().toAbsolutePath().normalize();
        }

        String envPath = System.getenv("TTS_MODEL_PATH");
        if (envPath != null && !envPath.isBlank()) {
            Path candidate = Paths.get(envPath.trim());
            if (isReadableRegularFile(candidate)) {
                return candidate.toAbsolutePath().normalize();
            }
        }

        String voiceId = config.defaultVoiceId();
        for (String pathValue : List.of(
                "/models/piper-" + voiceId + ".onnx",
                "/models/piper-en_US-lessac-medium.onnx",
                "/usr/local/share/piper/voices/" + voiceId + ".onnx",
                "models/piper-" + voiceId + ".onnx")) {
            Path candidate = Paths.get(pathValue);
            if (isReadableRegularFile(candidate)) {
                return candidate.toAbsolutePath().normalize();
            }
        }

        String userHome = System.getProperty("user.home");
        if (userHome != null && !userHome.isBlank()) {
            Path candidate = Paths.get(
                    userHome,
                    ".cache",
                    "ghatana",
                    "voices",
                    voiceId + ".onnx");
            if (isReadableRegularFile(candidate)) {
                return candidate.toAbsolutePath().normalize();
            }
        }
        return null;
    }

    private static boolean isReadableRegularFile(Path path) {
        return path != null && Files.isRegularFile(path) && Files.isReadable(path);
    }

    /** Explicit local/test-only engine that returns silence with deterministic duration. */
    private static final class SyntheticTtsEngine implements TtsEngine {
        private final TtsConfig config;
        private final AtomicLong requestCount = new AtomicLong();
        private final Semaphore concurrencyLimiter;
        private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
        private final AtomicReference<EngineStatus.State> state =
                new AtomicReference<>(EngineStatus.State.DEGRADED);
        private final AtomicReference<String> activeVoiceId;
        private final Set<String> availableVoiceIds;
        private final long startedAt = System.currentTimeMillis();

        private SyntheticTtsEngine(TtsConfig config) {
            this.config = config;
            this.concurrencyLimiter = new Semaphore(config.maxConcurrentRequests());
            List<String> configuredVoices = config.availableVoices().isEmpty()
                    ? List.of(config.defaultVoiceId())
                    : config.availableVoices();
            this.availableVoiceIds = Set.copyOf(configuredVoices);
            if (!availableVoiceIds.contains(config.defaultVoiceId())) {
                throw new IllegalArgumentException(
                        "defaultVoiceId must be present in availableVoices for synthetic fallback");
            }
            this.activeVoiceId = new AtomicReference<>(config.defaultVoiceId());
        }

        @Override
        public AudioData synthesize(String text, SynthesisOptions options) {
            ensureOpen();
            validateText(text);
            Objects.requireNonNull(options, "options");
            requestCount.incrementAndGet();
            try {
                concurrencyLimiter.acquire();
                try {
                    int samples = Math.max(1, (int) Math.ceil(text.length() * config.sampleRate() * 0.1));
                    return AudioData.builder()
                            .data(new byte[Math.multiplyExact(samples, 2)])
                            .sampleRate(config.sampleRate())
                            .channels(1)
                            .bitsPerSample(16)
                            .build();
                } finally {
                    concurrencyLimiter.release();
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new InferenceError("Synthetic synthesis interrupted", exception, true);
            }
        }

        @Override
        public Promise<AudioData> synthesizeAsync(String text, SynthesisOptions options) {
            ensureOpen();
            return Promise.ofBlocking(executor, () -> synthesize(text, options));
        }

        @Override
        public void synthesizeStreaming(
                String text,
                SynthesisOptions options,
                Consumer<AudioChunk> chunkConsumer) {
            Objects.requireNonNull(chunkConsumer, "chunkConsumer");
            if (!config.enableStreaming()) {
                throw new UnsupportedOperationException("Streaming synthesis is disabled");
            }
            AudioData audio = synthesize(text, options);
            int bytesPerChunk = Math.max(2, config.sampleRate() / 10 * 2);
            byte[] data = audio.data();
            int sequence = 0;
            for (int offset = 0; offset < data.length; offset += bytesPerChunk) {
                int end = Math.min(offset + bytesPerChunk, data.length);
                chunkConsumer.accept(new AudioChunk(
                        Arrays.copyOfRange(data, offset, end),
                        sequence++,
                        end == data.length,
                        System.currentTimeMillis()));
            }
        }

        @Override
        public List<VoiceInfo> getAvailableVoices() {
            return availableVoiceIds.stream()
                    .sorted()
                    .map(this::voiceInfo)
                    .toList();
        }

        @Override
        public List<VoiceInfo> getAvailableVoices(Locale language) {
            Objects.requireNonNull(language, "language");
            return getAvailableVoices().stream()
                    .filter(voice -> voice.language().getLanguage().equals(language.getLanguage()))
                    .toList();
        }

        @Override
        public VoiceInfo loadVoice(String voiceId) {
            String normalized = requireVoice(voiceId);
            activeVoiceId.set(normalized);
            return voiceInfo(normalized);
        }

        @Override
        public VoiceInfo getActiveVoice() {
            return voiceInfo(activeVoiceId.get());
        }

        @Override
        public void setActiveVoice(String voiceId) {
            activeVoiceId.set(requireVoice(voiceId));
        }

        @Override
        public VoiceInfo cloneVoice(
                String voiceName,
                List<AudioData> audioSamples,
                CloneOptions options) {
            throw new UnsupportedOperationException(
                    "Synthetic TTS fallback does not support voice cloning");
        }

        @Override
        public TtsProfile createProfile(
                String profileId,
                String displayName,
                ProfileSettings settings) {
            throw profileUnsupported();
        }

        @Override
        public Optional<TtsProfile> loadProfile(String profileId) {
            throw profileUnsupported();
        }

        @Override
        public void saveProfile(TtsProfile profile) {
            throw profileUnsupported();
        }

        @Override
        public boolean deleteProfile(String profileId) {
            throw profileUnsupported();
        }

        @Override
        public void warmup() {
            ensureOpen();
        }

        @Override
        public void close() {
            if (state.getAndSet(EngineStatus.State.CLOSED) != EngineStatus.State.CLOSED) {
                executor.shutdown();
            }
        }

        @Override
        public EngineStatus getStatus() {
            return new EngineStatus(
                    state.get(),
                    "synthetic:" + activeVoiceId.get(),
                    "synthetic-local-v1",
                    System.currentTimeMillis() - startedAt,
                    state.get() == EngineStatus.State.CLOSED
                            ? "Engine closed"
                            : "Synthetic fallback active");
        }

        @Override
        public EngineMetrics getMetrics() {
            return new EngineMetrics(
                    requestCount.get(),
                    0L,
                    0.0,
                    config.maxConcurrentRequests() - concurrencyLimiter.availablePermits(),
                    0L);
        }

        private VoiceInfo voiceInfo(String voiceId) {
            return new VoiceInfo(
                    voiceId,
                    voiceId,
                    "Synthetic local/test voice",
                    Locale.ENGLISH,
                    VoiceInfo.Gender.NEUTRAL,
                    config.sampleRate(),
                    false,
                    0L,
                    0.0f);
        }

        private String requireVoice(String voiceId) {
            if (voiceId == null || voiceId.isBlank() || !availableVoiceIds.contains(voiceId)) {
                throw new IllegalArgumentException("Unknown synthetic voice: " + voiceId);
            }
            return voiceId;
        }

        private void ensureOpen() {
            if (state.get() == EngineStatus.State.CLOSED) {
                throw new IllegalStateException("TTS Engine is closed");
            }
        }

        private void validateText(String text) {
            if (text == null || text.isBlank()) {
                throw new ValidationError("Text cannot be null or blank");
            }
            if (text.length() > config.maxTextLength()) {
                throw new ValidationError(
                        "Text too long: " + text.length() + " > " + config.maxTextLength());
            }
        }

        private static UnsupportedOperationException profileUnsupported() {
            return new UnsupportedOperationException(
                    "Synthetic TTS fallback does not provide profile persistence");
        }
    }
}
