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
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Decision;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.LanguageMode;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Profile;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.ProfileQualification;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Reason;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.TimingDisposition;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
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
                    .isInstanceOf(MediaSpeechToTextAdmission.NotAdmittedException.class)
                    .satisfies(failure -> assertThat(((MediaSpeechToTextAdmission.NotAdmittedException) failure)
                            .decision().reasons()).contains(Reason.SOURCE_VERSION_STALE_OR_NOT_FOUND));
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
        byte[] bytes = "stt-admission-source".getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                "tenant-a", "principal-a", "source.wav", "audio/wav", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()), "stt-admission-upload");
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
