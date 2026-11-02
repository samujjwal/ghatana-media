package com.ghatana.stt.provider;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.WhisperComputeClient;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.engine.onnx.WhisperOnnxEngine;
import com.ghatana.stt.service.SttAudioInputDecoder;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Canonical local Whisper ONNX provider for the Media processing attempt path.
 *
 * <p>The provider performs real pinned-profile inference only after the runtime has
 * admitted the exact source artifact: bytes are staged through the bounded,
 * authorization-checked {@link ProcessingContext#copySourceContentTo} reader, never
 * through caller-supplied content or environment paths. The submission result carries
 * only the {@code semanticObservations} projection required by the immutable transcript
 * store; transcript persistence remains the store's fenced, rights-checked decision.
 *
 * <p>Profile admission is honest: {@code QUALIFIED} is reported only with a non-blank
 * {@code qualificationEvidenceRef} identifying the actual pinned model, source audio,
 * and independently verified output evidence that backs this instance. There is no
 * environment-variable or caller-attested promotion path.
 */
public final class WhisperOnnxSttProvider implements MediaProcessingProvider {

    /** Bounded identity and qualification record for one pinned Whisper profile. */
    public record ProfileBinding(
            String providerId,
            String providerVersion,
            String profileId,
            String profileVersion,
            String configurationDigest,
            Set<String> supportedLanguageTags,
            String qualificationEvidenceRef,
            String processingRegion,
            boolean productionEligible) {
        public ProfileBinding {
            if (providerId == null || providerId.isBlank()
                    || providerVersion == null || providerVersion.isBlank()
                    || profileId == null || profileId.isBlank()
                    || profileVersion == null || profileVersion.isBlank()) {
                throw new IllegalArgumentException("Whisper provider identity must be complete");
            }
            if (configurationDigest == null
                    || !configurationDigest.matches("sha256:[0-9a-f]{64}")) {
                throw new IllegalArgumentException("configurationDigest must be sha256:<lowercase hex>");
            }
            supportedLanguageTags = Set.copyOf(
                    supportedLanguageTags == null ? Set.of() : supportedLanguageTags);
            if (supportedLanguageTags.isEmpty()) {
                throw new IllegalArgumentException("supportedLanguageTags must not be empty");
            }
            qualificationEvidenceRef = qualificationEvidenceRef == null
                    ? "" : qualificationEvidenceRef.trim();
            processingRegion = processingRegion == null || processingRegion.isBlank()
                    ? "local" : processingRegion.trim();
        }
    }

    private final WhisperOnnxEngine engine;
    private final SttConfig config;
    private final ProfileBinding binding;
    private final long maxSourceBytes;
    /** Trusted in-process measurement source; never an RPC, request field or admission flag. */
    private final QualityEvidenceReader qualityEvidenceReader;
    private final WhisperBrokerSttProvider brokerProvider;
    private final java.util.concurrent.atomic.AtomicBoolean closed =
            new java.util.concurrent.atomic.AtomicBoolean();

    /**
     * The default instance has no measured model-quality source. A ready engine
     * alone never creates a score, evaluation receipt or production authorization.
     */
    public WhisperOnnxSttProvider(
            SttConfig config, ProfileBinding binding, long maxSourceBytes) {
        this(config, binding, maxSourceBytes,
                (providerId, providerVersion, modelRevision) -> Optional.empty());
    }

    /**
     * Read-only, low-cost snapshot of an independently measured and verified
     * quality report, supplied solely by trusted server-side composition.
     * Implementations MUST hash-check source report bytes, model/voice dataset
     * version and gold/rights before returning a measurement; this constructor
     * does not turn a candidate measurement into an admitted provider.
     */
    @FunctionalInterface
    public interface QualityEvidenceReader {
        Optional<MediaModalityContracts.ProviderQualityObservation> latest(
                String providerId, String providerVersion, String modelRevision);

        /**
         * All measured rows a verified report carries for the exact identity —
         * aggregate plus bounded per-locale series. The default derives from
         * {@link #latest}; every row must still match the exact provider and model.
         */
        default List<MediaModalityContracts.ProviderQualityObservation> latestAll(
                String providerId, String providerVersion, String modelRevision) {
            return latest(providerId, providerVersion, modelRevision)
                    .map(List::of).orElse(List.of());
        }
    }

    public WhisperOnnxSttProvider(
            SttConfig config, ProfileBinding binding, long maxSourceBytes,
            QualityEvidenceReader qualityEvidenceReader) {
        this(config, binding, maxSourceBytes, qualityEvidenceReader, null, "");
    }

    /** Explicit broker composition; the server must supply the pinned profile and model digest. */
    public WhisperOnnxSttProvider(
            SttConfig config, ProfileBinding binding, long maxSourceBytes,
            QualityEvidenceReader qualityEvidenceReader, WhisperComputeClient computeClient,
            String pinnedModelSha256) {
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.binding = java.util.Objects.requireNonNull(binding, "binding");
        if (maxSourceBytes < 1) throw new IllegalArgumentException("maxSourceBytes must be positive");
        this.maxSourceBytes = maxSourceBytes;
        this.qualityEvidenceReader = java.util.Objects.requireNonNull(
                qualityEvidenceReader, "qualityEvidenceReader");
        this.brokerProvider = computeClient == null ? null : new WhisperBrokerSttProvider(
                binding.profileId(), config.modelId(), pinnedModelSha256,
                binding.configurationDigest().substring("sha256:".length()), computeClient);
        this.engine = computeClient == null
                ? new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState()) : null;
    }

    @Override public String providerId() { return binding.providerId(); }
    @Override public String providerVersion() { return binding.providerVersion(); }
    @Override public String modelVersion(JobType modality) {
        return modality == JobType.SPEECH_TO_TEXT ? config.modelId() : binding.providerVersion();
    }
    @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return binding.processingRegion(); }
    @Override public ProviderDataRetention providerDataRetention() {
        return ProviderDataRetention.NONE;
    }
    @Override public boolean productionEligible() { return binding.productionEligible(); }
    @Override public int priority() { return 10; }

    /**
     * Observed health is independent of scientific model qualification. Report
     * the engine's actual state with the exact local WAV/16kHz PCM capabilities;
     * do not invent timestamps, confidence, word-level alignment or supported
     * formats the current provider cannot decode.
     */
    @Override public MediaModalityContracts.ProviderHealth health() {
        if (brokerProvider != null) return brokerProvider.health();
        return capabilityProfiles().getFirst().health();
    }

    @Override public List<MediaModalityContracts.CapabilityProfile> capabilityProfiles() {
        if (brokerProvider != null) return brokerProvider.capabilityProfiles();
        EngineStatus.State state;
        try {
            state = engine.getStatus().state();
        } catch (RuntimeException unavailable) {
            state = EngineStatus.State.ERROR;
        }
        return List.of(observedCapabilityProfile(binding, config.modelId(), state, Instant.now()));
    }

    static MediaModalityContracts.CapabilityProfile observedCapabilityProfile(
            ProfileBinding binding, String modelRevision, EngineStatus.State state, Instant checkedAt) {
        java.util.Objects.requireNonNull(binding, "binding");
        java.util.Objects.requireNonNull(state, "state");
        java.util.Objects.requireNonNull(checkedAt, "checkedAt");
        String revision = java.util.Objects.requireNonNull(modelRevision, "modelRevision")
                .trim().toLowerCase(Locale.ROOT);
        if (!revision.matches("[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}")) {
            throw new IllegalArgumentException("Whisper observed model revision must be a bounded metric token");
        }
        boolean ready = state == EngineStatus.State.READY;
        var degradation = binding.productionEligible()
                ? MediaModalityContracts.DegradationPolicy.FAIL_CLOSED
                : MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY;
        var health = new MediaModalityContracts.ProviderHealth(
                binding.providerId(), binding.providerVersion(),
                ready ? MediaModalityContracts.ProviderHealthStatus.HEALTHY
                        : MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE,
                degradation,
                ready ? "engine ready; model quality and legal admission are independent"
                        : "Whisper engine not ready: " + state.name(),
                checkedAt);
        return new MediaModalityContracts.CapabilityProfile(
                binding.providerId(), binding.providerVersion(), JobType.SPEECH_TO_TEXT,
                Set.of("pcm_s16le"), Set.of("wav"), Set.of(16_000),
                0, 0, Set.of(revision), Set.of(binding.processingRegion()),
                ProcessingBoundary.LOCAL,
                false, false, false, health, degradation,
                MediaModalityContracts.ExecutionBounds.defaults());
    }

    /**
     * No measured score is reported unless the trusted provider-owned reader
     * supplies the same exact provider, modality and model revision. A model
     * reference, readiness flag and candidate evidence ID never substitute.
     */
    @Override
    public Optional<MediaModalityContracts.ProviderQualityObservation> qualityObservation(
            JobType modality, String modelRevision) {
        if (modality != JobType.SPEECH_TO_TEXT || closed.get() || modelRevision == null) {
            return Optional.empty();
        }
        String revision = config.modelId().trim().toLowerCase(Locale.ROOT);
        if (!revision.equals(modelRevision)) return Optional.empty();
        Optional<MediaModalityContracts.ProviderQualityObservation> candidate =
                qualityEvidenceReader.latest(binding.providerId(), binding.providerVersion(), revision);
        return matchingQualityObservation(binding, revision, candidate);
    }

    /**
     * Every measured row the trusted evidence source supplies for the exact
     * provider and model — aggregate plus any bounded per-locale series.
     * Each row is independently identity-checked before it is exposed.
     */
    @Override
    public List<MediaModalityContracts.ProviderQualityObservation> qualityObservations(
            JobType modality, String modelRevision) {
        if (modality != JobType.SPEECH_TO_TEXT || closed.get() || modelRevision == null) {
            return List.of();
        }
        String revision = config.modelId().trim().toLowerCase(Locale.ROOT);
        if (!revision.equals(modelRevision)) return List.of();
        return qualityEvidenceReader
                .latestAll(binding.providerId(), binding.providerVersion(), revision)
                .stream()
                .filter(value -> value.providerId().equals(binding.providerId())
                        && value.providerVersion().equals(binding.providerVersion())
                        && value.modality() == JobType.SPEECH_TO_TEXT
                        && value.modelRevision().equals(revision))
                .toList();
    }

    static Optional<MediaModalityContracts.ProviderQualityObservation> matchingQualityObservation(
            ProfileBinding binding, String modelRevision,
            Optional<MediaModalityContracts.ProviderQualityObservation> candidate) {
        if (candidate == null) return Optional.empty();
        return candidate.filter(value ->
                value.providerId().equals(binding.providerId())
                && value.providerVersion().equals(binding.providerVersion())
                && value.modality() == JobType.SPEECH_TO_TEXT
                && value.modelRevision().equals(modelRevision));
    }

    @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
        return Optional.of(new MediaSpeechToTextAdmission.Profile(
                binding.providerId(), binding.providerVersion(), binding.profileId(),
                binding.profileVersion(), binding.configurationDigest(),
                MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                binding.supportedLanguageTags(), false,
                MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                binding.qualificationEvidenceRef()));
    }

    @Override public boolean ready() {
        if (brokerProvider != null) return brokerProvider.ready();
        try {
            return engine.getStatus().state() == EngineStatus.State.READY;
        } catch (RuntimeException failure) {
            return false;
        }
    }

    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        if (brokerProvider != null) return brokerProvider.process(context);
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "Whisper STT requires the typed attempt context"));
    }

    @Override public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        if (brokerProvider != null) return brokerProvider.processAttempt(context, attempt);
        try {
            context.cancellation().throwIfCancelled();
            if (context.sourceAuthorization() == null) {
                return CompletableFuture.failedFuture(new IllegalStateException(
                        "STT provider invoked without admitted source authorization"));
            }
            if (context.request().parameters().get("customGlossaryRef") != null) {
                return CompletableFuture.failedFuture(new IllegalArgumentException(
                        "custom glossary application is not supported by this provider profile"));
            }
            VerifiedStagedSource staged = readVerifiedSourceContent(context,
                    Math.min(maxSourceBytes, SttAudioInputDecoder.MAX_INPUT_BYTES),
                    context.cancellation()::throwIfCancelled);
            context.cancellation().throwIfCancelled();
            ArtifactContentReadReceipt receipt = staged.receipt();
            AudioData audio = wavPcm16Mono16k(staged.bytes());
            TranscriptionOptions options = TranscriptionOptions.builder()
                    .language(requestLanguage(context))
                    .enableTimestamps(false)
                    .build();
            TranscriptionResult result = transcribeWithCancellationFence(engine, audio, options, context);
            String text = result.getText();
            String outputSha = sha256(text.getBytes(StandardCharsets.UTF_8));
            String transcriptVersionRef = "transcript:v1:sha256:" + outputSha;
            String provenance = sha256((config.modelId() + "|" + receipt.sha256() + "|" + outputSha)
                    .getBytes(StandardCharsets.UTF_8));
            String operationId = "whisper-local:" + attempt.jobId() + ":" + attempt.attemptNumber();
            String receiptId = "whisper-receipt:" + sha256(
                    (operationId + "|" + attempt.requestFingerprint()).getBytes(StandardCharsets.UTF_8));

            Map<String, Object> transcriptResponse = new LinkedHashMap<>();
            transcriptResponse.put("sourceArtifactVersionRef", context.artifact().version().value());
            transcriptResponse.put("requestFingerprint", attempt.requestFingerprint());
            transcriptResponse.put("transcriptVersionRef", transcriptVersionRef);
            transcriptResponse.put("glossaryDisposition", "NOT_REQUESTED");
            transcriptResponse.put("transcriptText", text);
            Map<String, Object> observations = new LinkedHashMap<>();
            observations.put("requestFingerprint", attempt.requestFingerprint());
            observations.put("glossaryApplication", Map.of("disposition", "NOT_REQUESTED"));
            observations.put("transcriptResponse", transcriptResponse);
            Locale language = requestLanguage(context);
            Map<String, Object> submissionResult = new LinkedHashMap<>();
            submissionResult.put("text", text);
            submissionResult.put("language", language == null ? "und" : language.toLanguageTag());
            submissionResult.put("semanticObservations", observations);
            List<Map<String, Object>> timed = sourceTickObservations(
                    audio.getSampleCount(), audio.sampleRate(), context.artifact().metadata());
            if (!timed.isEmpty()) {
                submissionResult.put("timedObservations", timed);
                submissionResult.put("timingAvailable", true);
                Map<String, Object> segment = sourceTickSegment(
                        text, audio.getSampleCount(), audio.sampleRate(),
                        context.artifact().metadata());
                if (segment != null) {
                    transcriptResponse.put("segments", List.of(segment));
                }
            }
            ProviderSubmission submission = new ProviderSubmission(
                    AttemptFinality.SUCCEEDED, operationId, receiptId,
                    submissionResult, provenance, Instant.now());
            return CompletableFuture.completedFuture(ensureSubmissionNotCancelled(context, submission));
        } catch (RuntimeException | java.io.IOException failure) {
            return CompletableFuture.failedFuture(failure);
        } catch (Exception failure) {
            return CompletableFuture.failedFuture(new IllegalStateException(
                    "Whisper inference failed", failure));
        }
    }

    @Override public Optional<ProviderAttemptIdentity> prepareAttemptIdentity(
            ProcessingJobRequest request, MediaArtifact artifact, ProviderAttemptContext attempt) {
        return brokerProvider == null ? Optional.empty()
                : brokerProvider.prepareAttemptIdentity(request, artifact, attempt);
    }

    @Override public CompletableFuture<ProviderAttemptObservation> reconcileAttempt(ProviderAttemptQuery query) {
        return brokerProvider == null
                ? MediaProcessingProvider.super.reconcileAttempt(query)
                : brokerProvider.reconcileAttempt(query);
    }

    static WhisperOnnxEngine.CancellationSignal cancellationSignal(ProcessingContext context) {
        java.util.Objects.requireNonNull(context, "context");
        return new WhisperOnnxEngine.CancellationSignal() {
            @Override public boolean cancelled() { return context.cancellation().cancelled(); }
            @Override public AutoCloseable onCancel(Runnable callback) {
                return context.cancellation().onCancel(callback);
            }
        };
    }

    static TranscriptionResult transcribeWithCancellationFence(
            WhisperOnnxEngine engine, AudioData audio, TranscriptionOptions options,
            ProcessingContext context) {
        TranscriptionResult result = engine.transcribe(audio, options, cancellationSignal(context));
        context.cancellation().throwIfCancelled();
        return result;
    }

    static ProviderSubmission ensureSubmissionNotCancelled(
            ProcessingContext context, ProviderSubmission submission) {
        context.cancellation().throwIfCancelled();
        return submission;
    }

    /**
     * Measured source ticks covering the exact decoded extent of the admitted source.
     * An entry is declared only when the artifact carries a complete exact source-clock
     * declaration and the decoded sample extent maps to source ticks without rounding;
     * otherwise the result honestly carries no timing claim and multimodal grounding
     * reports {@code SYNC_UNDETERMINED}. The pinned Whisper profile supplies no
     * qualified intra-stream word timings, so the single observation describes the
     * whole decoded span rather than fabricated segment times.
     */
    static List<Map<String, Object>> sourceTickObservations(
            long decodedSamples, int decodedSampleRate, Map<String, Object> artifactMetadata) {
        var declared = MultimodalOperationSpec.declaredSourceClock(artifactMetadata);
        if (declared.isEmpty() || decodedSamples < 1) return List.of();
        var clock = declared.orElseThrow();
        Long end = MultimodalOperationSpec.mapExtentToSourceTicks(
                decodedSamples, decodedSampleRate, clock.ticksPerSecond());
        if (end == null || end <= 0 || end > clock.durationTicks()) return List.of();
        return List.of(MultimodalOperationSpec.timedObservation(
                "transcript-span", 0, end, clock.clockId(), clock.ticksPerSecond()));
    }

    /**
     * The same measured decoded span expressed as one PDP-1 transcript segment with a
     * {@code SOURCE_TICKS} timing tag and the exact shared source-clock tuple — the
     * honest whole-extent claim the pinned profile can make. Returns null exactly when
     * no verified span exists; the provider never fabricates intra-stream splits.
     */
    static Map<String, Object> sourceTickSegment(
            String text, long decodedSamples, int decodedSampleRate,
            Map<String, Object> artifactMetadata) {
        var declared = MultimodalOperationSpec.declaredSourceClock(artifactMetadata);
        if (declared.isEmpty() || decodedSamples < 1) return null;
        var clock = declared.orElseThrow();
        Long end = MultimodalOperationSpec.mapExtentToSourceTicks(
                decodedSamples, decodedSampleRate, clock.ticksPerSecond());
        if (end == null || end <= 0 || end > clock.durationTicks()) return null;
        Map<String, Object> timing = new LinkedHashMap<>();
        timing.put("tag", "SOURCE_TICKS");
        timing.put("startTick", 0L);
        timing.put("endTick", end);
        timing.put("sourceClockId", clock.clockId());
        timing.put("sourceTicksPerSecond", clock.ticksPerSecond());
        timing.put("sourceDurationTicks", clock.durationTicks());
        Map<String, Object> segment = new LinkedHashMap<>();
        segment.put("segmentId", "transcript-span");
        segment.put("text", text);
        segment.put("origin", "PROVIDER");
        segment.put("timing", Map.copyOf(timing));
        return Map.copyOf(segment);
    }

    private Locale requestLanguage(ProcessingContext context) {
        Object intent = context.request().parameters().get("languageIntent");
        if (intent instanceof Map<?, ?> map && map.get("languageTag") instanceof String tag) {
            return Locale.forLanguageTag(tag);
        }
        return Locale.ENGLISH;
    }

    static AudioData wavPcm16Mono16k(byte[] wav) {
        AudioData decoded = SttAudioInputDecoder.decode(wav, AudioFormat.WAV, 16_000);
        if (decoded.sampleRate() != 16_000 || decoded.channels() != 1 || decoded.bitsPerSample() != 16
                || decoded.format() != AudioFormat.PCM) {
            throw new IllegalArgumentException(
                    "Whisper source must be mono 16kHz signed 16-bit little-endian PCM WAV");
        }
        return decoded;
    }

    record VerifiedStagedSource(byte[] bytes, ArtifactContentReadReceipt receipt) { }

    /** Reads through a physically bounded sink and verifies the receipt against the pinned artifact. */
    static VerifiedStagedSource readVerifiedSourceContent(ProcessingContext context, long requestedMaxBytes)
            throws IOException {
        return readVerifiedSourceContent(context, requestedMaxBytes, () -> { });
    }

    static VerifiedStagedSource readVerifiedSourceContent(
            ProcessingContext context, long requestedMaxBytes, Runnable cancellationCheck)
            throws IOException {
        java.util.Objects.requireNonNull(cancellationCheck, "cancellationCheck");
        cancellationCheck.run();
        MediaArtifact artifact = context.artifact();
        long cap = Math.min(requestedMaxBytes, SttAudioInputDecoder.MAX_INPUT_BYTES);
        if (cap < 1 || cap > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("STT source staging limit must be between 1 byte and 4 MiB");
        }
        BoundedStagingSink sink = new BoundedStagingSink((int) cap, cancellationCheck);
        ArtifactContentReadReceipt receipt = context.copySourceContentTo(sink, cap);
        cancellationCheck.run();
        byte[] staged = sink.toByteArray();
        String actualSha256 = sha256(staged);
        if (staged.length != receipt.bytesCopied()
                || staged.length != artifact.sizeBytes()
                || !actualSha256.equals(receipt.sha256())
                || !ArtifactVersion.fromSha256(actualSha256).equals(receipt.version())
                || !receipt.version().equals(artifact.version())) {
            throw new IllegalStateException(
                    "STT_SOURCE_CONTENT_RECEIPT_MISMATCH: staged bytes do not match the admitted artifact version");
        }
        return new VerifiedStagedSource(staged, receipt);
    }

    /** Fixed-capacity staging: a nonconforming reader cannot grow memory past its declared ceiling. */
    private static final class BoundedStagingSink extends OutputStream {
        private static final int CANCELLATION_CHECK_BYTES = 64 * 1024;
        private final int capacity;
        private final Runnable cancellationCheck;
        private byte[] buffer;
        private int size;

        private BoundedStagingSink(int capacity, Runnable cancellationCheck) {
            this.capacity = capacity;
            this.cancellationCheck = cancellationCheck;
            buffer = new byte[Math.min(capacity, 8 * 1024)];
        }

        @Override public void write(int value) throws IOException {
            requireCapacity(1);
            if (size % CANCELLATION_CHECK_BYTES == 0) cancellationCheck.run();
            ensureCapacity(size + 1);
            buffer[size++] = (byte) value;
        }

        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            java.util.Objects.checkFromIndexSize(offset, length, bytes.length);
            requireCapacity(length);
            int remaining = length;
            int sourceOffset = offset;
            if (remaining == 0) cancellationCheck.run();
            while (remaining > 0) {
                cancellationCheck.run();
                int untilCheck = CANCELLATION_CHECK_BYTES - (size % CANCELLATION_CHECK_BYTES);
                int chunk = Math.min(remaining, untilCheck);
                ensureCapacity(size + chunk);
                System.arraycopy(bytes, sourceOffset, buffer, size, chunk);
                size += chunk;
                sourceOffset += chunk;
                remaining -= chunk;
            }
        }

        private void requireCapacity(int additional) throws IOException {
            if (additional > capacity - size) {
                throw new IOException("STT_SOURCE_TOO_LARGE: source reader exceeded the bounded staging limit");
            }
        }

        private void ensureCapacity(int required) {
            if (required <= buffer.length) return;
            int grown = Math.max(required, Math.min(capacity, Math.max(1, buffer.length) * 2));
            if (grown > capacity) grown = capacity;
            buffer = java.util.Arrays.copyOf(buffer, grown);
        }

        private byte[] toByteArray() { return java.util.Arrays.copyOf(buffer, size); }
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value));
        } catch (java.security.NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) {
            if (engine != null) engine.close();
            if (brokerProvider != null) brokerProvider.close();
        }
    }
}
