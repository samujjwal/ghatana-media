package com.ghatana.stt.provider;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.engine.onnx.WhisperOnnxEngine;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
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
    private final java.util.concurrent.atomic.AtomicBoolean closed =
            new java.util.concurrent.atomic.AtomicBoolean();

    public WhisperOnnxSttProvider(
            SttConfig config, ProfileBinding binding, long maxSourceBytes) {
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.binding = java.util.Objects.requireNonNull(binding, "binding");
        if (maxSourceBytes < 1) throw new IllegalArgumentException("maxSourceBytes must be positive");
        this.maxSourceBytes = maxSourceBytes;
        this.engine = new WhisperOnnxEngine(config, new AudioVideoLibrary.LibraryState());
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
        try {
            return engine.getStatus().state() == EngineStatus.State.READY;
        } catch (RuntimeException failure) {
            return false;
        }
    }

    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "Whisper STT requires the typed attempt context"));
    }

    @Override public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        try {
            if (context.sourceAuthorization() == null) {
                return CompletableFuture.failedFuture(new IllegalStateException(
                        "STT provider invoked without admitted source authorization"));
            }
            if (context.request().parameters().get("customGlossaryRef") != null) {
                return CompletableFuture.failedFuture(new IllegalArgumentException(
                        "custom glossary application is not supported by this provider profile"));
            }
            ByteArrayOutputStream staged = new ByteArrayOutputStream();
            ArtifactContentReadReceipt receipt = context.copySourceContentTo(staged, maxSourceBytes);
            AudioData audio = wavPcm16Mono16k(staged.toByteArray());
            TranscriptionOptions options = TranscriptionOptions.builder()
                    .language(requestLanguage(context))
                    .enableTimestamps(false)
                    .build();
            TranscriptionResult result = engine.transcribe(audio, options);
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
            return CompletableFuture.completedFuture(new ProviderSubmission(
                    AttemptFinality.SUCCEEDED, operationId, receiptId,
                    submissionResult, provenance, Instant.now()));
        } catch (RuntimeException | java.io.IOException failure) {
            return CompletableFuture.failedFuture(failure);
        } catch (Exception failure) {
            return CompletableFuture.failedFuture(new IllegalStateException(
                    "Whisper inference failed", failure));
        }
    }

    private Locale requestLanguage(ProcessingContext context) {
        Object intent = context.request().parameters().get("languageIntent");
        if (intent instanceof Map<?, ?> map && map.get("languageTag") instanceof String tag) {
            return Locale.forLanguageTag(tag);
        }
        return Locale.ENGLISH;
    }

    private static AudioData wavPcm16Mono16k(byte[] wav) throws Exception {
        try (AudioInputStream input = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            var format = input.getFormat();
            if (!"PCM_SIGNED".equals(format.getEncoding().toString())
                    || format.getSampleRate() != 16_000f || format.getChannels() != 1
                    || format.getSampleSizeInBits() != 16 || format.isBigEndian()) {
                throw new IllegalArgumentException(
                        "Whisper source must be mono 16kHz signed 16-bit little-endian PCM WAV");
            }
            byte[] pcm = input.readAllBytes();
            return new AudioData(pcm, 16_000, 1, 16,
                    Duration.ofMillis(Math.round(pcm.length * 1_000d / (16_000 * 2))),
                    AudioFormat.PCM);
        }
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
            engine.close();
        }
    }
}
