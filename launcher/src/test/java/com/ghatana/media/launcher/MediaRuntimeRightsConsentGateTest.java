package com.ghatana.media.launcher;

import com.ghatana.media.runtime.InMemoryMediaRightsAttestationStore;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaRightsConsentAuthority;
import com.ghatana.media.runtime.MediaRightsConsentAuthority.AttestRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Canonical job lane (not the DEV lane) over the rights and consent authority: speech-to-text and vision job
 * submission is refused without a statement for the exact source version, admitted with one and refused again
 * once it is revoked. The Shared-policy authority below is a TEST DOUBLE standing in for the real one; the
 * statements are real records of synthetic TEST principals in the in-memory unit-test store. Nothing here is
 * evidence of any real rights, consent or approval.
 */
class MediaRuntimeRightsConsentGateTest {
    private static final String TENANT = "tenant-a";
    private static final String UPLOADER = "principal-a";
    private static final String REVIEWER = "principal-reviewer";

    @Test
    void visionJobIsRefusedWithoutStatementAdmittedWithOneAndRefusedAfterRevocation() throws Exception {
        try (Fixture fixture = new Fixture(List.of(visionProvider()))) {
            MediaArtifact source = fixture.artifact(Map.of());
            ProcessingJobRequest request = request("req-vision-1", JobType.VISION, source, Map.of());

            assertRefused(fixture, request);
            assertThat(fixture.jobStore.list(TENANT, 100)).isEmpty();

            var attestation = fixture.attest(source, StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING));
            ProcessingJob accepted = fixture.submit(request("req-vision-2", JobType.VISION, source, Map.of()));
            assertThat(accepted.jobId()).isNotBlank();

            fixture.administration.revoke(who(UPLOADER, AssuranceSource.UNSPECIFIED),
                    attestation.attestation().attestationId(), "TEST revoke");
            assertRefused(fixture, request("req-vision-3", JobType.VISION, source, Map.of()));
        }
    }

    @Test
    void speechToTextJobIsRefusedWithoutStatementAdmittedWithOneAndRefusedAfterRevocation() throws Exception {
        try (Fixture fixture = new Fixture(List.of(sttProvider()))) {
            MediaArtifact source = fixture.artifact(Map.of("sourceClockId", "fixture-clock",
                    "sourceClockMappingEvidenceRef", "fixture-clock-evidence",
                    "sourceClockTicksPerSecond", 1, "sourceDurationTicks", 1));
            Map<String, Object> parameters = Map.of(
                    "profileId", "profile-a", "profileVersion", "v1",
                    "profileConfigurationDigest", "sha256:" + "a".repeat(64),
                    "languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en-US"));

            assertRefused(fixture, request("req-stt-1", JobType.SPEECH_TO_TEXT, source, parameters));
            assertThat(fixture.jobStore.list(TENANT, 100)).isEmpty();

            var attestation = fixture.attest(source, StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING));
            assertThat(fixture.submit(request("req-stt-2", JobType.SPEECH_TO_TEXT, source, parameters)).jobId())
                    .isNotBlank();

            fixture.administration.revoke(who(UPLOADER, AssuranceSource.UNSPECIFIED),
                    attestation.attestation().attestationId(), "TEST revoke");
            assertRefused(fixture, request("req-stt-3", JobType.SPEECH_TO_TEXT, source, parameters));
        }
    }

    @Test
    void aStatementForAnotherVersionNeverAdmitsAndAnUnconfirmedVoiceStatementDoesNotEither() throws Exception {
        try (Fixture fixture = new Fixture(List.of(visionProvider()))) {
            MediaArtifact source = fixture.artifact(Map.of());
            MediaArtifact otherVersion = fixture.artifact(Map.of());
            fixture.attest(otherVersion, StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING));
            assertRefused(fixture, request("req-other", JobType.VISION, source, Map.of()));

            // A job carrying a voice or likeness reference needs a CONFIRMED person-consent statement.
            fixture.attest(source, StatementKind.MEDIA_RIGHTS, Set.of(Scope.PROCESSING));
            Map<String, Object> withVoice = Map.of("voiceReference", "voice-artifact@sha256:" + "d".repeat(64));
            assertThat(fixture.submit(request("req-plain", JobType.VISION, source, Map.of())).jobId()).isNotBlank();
            assertRefused(fixture, request("req-voice-1", JobType.VISION, source, withVoice));

            var consent = fixture.attest(source, StatementKind.IDENTIFIABLE_PERSON_CONSENT,
                    Set.of(Scope.VOICE_OR_LIKENESS_USE));
            assertRefused(fixture, request("req-voice-2", JobType.VISION, source, withVoice));
            fixture.administration.confirm(who(REVIEWER, AssuranceSource.UNSPECIFIED),
                    consent.attestation().attestationId(), "TEST confirm");
            assertThat(fixture.submit(request("req-voice-3", JobType.VISION, source, withVoice)).jobId())
                    .isNotBlank();
        }
    }

    // -- fixtures -------------------------------------------------------------------------------------------

    private static void assertRefused(Fixture fixture, ProcessingJobRequest request) {
        assertThatThrownBy(() -> fixture.submit(request)).isInstanceOf(MediaCapabilityNotAdmittedException.class);
    }

    private static AuthenticatedPrincipal who(String principal, AssuranceSource assurance) {
        return new AuthenticatedPrincipal(TENANT, principal, Instant.now(), assurance);
    }

    private static ProcessingJobRequest request(String id, JobType type, MediaArtifact source,
                                                Map<String, Object> parameters) {
        return new ProcessingJobRequest(id, TENANT, UPLOADER, "correlation-" + id, source.artifactId(),
                source.version().value(), type, "", parameters, new MediaGovernanceContext(
                "consent-a", "analysis",
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL,
                "us", Set.of("us"), true, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE));
    }

    private static final class Fixture implements AutoCloseable {
        final LocalMediaRuntimeSupport.JobStore jobStore = new LocalMediaRuntimeSupport.JobStore();
        final MediaRuntime runtime;
        final MediaRightsConsentAuthority administration;

        Fixture(List<MediaProcessingProvider> providers) throws Exception {
            var root = Files.createTempDirectory("media-rights-gate-");
            var composed = MediaRightsConsentComposition.composeWithStore(policyDouble(),
                    new InMemoryMediaRightsAttestationStore(), "test", Clock.systemUTC());
            administration = composed.administration().orElseThrow();
            runtime = new MediaRuntime(
                    new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                            Duration.ofSeconds(10), 8, "", "", false, false, root),
                    new LocalMediaRuntimeSupport.FileArtifactStore(root), jobStore,
                    new LocalMediaRuntimeSupport.StreamStore(), null,
                    MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(10)),
                    MediaLifecyclePublisher.disabled(), providers,
                    List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(),
                    composed.authority(), transcriptStore(), Clock.systemUTC());
        }

        ProcessingJob submit(ProcessingJobRequest request) {
            return runtime.submit(request, new AuthenticatedPrincipal(
                    request.tenantId(), request.principalId(), Instant.now()));
        }

        MediaArtifact artifact(Map<String, Object> metadata) throws Exception {
            byte[] bytes = ("rights-gate-" + UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                    TENANT, UPLOADER, "source.wav", "audio/wav", bytes.length,
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                    "CONFIDENTIAL", Duration.ofMinutes(10), metadata), "upload-" + UUID.randomUUID());
            runtime.appendChunk(TENANT, UPLOADER, upload.uploadId(), 0, bytes);
            return runtime.completeUpload(TENANT, UPLOADER, upload.uploadId());
        }

        com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord attest(
                MediaArtifact source, StatementKind kind, Set<Scope> scopes) {
            return administration.attest(who(UPLOADER, AssuranceSource.UNSPECIFIED), new AttestRequest(
                    source.artifactId(), source.version().value(), source.sha256(), kind, scopes,
                    "TEST basis for a synthetic fixture", null, null, null));
        }

        @Override public void close() { runtime.close(); }
    }

    /** TEST DOUBLE for the Shared-policy authority: it allows, and the gate decides on attestations. */
    private static MediaSourceAuthorizationContracts.Authority policyDouble() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-policy-double"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request, AuthenticatedPrincipal authenticated) {
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-" + request.artifactId(), request.tenantId(),
                        request.principalId(), "fixture-owner", request.artifactId(), request.sourceVersion(),
                        request.sourceSha256(), request.operation(), request.purpose(), request.providerId(),
                        request.providerVersion(), request.processingBoundary(), request.processingRegion(),
                        request.providerRetention(), Set.of(request.operation().toLowerCase(Locale.ROOT)),
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
                    MediaSourceAuthorizationContracts.Evidence expected, AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expected);
            }
        };
    }

    private static MediaProcessingProvider visionProvider() {
        return provider("test-vision", JobType.VISION, null);
    }

    private static MediaProcessingProvider sttProvider() {
        return provider("test-stt", JobType.SPEECH_TO_TEXT, java.util.Optional.of(
                new com.ghatana.media.runtime.MediaSpeechToTextAdmission.Profile(
                        "test-stt", "v1", "profile-a", "v1", "sha256:" + "a".repeat(64),
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                        Set.of("en-US"), false,
                        com.ghatana.media.runtime.MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                        "fixture-qualification-evidence")));
    }

    private static MediaProcessingProvider provider(
            String id, JobType type,
            java.util.Optional<com.ghatana.media.runtime.MediaSpeechToTextAdmission.Profile> profile) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return id; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(type); }
            @Override public java.util.Optional<com.ghatana.media.runtime.MediaSpeechToTextAdmission.Profile>
                    speechToTextProfile() {
                return profile == null ? java.util.Optional.empty() : profile;
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(Map.of("text", "grounded transcript"));
            }
        };
    }

    private static com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore transcriptStore() {
        return new com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore() {
            @Override public com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision append(
                    com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft draft) {
                throw new UnsupportedOperationException("test store does not write transcripts");
            }
            @Override public List<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision> revisions(
                    String tenantId, String transcriptId) {
                return List.of();
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public void close() { }
        };
    }
}
