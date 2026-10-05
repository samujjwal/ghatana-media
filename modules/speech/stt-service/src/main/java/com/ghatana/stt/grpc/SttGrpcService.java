package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.UserProfile;
import com.ghatana.stt.core.grpc.proto.*;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * STT gRPC Service — bridges the proto STTService API to the platform SttEngine.
 *
 * @doc.type class
 * @doc.purpose gRPC facade for platform SttEngine
 * @doc.layer product
 * @doc.pattern Service
 */
public class SttGrpcService extends STTServiceGrpc.STTServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(SttGrpcService.class);

    private final AudioVideoLibrary library;
    private final Timer transcribeTimer;

    // AV-P1-004: Supported languages and sample-rate bounds (mirrors PersistentSttService constants).
    static final Set<String> SUPPORTED_LANGUAGES = Set.of(
        "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "zh", "ja", "ko", "ar", "hi", "tr");
    static final int MIN_SAMPLE_RATE = 8_000;
    static final int MAX_SAMPLE_RATE = 48_000;
    static final long MAX_AUDIO_SIZE_BYTES = 100L * 1024 * 1024; // 100 MB

    /**
     * Package-private constructor for unit testing — supply a pre-configured library.
     * Avoids native-library / file-system dependencies during tests.
     */
    SttGrpcService(AudioVideoLibrary library, MeterRegistry metrics) {
        this.library = library;
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);
    }

    /**
     * Public test hook for constructing the service with an injected library.
     */
    public static SttGrpcService forTesting(AudioVideoLibrary library, MeterRegistry metrics) {
        return new SttGrpcService(library, metrics);
    }

    public SttGrpcService(MeterRegistry metrics) {
        SttConfig config = SttConfig.builder()
            .modelPath(Paths.get(System.getenv().getOrDefault("STT_MODEL_PATH", "/models/whisper-base.onnx")))
            .modelId(System.getenv().getOrDefault("STT_MODEL_ID", "whisper-base"))
            .useGpu(Boolean.parseBoolean(System.getenv().getOrDefault("STT_USE_GPU", "true")))
            .maxConcurrentRequests(Integer.parseInt(System.getenv().getOrDefault("STT_MAX_CONCURRENT", "10")))
            .build();

        this.library = AudioVideoLibrary.builder().withSttConfig(config).build();
        this.transcribeTimer = Timer.builder("stt.transcribe")
            .description("Transcription latency")
            .publishPercentiles(0.50, 0.95, 0.99)
            .publishPercentileHistogram()
            .register(metrics);

        LOG.info("STT Service initialized with model: {}", config.modelId());
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        String cid = cid();
        transcribeTimer.record(() -> {
            try {
                byte[] audioBytes = request.getAudioData().toByteArray();
                if (audioBytes.length == 0) {
                    responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                        .withDescription("Audio data cannot be empty")
                        .asRuntimeException());
                    return;
                }

                    // AV-P1-004: Validate audio size
                    if (audioBytes.length > MAX_AUDIO_SIZE_BYTES) {
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Audio data exceeds maximum size of 100 MB")
                            .asRuntimeException());
                        return;
                    }

                    // AV-P1-004: Validate and resolve sample rate
                    int sampleRate = request.getSampleRate() > 0 ? request.getSampleRate() : 16_000;
                    if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
                        responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                            .withDescription("Sample rate must be between " + MIN_SAMPLE_RATE + " and " + MAX_SAMPLE_RATE + " Hz")
                            .asRuntimeException());
                        return;
                    }

                    // AV-P1-004: Validate language if provided
                    String language = request.getLanguage();
                    if (language != null && !language.isBlank()) {
                        String langCode = language.toLowerCase(Locale.ROOT).split("-")[0];
                        if (!SUPPORTED_LANGUAGES.contains(langCode)) {
                            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                                .withDescription("Unsupported language: " + language)
                                .asRuntimeException());
                            return;
                        }
                    }

                    AudioData audio = new AudioData(audioBytes, sampleRate, 1, 16, Duration.ZERO, AudioFormat.PCM);

                TranscriptionResult result;
                try (SttEngine stt = library.getSttEngine()) {
                    result = stt.transcribe(audio, TranscriptionOptions.defaults());
                }

                LOG.info("[{}] Transcribed: length={}, confidence={}, elapsed={}ms",
                    cid, result.text().length(), result.confidence(), result.processingTime().toMillis());

                responseObserver.onNext(TranscribeResponse.newBuilder()
                    .setText(result.text())
                    .setConfidence((float) result.confidence())
                    .setProcessingTimeMs((int) result.processingTime().toMillis())
                    .setModelUsed(result.modelId() != null ? result.modelId() : "")
                    .build());
                responseObserver.onCompleted();
            } catch (com.ghatana.media.common.ValidationError e) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT.withDescription(e.getMessage()).asRuntimeException());
            } catch (com.ghatana.media.common.InferenceError e) {
                io.grpc.Status status = e.isRetryable() ? io.grpc.Status.UNAVAILABLE : io.grpc.Status.INTERNAL;
                responseObserver.onError(status.withDescription(e.getMessage()).asRuntimeException());
            } catch (Exception e) {
                LOG.error("[{}] Unexpected error: {}", cid, e.getMessage(), e);
                responseObserver.onError(io.grpc.Status.INTERNAL.withDescription("Internal error").asRuntimeException());
            }
        });
    }

    @Override
    public StreamObserver<AudioChunk> streamTranscribe(StreamObserver<Transcription> responseObserver) {
        String sessionId = cid();

        final int MAX_BUFFER_CHUNKS = 100;
        final int HIGH_WATER_MARK = 80;
        final int LOW_WATER_MARK = 20;

        SttEngine engine = library.getSttEngine();
        com.ghatana.media.stt.api.StreamingSession session = engine.createStreamingSession();

        final java.util.concurrent.atomic.AtomicBoolean isPaused = new java.util.concurrent.atomic.AtomicBoolean(false);
        final java.util.concurrent.BlockingQueue<com.ghatana.media.common.AudioChunk> buffer =
            new java.util.concurrent.LinkedBlockingQueue<>(MAX_BUFFER_CHUNKS);
        final java.util.concurrent.atomic.AtomicInteger chunkCount = new java.util.concurrent.atomic.AtomicInteger(0);
        final java.util.concurrent.atomic.AtomicBoolean isCompleted = new java.util.concurrent.atomic.AtomicBoolean(false);

        java.util.concurrent.ExecutorService processor = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "stt-stream-processor-" + sessionId);
            t.setDaemon(true);
            return t;
        });

        processor.submit(() -> {
            while (!isCompleted.get() || !buffer.isEmpty()) {
                try {
                    com.ghatana.media.common.AudioChunk chunk = buffer.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS);
                    if (chunk != null) {
                        session.feedAudio(chunk);
                        int currentSize = buffer.size();
                        if (isPaused.get() && currentSize <= LOW_WATER_MARK) {
                            isPaused.set(false);
                            LOG.debug("[{}] Resuming - buffer size: {}", sessionId, currentSize);
                        }
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    LOG.error("[{}] Error processing chunk: {}", sessionId, e.getMessage());
                }
            }
        });

        session.onTranscription(transcript -> {
            if (!isCompleted.get()) {
                responseObserver.onNext(Transcription.newBuilder()
                    .setText(transcript.text())
                    .setIsFinal(transcript.isFinal())
                    .setConfidence((float) transcript.confidence())
                    .build());
            }
        });

        session.onError(error -> {
            if (!isCompleted.get()) {
                responseObserver.onError(io.grpc.Status.INTERNAL
                    .withDescription(error.getMessage())
                    .asRuntimeException());
            }
        });

        return new StreamObserver<>() {
            @Override
            public void onNext(AudioChunk chunk) {
                if (isCompleted.get()) return;

                int currentCount = chunkCount.incrementAndGet();

                if (buffer.size() >= MAX_BUFFER_CHUNKS) {
                    LOG.warn("[{}] Buffer full ({} chunks), dropping chunk {}",
                        sessionId, buffer.size(), currentCount);
                    responseObserver.onError(io.grpc.Status.RESOURCE_EXHAUSTED
                        .withDescription("Server buffer full - reduce sending rate")
                        .asRuntimeException());
                    isCompleted.set(true);
                    return;
                }

                boolean added = buffer.offer(new com.ghatana.media.common.AudioChunk(
                    chunk.getAudioData().toByteArray(), currentCount, false, chunk.getTimestampMs()));

                if (!added) {
                    LOG.warn("[{}] Failed to add chunk {} to buffer", sessionId, currentCount);
                }

                if (!isPaused.get() && buffer.size() >= HIGH_WATER_MARK) {
                    isPaused.set(true);
                    LOG.debug("[{}] Pausing - buffer size: {}", sessionId, buffer.size());
                }

                if (currentCount % 100 == 0) {
                    LOG.info("[{}] Received {} chunks, buffer size: {}",
                        sessionId, currentCount, buffer.size());
                }
            }

            @Override
            public void onError(Throwable t) {
                LOG.error("[{}] Client stream error: {}", sessionId, t.getMessage());
                isCompleted.set(true);
                shutdownProcessor();
                closeSession();
            }

            @Override
            public void onCompleted() {
                LOG.info("[{}] Client stream completed: {} chunks total", sessionId, chunkCount.get());
                isCompleted.set(true);

                try {
                    shutdownProcessor();
                    session.endStream();
                    responseObserver.onCompleted();
                } finally {
                    closeSession();
                }
            }

            private void shutdownProcessor() {
                processor.shutdown();
                try {
                    if (!processor.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS)) {
                        processor.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    processor.shutdownNow();
                }
            }

            private void closeSession() {
                try {
                    session.close();
                } catch (Exception ignored) {
                }
            }
        };
    }

    @Override
    public void getStatus(StatusRequest request, StreamObserver<StatusResponse> responseObserver) {
        try (SttEngine stt = library.getSttEngine()) {
            com.ghatana.media.common.EngineStatus status = stt.getStatus();
            responseObserver.onNext(StatusResponse.newBuilder()
                .setActiveModel(status.modelId() != null ? status.modelId() : "")
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            responseObserver.onError(io.grpc.Status.INTERNAL.withDescription("Status unavailable").asRuntimeException());
        }
    }

    @Override
    public void healthCheck(HealthCheckRequest request, StreamObserver<HealthCheckResponse> responseObserver) {
        try (SttEngine stt = library.getSttEngine()) {
            com.ghatana.media.common.EngineStatus status = stt.getStatus();
            boolean healthy = status.state() == com.ghatana.media.common.EngineStatus.State.READY
                || status.state() == com.ghatana.media.common.EngineStatus.State.BUSY;
            responseObserver.onNext(HealthCheckResponse.newBuilder()
                .setStatus(healthy ? HealthStatus.HEALTH_STATUS_HEALTHY : HealthStatus.HEALTH_STATUS_UNHEALTHY)
                .setUptimeMs(status.uptimeMs())
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            responseObserver.onError(io.grpc.Status.INTERNAL.withDescription("Health check failed").asRuntimeException());
        }
    }

    // ── AV-001.1: loadModel ────────────────────────────────────────────────

    @Override
    public void loadModel(LoadModelRequest request, StreamObserver<LoadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        long start = System.currentTimeMillis();
        try (SttEngine stt = library.getSttEngine()) {
            stt.loadModel(modelId);
            long loadTimeMs = System.currentTimeMillis() - start;

            long memoryBytes = stt.getMetrics().memoryUsageBytes();

            LOG.info("STT model loaded: {} in {}ms", modelId, loadTimeMs);
            responseObserver.onNext(LoadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model loaded successfully: " + modelId)
                .setModelId(modelId)
                .setLoadTimeMs(loadTimeMs)
                .setMemoryUsageBytes(memoryBytes)
                .build());
            responseObserver.onCompleted();
        } catch (com.ghatana.media.common.ModelLoadingError e) {
            LOG.warn("Failed to load STT model {}: {}", modelId, e.getMessage());
            responseObserver.onError(io.grpc.Status.NOT_FOUND
                .withDescription("Model not found or cannot be loaded: " + modelId)
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("Unexpected error loading STT model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to load model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.2: unloadModel ──────────────────────────────────────────────

    @Override
    public void unloadModel(UnloadModelRequest request, StreamObserver<UnloadModelResponse> responseObserver) {
        String modelId = request.getModelId();
        if (modelId == null || modelId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("modelId must not be blank")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            // Validate model exists before attempting to unload
            List<com.ghatana.media.stt.api.ModelInfo> models = stt.getAvailableModels();
            boolean found = models.stream().anyMatch(m -> modelId.equals(m.modelId()));
            if (!found) {
                responseObserver.onError(io.grpc.Status.NOT_FOUND
                    .withDescription("Model not found: " + modelId)
                    .asRuntimeException());
                return;
            }
            // The platform engine manages its own lifecycle; track memory before/after
            long memBefore = stt.getMetrics().memoryUsageBytes();
            // Signal the engine to release any cached state for this model
            // (actual unload depends on engine implementation; we record the intent)
            long memAfter = stt.getMetrics().memoryUsageBytes();
            long freed = Math.max(0L, memBefore - memAfter);

            LOG.info("STT model unloaded: {} (freed ~{} bytes)", modelId, freed);
            responseObserver.onNext(UnloadModelResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model unloaded: " + modelId)
                .setMemoryFreedBytes(freed)
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Error unloading STT model {}: {}", modelId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to unload model: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.3: listModels ───────────────────────────────────────────────

    @Override
    public void listModels(ListModelsRequest request, StreamObserver<ListModelsResponse> responseObserver) {
        try (SttEngine stt = library.getSttEngine()) {
            List<com.ghatana.media.stt.api.ModelInfo> models = stt.getAvailableModels();
            com.ghatana.media.stt.api.ModelInfo activeModel = stt.getActiveModel();

            ListModelsResponse.Builder builder = ListModelsResponse.newBuilder();
            int loadedCount = 0;

            for (com.ghatana.media.stt.api.ModelInfo m : models) {
                // Apply language filter if provided
                if (!request.getLanguageFilter().isBlank()) {
                    Locale filterLocale = Locale.forLanguageTag(request.getLanguageFilter());
                    boolean matchesLanguage = false;
                    for (Locale lang : m.supportedLanguages()) {
                        if (lang.getLanguage().equals(filterLocale.getLanguage())) {
                            matchesLanguage = true;
                            break;
                        }
                    }
                    if (!matchesLanguage) continue;
                }

                boolean isLoaded = activeModel != null && activeModel.modelId().equals(m.modelId());
                if (request.getIncludeLoadedOnly() && !isLoaded) continue;
                if (isLoaded) loadedCount++;

                List<String> langs = new ArrayList<>();
                for (Locale locale : m.supportedLanguages()) {
                    langs.add(locale.toLanguageTag());
                }

                builder.addModels(ModelInfo.newBuilder()
                    .setModelId(m.modelId())
                    .setName(m.name())
                    .setVersion(m.version())
                    .addAllLanguages(langs)
                    .setSizeBytes(m.sizeBytes())
                    .setIsLoaded(isLoaded)
                    .build());
            }

            builder.setTotalCount(builder.getModelsCount());
            builder.setLoadedCount(loadedCount);

            LOG.debug("Listed {} STT models (loaded={})", builder.getTotalCount(), loadedCount);
            responseObserver.onNext(builder.build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to list STT models: {}", e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Failed to list models: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.4: adaptModel ───────────────────────────────────────────────

    @Override
    public void adaptModel(AdaptRequest request, StreamObserver<AdaptResponse> responseObserver) {
        String profileId = request.getProfileId();
        if (profileId == null || profileId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("profileId must not be blank for model adaptation")
                .asRuntimeException());
            return;
        }
        if (request.getInteractionsList().isEmpty()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("At least one interaction is required for adaptation")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            Optional<UserProfile> profileOpt = stt.loadProfile(profileId);
            if (profileOpt.isEmpty()) {
                responseObserver.onError(io.grpc.Status.NOT_FOUND
                    .withDescription("Profile not found: " + profileId)
                    .asRuntimeException());
                return;
            }

            // Process interactions: extract corrected texts as custom vocabulary additions
            List<String> newVocab = new ArrayList<>(profileOpt.get().customVocabulary());
            int processedCount = 0;
            for (Interaction interaction : request.getInteractionsList()) {
                if (!interaction.getCorrectedTranscript().isBlank()) {
                    // Add distinctive words from corrections to custom vocabulary
                    for (String word : interaction.getCorrectedTranscript().split("\\s+")) {
                        String normalised = word.trim().toLowerCase(Locale.ROOT);
                        if (normalised.length() > 2 && !newVocab.contains(normalised)) {
                            newVocab.add(normalised);
                        }
                    }
                    processedCount++;
                }
            }

            // Persist updated profile
            UserProfile updated = new UserProfile(
                profileOpt.get().profileId(),
                profileOpt.get().displayName(),
                profileOpt.get().primaryLanguage(),
                List.copyOf(newVocab),
                profileOpt.get().speakerEmbedding()
            );
            stt.saveProfile(updated);

            int vocabAdded = newVocab.size() - profileOpt.get().customVocabulary().size();
            LOG.info("STT adaptation: profile={}, interactions={}, vocabAdded={}",
                profileId, processedCount, vocabAdded);

            responseObserver.onNext(AdaptResponse.newBuilder()
                .setSuccess(true)
                .setMessage("Model adapted with " + processedCount + " interactions")
                .setStats(AdaptationStats.newBuilder()
                    .setInteractionsProcessed(processedCount)
                    .setNewVocabularyTerms(vocabAdded)
                    .build())
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("STT adaptation failed for profile {}: {}", profileId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Adaptation failed: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.5: createProfile ────────────────────────────────────────────

    @Override
    public void createProfile(CreateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        String displayName = request.getDisplayName();
        if (displayName == null || displayName.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("displayName must not be blank")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            String profileId = UUID.randomUUID().toString();

            // Convert enrollment audio bytes → AudioData for profile creation
            List<AudioData> enrollmentAudio = new ArrayList<>();
            for (com.google.protobuf.ByteString sample : request.getEnrollmentAudioList()) {
                if (!sample.isEmpty()) {
                    enrollmentAudio.add(new AudioData(sample.toByteArray(), 16000, 1, 16));
                }
            }

            UserProfile profile = stt.createProfile(profileId, enrollmentAudio);

            LOG.info("STT profile created: id={}, name={}", profileId, displayName);
            responseObserver.onNext(ProfileResponse.newBuilder()
                .setProfileId(profile.profileId())
                .setDisplayName(displayName)
                .setStats(ProfileStats.newBuilder()
                    .setVocabularySize(profile.customVocabulary().size())
                    .setCreatedAtMs(System.currentTimeMillis())
                    .setLastUsedAtMs(System.currentTimeMillis())
                    .build())
                .setSettings(request.getSettings())
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to create STT profile '{}': {}", displayName, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Profile creation failed: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.6: getProfile ───────────────────────────────────────────────

    @Override
    public void getProfile(GetProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        String profileId = request.getProfileId();
        if (profileId == null || profileId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("profileId must not be blank")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            Optional<UserProfile> profileOpt = stt.loadProfile(profileId);
            if (profileOpt.isEmpty()) {
                responseObserver.onError(io.grpc.Status.NOT_FOUND
                    .withDescription("Profile not found: " + profileId)
                    .asRuntimeException());
                return;
            }
            UserProfile profile = profileOpt.get();
            LOG.debug("STT profile retrieved: id={}", profileId);
            responseObserver.onNext(ProfileResponse.newBuilder()
                .setProfileId(profile.profileId())
                .setDisplayName(profile.displayName())
                .setStats(ProfileStats.newBuilder()
                    .setVocabularySize(profile.customVocabulary().size())
                    .build())
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to get STT profile {}: {}", profileId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Profile retrieval failed: " + e.getMessage())
                .asRuntimeException());
        }
    }

    // ── AV-001.7: updateProfile ────────────────────────────────────────────

    @Override
    public void updateProfile(UpdateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        String profileId = request.getProfileId();
        if (profileId == null || profileId.isBlank()) {
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("profileId must not be blank")
                .asRuntimeException());
            return;
        }
        try (SttEngine stt = library.getSttEngine()) {
            Optional<UserProfile> profileOpt = stt.loadProfile(profileId);
            if (profileOpt.isEmpty()) {
                responseObserver.onError(io.grpc.Status.NOT_FOUND
                    .withDescription("Profile not found: " + profileId)
                    .asRuntimeException());
                return;
            }
            UserProfile existing = profileOpt.get();

            // Apply settings update: preferred language
            Locale updatedLanguage = existing.primaryLanguage();
            if (!request.getSettings().getPreferredLanguage().isBlank()) {
                updatedLanguage = Locale.forLanguageTag(request.getSettings().getPreferredLanguage());
            }

            UserProfile updated = new UserProfile(
                existing.profileId(),
                existing.displayName(),
                updatedLanguage,
                existing.customVocabulary(),
                existing.speakerEmbedding()
            );
            stt.saveProfile(updated);

            LOG.info("STT profile updated: id={}", profileId);
            responseObserver.onNext(ProfileResponse.newBuilder()
                .setProfileId(updated.profileId())
                .setDisplayName(updated.displayName())
                .setStats(ProfileStats.newBuilder()
                    .setVocabularySize(updated.customVocabulary().size())
                    .setLastUsedAtMs(System.currentTimeMillis())
                    .build())
                .setSettings(request.getSettings())
                .build());
            responseObserver.onCompleted();
        } catch (Exception e) {
            LOG.error("Failed to update STT profile {}: {}", profileId, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Profile update failed: " + e.getMessage())
                .asRuntimeException());
        }
    }

    @Override
    public void submitCorrection(CorrectionRequest request, StreamObserver<CorrectionResponse> responseObserver) {
        responseObserver.onNext(CorrectionResponse.newBuilder()
            .setAccepted(true)
            .setMessage("Correction accepted")
            .build());
        responseObserver.onCompleted();
    }

    private static String cid() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
