package com.ghatana.media.integration;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEngineLifecycle;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;

import java.time.Duration;
import java.time.Instant;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Test-only ServiceLoader fixtures. Descriptors are installed on the child JVM classpath only. */
public final class MediaLauncherProcessFixtures {
    public static final String TENANT = "tenant-launcher-stt-fixture";
    public static final String PRINCIPAL = "media-local-development";
    public static final String PROVIDER_ID = "launcher-synthetic-stt-fixture";
    public static final String BLOCKING_PROVIDER_ID = "launcher-blocking-transcode-fixture";
    public static final String FALLBACK_PROVIDER_ID = "launcher-fallback-transcode-fixture";
    public static final String PROFILE_ID = "launcher-synthetic-profile";
    public static final String PROFILE_DIGEST = "sha256:" + "b".repeat(64);

    private MediaLauncherProcessFixtures() { }

    /** ALLOW is limited to the one synthetic source test identity and source-processing action. */
    public static final class Policy implements PolicyEngine {
        @Override public CompletionStage<PolicyDecisionRecord> evaluate(PolicyEvaluationRequest request) {
            String fixtureArtifactId = System.getenv("MEDIA_FIXTURE_ARTIFACT_ID");
            String fixtureSourceVersion = System.getenv("MEDIA_FIXTURE_SOURCE_VERSION");
            boolean allowed = TENANT.equals(request.tenantId())
                    && PRINCIPAL.equals(request.principalId())
                    && "CALL_EXTERNAL".equals(request.actionClass())
                    && "MEDIA_SOURCE_ARTIFACT".equals(request.targetType())
                    && fixtureArtifactId != null && fixtureArtifactId.equals(request.targetId())
                    && "SPEECH_TO_TEXT".equals(request.attributes().get("operation"))
                    && fixtureSourceVersion != null
                    && fixtureSourceVersion.equals(request.attributes().get("sourceVersion"))
                    && "transcription".equals(request.attributes().get("purpose"))
                    && "NOT_APPLICABLE_HUMAN_CONSENT".equals(request.attributes().get("consentDisposition"))
                    && "fixture:launcher-synthetic-nonhuman".equals(request.attributes().get("provenanceRef"));
            PolicyDecisionOutcome outcome = allowed ? PolicyDecisionOutcome.ALLOW : PolicyDecisionOutcome.DENY;
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(), request.targetType(),
                    request.targetId(), request.toolId(), request.criticality(), request.reversibility(),
                    request.attributes(), Instant.now(), request.correlationId(), request.verifiedContext());
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "launcher-process-fixture-policy", outcome,
                    List.of("test-only:launcher-process-fixture"), List.of("fixture-rule"),
                    List.of("isolated launcher process fixture"), context, Instant.now(), null,
                    "launcher-process-fixture-v1", List.of(allowed
                            ? PolicyReasonCode.POLICY_ALLOWED : PolicyReasonCode.POLICY_DENIED)));
        }

        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("launcher-process-fixture-v1".equals(policyId));
        }
        @Override public CompletionStage<Boolean> policyExists(String policyId, String version) {
            return policyExists(policyId);
        }
        @Override public boolean isOpen() { return true; }
        @Override public void close() { }
        @Override public PolicyEngineLifecycle.State lifecycleState() { return PolicyEngineLifecycle.State.OPEN; }
        @Override public long inFlightEvaluations() { return 0; }
        @Override public PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new PolicyEngineLifecycle.Result(PolicyEngineLifecycle.State.DRAINED, 0);
        }
        @Override public PolicyEngineLifecycle.Result close(Duration timeout) {
            return new PolicyEngineLifecycle.Result(PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }

    /** Deterministic synthetic provider: it consumes no audio bytes and performs no external I/O. */
    public static final class Stt implements MediaProcessingProvider {
        @Override public String providerId() { return PROVIDER_ID; }
        @Override public String providerVersion() { return "fixture-v1"; }
        @Override public String modelVersion(JobType type) { return "synthetic-fixture-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
        @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
            return Optional.of(new MediaSpeechToTextAdmission.Profile(
                    PROVIDER_ID, "fixture-v1", PROFILE_ID, "v1", PROFILE_DIGEST,
                    MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                    Set.of("en-US"), false,
                    MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                    "test-fixture-only"));
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return -100; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(
                    new AssertionError("durable launcher dispatch must use processAttempt"));
        }
        @Override public CompletableFuture<ProviderSubmission> processAttempt(
                ProcessingContext context, ProviderAttemptContext attempt) {
            String text = "synthetic launcher transcript";
            String fingerprint = attempt.requestFingerprint();
            return CompletableFuture.completedFuture(new ProviderSubmission(
                    AttemptFinality.SUCCEEDED, "op-launcher-fixture", "receipt-launcher-fixture",
                    Map.of("text", text,
                            "semanticObservations", Map.of(
                                    "requestFingerprint", fingerprint,
                                    "glossaryApplication", Map.of("disposition", "NOT_REQUESTED"),
                                    "transcriptResponse", Map.of(
                                            "sourceArtifactVersionRef", context.artifact().version().value(),
                                            "requestFingerprint", fingerprint,
                                            "transcriptVersionRef", "transcript-launcher-fixture-v1",
                                            "glossaryDisposition", "NOT_REQUESTED",
                                            "transcriptText", text))),
                    "b".repeat(64), Instant.now()));
        }
    }

    /**
     * Process-boundary fixture that records dispatch entry and never fabricates provider finality.
     * The marker is test coordination only; it is not an external effect receipt.
     */
    public static final class BlockingTranscode implements MediaProcessingProvider {
        @Override public String providerId() { return BLOCKING_PROVIDER_ID; }
        @Override public String providerVersion() { return "fixture-v1"; }
        @Override public String modelVersion(JobType type) { return "process-recovery-fixture-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
            return Optional.empty();
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return -100; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(
                    new AssertionError("durable process-recovery fixture must use processAttempt"));
        }

        @Override public CompletableFuture<ProviderSubmission> processAttempt(
                ProcessingContext context, ProviderAttemptContext attempt) {
            String markerValue = System.getenv("MEDIA_FIXTURE_PROVIDER_DISPATCH_MARKER");
            if (markerValue == null || markerValue.isBlank()) {
                return CompletableFuture.failedFuture(
                        new IllegalStateException("process-recovery fixture marker is required"));
            }
            try {
                Files.writeString(Path.of(markerValue),
                        attempt.requestId() + "," + attempt.attemptNumber() + "\n",
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException failure) {
                return CompletableFuture.failedFuture(failure);
            }
            return new CompletableFuture<>();
        }
    }

    /** Available alternate used to prove an ambiguous durable attempt is never silently replayed. */
    public static final class AvailableFallbackTranscode implements MediaProcessingProvider {
        @Override public String providerId() { return FALLBACK_PROVIDER_ID; }
        @Override public String providerVersion() { return "fixture-fallback-v1"; }
        @Override public String modelVersion(JobType type) { return "fixture-fallback-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public Optional<MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
            return Optional.empty();
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 100; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(
                    new AssertionError("durable fallback fixture must use processAttempt"));
        }
        @Override public CompletableFuture<ProviderSubmission> processAttempt(
                ProcessingContext context, ProviderAttemptContext attempt) {
            String markerValue = System.getenv("MEDIA_FIXTURE_FALLBACK_PROVIDER_MARKER");
            if (markerValue != null && !markerValue.isBlank()) {
                try {
                    Files.writeString(Path.of(markerValue), attempt.requestId() + "\n",
                            StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                } catch (IOException failure) {
                    return CompletableFuture.failedFuture(failure);
                }
            }
            return CompletableFuture.completedFuture(new ProviderSubmission(
                    AttemptFinality.SUCCEEDED, "fallback-operation", "fallback-receipt",
                    Map.of("fixtureOutput", "fallback-must-not-run"), "c".repeat(64), Instant.now()));
        }
    }
}
