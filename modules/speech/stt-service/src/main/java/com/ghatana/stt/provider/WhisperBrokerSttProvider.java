package com.ghatana.stt.provider;

import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.WhisperComputeBrokerClient;
import com.ghatana.media.runtime.WhisperComputeClient;
import com.ghatana.media.runtime.WhisperComputeContracts;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import com.ghatana.stt.service.SttAudioInputDecoder;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.AudioData;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** STT adapter for the authenticated host Whisper compute broker. */
public final class WhisperBrokerSttProvider implements MediaProcessingProvider {
    private static final String RECEIPT_PREFIX = "whisper-broker-v1:";

    private final Path socketPath;
    private final Path tokenPath;
    private final String profileId;
    private final String modelRevision;
    private final String modelSha256;
    private final String configurationDigest;
    private final WhisperComputeClient broker;
    private final boolean injectedClient;
    private final ThreadPoolExecutor execution = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(16), task -> {
                Thread thread = new Thread(task, "media-whisper-broker-call");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());
    private final ThreadPoolExecutor cancellationExecution = new ThreadPoolExecutor(1, 1, 0L,
            TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8), task -> {
                Thread thread = new Thread(task, "media-whisper-broker-cancel");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());
    private final ThreadPoolExecutor reconciliationExecution = new ThreadPoolExecutor(1, 1, 0L,
            TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4), task -> {
                Thread thread = new Thread(task, "media-whisper-broker-status");
                thread.setDaemon(true);
                return thread;
            }, new ThreadPoolExecutor.AbortPolicy());

    /** Server-owned environment composition. An absent or incomplete pin stays unavailable. */
    public WhisperBrokerSttProvider() {
        this(System.getenv());
    }

    WhisperBrokerSttProvider(Map<String, String> environment) {
        this(path(environment, "MEDIA_WHISPER_BROKER_SOCKET"),
                path(environment, "MEDIA_WHISPER_BROKER_TOKEN_FILE"),
                environment.getOrDefault("MEDIA_WHISPER_BROKER_PROFILE_ID", ""),
                environment.getOrDefault("MEDIA_WHISPER_BROKER_MODEL_REVISION", ""),
                environment.getOrDefault("MEDIA_WHISPER_BROKER_MODEL_SHA256", ""),
                environment.getOrDefault("MEDIA_WHISPER_BROKER_CONFIGURATION_SHA256", ""), null);
    }

    WhisperBrokerSttProvider(Path socketPath, Path tokenPath, String profileId,
            String modelRevision, String modelSha256, String configurationDigest, WhisperComputeClient broker) {
        this(socketPath, tokenPath, profileId, modelRevision, modelSha256, configurationDigest, broker, false);
    }

    WhisperBrokerSttProvider(String profileId, String modelRevision, String modelSha256,
            String configurationDigest, WhisperComputeClient broker) {
        this(null, null, profileId, modelRevision, modelSha256, configurationDigest,
                java.util.Objects.requireNonNull(broker, "broker"), true);
    }

    private WhisperBrokerSttProvider(Path socketPath, Path tokenPath, String profileId,
            String modelRevision, String modelSha256, String configurationDigest,
            WhisperComputeClient broker, boolean injectedClient) {
        this.socketPath = socketPath;
        this.tokenPath = tokenPath;
        this.profileId = normalized(profileId);
        this.modelRevision = normalized(modelRevision);
        this.modelSha256 = normalized(modelSha256);
        this.configurationDigest = normalized(configurationDigest);
        this.broker = broker == null && socketPath != null && tokenPath != null
                ? new WhisperComputeBrokerClient(socketPath, tokenPath) : broker;
        this.injectedClient = injectedClient;
    }

    @Override public String providerId() { return "whisper-host-broker"; }
    @Override public String providerVersion() { return "broker-v1"; }
    @Override public String modelVersion(JobType modality) {
        return modality == JobType.SPEECH_TO_TEXT ? modelRevision : providerVersion();
    }
    @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return "local"; }
    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
    @Override public int priority() { return 5; }

    /** A configured broker pin is still only a candidate; real quality and rights evidence gate production. */
    @Override public boolean productionEligible() { return false; }

    @Override public boolean ready() {
        if (broker == null || (!injectedClient && (socketPath == null || tokenPath == null))
                || !validProfileId(profileId) || modelRevision.isBlank()
                || !modelSha256.matches("[0-9a-f]{64}")
                || !configurationDigest.matches("[0-9a-f]{64}")) return false;
        if (injectedClient) return true;
        try {
            return Files.exists(socketPath)
                    && Files.getPosixFilePermissions(tokenPath).equals(
                            java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        } catch (Exception unavailable) {
            return false;
        }
    }

    @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
        if (!validProfileId(profileId) || modelRevision.isBlank()
                || !configurationDigest.matches("[0-9a-f]{64}")) return Optional.empty();
        return Optional.of(new MediaSpeechToTextAdmission.Profile(providerId(), providerVersion(),
                profileId, modelRevision, "sha256:" + configurationDigest,
                MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en", "hi", "ne"), false,
                MediaSpeechToTextAdmission.TimingDisposition.NOT_SUPPLIED, ""));
    }

    @Override public Optional<ProviderAttemptIdentity> prepareAttemptIdentity(
            MediaRuntimeContracts.ProcessingJobRequest request,
            MediaRuntimeContracts.MediaArtifact artifact,
            ProviderAttemptContext attempt) {
        if (!validProfileId(profileId) || modelSha256.isBlank()) return Optional.empty();
        UUID invocation = invocationId(attempt);
        String locale = requestedLocale(request);
        String sourceDigest = artifact.sha256();
        return Optional.of(new ProviderAttemptIdentity(invocation.toString(),
                RECEIPT_PREFIX + profileId + ":" + locale + ":" + sourceDigest));
    }

    @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(new UnsupportedOperationException(
                "Whisper broker requires a durable Media provider attempt"));
    }

    @Override public CompletableFuture<ProviderSubmission> processAttempt(
            ProcessingContext context, ProviderAttemptContext attempt) {
        try {
            return CompletableFuture.supplyAsync(() -> {
                try { return executeAttempt(context, attempt); }
                catch (java.io.IOException ambiguous) { return ProviderSubmission.unknown(); }
            }, execution);
        } catch (java.util.concurrent.RejectedExecutionException saturated) {
            return CompletableFuture.completedFuture(ProviderSubmission.unknown());
        }
    }

    private ProviderSubmission executeAttempt(ProcessingContext context, ProviderAttemptContext attempt)
            throws java.io.IOException {
        try {
            context.cancellation().throwIfCancelled();
            if (context.deadlineBudget().expired()) return preDispatchNoEffect(attempt, "EXPIRED_AT_ENTRY");
            if (!ready() || attempt.providerOperationId().isBlank()) {
                throw new IllegalStateException("Whisper broker profile or durable invocation identity is unavailable");
            }
            if (context.sourceAuthorization() == null) {
                throw new IllegalStateException("STT provider invoked without admitted source authorization");
            }
            byte[] wav = WhisperOnnxSttProvider.readVerifiedSourceContent(context,
                    WhisperComputeContracts.MAX_WAV_BYTES, context.cancellation()::throwIfCancelled).bytes();
            context.cancellation().throwIfCancelled();
            if (context.deadlineBudget().expired()) return preDispatchNoEffect(attempt, "EXPIRED_DURING_STAGING");
            AudioData decoded = SttAudioInputDecoder.decode(wav, AudioFormat.WAV, 16_000);
            if (decoded.sampleRate() != 16_000 || decoded.channels() != 1 || decoded.bitsPerSample() != 16
                    || decoded.format() != AudioFormat.PCM) {
                throw new IllegalArgumentException("Whisper source must be mono 16kHz signed 16-bit PCM WAV");
            }
            String inputDigest = sha256(wav);
            String locale = requestedLocale(context);
            UUID invocation = UUID.fromString(attempt.providerOperationId());
            context.cancellation().throwIfCancelled();
            long remainingBudget = context.deadlineBudget().remainingBudgetMillis();
            if (remainingBudget == 0) return preDispatchNoEffect(attempt, "EXPIRED_BEFORE_DISPATCH");
            Result result;
            AtomicReference<Result> cancelResult = new AtomicReference<>();
            AutoCloseable cancelRegistration = context.cancellation().onCancel(() -> {
                try {
                    cancellationExecution.execute(() -> {
                        try { cancelResult.set(broker.cancel(invocation, profileId, locale, inputDigest)); }
                        catch (Exception ignored) { }
                    });
                } catch (java.util.concurrent.RejectedExecutionException full) {
                    // No cancellation result means the provider outcome stays UNKNOWN.
                }
            });
            try {
                result = broker.execute(new Request(invocation, profileId, locale, inputDigest, wav,
                        remainingBudget), context.deadlineBudget());
            } finally {
                try { cancelRegistration.close(); } catch (Exception ignored) { }
            }
            if (context.cancellation().cancelled()) {
                Result cancelled = cancelResult.get();
                if (confirmedStop(cancelled, invocation, profileId, locale, inputDigest)) {
                    return new ProviderSubmission(
                            AttemptFinality.NO_EFFECT_PROVEN, attempt.providerOperationId(),
                            attempt.providerReceiptId(), Map.of(), sha256((attempt.providerOperationId()
                                    + "|STOPPED|" + inputDigest).getBytes(StandardCharsets.UTF_8)), Instant.now());
                }
                return ProviderSubmission.unknown();
            }
            if (!exactIdentity(result, invocation, profileId, inputDigest)) return ProviderSubmission.unknown();
            if (notDispatched(result, invocation, profileId, inputDigest)) {
                return new ProviderSubmission(AttemptFinality.NO_EFFECT_PROVEN,
                        attempt.providerOperationId(), attempt.providerReceiptId(), Map.of(),
                        sha256((attempt.providerOperationId() + "|NOT_ADMITTED|" + inputDigest)
                                .getBytes(StandardCharsets.UTF_8)), Instant.now());
            }
            if (result.status() != Status.SUCCESS || !result.complete() || !result.endOfTask()
                    || result.tokenLimitReached() || !profileId.equals(result.profileId())
                    || !inputDigest.equals(result.inputSha256()) || !modelSha256.equals(result.modelSha256())) {
                return ProviderSubmission.unknown();
            }
            String outputDigest = sha256(result.transcript().getBytes(StandardCharsets.UTF_8));
            String versionRef = "transcript:v1:sha256:" + outputDigest;
            Map<String, Object> response = Map.of(
                    "sourceArtifactVersionRef", context.artifact().version().value(),
                    "requestFingerprint", attempt.requestFingerprint(),
                    "transcriptVersionRef", versionRef,
                    "glossaryDisposition", "NOT_REQUESTED",
                    "transcriptText", result.transcript());
            Map<String, Object> observations = Map.of(
                    "requestFingerprint", attempt.requestFingerprint(),
                    "glossaryApplication", Map.of("disposition", "NOT_REQUESTED"),
                    "transcriptResponse", response);
            Map<String, Object> submission = Map.of("text", result.transcript(), "language", locale,
                    "semanticObservations", observations);
            return new ProviderSubmission(AttemptFinality.SUCCEEDED,
                    attempt.providerOperationId(), attempt.providerReceiptId(), submission,
                    sha256((attempt.providerOperationId() + "|" + inputDigest + "|" + outputDigest
                            + "|" + result.modelSha256()).getBytes(StandardCharsets.UTF_8)), Instant.now());
        } catch (RuntimeException failure) {
            throw failure;
        }
    }

    private static ProviderSubmission preDispatchNoEffect(ProviderAttemptContext attempt, String reason) {
        return new ProviderSubmission(AttemptFinality.NO_EFFECT_PROVEN,
                attempt.providerOperationId(), attempt.providerReceiptId(), Map.of(),
                sha256((attempt.providerOperationId() + "|" + reason).getBytes(StandardCharsets.UTF_8)), Instant.now());
    }

    @Override public CompletableFuture<ProviderAttemptObservation> reconcileAttempt(ProviderAttemptQuery query) {
        return reconcileAttempt(query, providerId());
    }

    /** Reconciles a wrapped provider's durable identity while preserving direct-provider binding. */
    CompletableFuture<ProviderAttemptObservation> reconcileAttempt(
            ProviderAttemptQuery query, String expectedProviderId) {
        try {
            // A receipt with a matching profile/source is not sufficient to answer a query
            // owned by another provider. Wrappers pass their public durable provider ID;
            // direct calls bind to this provider's own ID above.
            if (!expectedProviderId.equals(query.providerId())) {
                return CompletableFuture.completedFuture(unknownObservation(query));
            }
            Receipt receipt = parseReceipt(query.providerReceiptId());
            if (!profileId.equals(receipt.profileId()) || broker == null) {
                return CompletableFuture.completedFuture(unknownObservation(query));
            }
            CompletableFuture<ProviderAttemptObservation> result = new CompletableFuture<>();
            java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<?>> taskRef =
                    new java.util.concurrent.atomic.AtomicReference<>();
            result.whenComplete((ignored, failure) -> {
                if (result.isCancelled()) {
                    java.util.concurrent.Future<?> task = taskRef.get();
                    if (task != null) task.cancel(true);
                }
            });
            try {
                java.util.concurrent.Future<?> task = reconciliationExecution.submit(() ->
                        result.complete(reconcileAttemptNow(query, receipt)));
                taskRef.set(task);
                if (result.isCancelled()) task.cancel(true);
            } catch (java.util.concurrent.RejectedExecutionException saturated) {
                result.complete(unknownObservation(query));
            }
            return result;
        } catch (Exception uncertain) {
            return CompletableFuture.completedFuture(unknownObservation(query));
        }
    }

    private ProviderAttemptObservation reconcileAttemptNow(ProviderAttemptQuery query, Receipt receipt) {
        try {
            Result result = broker.status(UUID.fromString(query.providerOperationId()), receipt.profileId(),
                    receipt.locale(), receipt.sourceSha256());
            if (!exactIdentity(result, UUID.fromString(query.providerOperationId()), receipt.profileId(),
                    receipt.sourceSha256()) || result.status() != Status.SUCCESS
                    || !result.complete() || !result.endOfTask()
                    || result.tokenLimitReached() || !modelSha256.equals(result.modelSha256())
                    || !receipt.profileId().equals(result.profileId())
                    || !receipt.sourceSha256().equals(result.inputSha256())) return unknownObservation(query);
            String outputDigest = sha256(result.transcript().getBytes(StandardCharsets.UTF_8));
            String versionRef = "transcript:v1:sha256:" + outputDigest;
            Map<String, Object> response = Map.of(
                    "sourceArtifactVersionRef", "sha256:" + receipt.sourceSha256(),
                    "requestFingerprint", query.requestFingerprint(), "transcriptVersionRef", versionRef,
                    "glossaryDisposition", "NOT_REQUESTED", "transcriptText", result.transcript());
            Map<String, Object> observations = Map.of("requestFingerprint", query.requestFingerprint(),
                    "glossaryApplication", Map.of("disposition", "NOT_REQUESTED"),
                    "transcriptResponse", response);
            Map<String, Object> value = Map.of("text", result.transcript(), "language", receipt.locale(),
                    "semanticObservations", observations);
            String provenance = sha256((query.providerOperationId() + "|" + receipt.sourceSha256()
                    + "|" + outputDigest + "|" + result.modelSha256()).getBytes(StandardCharsets.UTF_8));
            return new ProviderAttemptObservation(query, AttemptFinality.SUCCEEDED,
                    query.providerReceiptId(), value, provenance, Instant.now());
        } catch (Exception uncertain) {
            return unknownObservation(query);
        }
    }

    private static ProviderAttemptObservation unknownObservation(ProviderAttemptQuery query) {
        return new ProviderAttemptObservation(query, AttemptFinality.UNKNOWN,
                query.providerReceiptId(), Map.of(), "", Instant.now());
    }

    static boolean confirmedStop(Result result, UUID invocation, String profile, String locale, String digest) {
        // The public compute contract does not define DEADLINE_EXCEEDED as proof that no result
        // or effect occurred. Without a distinct authenticated no-effect state, cancellation is
        // therefore always conservative; exact identity alone cannot establish finality.
        return false;
    }

    static boolean notDispatched(Result result, UUID invocation, String profile, String digest) {
        return exactIdentity(result, invocation, profile, digest)
                // DEADLINE_EXCEEDED is not a no-effect proof: the broker may have started
                // inference before the deadline elapsed. Only an explicit admission rejection
                // is currently defined as proof that dispatch did not occur.
                && result.status() == Status.NOT_ADMITTED
                && !result.complete() && !result.endOfTask() && !result.tokenLimitReached()
                && result.transcript().isEmpty();
    }

    private static boolean exactIdentity(Result result, UUID invocation, String profile, String digest) {
        return result != null && invocation.equals(result.invocationId()) && profile.equals(result.profileId())
                && digest.equals(result.inputSha256());
    }

    @Override public void close() {
        execution.shutdownNow();
        cancellationExecution.shutdownNow();
        reconciliationExecution.shutdownNow();
    }

    private static UUID invocationId(ProviderAttemptContext attempt) {
        byte[] hash = digest((attempt.tenantId() + "\n" + attempt.jobId() + "\n" + attempt.requestId()
                + "\n" + attempt.attemptNumber() + "\n" + attempt.fencingToken() + "\n"
                + attempt.requestFingerprint()).getBytes(StandardCharsets.UTF_8));
        hash[6] = (byte) ((hash[6] & 0x0f) | 0x50);
        hash[8] = (byte) ((hash[8] & 0x3f) | 0x80);
        java.nio.ByteBuffer bytes = java.nio.ByteBuffer.wrap(hash);
        return new UUID(bytes.getLong(), bytes.getLong());
    }

    private static String requestedLocale(ProcessingContext context) {
        return requestedLocale(context.request());
    }

    private static String requestedLocale(MediaRuntimeContracts.ProcessingJobRequest request) {
        Object intent = request.parameters().get("languageIntent");
        if (intent instanceof Map<?, ?> map && map.get("languageTag") instanceof String tag) {
            return Locale.forLanguageTag(tag).toLanguageTag();
        }
        return "en";
    }

    private record Receipt(String profileId, String locale, String sourceSha256) { }
    private static Receipt parseReceipt(String value) {
        String[] fields = value.split(":", -1);
        if (fields.length != 4 || !"whisper-broker-v1".equals(fields[0])
                || !fields[3].matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid broker receipt");
        return new Receipt(fields[1], fields[2], fields[3]);
    }

    private static String sha256(byte[] value) { return HexFormat.of().formatHex(digest(value)); }
    private static byte[] digest(byte[] value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static Path path(Map<String, String> environment, String name) {
        String value = environment.get(name);
        return value == null || value.isBlank() ? null : Path.of(value);
    }
    private static String normalized(String value) { return value == null ? "" : value.trim(); }
    private static boolean validProfileId(String value) {
        return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    }
}
