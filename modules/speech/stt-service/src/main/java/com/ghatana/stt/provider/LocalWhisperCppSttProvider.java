package com.ghatana.stt.provider;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import com.ghatana.stt.local.LocalSpeechException;
import com.ghatana.stt.local.LocalWhisperCppRunner;
import com.ghatana.stt.service.SttAudioInputDecoder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Local speech-to-text provider: Whisper large-v3-turbo (MIT) via whisper.cpp on this host, per the owner decision
 * recorded in {@link LocalModelManifest#OWNER_DECISION_QUOTE}.
 *
 * <p>The provider exposes an STT profile only while the server-owned manifest verified every file digest on disk
 * ({@link LocalModelInstall#usable()}) and the whisper.cpp executable is present. Verification supplies
 * artifact identity and licence provenance; it is not quality evidence, so {@link #productionEligible()} stays
 * false unless the manifest's own admission block is flipped by the owner. Rights, consent, source clock and
 * transcript-store gates are evaluated by the Media runtime and are not weakened here.</p>
 */
public final class LocalWhisperCppSttProvider implements MediaProcessingProvider {
    public static final String PROVIDER_ID = "whisper-cpp-local";
    public static final String PROFILE_ID = "whisper-large-v3-turbo-cpp-local";
    public static final String MODEL_KEY = "whisper-large-v3-turbo";
    public static final String ENV_MODEL_ROOT = "MEDIA_LOCAL_MODEL_ROOT";
    public static final String ENV_WHISPER_BIN = "MEDIA_WHISPER_CPP_BIN";
    public static final String ENV_THREADS = "MEDIA_WHISPER_CPP_THREADS";
    private static final String DECODING = "beam=5,temperature=0+fallback,language=explicit,timestamps=segment";
    private static final Duration MAX_RUN = Duration.ofMinutes(5);

    private final LocalModelInstall install;
    private final Path executable;
    private final int threads;
    private volatile LocalWhisperCppRunner runner;
    private final ThreadPoolExecutor execution = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(4), task -> {
                Thread thread = new Thread(task, "media-whisper-cpp-local");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());

    /** ServiceLoader entry: server-owned environment composition. An absent pin leaves the provider unready. */
    public LocalWhisperCppSttProvider() {
        this(System.getenv());
    }

    LocalWhisperCppSttProvider(Map<String, String> environment) {
        this(installFrom(environment), path(environment.get(ENV_WHISPER_BIN)), threads(environment));
    }

    public LocalWhisperCppSttProvider(LocalModelInstall install, Path executable, int threads) {
        this.install = java.util.Objects.requireNonNull(install, "install");
        this.executable = executable;
        this.threads = threads;
        this.runner = buildRunner();
    }

    private LocalWhisperCppRunner buildRunner() {
        if (!install.usable()) return null;
        LocalModelManifest manifest = install.manifest();
        return LocalWhisperCppRunner.forVerified(manifest,
                install.verification().path(manifest.first(LocalModelManifest.FileRole.WEIGHTS).path()),
                executable, threads, MAX_RUN);
    }

    private static LocalModelInstall installFrom(Map<String, String> environment) {
        String root = environment.get(ENV_MODEL_ROOT);
        if (root == null || root.isBlank()) return LocalModelInstall.absent(ENV_MODEL_ROOT + " is not set");
        return LocalModelInstall.inspect(Path.of(root).resolve("models").resolve(MODEL_KEY), MODEL_KEY,
                LocalModelManifest.Modality.SPEECH_TO_TEXT);
    }

    private static Path path(String value) { return value == null || value.isBlank() ? null : Path.of(value); }

    private static int threads(Map<String, String> environment) {
        try {
            int configured = Integer.parseInt(environment.getOrDefault(ENV_THREADS, "0"));
            if (configured >= 1 && configured <= 64) return configured;
        } catch (NumberFormatException ignored) { }
        return Math.max(1, Math.min(8, Runtime.getRuntime().availableProcessors() / 2));
    }

    @Override public String providerId() { return PROVIDER_ID; }

    @Override public String providerVersion() {
        return install.usable() && install.manifest().runtime() != null ? install.manifest().runtime().version()
                : "unavailable";
    }

    @Override public String modelVersion(JobType modality) {
        return modality == JobType.SPEECH_TO_TEXT && install.usable() ? install.manifest().source().revision()
                : providerVersion();
    }

    @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return "local"; }
    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
    @Override public int priority() { return 7; }

    @Override public boolean ready() {
        return runner != null && install.stillCurrent();
    }

    /** Production use needs the owner to flip the manifest's own admission switch after real quality evidence. */
    @Override public boolean productionEligible() {
        return ready() && install.manifest().admission().productionEligible();
    }

    @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
        if (!ready()) return Optional.empty();
        LocalModelManifest manifest = install.manifest();
        return Optional.of(new MediaSpeechToTextAdmission.Profile(PROVIDER_ID, providerVersion(), PROFILE_ID,
                manifest.source().revision(), "sha256:" + manifest.configurationDigest(DECODING),
                MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED, manifest.verifiedLanguages(), false,
                MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                // Evidence reference = the exact verified manifest. It proves artifact identity and licence only.
                "local-model-manifest:sha256:" + install.manifestSha256()));
    }

    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "local whisper.cpp STT requires a durable Media provider attempt"));
    }

    @Override public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        try {
            return CompletableFuture.supplyAsync(() -> {
                try { return run(context, attempt); }
                catch (LocalSpeechException | java.io.IOException failure) { throw new IllegalStateException(failure); }
            }, execution);
        } catch (RejectedExecutionException saturated) {
            return CompletableFuture.completedFuture(ProviderSubmission.unknown());
        }
    }

    private ProviderSubmission run(ProcessingContext context, ProviderAttemptContext attempt)
            throws LocalSpeechException, java.io.IOException {
        context.cancellation().throwIfCancelled();
        LocalWhisperCppRunner active = runner;
        if (active == null || !install.stillCurrent()) {
            throw new IllegalStateException("local whisper.cpp profile is no longer verified");
        }
        if (context.sourceAuthorization() == null) {
            throw new IllegalStateException("STT provider invoked without admitted source authorization");
        }
        if (context.request().parameters().get("customGlossaryRef") != null) {
            throw new IllegalArgumentException("custom glossary application is not supported by this provider profile");
        }
        byte[] wav = WhisperOnnxSttProvider.readVerifiedSourceContent(context,
                Math.min(4L * 1024 * 1024, SttAudioInputDecoder.MAX_INPUT_BYTES),
                context.cancellation()::throwIfCancelled).bytes();
        AudioData audio = WhisperOnnxSttProvider.wavPcm16Mono16k(wav);
        String language = language(context);
        if (!install.manifest().verifiedLanguages().contains(language)) {
            throw new IllegalArgumentException("language is not verified for this local profile");
        }
        long remaining = context.deadlineBudget().remainingBudgetMillis();
        if (remaining <= 0) throw new IllegalStateException("provider deadline elapsed before dispatch");
        BoundedProcessRunner.CancellationToken token = () -> context.cancellation().cancelled();
        LocalWhisperCppRunner.Transcription result =
                active.transcribe(wav, language, Duration.ofMillis(remaining), token);
        context.cancellation().throwIfCancelled();
        if (!install.stillCurrent()) {
            throw new IllegalStateException("local whisper.cpp model changed during inference");
        }
        String text = result.text();
        String outputSha = sha256(text.getBytes(StandardCharsets.UTF_8));
        String operationId = "whisper-cpp-local:" + attempt.jobId() + ":" + attempt.attemptNumber();
        String receiptId = "whisper-cpp-receipt:" + sha256(
                (operationId + "|" + attempt.requestFingerprint()).getBytes(StandardCharsets.UTF_8));
        String provenance = sha256((MODEL_KEY + "|" + result.modelSha256() + "|" + sha256(wav) + "|" + outputSha)
                .getBytes(StandardCharsets.UTF_8));

        Map<String, Object> transcriptResponse = new LinkedHashMap<>();
        transcriptResponse.put("sourceArtifactVersionRef", context.artifact().version().value());
        transcriptResponse.put("requestFingerprint", attempt.requestFingerprint());
        transcriptResponse.put("transcriptVersionRef", "transcript:v1:sha256:" + outputSha);
        transcriptResponse.put("glossaryDisposition", "NOT_REQUESTED");
        transcriptResponse.put("transcriptText", text);
        Map<String, Object> observations = new LinkedHashMap<>();
        observations.put("requestFingerprint", attempt.requestFingerprint());
        observations.put("glossaryApplication", Map.of("disposition", "NOT_REQUESTED"));
        observations.put("transcriptResponse", transcriptResponse);
        Map<String, Object> submission = new LinkedHashMap<>();
        submission.put("text", text);
        submission.put("language", language);
        submission.put("semanticObservations", observations);
        // Recognizer segment timings relative to the start of the decoded audio; supplementary, unqualified.
        List<Map<String, Object>> cues = new ArrayList<>();
        for (LocalWhisperCppRunner.Segment segment : result.segments()) {
            cues.add(Map.of("startMillis", segment.startMillis(), "endMillis", segment.endMillis(),
                    "text", segment.text()));
        }
        submission.put("cues", List.copyOf(cues));
        submission.put("modelSha256", result.modelSha256());
        List<Map<String, Object>> timed = WhisperOnnxSttProvider.sourceTickObservations(
                audio.getSampleCount(), audio.sampleRate(), context.artifact().metadata());
        if (!timed.isEmpty()) {
            submission.put("timedObservations", timed);
            submission.put("timingAvailable", true);
            Map<String, Object> segment = WhisperOnnxSttProvider.sourceTickSegment(
                    text, audio.getSampleCount(), audio.sampleRate(), context.artifact().metadata());
            if (segment != null) transcriptResponse.put("segments", List.of(segment));
        }
        context.cancellation().throwIfCancelled();
        return new ProviderSubmission(AttemptFinality.SUCCEEDED, operationId, receiptId, submission,
                provenance, Instant.now());
    }

    private static String language(ProcessingContext context) {
        Object intent = context.request().parameters().get("languageIntent");
        if (intent instanceof Map<?, ?> map && map.get("languageTag") instanceof String tag) {
            return Locale.forLanguageTag(tag).getLanguage();
        }
        return "en";
    }

    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    @Override public void close() { execution.shutdownNow(); }
}
