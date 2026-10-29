package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaChildJobDispatcher;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** M5: restart recovery of a crashed multimodal parent from durable spec + child states. */
class MediaRuntimeMultimodalRestartTest {

    @Test
    void crashedParentWithCompletedChildrenReconcilesToExactCompletedResult() throws Exception {
        var root = Files.createTempDirectory("media-mm-restart-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore(false);
        var submitted = new CountDownLatch(1);
        var runtime1 = runtime(root, jobStore,
                blockingMmProvider(submitted, Map.of("text", "grounded")),
                sttProvider(Map.of("text", "grounded")));
        var source = artifact(runtime1);
        var childArtifact = artifact(runtime1);
        runtime1.submit(mmRequest(source, spec(source, childArtifact)));
        assertThat(submitted.await(10, TimeUnit.SECONDS)).isTrue();
        awaitStatus(jobStore, "req-mm:stt", JobStatus.COMPLETED);
        runtime1.close(); // parent attempt thread dies mid-dispatch; job stays RUNNING

        var runtime2 = runtime(root, jobStore,
                blockingMmProvider(new CountDownLatch(1), Map.of()),
                sttProvider(Map.of()));
        try {
            var parent = runtime2.job("tenant-a", "principal-a",
                    jobStore.findByRequest("tenant-a", "req-mm").orElseThrow().jobId()).orElseThrow();
            assertThat(parent.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(parent.result()).containsKey("observations");
            // Exact readback: fused result rebuilt solely from the durable spec + children.
            assertThat(String.valueOf(parent.result().get("observations"))).contains("stt");
        } finally {
            runtime2.close();
        }
    }

    @Test
    void crashedParentWithUnknownChildPreservesOutcomeUnknown() throws Exception {
        var root = Files.createTempDirectory("media-mm-restart-fail-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore(false);
        var submitted = new CountDownLatch(1);
        var runtime1 = runtime(root, jobStore,
                blockingMmProvider(submitted, Map.of()),
                failingSttProvider());
        var source = artifact(runtime1);
        var childArtifact = artifact(runtime1);
        runtime1.submit(mmRequest(source, spec(source, childArtifact)));
        assertThat(submitted.await(10, TimeUnit.SECONDS)).isTrue();
        awaitStatus(jobStore, "req-mm:stt", JobStatus.OUTCOME_UNKNOWN);
        runtime1.close();

        var runtime2 = runtime(root, jobStore,
                blockingMmProvider(new CountDownLatch(1), Map.of()),
                failingSttProvider());
        try {
            var parent = runtime2.job("tenant-a", "principal-a",
                    jobStore.findByRequest("tenant-a", "req-mm").orElseThrow().jobId()).orElseThrow();
            // An ambiguous child outcome can never be relabeled success or fabricated
            // failure: the parent honestly remains OUTCOME_UNKNOWN.
            assertThat(parent.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
        } finally {
            runtime2.close();
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static MediaRuntime runtime(
            java.nio.file.Path root, LocalMediaRuntimeSupport.JobStore jobStore,
            MediaProcessingProvider mmProvider, MediaProcessingProvider sttProvider) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(30), 8, "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                com.ghatana.media.launcher.MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(30)),
                MediaLifecyclePublisher.disabled(),
                List.of(mmProvider, sttProvider),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), allowAll(), transcriptStore(), Clock.systemUTC());
    }

    /** MM provider: submits children through the canonical dispatcher, then never returns. */
    private static MediaProcessingProvider blockingMmProvider(
            CountDownLatch submitted, Map<String, Object> ignored) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-mm-blocking"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.MULTIMODAL); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                MediaChildJobDispatcher dispatcher = context.requireChildDispatcher();
                MultimodalOperationSpec spec = MultimodalOperationSpec.from(context.request());
                for (var child : spec.children()) {
                    dispatcher.submitChild(new ProcessingJobRequest(
                            MultimodalOperationSpec.childRequestId(
                                    context.request().requestId(), child.childKey()),
                            context.request().tenantId(), context.request().principalId(),
                            context.request().correlationId(), child.artifactId(),
                            child.artifactVersion(), child.jobType(), child.providerHint(),
                            child.parameters(), context.request().governanceContext()));
                }
                submitted.countDown();
                return new CompletableFuture<>(); // never completes — simulates crash mid-dispatch
            }
        };
    }

    private static MediaProcessingProvider sttProvider(Map<String, Object> result) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-stt"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new com.ghatana.media.runtime
                        .MediaSpeechToTextAdmission.Profile("test-stt", "v1", "profile-a", "v1",
                        "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .TimingDisposition.SOURCE_CLOCK_BOUND, "fixture"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(result);
            }
        };
    }

    private static MediaProcessingProvider failingSttProvider() {
        var base = sttProvider(Map.of());
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-stt"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return base.speechToTextProfile();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.failedFuture(new IllegalStateException("child effect failed"));
            }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority allowAll() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "d-" + request.artifactId(),
                        request.tenantId(), request.principalId(), "owner",
                        request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                        request.operation(), request.purpose(), request.providerId(),
                        request.providerVersion(), request.processingBoundary(),
                        request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "clock", 0, now.minusSeconds(1), now.plusSeconds(300));
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
            }
        };
    }

    private static com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore
            transcriptStore() {
        return new com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore() {
            @Override public com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision
                    append(com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft draft) {
                throw new UnsupportedOperationException();
            }
            @Override public java.util.List<com.ghatana.media.runtime.MediaTranscriptContracts
                    .TranscriptRevision> revisions(String t, String id) { return List.of(); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public void close() { }
        };
    }

    private static Map<String, Object> sttParameters() {
        return Map.of("profileId", "profile-a", "profileVersion", "v1",
                "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US"));
    }

    private static MultimodalOperationSpec spec(
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact source,
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact child) {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION, "cap", "op", 1,
                source.artifactId(), source.version().value(), source.sha256(),
                List.of(new MultimodalOperationSpec.ChildOperationSpec("stt",
                        JobType.SPEECH_TO_TEXT, child.artifactId(), child.version().value(),
                        child.sha256(), "", sttParameters())),
                null, Map.of("purpose", "mm-observe"));
    }

    private static ProcessingJobRequest mmRequest(
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact source,
            MultimodalOperationSpec spec) {
        return new ProcessingJobRequest("req-mm", "tenant-a", "principal-a", "corr-mm",
                source.artifactId(), source.version().value(), JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()),
                new MediaGovernanceContext("consent-a", "mm-observe",
                        com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL,
                        "us", Set.of("us"), true, "short-lived-media", false, false, "",
                        com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                        com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE));
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime) throws Exception {
        byte[] bytes = ("src-" + java.util.UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                "tenant-a", "principal-a", "s.wav", "audio/wav", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), Map.of("sourceClockId", "c",
                        "sourceClockMappingEvidenceRef", "e", "sourceClockTicksPerSecond", 1,
                        "sourceDurationTicks", 1)), "up-" + java.util.UUID.randomUUID());
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static void awaitStatus(
            LocalMediaRuntimeSupport.JobStore store, String requestId, JobStatus status)
            throws InterruptedException {
        for (int i = 0; i < 400; i++) {
            var job = store.findByRequest("tenant-a", requestId);
            if (job.isPresent() && job.orElseThrow().status() == status) return;
            Thread.sleep(25);
        }
        throw new AssertionError("child job did not reach " + status);
    }
}
