package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
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
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Wave-2 multimodal/vision admission, durable spec persistence and authenticated child
 * dispatch coverage over the canonical runtime path.
 */
class MediaRuntimeMultimodalAdmissionTest {

    @Test
    void authenticatedPortSubmitRejectsMismatchedPrincipal() throws Exception {
        var root = Files.createTempDirectory("media-mm-auth-");
        var runtime = runtime(root, List.of(), null);
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            ProcessingJobRequest request = mmRequest(source, spec(source, List.of()));
            var wrongPrincipal = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                    "tenant-a", "other-principal", Instant.now());
            assertThatThrownBy(() -> runtime.submit(request, wrongPrincipal))
                    .isInstanceOf(SecurityException.class);
        } finally {
            runtime.close();
        }
    }

    @Test
    void multimodalJobWithoutAuthorityIsNotAdmitted() throws Exception {
        var root = Files.createTempDirectory("media-mm-noauth-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger calls = new AtomicInteger();
        var runtime = runtime(root, jobStore, List.of(mmProvider(calls)), null);
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            assertThatThrownBy(() -> runtime.submit(mmRequest(source, spec(source, List.of()))))
                    .isInstanceOf(MediaCapabilityNotAdmittedException.class);
            assertThat(jobStore.list("tenant-a", 100)).isEmpty();
            assertThat(calls.get()).isEqualTo(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void admittedMultimodalJobFansOutChildrenThroughCanonicalJobs() throws Exception {
        var root = Files.createTempDirectory("media-mm-admit-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var authority = allowAllAuthority();
        var stt = sttProvider();
        var mm = mmProvider(new AtomicInteger());
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mm, stt), authority);
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var child = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var spec = spec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            child.artifactId(), child.version().value(), child.sha256(), "",
                            sttParameters())));
            var accepted = runtime.submit(mmRequest(source, spec));
            awaitTerminal(jobStore, accepted.jobId());
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.result()).containsKey("observations");
            // The child ran as its own canonical job with deterministic request identity.
            var childJob = jobStore.findByRequest("tenant-a", "req-mm:stt").orElseThrow();
            assertThat(childJob.jobType()).isEqualTo(JobType.SPEECH_TO_TEXT);
            // The durable operation snapshot is reconstructible from the job store alone.
            var snapshot = jobStore.findMultimodalOperationSnapshot("tenant-a", accepted.jobId());
            assertThat(snapshot).isPresent();
            assertThat(snapshot.orElseThrow().operationSpec()).isEqualTo(spec);
        } finally {
            runtime.close();
        }
    }

    @Test
    void admittedVisionAndSttChildrenFuseOntoTheBoundSourceClock() throws Exception {
        var root = Files.createTempDirectory("media-mm-vision-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var mm = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var stt = sttProvider(Map.of("text", "grounded transcript",
                "timedObservations", List.of(MultimodalOperationSpec.timedObservation(
                        "transcript-span", 0, 48_000, "src-clock", 48_000))));
        var vision = visionProvider(Map.of(
                "detections", List.of(Map.of(
                        "label", "synthetic-object",
                        "confidence", 0.9,
                        "boundingBox", Map.of("x", 0.1, "y", 0.1, "w", 0.2, "h", 0.2))),
                "timedObservations", List.of(MultimodalOperationSpec.timedObservation(
                        "frame-window", 14_400, 43_200, "src-clock", 48_000))));
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mm, stt, vision),
                allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var sttChild = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var visionChild = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var spec = clockedSpec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            sttChild.artifactId(), sttChild.version().value(),
                            sttChild.sha256(), "", sttParameters()),
                    new MultimodalOperationSpec.ChildOperationSpec("vision", JobType.VISION,
                            visionChild.artifactId(), visionChild.version().value(),
                            visionChild.sha256(), "", Map.of())));
            var accepted = runtime.submit(mmRequest(source, spec));
            awaitTerminal(jobStore, accepted.jobId());
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            // Both children ran as canonical jobs and their declared ticks grounded on the
            // operation's bound source clock — timestamp comparability, not measured sync.
            var sttJob = jobStore.findByRequest("tenant-a", "req-mm:stt").orElseThrow();
            var visionJob = jobStore.findByRequest("tenant-a", "req-mm:vision").orElseThrow();
            assertThat(sttJob.jobType()).isEqualTo(JobType.SPEECH_TO_TEXT);
            assertThat(visionJob.jobType()).isEqualTo(JobType.VISION);
            String fused = String.valueOf(terminal.result().get("observations"));
            assertThat(fused).contains("TIMESTAMP_ALIGNED")
                    .contains("mediaStartMs=300").contains("mediaEndMs=900");
            assertThat(terminal.result().get("clockComparability"))
                    .isEqualTo("SOURCE_CLOCK_SHARED");
        } finally {
            runtime.close();
        }
    }

    @Test
    void visionChildOnAnUnrelatedClockStaysSyncUndetermined() throws Exception {
        var root = Files.createTempDirectory("media-mm-wrongclock-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var mm = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var stt = sttProvider(Map.of("text", "grounded transcript",
                "timedObservations", List.of(MultimodalOperationSpec.timedObservation(
                        "transcript-span", 0, 48_000, "src-clock", 48_000))));
        var vision = visionProvider(Map.of(
                "detections", List.of(Map.of("label", "synthetic-object")),
                "timedObservations", List.of(MultimodalOperationSpec.timedObservation(
                        "frame-window", 14_400, 43_200, "other-clock", 48_000))));
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mm, stt, vision),
                allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var sttChild = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var visionChild = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var spec = clockedSpec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            sttChild.artifactId(), sttChild.version().value(),
                            sttChild.sha256(), "", sttParameters()),
                    new MultimodalOperationSpec.ChildOperationSpec("vision", JobType.VISION,
                            visionChild.artifactId(), visionChild.version().value(),
                            visionChild.sha256(), "", Map.of())));
            var accepted = runtime.submit(mmRequest(source, spec));
            awaitTerminal(jobStore, accepted.jobId());
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            // Composition succeeded, but a child on an unverifiable clock cannot ground:
            // comparability degrades honestly, never an estimated position.
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(String.valueOf(terminal.result().get("observations")))
                    .contains("SYNC_UNDETERMINED").contains("SOURCE_CLOCK_MISMATCH");
            assertThat(terminal.result().get("clockComparability"))
                    .isEqualTo("SYNC_UNDETERMINED");
        } finally {
            runtime.close();
        }
    }

    @Test
    void deniedMultimodalRightsProduceNoJobOrChildEffect() throws Exception {
        var root = Files.createTempDirectory("media-mm-deny-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger calls = new AtomicInteger();
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mmProvider(calls)),
                denyAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            assertThatThrownBy(() -> runtime.submit(mmRequest(source, spec(source, List.of()))))
                    .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                    .satisfies(f -> assertThat(((MediaCapabilityNotAdmittedException) f).reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.POLICY_DENIED));
            assertThat(jobStore.list("tenant-a", 100)).isEmpty();
            assertThat(calls.get()).isEqualTo(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void staleChildArtifactIsRejectedBeforeJobCreation() throws Exception {
        var root = Files.createTempDirectory("media-mm-stalechild-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mmProvider(new AtomicInteger())),
                allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            String fakeSha = "0".repeat(64);
            var spec = spec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("vision", JobType.VISION,
                            "missing-artifact", "sha256:" + fakeSha, fakeSha, "", Map.of())));
            assertThatThrownBy(() -> runtime.submit(mmRequest(source, spec)))
                    .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                    .satisfies(f -> assertThat(((MediaCapabilityNotAdmittedException) f).reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.SOURCE_VERSION_STALE));
            assertThat(jobStore.list("tenant-a", 100)).isEmpty();
        } finally {
            runtime.close();
        }
    }

    @Test
    void parentCancellationPropagatesToInflightChildrenThroughCanonicalJobs() throws Exception {
        var root = Files.createTempDirectory("media-mm-cancel-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var mm = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var stt = pendingCancellableSttProvider();
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mm, stt), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var child = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var spec = spec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            child.artifactId(), child.version().value(), child.sha256(), "",
                            sttParameters())));
            var accepted = runtime.submit(mmRequest(source, spec));
            var childJob = awaitJob(jobStore, "req-mm:stt");
            var cancelled = runtime.cancel("tenant-a", "principal-a", accepted.jobId());
            assertThat(cancelled.status()).isEqualTo(JobStatus.CANCELLED);
            awaitTerminal(jobStore, childJob.jobId());
            var childAfter = jobStore.find("tenant-a", childJob.jobId()).orElseThrow();
            assertThat(childAfter.status()).isEqualTo(JobStatus.CANCELLED);
            assertThat(jobStore.find("tenant-a", accepted.jobId()).orElseThrow().status())
                    .isEqualTo(JobStatus.CANCELLED);
        } finally {
            runtime.close();
        }
    }

    @Test
    void deniedChildDuringFanoutCancelsAlreadySubmittedSiblings() throws Exception {
        var root = Files.createTempDirectory("media-mm-partial-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var mm = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var stt = pendingCancellableSttProvider();
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mm, stt),
                denyOperationAuthority(JobType.VISION.name()));
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var sttChild = artifact(runtime, "tenant-a", "principal-a", sourceClockMetadata());
            var deniedChild = artifact(runtime, "tenant-a", "principal-a");
            var spec = spec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            sttChild.artifactId(), sttChild.version().value(), sttChild.sha256(), "",
                            sttParameters()),
                    new MultimodalOperationSpec.ChildOperationSpec("vision", JobType.VISION,
                            deniedChild.artifactId(), deniedChild.version().value(),
                            deniedChild.sha256(), "", Map.of())));
            var accepted = runtime.submit(mmRequest(source, spec));
            awaitTerminal(jobStore, accepted.jobId());
            var parent = jobStore.find("tenant-a", accepted.jobId()).orElseThrow();
            assertThat(parent.status()).isEqualTo(JobStatus.FAILED);
            // The refused vision child never created a durable job; the submitted STT
            // sibling was cancelled rather than left running as a leaked effect.
            assertThat(jobStore.findByRequest("tenant-a", "req-mm:vision")).isEmpty();
            var sttJob = awaitJob(jobStore, "req-mm:stt");
            assertThat(sttJob.status()).isEqualTo(JobStatus.CANCELLED);
        } finally {
            runtime.close();
        }
    }

    @Test
    void foreignPrincipalChildArtifactIsRejectedBeforeFanout() throws Exception {
        var root = Files.createTempDirectory("media-mm-foreign-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        var calls = new AtomicInteger();
        var runtime = runtimeWithAuthority(root, jobStore, List.of(mmProvider(calls)),
                allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var foreign = artifact(runtime, "tenant-a", "principal-b");
            var spec = spec(source, List.of(
                    new MultimodalOperationSpec.ChildOperationSpec("stt", JobType.SPEECH_TO_TEXT,
                            foreign.artifactId(), foreign.version().value(), foreign.sha256(), "",
                            sttParameters())));
            assertThatThrownBy(() -> runtime.submit(mmRequest(source, spec)))
                    .isInstanceOf(MediaCapabilityNotAdmittedException.class);
            assertThat(jobStore.list("tenant-a", 100)).isEmpty();
            assertThat(calls.get()).isEqualTo(0);
        } finally {
            runtime.close();
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static MediaRuntime runtime(
            java.nio.file.Path root, List<MediaProcessingProvider> providers,
            MediaSourceAuthorizationContracts.Authority authority) {
        return runtimeWithAuthority(root, new LocalMediaRuntimeSupport.JobStore(),
                providers, authority);
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root, LocalMediaRuntimeSupport.JobStore jobStore,
            List<MediaProcessingProvider> providers,
            MediaSourceAuthorizationContracts.Authority authority) {
        return runtimeWithAuthority(root, jobStore, providers, authority);
    }

    private static MediaRuntime runtimeWithAuthority(
            java.nio.file.Path root, LocalMediaRuntimeSupport.JobStore jobStore,
            List<MediaProcessingProvider> providers,
            MediaSourceAuthorizationContracts.Authority authority) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(10), 8, "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                com.ghatana.media.launcher.MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(10)),
                MediaLifecyclePublisher.disabled(),
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, transcriptStore(), Clock.systemUTC());
    }

    private static com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore
            transcriptStore() {
        return new com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore() {
            @Override public com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision
                    append(com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft draft) {
                throw new UnsupportedOperationException("test store does not write transcripts");
            }
            @Override public java.util.List<com.ghatana.media.runtime.MediaTranscriptContracts
                    .TranscriptRevision> revisions(String tenantId, String transcriptId) {
                return java.util.List.of();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public void close() { }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority allowAllAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                if (!authenticated.tenantId().equals(request.tenantId())
                        || !authenticated.principalId().equals(request.principalId())) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-" + request.artifactId(),
                        request.tenantId(), request.principalId(), "fixture-owner",
                        request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                        request.operation(), request.purpose(), request.providerId(),
                        request.providerVersion(), request.processingBoundary(),
                        request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
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

    /** Fixture authority identical to {@link #allowAllAuthority()} except one denied operation. */
    private static MediaSourceAuthorizationContracts.Authority denyOperationAuthority(String operation) {
        var delegate = allowAllAuthority();
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                if (operation.equals(request.operation())) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                return delegate.resolve(request, authenticated);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return delegate.revalidate(request, expectedEvidence, authenticated);
            }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority denyAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.DENIED, null);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.DENIED, null);
            }
        };
    }

    /**
     * Test MM provider: submits each declared child through the canonical dispatcher and
     * fuses their durable results into the parent observation list — mirroring the
     * production delegating provider's contract.
     */
    private static MediaProcessingProvider mmProvider(AtomicInteger calls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-mm"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.MULTIMODAL); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                calls.incrementAndGet();
                MediaChildJobDispatcher dispatcher = context.requireChildDispatcher();
                MultimodalOperationSpec spec = MultimodalOperationSpec.from(context.request());
                List<Object> observations = new java.util.ArrayList<>();
                for (var child : spec.children()) {
                    var childRequest = new ProcessingJobRequest(
                            MultimodalOperationSpec.childRequestId(
                                    context.request().requestId(), child.childKey()),
                            context.request().tenantId(), context.request().principalId(),
                            context.request().correlationId(), child.artifactId(),
                            child.artifactVersion(), child.jobType(), child.providerHint(),
                            child.parameters(), context.request().governanceContext());
                    var childJob = dispatcher.submitChild(childRequest);
                    observations.add(Map.of(
                            "childJobId", childJob.jobId(),
                            "childJobType", childJob.jobType().name(),
                            "observations", childJob.result()));
                }
                return CompletableFuture.completedFuture(
                        Map.<String, Object>of("observations", observations));
            }
        };
    }

    /** STT test provider returning a governed grounded transcript shape. */
    private static MediaProcessingProvider sttProvider() {
        return sttProvider(Map.of("text", "grounded transcript"));
    }

    /** STT test provider returning the supplied governed result. */
    private static MediaProcessingProvider sttProvider(Map<String, Object> result) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-stt"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new com.ghatana.media.runtime
                        .MediaSpeechToTextAdmission.Profile(
                        "test-stt", "v1", "profile-a", "v1",
                        "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
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

    /** Vision test provider returning the supplied governed result. */
    private static MediaProcessingProvider visionProvider(Map<String, Object> result) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-vision"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
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

    /**
     * STT test provider whose attempt stays in flight until cancelled; its cancel is
     * provider-confirmed so the canonical child cancel path is exercised end to end.
     */
    private static MediaProcessingProvider pendingCancellableSttProvider() {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-stt-pending"; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<com.ghatana.media.runtime
                    .MediaSpeechToTextAdmission.Profile> speechToTextProfile() {
                return java.util.Optional.of(new com.ghatana.media.runtime
                        .MediaSpeechToTextAdmission.Profile(
                        "test-stt-pending", "v1", "profile-a", "v1",
                        "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission
                                .TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return new CompletableFuture<>();
            }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome.CONFIRMED;
            }
        };
    }

    private static Map<String, Object> sttParameters() {
        return Map.of(
                "profileId", "profile-a",
                "profileVersion", "v1",
                "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US"));
    }

    private static MultimodalOperationSpec clockedSpec(
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact source,
            List<MultimodalOperationSpec.ChildOperationSpec> children) {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, source.artifactId(), source.version().value(), source.sha256(),
                children,
                new MultimodalOperationSpec.SourceClockBinding(
                        "fixture-clock-evidence", 48_000, 0, "src-clock", 96_000),
                Map.of("purpose", "mm-observe"));
    }

    private static MultimodalOperationSpec spec(
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact source,
            List<MultimodalOperationSpec.ChildOperationSpec> children) {
        List<MultimodalOperationSpec.ChildOperationSpec> actual = children.isEmpty()
                ? List.of(new MultimodalOperationSpec.ChildOperationSpec("stt",
                        JobType.SPEECH_TO_TEXT, source.artifactId(), source.version().value(),
                        source.sha256(), "", sttParameters()))
                : children;
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, source.artifactId(), source.version().value(), source.sha256(),
                actual, null, Map.of());
    }

    private static ProcessingJobRequest mmRequest(
            com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact source,
            MultimodalOperationSpec spec) {
        return new ProcessingJobRequest("req-mm", "tenant-a", "principal-a", "correlation-mm",
                source.artifactId(), source.version().value(), JobType.MULTIMODAL, "",
                Map.of(MultimodalOperationSpec.PARAMETERS_KEY, spec.toParametersValue()),
                governance());
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext(
                "consent-a", "mm-observe",
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL,
                "us", Set.of("us"), true, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static Map<String, Object> sourceClockMetadata() {
        return Map.of("sourceClockId", "fixture-clock",
                "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                "sourceClockTicksPerSecond", 1,
                "sourceDurationTicks", 1);
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime, String tenantId, String principalId) throws Exception {
        return artifact(runtime, tenantId, principalId, Map.of());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime, String tenantId, String principalId,
            Map<String, Object> metadata) throws Exception {
        byte[] bytes = ("mm-source-" + java.util.UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                tenantId, principalId, "source.wav", "audio/wav", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), metadata), "mm-upload-" + java.util.UUID.randomUUID());
        runtime.appendChunk(tenantId, principalId, upload.uploadId(), 0, bytes);
        return runtime.completeUpload(tenantId, principalId, upload.uploadId());
    }

    private static void awaitTerminal(
            LocalMediaRuntimeSupport.JobStore store, String jobId) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            var job = store.find("tenant-a", jobId);
            if (job.isPresent() && Set.of(JobStatus.COMPLETED, JobStatus.FAILED,
                    JobStatus.CANCELLED, JobStatus.OUTCOME_UNKNOWN).contains(job.orElseThrow().status())) {
                return;
            }
            Thread.sleep(25);
        }
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitJob(
            LocalMediaRuntimeSupport.JobStore store, String requestId) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            var job = store.findByRequest("tenant-a", requestId);
            if (job.isPresent()) return job.orElseThrow();
            Thread.sleep(25);
        }
        throw new AssertionError("durable child job never appeared: " + requestId
                + " jobs=" + store.list("tenant-a", 100));
    }
}
