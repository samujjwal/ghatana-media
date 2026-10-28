package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Decision;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.LanguageMode;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Profile;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.ProfileQualification;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Reason;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.TimingDisposition;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaRuntimeSpeechAdmissionTest {

    @Test
    void modalityPortUsesCanonicalRuntimeAndKeepsPrincipalScopedArtifactReadback() throws Exception {
        var root = Files.createTempDirectory("media-runtime-port-");
        var runtime = runtime(root, new LocalMediaRuntimeSupport.JobStore(), List.of(), null);
        try {
            MediaProcessingRuntimePort port = runtime.modalityPort();
            var source = artifact(runtime);

            assertThat(port).isSameAs(runtime);
            assertThat(port.artifact("tenant-a", "principal-a", source.artifactId()))
                    .contains(source);
            assertThat(port.artifact("tenant-a", "another-principal", source.artifactId()))
                    .isEmpty();
            assertThat(port.job("tenant-a", "principal-a", "missing-job")).isEmpty();
        } finally {
            runtime.close();
        }
    }

    @Test
    void absentProfileAndUnqualifiedTimingNeverCreateJobOrCallProvider() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-profile-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        MediaProcessingProvider provider = candidate(providerCalls, null, ProcessingBoundary.LOCAL);
        var runtime = runtime(root, jobStore, List.of(provider), null);
        try {
            var source = artifact(runtime);
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(),
                    Map.of("languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US")));

            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(MediaSpeechToTextAdmission.NotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaSpeechToTextAdmission.NotAdmittedException) failure)
                            .decision().reasons()).contains(Reason.PROFILE_ABSENT));
            assertNoJobOrProviderEffect(jobStore, providerCalls);
        } finally {
            runtime.close();
        }
    }

    @Test
    void staleExactSourceVersionIsTypedNotAdmittedBeforeJobCreation() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-stale-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        var runtime = runtime(root, jobStore,
                List.of(candidate(providerCalls, null, ProcessingBoundary.LOCAL)), null);
        try {
            var source = artifact(runtime);
            String stale = "sha256:" + "0".repeat(64);
            ProcessingJobRequest request = request(source.artifactId(), stale,
                    Map.of("languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US")));

            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaCapabilityNotAdmittedException) failure).reason())
                            .isEqualTo(MediaCapabilityNotAdmittedException.Reason.SOURCE_VERSION_STALE));
            assertNoJobOrProviderEffect(jobStore, providerCalls);
        } finally {
            runtime.close();
        }
    }

    @Test
    void whitespaceWrappedLanguageModeIsRejectedBeforeJobOrProviderEffects() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-language-mode-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        Profile profile = unqualifiedProfile("profile-a", TimingDisposition.PROVIDER_TIME_UNQUALIFIED);
        var runtime = runtime(root, jobStore,
                List.of(candidate(providerCalls, profile, ProcessingBoundary.LOCAL)), null);
        try {
            var source = artifact(runtime);
            Map<String, Object> parameters = new java.util.LinkedHashMap<>(speechParameters("profile-a", "en-US"));
            parameters.put("languageIntent", Map.of("mode", " EXPLICIT ", "languageTag", "en-US"));
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(), parameters);

            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(MediaSpeechToTextAdmission.NotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaSpeechToTextAdmission.NotAdmittedException) failure)
                            .decision().reasons()).contains(Reason.LANGUAGE_INTENT_REQUIRED));
            assertNoJobOrProviderEffect(jobStore, providerCalls);
        } finally {
            runtime.close();
        }
    }

    @Test
    void revokedOrUnverifiedConsentIsTypedNotAdmittedBeforeProviderEffect() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-consent-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        Profile unqualified = unqualifiedProfile("profile-a", TimingDisposition.NOT_SUPPLIED);
        MediaConsentAuthority deniedAuthority = new MediaConsentAuthority() {
            @Override public String authorityId() { return "test-authority"; }
            @Override public ConsentDecision verify(
                    String tenantId, String principalId, MediaGovernanceContext governance, String operation) {
                return ConsentDecision.unverified();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
        };
        var runtime = runtime(root, jobStore,
                List.of(candidate(providerCalls, unqualified, ProcessingBoundary.EXTERNAL)), deniedAuthority);
        try {
            var source = artifact(runtime);
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(),
                    speechParameters("profile-a", "en-US"), governance());

            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(MediaSpeechToTextAdmission.NotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaSpeechToTextAdmission.NotAdmittedException) failure)
                            .decision().reasons()).contains(Reason.CONSENT_NOT_ADMITTED,
                                    Reason.PROFILE_NOT_QUALIFIED, Reason.RIGHTS_AUTHORITY_UNAVAILABLE));
            assertNoJobOrProviderEffect(jobStore, providerCalls);
        } finally {
            runtime.close();
        }
    }

    @Test
    void deniedSourceRightsProduceNoJobOrProviderEffect() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-rights-denied-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        AtomicInteger revalidations = new AtomicInteger();
        Profile qualified = qualifiedProfile("profile-a");
        MediaProcessingProvider provider = admittedProvider(providerCalls, qualified);
        var runtime = runtimeWithAuthority(root, jobStore, List.of(provider), authority(false, true, revalidations),
                transcriptStore());
        try {
            var source = artifact(runtime, sourceClockMetadata());
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(),
                    speechParameters("profile-a", "en-US"), governance());
            assertThatThrownBy(() -> runtime.submit(request))
                    .isInstanceOf(MediaSpeechToTextAdmission.NotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaSpeechToTextAdmission.NotAdmittedException) failure)
                            .decision().reasons()).contains(Reason.RIGHTS_DECISION_DENIED));
            assertNoJobOrProviderEffect(jobStore, providerCalls);
            assertThat(revalidations).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void sourceAuthorizationIsRevalidatedBeforeProviderAndBoundedSourceRead() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-authorized-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        AtomicInteger revalidations = new AtomicInteger();
        Profile qualified = qualifiedProfile("profile-a");
        MediaProcessingProvider provider = admittedProvider(providerCalls, qualified);
        var runtime = runtimeWithAuthority(root, jobStore, List.of(provider), authority(true, true, revalidations),
                transcriptStore());
        try {
            var source = artifact(runtime, sourceClockMetadata());
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(),
                    speechParameters("profile-a", "en-US"), governance());
            var accepted = runtime.submit(request);
            assertThat(accepted.status()).isEqualTo(JobStatus.ACCEPTED);
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(terminal.status()).isEqualTo(JobStatus.FAILED);
            assertThat(terminal.failureCode()).isEqualTo("MEDIA_CAPABILITY_NOT_ADMITTED");
            assertThat(providerCalls).hasValue(0);
            assertThat(revalidations.get()).isGreaterThanOrEqualTo(1);
        } finally {
            runtime.close();
        }
    }

    @Test
    void authorizedFixtureCanReachProviderOnlyAfterExactSourceAndPolicyChecks() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-authorized-fixture-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        AtomicInteger providerCalls = new AtomicInteger();
        AtomicInteger revalidations = new AtomicInteger();
        Profile qualified = qualifiedProfile("profile-a");
        MediaProcessingProvider provider = admittedProvider(providerCalls, qualified);
        var runtime = runtimeWithAuthority(root, jobStore, List.of(provider), authority(true, false, revalidations),
                transcriptStore());
        try {
            var source = artifact(runtime, sourceClockMetadata());
            ProcessingJobRequest request = request(source.artifactId(), source.version().value(),
                    speechParameters("profile-a", "en-US"), governance());
            var accepted = runtime.submit(request);
            var terminal = runtime.job("tenant-a", "principal-a", accepted.jobId()).orElseThrow();
            assertThat(terminal.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(terminal.result()).containsEntry("text", "test transcript");
            assertThat(providerCalls).hasValue(1);
            assertThat(revalidations.get()).isGreaterThanOrEqualTo(3);
        } finally {
            runtime.close();
        }
    }

    @Test
    void speechAdmissionReportsImplicitUnsupportedAndUnqualifiedTimeInputs() throws Exception {
        var root = Files.createTempDirectory("media-stt-admission-contract-");
        var runtime = runtime(root, new LocalMediaRuntimeSupport.JobStore(), List.of(), null);
        try {
            var source = artifact(runtime);
            String digest = "sha256:" + "a".repeat(64);
            Profile unqualified = unqualifiedProfile("profile-a", TimingDisposition.PROVIDER_TIME_UNQUALIFIED);

            Decision implicit = MediaSpeechToTextAdmission.evaluate(
                    new MediaSpeechToTextAdmission.Request(source.version().value(), "profile-a", "v1", digest,
                            null, ""),
                    source, unqualified, false, false, false);
            assertThat(implicit.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
            assertThat(implicit.reasons()).contains(Reason.LANGUAGE_INTENT_REQUIRED,
                    Reason.PROFILE_NOT_QUALIFIED, Reason.TIMING_NOT_QUALIFIED,
                    Reason.SOURCE_CLOCK_NOT_QUALIFIED, Reason.RIGHTS_AUTHORITY_UNAVAILABLE);

            Decision explicitButUnsupported = MediaSpeechToTextAdmission.evaluate(
                    new MediaSpeechToTextAdmission.Request(source.version().value(), "profile-a", "v1", digest,
                            LanguageMode.EXPLICIT, "fr-FR"),
                    source, unqualified, true, false, false);
            assertThat(explicitButUnsupported.reasons()).contains(Reason.LANGUAGE_SUPPORT_UNVERIFIED,
                    Reason.PROFILE_NOT_QUALIFIED, Reason.SOURCE_CLOCK_NOT_QUALIFIED);
        } finally {
            runtime.close();
        }
    }

    private static MediaRuntime runtime(
            java.nio.file.Path root,
            LocalMediaRuntimeSupport.JobStore jobStore,
            List<MediaProcessingProvider> providers,
            MediaConsentAuthority authority) {
        return new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024, Duration.ofSeconds(2), 1,
                        "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore,
                new LocalMediaRuntimeSupport.StreamStore(),
                authority,
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static MediaRuntime runtimeWithAuthority(
            java.nio.file.Path root,
            LocalMediaRuntimeSupport.JobStore jobStore,
            List<MediaProcessingProvider> providers,
            MediaSourceAuthorizationContracts.Authority authority,
            MediaTranscriptStore transcriptStore) {
        return new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024, Duration.ofSeconds(2), 1,
                        "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobStore,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                com.ghatana.media.launcher.MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                MediaLifecyclePublisher.disabled(),
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, transcriptStore, Clock.systemUTC());
    }

    private static MediaSourceAuthorizationContracts.Authority authority(
            boolean allowResolve,
            boolean revokeOnRevalidate,
            AtomicInteger revalidations) {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-source-policy-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request) {
                if (!allowResolve) return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.DENIED, null);
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence(request));
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence) {
                revalidations.incrementAndGet();
                if (!revokeOnRevalidate) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
                }
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.REVOKED, null);
            }
        };
    }

    private static MediaSourceAuthorizationContracts.Evidence evidence(
            MediaSourceAuthorizationContracts.Request request) {
        Instant now = Instant.now();
        return new MediaSourceAuthorizationContracts.Evidence(
                "fixture-source-policy-authority", "decision-" + request.artifactId(),
                request.tenantId(), request.principalId(), "fixture-source-owner", request.artifactId(),
                request.sourceVersion(), request.sourceSha256(), request.operation(), request.purpose(),
                request.providerId(), request.providerVersion(), request.processingBoundary(),
                request.processingRegion(), request.providerRetention(), Set.of("speech_to_text"),
                Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                "rights-" + request.artifactId(), "policy-" + request.artifactId(), "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "fixture-source-clock-evidence", 0, now.minusSeconds(1), now.plusSeconds(60));
    }

    private static MediaTranscriptStore transcriptStore() {
        return new MediaTranscriptStore() {
            @Override public TranscriptRevision append(TranscriptDraft draft) {
                throw new UnsupportedOperationException("test store does not write transcripts");
            }
            @Override public List<TranscriptRevision> revisions(String tenantId, String transcriptId) {
                return List.of();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public void close() { }
        };
    }

    private static MediaProcessingProvider admittedProvider(
            AtomicInteger providerCalls, Profile profile) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return profile.providerId(); }
            @Override public String providerVersion() { return profile.providerVersion(); }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<Profile> speechToTextProfile() {
                return java.util.Optional.of(profile);
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "us"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                try {
                    ByteArrayOutputStream copied = new ByteArrayOutputStream();
                    context.copySourceContentTo(copied, 1_024);
                    if (copied.size() == 0 || context.sourceAuthorization() == null) {
                        return CompletableFuture.failedFuture(new AssertionError("admitted STT context is incomplete"));
                    }
                    return CompletableFuture.completedFuture(Map.of("text", "test transcript"));
                } catch (Exception failure) {
                    return CompletableFuture.failedFuture(failure);
                }
            }
        };
    }

    private static Profile qualifiedProfile(String profileId) {
        return new Profile("test-authorized-provider", "test-authorized-v1", profileId, "v1",
                "sha256:" + "a".repeat(64), ProfileQualification.QUALIFIED,
                Set.of("en-US"), false, TimingDisposition.SOURCE_CLOCK_BOUND,
                "fixture-qualification-evidence");
    }

    private static Map<String, Object> sourceClockMetadata() {
        return Map.of("sourceClockId", "fixture-clock",
                "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                "sourceClockTicksPerSecond", 1,
                "sourceDurationTicks", 1);
    }

    private static MediaProcessingProvider candidate(
            AtomicInteger providerCalls, Profile profile, ProcessingBoundary boundary) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-only-unqualified-candidate"; }
            @Override public String providerVersion() { return "test-only"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.SPEECH_TO_TEXT); }
            @Override public java.util.Optional<Profile> speechToTextProfile() {
                return java.util.Optional.ofNullable(profile);
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return boundary; }
            @Override public String processingRegion() { return "us"; }
            @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention
                    providerDataRetention() {
                return com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE;
            }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                return CompletableFuture.failedFuture(new AssertionError("NOT_ADMITTED must prevent provider I/O"));
            }
        };
    }

    private static Profile unqualifiedProfile(String profileId, TimingDisposition timing) {
        return new Profile("test-only-unqualified-candidate", "test-only", profileId, "v1",
                "sha256:" + "a".repeat(64), ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, timing, "");
    }

    private static ProcessingJobRequest request(String artifactId, String version, Map<String, Object> parameters) {
        return request(artifactId, version, parameters, governance());
    }

    private static ProcessingJobRequest request(
            String artifactId, String version, Map<String, Object> parameters,
            MediaGovernanceContext governance) {
        return new ProcessingJobRequest("speech-request", "tenant-a", "principal-a", "correlation-a",
                artifactId, version, JobType.SPEECH_TO_TEXT, "", parameters, governance);
    }

    private static Map<String, Object> speechParameters(String profileId, String languageTag) {
        return Map.of(
                "profileId", profileId,
                "profileVersion", "v1",
                "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", languageTag));
    }

    private static MediaGovernanceContext governance() {
        return new MediaGovernanceContext(
                "consent-a", "speech-transcription", DataClassification.CONFIDENTIAL, "us",
                Set.of("us"), true, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime) throws Exception {
        return artifact(runtime, Map.of());
    }

    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact artifact(
            MediaRuntime runtime, Map<String, Object> metadata) throws Exception {
        byte[] bytes = "stt-admission-source".getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                "tenant-a", "principal-a", "source.wav", "audio/wav", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), metadata), "stt-admission-upload");
        runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
        return runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
    }

    private static void assertNoJobOrProviderEffect(
            LocalMediaRuntimeSupport.JobStore store, AtomicInteger providerCalls) {
        assertThat(store.countByStatus(JobStatus.ACCEPTED)).isZero();
        assertThat(store.countByStatus(JobStatus.RUNNING)).isZero();
        assertThat(store.list("tenant-a", 100)).isEmpty();
        assertThat(providerCalls).hasValue(0);
    }
}
