package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaJobRequestFingerprint;
import com.ghatana.media.runtime.MediaJobRequestFingerprint.ProviderDescriptor;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaRuntimeJobGovernanceTest {

    @Test
    void submitPolicyDenialCreatesAuditableFailedJobAndCallsNoProvider() throws Exception {
        var root = Files.createTempDirectory("media-policy-preflight-");
        var store = new LocalMediaRuntimeSupport.JobStore();
        var providerCalls = new AtomicInteger();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "external-policy-test"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us-west-2"; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of());
            }
        };
        MediaConsentAuthority authority = new MediaConsentAuthority() {
            @Override public String authorityId() { return "revoked-consent"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public ConsentDecision verify(String tenant, String principal,
                    MediaGovernanceContext governance, String operation) {
                return ConsentDecision.unverified();
            }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root), store,
                new LocalMediaRuntimeSupport.StreamStore(), authority,
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            var artifact = artifact(runtime);
            var governance = new MediaGovernanceContext("revoked", "vision-analysis",
                    DataClassification.CONFIDENTIAL, "us", Set.of("us-west-2"), true,
                    "short-lived", false, false, "", BiometricSensitivity.NONE, AutomationRisk.ASSISTIVE);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-policy-denied", "tenant-a", "principal-a", "correlation-policy",
                    artifact.artifactId(), null, JobType.VISION, "external-policy-test", Map.of(), governance));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_BLOCKED_BEFORE_PROVIDER");
            assertThat(runtime.jobs("tenant-a", "principal-a", 100)).extracting(job -> job.jobId()).contains(accepted.jobId());
            assertThat(providerCalls).hasValue(0);

        } finally {
            runtime.close();
        }
    }

    @Test
    void providerPolicyDenialAfterHandoffRemainsUnknownAndNeverFallsBack() throws Exception {
        for (boolean asynchronous : List.of(false, true)) {
            var root = Files.createTempDirectory("media-provider-denial-after-handoff-");
            var calls = new AtomicInteger();
            var fallbackCalls = new AtomicInteger();
            MediaProcessingProvider handedOff = new MediaProcessingProvider() {
                @Override public String providerId() { return "external-denial-" + asynchronous; }
                @Override public String providerVersion() { return "v1"; }
                @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
                @Override public boolean ready() { return true; }
                @Override public boolean productionEligible() { return false; }
                @Override public int priority() { return 0; }
                @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
                @Override public String processingRegion() { return "us"; }
                @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention
                        providerDataRetention() {
                    return com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE;
                }
                @Override public boolean fallbackEligible(Throwable failure) { return true; }
                @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                    calls.incrementAndGet();
                    var denied = new com.ghatana.media.runtime.MediaCapabilityNotAdmittedException(
                            com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.Reason.POLICY_DENIED,
                            "provider-policy", "provider refused after receiving the request");
                    if (asynchronous) return CompletableFuture.failedFuture(denied);
                    throw denied;
                }
            };
            MediaProcessingProvider fallback = provider(
                    "fallback", 1, fallbackCalls, CompletableFuture.completedFuture(Map.of()),
                    CancellationOutcome.UNSUPPORTED, true);
            var runtime = runtime(root, List.of(handedOff, fallback), consentAuthority(allowedConsent()));
            try {
                var artifact = artifact(runtime);
                var accepted = runtime.submit(new ProcessingJobRequest(
                        "request-after-handoff-" + asynchronous, "tenant-a", "principal-a",
                        "correlation-after-handoff", artifact.artifactId(), JobType.VISION,
                        "", Map.of(), governance()));
                var terminal = awaitTerminal(runtime, accepted.jobId());
                assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
                assertThat(terminal.result()).containsEntry("providerOutcome", "UNKNOWN");
                assertThat(calls).hasValue(1);
                assertThat(fallbackCalls).hasValue(0);
            } finally {
                runtime.close();
            }
        }
    }

    @Test
    void externalProviderTimeoutSignalsCancellationAndNeverFallsBack() throws Exception {
        var root = Files.createTempDirectory("media-external-timeout-after-handoff-");
        var pending = new CompletableFuture<Map<String, Object>>();
        var cancellation = new AtomicReference<com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation>();
        var calls = new AtomicInteger();
        var fallbackCalls = new AtomicInteger();
        MediaProcessingProvider external = new MediaProcessingProvider() {
            @Override public String providerId() { return "external-timeout"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention
                    providerDataRetention() {
                return com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE;
            }
            @Override public boolean fallbackEligible(Throwable failure) { return true; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                cancellation.set(context.cancellation());
                return pending;
            }
        };
        MediaProcessingProvider fallback = provider(
                "timeout-fallback", 1, fallbackCalls, CompletableFuture.completedFuture(Map.of("fallback", true)),
                CancellationOutcome.UNSUPPORTED, true);
        var runtime = runtime(root, List.of(external, fallback), consentAuthority(allowedConsent()));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-external-timeout", "tenant-a", "principal-a", "correlation-timeout",
                    artifact.artifactId(), null, JobType.VISION, "", Map.of(), governance()));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.result()).containsEntry("providerOutcome", "UNKNOWN");
            assertThat(calls).hasValue(1);
            assertThat(cancellation.get()).isNotNull();
            assertThat(cancellation.get().cancelled()).isTrue();
            assertThat(pending.isCancelled()).isTrue();
            assertThat(fallbackCalls).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void exactIdempotentSubmissionReplaysAndChangedNormalizedFieldsConflict() throws Exception {
        var root = Files.createTempDirectory("media-submission-digest-");
        AtomicReference<String> providerVersion = new AtomicReference<>("local-v1");
        var localProvider = new MediaProcessingProvider() {
            @Override public String providerId() { return "local"; }
            @Override public String providerVersion() { return providerVersion.get(); }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(Map.of("labels", List.of("safe")));
            }
        };
        var runtime = runtime(root, List.of(localProvider));
        try {
            var artifact = artifact(runtime);
            var request = new ProcessingJobRequest(
                    "request-digest", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "local", Map.of("threshold", 0.5));
            var accepted = runtime.submit(request);
            var replay = runtime.submit(request);

            assertThat(replay.jobId()).isEqualTo(accepted.jobId());
            assertThatThrownBy(() -> runtime.submit(new ProcessingJobRequest(
                    "request-digest", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "local", Map.of("threshold", 0.6))))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("different submission");

            providerVersion.set("local-v2");
            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("different submission");

        } finally {
            runtime.close();
        }
    }

    @Test
    void normalizedSubmissionDigestIncludesTheSelectedProviderPlan() {
        AtomicReference<String> providerVersion = new AtomicReference<>("provider-v1");
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "provider"; }
            @Override public String providerVersion() { return providerVersion.get(); }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(Map.of());
            }
        };
        Map<String, Object> firstParameters = new java.util.LinkedHashMap<>();
        firstParameters.put("labels", List.of("one", "two"));
        firstParameters.put("threshold", 0.5);
        Map<String, Object> sameParametersDifferentOrder = new java.util.LinkedHashMap<>();
        sameParametersDifferentOrder.put("threshold", 0.5);
        sameParametersDifferentOrder.put("labels", List.of("one", "two"));
        var first = new ProcessingJobRequest("digest", "tenant-a", "principal-a", "correlation-a",
                "artifact-a", "sha256:" + "a".repeat(64), JobType.VISION, "provider", firstParameters,
                governance());
        var reordered = new ProcessingJobRequest("digest", "tenant-a", "principal-a", "correlation-a",
                "artifact-a", "sha256:" + "a".repeat(64), JobType.VISION, "provider", sameParametersDifferentOrder,
                governance());

        String firstDigest = MediaSubmissionDigest.compute(first, first.expectedArtifactVersion(), List.of(provider));
        String reorderedDigest = MediaSubmissionDigest.compute(
                reordered, reordered.expectedArtifactVersion(), List.of(provider));
        providerVersion.set("provider-v2");
        String changedProviderDigest = MediaSubmissionDigest.compute(
                first, first.expectedArtifactVersion(), List.of(provider));

        assertThat(firstDigest).isEqualTo(reorderedDigest).matches("[0-9a-f]{64}");
        assertThat(changedProviderDigest).isNotEqualTo(firstDigest);
    }

    @Test
    void currentConsentPermissionsAreEnforcedBeforeCustomExternalProviderIo() throws Exception {
        AtomicInteger providerCalls = new AtomicInteger();
        var provider = externalProvider(providerCalls);
        var authority = consentAuthority(allowedConsent());
        var root = Files.createTempDirectory("media-external-permission-");
        var runtime = runtime(root, List.of(provider), authority);
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-external-allowed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "external-test", Map.of(), governance()));
            var terminal = awaitTerminal(runtime, accepted.jobId());

            assertThat(terminal.status()).as("terminal result %s", terminal).isEqualTo(JobStatus.COMPLETED);
            assertThat(providerCalls).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void providerRetentionRequiresVerifiedAuthorityPermission() throws Exception {
        var retention = com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.TRANSIENT;
        AtomicInteger deniedCalls = new AtomicInteger();
        var deniedRuntime = runtime(Files.createTempDirectory("media-retention-denied-"),
                List.of(retainingExternalProvider("retaining-denied", deniedCalls, retention)),
                consentAuthority(allowedConsent()));
        try {
            var artifact = artifact(deniedRuntime);
            var accepted = deniedRuntime.submit(new ProcessingJobRequest(
                    "request-retention-denied", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "retaining-denied", Map.of(),
                    governanceWithProviderRetention(true)));
            var terminal = awaitTerminal(deniedRuntime, accepted.jobId());

            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.result()).containsEntry(
                    "authorizationDenialReason", "PROVIDER_RETENTION_NOT_ALLOWED");
            assertThat(deniedCalls).hasValue(0);
        } finally {
            deniedRuntime.close();
        }

        AtomicInteger allowedCalls = new AtomicInteger();
        var allowedRuntime = runtime(Files.createTempDirectory("media-retention-allowed-"),
                List.of(retainingExternalProvider("retaining-allowed", allowedCalls, retention)),
                consentAuthority(consentWithRetention(retention)));
        try {
            var artifact = artifact(allowedRuntime);
            var accepted = allowedRuntime.submit(new ProcessingJobRequest(
                    "request-retention-allowed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "retaining-allowed", Map.of(),
                    governanceWithProviderRetention(true)));
            var terminal = awaitTerminal(allowedRuntime, accepted.jobId());

            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(allowedCalls).hasValue(1);
        } finally {
            allowedRuntime.close();
        }
    }

    @Test
    void revokedPurposeMismatchWrongRegionAndStaleConsentHaveNoProviderEffect() throws Exception {
        List<ConsentDecision> denials = List.of(
                ConsentDecision.unverified(),
                new ConsentDecision(true, "test-authority", "consent-a", Instant.now(),
                        Instant.now().plusSeconds(300), Set.of("other-purpose"), Set.of("us"),
                        true, false),
                new ConsentDecision(true, "test-authority", "consent-a", Instant.now(),
                        Instant.now().plusSeconds(300), Set.of("media-analysis"), Set.of("eu"),
                        true, false),
                new ConsentDecision(true, "test-authority", "consent-a", Instant.now().minusSeconds(90),
                        Instant.now().plusSeconds(300), Set.of("media-analysis"), Set.of("us"),
                        true, false));
        for (int index = 0; index < denials.size(); index++) {
            AtomicInteger providerCalls = new AtomicInteger();
            var runtime = runtime(Files.createTempDirectory("media-external-denied-" + index),
                    List.of(externalProvider(providerCalls)), consentAuthority(denials.get(index)));
            try {
                var artifact = artifact(runtime);
                var accepted = runtime.submit(new ProcessingJobRequest(
                        "request-external-denied-" + index, "tenant-a", "principal-a", "correlation-a",
                        artifact.artifactId(), JobType.VISION, "external-test", Map.of(), governance()));
                var terminal = awaitTerminal(runtime, accepted.jobId());

                assertThat(terminal.status()).as("denial case %s", index).isEqualTo(JobStatus.FAILED);
                assertThat(terminal.failureCode()).isEqualTo("PROCESSING_BLOCKED_BEFORE_PROVIDER");
                assertThat(terminal.result()).containsKey("authorizationDenialReason");
                assertThat(providerCalls).as("denial case %s", index).hasValue(0);
            } finally {
                runtime.close();
            }
        }
    }

    @Test

    void retryableProviderFailureUsesBoundedDeterministicFallbackWithActualProvenance() throws Exception {
        AtomicInteger primaryCalls = new AtomicInteger();
        AtomicInteger fallbackCalls = new AtomicInteger();
        MediaProcessingProvider primary = provider("primary", 0, primaryCalls,
                CompletableFuture.failedFuture(new CompletionException(new IOException("temporary outage"))),
                CancellationOutcome.UNSUPPORTED, true);
        MediaProcessingProvider fallback = provider("fallback", 1, fallbackCalls,
                CompletableFuture.completedFuture(Map.of("labels", List.of("safe"))),
                CancellationOutcome.UNSUPPORTED);
        var root = Files.createTempDirectory("media-fallback-");
        var runtime = runtime(root, List.of(primary, fallback));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-fallback", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "", Map.of()));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.providerId()).isEqualTo("fallback");
            assertThat(terminal.result()).containsEntry("providerId", "fallback");
            assertThat(primaryCalls).hasValue(1);
            assertThat(fallbackCalls).hasValue(1);
            assertThat(runtime.prometheusMetrics()).contains(
                    "media_workflow_events_total",
                    "event=\"retry\"",
                    "media_workflow_stage_duration_seconds_bucket",
                    "stage=\"provider\"");
        } finally {
            runtime.close();
        }
    }

    @Test
    void providerFailureWithoutSafeFallbackIsPersistedAsUnknownOutcome() throws Exception {

        MediaProcessingProvider provider = provider(
                "failing", 0, new AtomicInteger(),
                CompletableFuture.failedFuture(new IllegalStateException("provider failure")),
                CancellationOutcome.UNSUPPORTED);
        var root = Files.createTempDirectory("media-provider-failure-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-provider-failure", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "failing", Map.of()));

            var terminal = awaitTerminal(runtime, accepted.jobId());

            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(terminal.result()).containsEntry("failureType", "IllegalStateException")
                    .containsEntry("providerOutcome", "UNKNOWN");
            assertThat(runtime.prometheusMetrics()).contains(
                    "event=\"unknown\"",
                    "media_workflow_unknown_backlog",
                    "service=\"launcher\"");

        } finally {
            runtime.close();
        }
    }

    @Test
    void unconfirmedCancellationRemainsNonTerminalAndProviderOutcomeStillWins() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        MediaProcessingProvider provider = provider(
                "remote", 0, new AtomicInteger(), pending,
                CancellationOutcome.REQUESTED_UNCONFIRMED);
        var root = Files.createTempDirectory("media-cancel-unconfirmed-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-unconfirmed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));

            var cancellationRequested = runtime.cancel("tenant-a", "principal-a", accepted.jobId());

            assertThat(cancellationRequested.status()).isEqualTo(JobStatus.RUNNING);
            assertThat(cancellationRequested.failureCode()).isBlank();
            assertThat(cancellationRequested.completedAt()).isNull();
            assertThat(cancellationRequested.result())
                    .containsEntry("cancellationOutcome", "REQUESTED_UNCONFIRMED")
                    .containsKey("cancellationRequestedAt");
            assertThat(pending).isNotCancelled();

            pending.complete(Map.of("labels", List.of("provider-completed-after-cancel-request")));
            var terminal = awaitTerminal(runtime, accepted.jobId());
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.result())
                    .containsEntry("providerId", "remote")
                    .containsEntry("labels", List.of("provider-completed-after-cancel-request"));
        } finally {
            runtime.close();
        }
    }

    @Test
    void providerFutureCancellationWithoutConfirmationRemainsOutcomeUnknown() throws Exception {
        CompletableFuture<Map<String, Object>> cancelledByProvider = new CompletableFuture<>();
        AtomicInteger providerCalls = new AtomicInteger();
        var provider = provider("remote-cancel", 0, providerCalls, cancelledByProvider,
                CancellationOutcome.UNSUPPORTED);
        var runtime = runtime(Files.createTempDirectory("media-provider-cancel-unknown-"), List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-provider-cancel-unknown", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote-cancel", Map.of()));

            assertThat(cancelledByProvider.cancel(false)).isTrue();
            var terminal = awaitTerminal(runtime, accepted.jobId());

            assertThat(terminal.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(terminal.failureCode()).isEqualTo("PROCESSING_CANCELLED_UNCONFIRMED");
            assertThat(terminal.result())
                    .containsEntry("cancellationOutcome", "UNCONFIRMED")
                    .containsEntry("providerOutcome", "UNKNOWN");
            assertThat(providerCalls).hasValue(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void confirmedCancellationIsTerminalAndCarriesProviderConfirmation() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        MediaProcessingProvider provider = provider(
                "remote", 0, new AtomicInteger(), pending,
                CancellationOutcome.CONFIRMED);
        var root = Files.createTempDirectory("media-cancel-confirmed-");
        var runtime = runtime(root, List.of(provider));
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-confirmed", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));

            var cancelled = runtime.cancel("tenant-a", "principal-a", accepted.jobId());

            assertThat(cancelled.status()).isEqualTo(JobStatus.CANCELLED);
            assertThat(cancelled.failureCode()).isEqualTo("CANCELLED");
            assertThat(cancelled.result())
                    .containsEntry("cancellationOutcome", "CONFIRMED");
        } finally {
            runtime.close();
        }
    }

    @Test
    void submissionDigestAndProviderObserveTheSameDeepParameterSnapshot() throws Exception {
        var root = Files.createTempDirectory("media-runtime-request-snapshot-");
        AtomicReference<Map<String, Object>> observed = new AtomicReference<>();
        CountDownLatch dispatched = new CountDownLatch(1);
        MediaProcessingProvider snapshotProvider = new MediaProcessingProvider() {
            @Override public String providerId() { return "snapshot-provider"; }
            @Override public String providerVersion() { return "snapshot-v1"; }
            @Override public String modelVersion(JobType modality) { return "snapshot-model-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                observed.set(context.request().parameters());
                dispatched.countDown();
                return CompletableFuture.completedFuture(Map.of("accepted", true));
            }
        };
        MediaRuntime runtime = runtime(root, List.of(snapshotProvider));
        try {
            var artifact = artifact(runtime);
            Map<String, Object> nested = new LinkedHashMap<>();
            nested.put("value", "before");
            List<Object> values = new ArrayList<>();
            values.add(nested);
            int[] array = {3, 4};
            Map<String, Object> parameters = new LinkedHashMap<>();
            parameters.put("values", values);
            parameters.put("array", array);
            ProcessingJobRequest request = new ProcessingJobRequest(
                    "request-snapshot", "tenant-a", "principal-a", "correlation-snapshot",
                    artifact.artifactId(), JobType.VISION, "snapshot-provider", parameters);
            String expectedFingerprint = MediaJobRequestFingerprint.compute(request,
                    List.of(new ProviderDescriptor("snapshot-provider", "snapshot-v1", "snapshot-model-v1")));

            nested.put("value", "mutated-before-submit");
            values.add(Map.of("value", "late-before-submit"));
            array[0] = 99;
            var accepted = runtime.submit(request);
            nested.put("value", "mutated-after-submit");
            array[1] = 99;

            assertThat(dispatched.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(accepted.requestFingerprint()).isEqualTo(expectedFingerprint);
            Map<String, Object> providerPayload = observed.get();
            assertThat(((Map<?, ?>) ((List<?>) providerPayload.get("values")).get(0)).get("value"))
                    .isEqualTo("before");
            assertThat((int[]) providerPayload.get("array")).containsExactly(3, 4);
            var observedRequest = new ProcessingJobRequest(
                    request.requestId(), request.tenantId(), request.principalId(), request.correlationId(),
                    request.artifactId(), request.jobType(), request.providerHint(), providerPayload,
                    request.governanceContext());
            assertThat(MediaJobRequestFingerprint.compute(observedRequest,
                    List.of(new ProviderDescriptor("snapshot-provider", "snapshot-v1", "snapshot-model-v1"))))
                    .isEqualTo(accepted.requestFingerprint());
        } finally {
            runtime.close();
        }
    }

    @Test
    void lateCancellationConfirmationCannotOverwriteCompletedProviderOutcome() throws Exception {
        CompletableFuture<Map<String, Object>> pending = new CompletableFuture<>();
        CountDownLatch cancellationEntered = new CountDownLatch(1);
        CountDownLatch allowCancellationReturn = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        MediaProcessingProvider provider = new MediaProcessingProvider() {
            @Override public String providerId() { return "remote"; }
            @Override public String providerVersion() { return "remote-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return pending;
            }
            @Override public CancellationOutcome cancel(String tenantId, String principalId,
                                                         String correlationId, String jobId) {
                cancellationEntered.countDown();
                try {
                    if (!allowCancellationReturn.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test cancellation release timed out");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
                return CancellationOutcome.CONFIRMED;
            }
        };
        var root = Files.createTempDirectory("media-cancel-completion-race-");
        var runtime = runtime(root, List.of(provider));
        var cancelExecutor = Executors.newSingleThreadExecutor();
        try {
            var artifact = artifact(runtime);
            var accepted = runtime.submit(new ProcessingJobRequest(
                    "request-cancel-race", "tenant-a", "principal-a", "correlation-a",
                    artifact.artifactId(), JobType.VISION, "remote", Map.of()));
            var cancellation = cancelExecutor.submit(() -> runtime.cancel("tenant-a", "principal-a", accepted.jobId()));
            assertThat(cancellationEntered.await(5, TimeUnit.SECONDS)).isTrue();

            pending.complete(Map.of("labels", List.of("completed")));
            var completed = awaitTerminal(runtime, accepted.jobId());
            assertThat(completed.status()).isEqualTo(JobStatus.COMPLETED);
            allowCancellationReturn.countDown();

            assertThat(cancellation.get(5, TimeUnit.SECONDS).status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow().status())
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(calls).hasValue(1);
        } finally {
            allowCancellationReturn.countDown();
            cancelExecutor.shutdownNow();
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, List<MediaProcessingProvider> providers) {
        return runtime(root, providers, null);
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root,
            List<MediaProcessingProvider> providers,
            MediaConsentAuthority authority) {
        return new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                authority,
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static MediaProcessingProvider externalProvider(AtomicInteger calls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "external-test"; }
            @Override public String providerVersion() { return "external-test-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention providerDataRetention() {
                return com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("labels", List.of("safe")));
            }
        };
    }

    private static MediaConsentAuthority consentAuthority(ConsentDecision decision) {
        return new MediaConsentAuthority() {
            @Override public String authorityId() { return "test-authority"; }
            @Override public ConsentDecision verify(
                    String tenantId, String principalId, MediaGovernanceContext governance, String operation) {
                assertThat(tenantId).isEqualTo("tenant-a");
                assertThat(principalId).isEqualTo("principal-a");
                return decision;
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
        };
    }

    private static ConsentDecision allowedConsent() {
        Instant now = Instant.now();
        return new ConsentDecision(true, "test-authority", "consent-a", now,
                now.plusSeconds(300), Set.of("media-analysis"), Set.of("us"), true, false);
    }

    private static ConsentDecision consentWithRetention(
            com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention retention) {
        Instant now = Instant.now();
        return new ConsentDecision(true, "test-authority", "consent-a", now,
                now.plusSeconds(300), Set.of("media-analysis"), Set.of("us"), true, false,
                Set.of(retention));
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext("consent-a", "media-analysis", DataClassification.RESTRICTED,
                "us", Set.of("us"), true, "service-default", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static MediaGovernanceContext governanceWithProviderRetention(boolean allowed) {
        return new MediaGovernanceContext("consent-a", "media-analysis", DataClassification.RESTRICTED,
                "us", Set.of("us"), true, "short-lived-media", allowed, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static MediaProcessingProvider retainingExternalProvider(
            String id, AtomicInteger calls,
            com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention retention) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return id; }
            @Override public String providerVersion() { return id + "-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention providerDataRetention() {
                return retention;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of("labels", List.of("safe")));
            }
        };
    }

    private static MediaProcessingProvider provider(
            String id,
            int priority,
            AtomicInteger calls,
            CompletableFuture<Map<String, Object>> response,
            CancellationOutcome cancellation) {
        return provider(id, priority, calls, response, cancellation, false);
    }

    private static MediaProcessingProvider provider(
            String id,
            int priority,
            AtomicInteger calls,
            CompletableFuture<Map<String, Object>> response,
            CancellationOutcome cancellation,
            boolean fallbackEligible) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return id; }
            @Override public String providerVersion() { return id + "-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return priority; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                return response;
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return cancellation;
            }
            @Override public boolean fallbackEligible(Throwable failure) {
                return fallbackEligible && failure instanceof IOException;
            }
        };
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime) throws Exception {
        byte[] bytes = "media".getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new UploadRequest(
                "tenant-a", "principal-a", "clip.bin", "application/octet-stream", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()), "governance-upload");
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitTerminal(
            MediaRuntime runtime, String jobId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        var value = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
        while (!Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.OUTCOME_UNKNOWN)
                .contains(value.status())
                && System.nanoTime() < deadline) {
            Thread.sleep(10);
            value = runtime.job("tenant-a", "principal-a", jobId).orElseThrow();
        }
        return value;
    }
}
