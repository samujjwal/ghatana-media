package com.ghatana.tts.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Local text-to-speech provider: Kokoro-82M (Apache-2.0, no voice cloning) on this host, per the owner decision
 * recorded in {@link LocalModelManifest#OWNER_DECISION_QUOTE}. Ready only while the server-owned manifest verified
 * every file digest (weights, config, voice packs, licence) and the sidecar runtime is present. Verification is
 * artifact identity and licence provenance, not voice/quality qualification, so {@link #productionEligible()}
 * stays false unless the manifest's own admission switch is flipped. In production-like profiles the runtime
 * additionally requires source-rights evidence for TEXT_TO_SPEECH, which this provider cannot supply.
 *
 * <p>Job results carry the audio inline only up to {@link #MAX_JOB_AUDIO_BYTES}; longer synthesis belongs to a
 * lane that registers an immutable artifact (for example the DEV_ONLY speech lane).</p>
 */
public final class LocalKokoroTtsProvider implements MediaProcessingProvider {
    public static final String PROVIDER_ID = "kokoro-local";
    public static final String MODEL_KEY = "kokoro-82m";
    public static final String DEFAULT_VOICE = "af_heart";
    public static final String ENV_MODEL_ROOT = "MEDIA_LOCAL_MODEL_ROOT";
    public static final String ENV_PYTHON = "MEDIA_KOKORO_PYTHON";
    public static final String ENV_SCRIPT = "MEDIA_KOKORO_SCRIPT";
    public static final int MAX_JOB_TEXT_CHARS = 400;
    public static final int MAX_JOB_AUDIO_BYTES = 1_572_864;
    private static final Duration MAX_RUN = Duration.ofMinutes(3);

    private final LocalModelInstall install;
    private final LocalKokoroSynthesizer synthesizer;
    private final ThreadPoolExecutor execution = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(4), task -> {
                Thread thread = new Thread(task, "media-kokoro-local");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());

    /** ServiceLoader entry: server-owned environment composition. An absent pin leaves the provider unready. */
    public LocalKokoroTtsProvider() {
        this(System.getenv());
    }

    LocalKokoroTtsProvider(Map<String, String> environment) {
        this(installFrom(environment), path(environment.get(ENV_PYTHON)), path(environment.get(ENV_SCRIPT)));
    }

    public LocalKokoroTtsProvider(LocalModelInstall install, Path python, Path script) {
        this.install = java.util.Objects.requireNonNull(install, "install");
        this.synthesizer = install.usable()
                ? LocalKokoroSynthesizer.forVerified(install.manifest(), install.modelDir(), python, script, MAX_RUN)
                : null;
    }

    private static LocalModelInstall installFrom(Map<String, String> environment) {
        String root = environment.get(ENV_MODEL_ROOT);
        if (root == null || root.isBlank()) return LocalModelInstall.absent(ENV_MODEL_ROOT + " is not set");
        return LocalModelInstall.inspectShared(Path.of(root).resolve("models").resolve(MODEL_KEY), MODEL_KEY,
                LocalModelManifest.Modality.TEXT_TO_SPEECH);
    }

    private static Path path(String value) { return value == null || value.isBlank() ? null : Path.of(value); }

    @Override public String providerId() { return PROVIDER_ID; }

    @Override public String providerVersion() {
        return install.usable() && install.manifest().runtime() != null ? install.manifest().runtime().version()
                : "unavailable";
    }

    @Override public String modelVersion(JobType modality) {
        return modality == JobType.TEXT_TO_SPEECH && install.usable() ? install.manifest().source().revision()
                : providerVersion();
    }

    @Override public Set<JobType> capabilities() { return Set.of(JobType.TEXT_TO_SPEECH); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return "local"; }
    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
    @Override public int priority() { return 7; }

    @Override public boolean ready() { return synthesizer != null && install.stillCurrent(); }

    @Override public boolean productionEligible() {
        return ready() && install.manifest().admission().productionEligible();
    }

    /** The verified, manifest-listed voices; empty while not ready. */
    public Set<String> voices() { return ready() ? synthesizer.voices() : Set.of(); }

    public LocalModelInstall install() { return install; }

    /** The verified synthesizer, or null while the provider is not ready. */
    public LocalKokoroSynthesizer synthesizer() { return ready() ? synthesizer : null; }

    /** Server-owned composition from an explicit environment map (shares the verified install with ServiceLoader). */
    public static LocalKokoroTtsProvider fromEnvironment(Map<String, String> environment) {
        return new LocalKokoroTtsProvider(environment);
    }

    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "local Kokoro TTS requires a durable Media provider attempt"));
    }

    @Override public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        try {
            return CompletableFuture.supplyAsync(() -> {
                try { return run(context, attempt); }
                catch (LocalTtsException failure) { throw new IllegalStateException(failure); }
            }, execution);
        } catch (RejectedExecutionException saturated) {
            return CompletableFuture.completedFuture(ProviderSubmission.unknown());
        }
    }

    private ProviderSubmission run(ProcessingContext context, ProviderAttemptContext attempt)
            throws LocalTtsException {
        context.cancellation().throwIfCancelled();
        if (!ready()) throw new IllegalStateException("local Kokoro profile is no longer verified");
        Object textValue = context.request().parameters().get("text");
        if (!(textValue instanceof String text) || text.isBlank() || text.length() > MAX_JOB_TEXT_CHARS) {
            throw new IllegalArgumentException("TTS_JOB_TEXT_INVALID: text must be 1-" + MAX_JOB_TEXT_CHARS
                    + " characters for the job lane");
        }
        Object voiceValue = context.request().parameters().get("voice");
        // The agent tool's literal default is not a voice pack; it means "the profile's default voice".
        String voice = voiceValue instanceof String v && !v.isBlank() && !"en-US-default".equals(v) ? v : DEFAULT_VOICE;
        double speed = context.request().parameters().get("speakingRate") instanceof Number n ? n.doubleValue() : 1.0;
        Object encoding = context.request().parameters().get("audioEncoding");
        if (encoding != null && !(encoding instanceof String e && ("LINEAR16".equals(e) || "WAV".equals(e)))) {
            throw new IllegalArgumentException(
                    "TTS_AUDIO_ENCODING_NOT_SUPPORTED: this local profile produces PCM16 WAV (LINEAR16/WAV) only");
        }
        Object pitch = context.request().parameters().get("pitch");
        if (pitch != null && !(pitch instanceof Number n && n.doubleValue() == 0.0)) {
            throw new IllegalArgumentException("TTS_PITCH_NOT_SUPPORTED: this local profile has no pitch control");
        }
        long remaining = context.deadlineBudget().remainingBudgetMillis();
        if (remaining <= 0) throw new IllegalStateException("provider deadline elapsed before dispatch");
        BoundedProcessRunner.CancellationToken token = () -> context.cancellation().cancelled();
        LocalKokoroSynthesizer.Synthesis result =
                synthesizer.synthesize(text, voice, speed, Duration.ofMillis(remaining), token);
        context.cancellation().throwIfCancelled();
        if (!install.stillCurrent()) throw new IllegalStateException("local Kokoro model changed during synthesis");
        byte[] wav = result.wav();
        if (wav.length > MAX_JOB_AUDIO_BYTES) {
            throw new IllegalArgumentException("TTS_JOB_OUTPUT_TOO_LARGE: use an artifact-registering lane");
        }
        String audioSha = sha256(wav);
        String operationId = "kokoro-local:" + attempt.jobId() + ":" + attempt.attemptNumber();
        String receiptId = "kokoro-receipt:" + sha256(
                (operationId + "|" + attempt.requestFingerprint()).getBytes(StandardCharsets.UTF_8));
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("audioContentType", "audio/wav");
        value.put("audioEncoding", "LINEAR16");
        value.put("sampleRate", result.sampleRate());
        value.put("durationMillis", result.durationMillis());
        value.put("sizeBytes", wav.length);
        value.put("audioSha256", audioSha);
        value.put("audioBase64", Base64.getEncoder().encodeToString(wav));
        value.put("voice", result.voice());
        value.put("modelId", install.manifest().modelId());
        value.put("modelSha256", result.modelSha256());
        value.put("voiceCloning", "NOT_SUPPORTED");
        String provenance = sha256((MODEL_KEY + "|" + result.modelSha256() + "|" + sha256(
                text.getBytes(StandardCharsets.UTF_8)) + "|" + audioSha).getBytes(StandardCharsets.UTF_8));
        return new ProviderSubmission(AttemptFinality.SUCCEEDED, operationId, receiptId, value, provenance,
                Instant.now());
    }

    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    @Override public void close() { execution.shutdownNow(); }
}
