package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** @doc.type class @doc.purpose Prove authority-owned consent checks occur before remote Media dispatch */
class MediaExternalGovernanceTest {

    @Test
    void unverifiedConsentBlocksRemoteProcessingBeforeNetworkDispatch() {
        HttpMediaProcessingProvider provider = processingProvider();
        ProcessingContext context = new ProcessingContext(
                request(governance(true, Set.of("us"), true), Map.of()),
                artifact(), new Cancellation(), ConsentDecision.unverified());

        assertThatThrownBy(() -> provider.process(context))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("Verified");
    }

    @Test
    void bothRequestAndAuthorityMustPermitExternalProcessingAndResidency() {
        HttpMediaProcessingProvider provider = processingProvider();

        assertThatThrownBy(() -> provider.process(new ProcessingContext(
                request(governance(false, Set.of("us"), true), Map.of()),
                artifact(), new Cancellation(), verifiedConsent(Set.of("us"), true, true))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("request does not permit external processing");

        assertThatThrownBy(() -> provider.process(new ProcessingContext(
                request(governance(true, Set.of("us"), true), Map.of()),
                artifact(), new Cancellation(), verifiedConsent(Set.of("us"), false, true))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("consent does not permit external processing");

        assertThatThrownBy(() -> provider.process(new ProcessingContext(
                request(governance(true, Set.of("us"), true), Map.of()),
                artifact(), new Cancellation(), verifiedConsent(Set.of("eu"), true, true))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("verified consent");
    }

    @Test
    void callerCannotSelfAuthorizePurposeOrBiometricProcessing() {
        HttpMediaProcessingProvider provider = processingProvider();
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("faceRecognition", true);

        ConsentDecision wrongPurpose = new ConsentDecision(
                true, "consent-authority", "consent-a", Instant.now(), Instant.now().plusSeconds(600),
                Set.of("speech-to-text"), Set.of("us"), true, true);
        assertThatThrownBy(() -> provider.process(new ProcessingContext(
                request(governance(true, Set.of("us"), true), parameters),
                artifact(), new Cancellation(), wrongPurpose)))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("purpose");

        assertThatThrownBy(() -> provider.process(new ProcessingContext(
                request(governance(true, Set.of("us"), true), parameters),
                artifact(), new Cancellation(), verifiedConsent(Set.of("us"), true, false))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("Biometric");
    }

    @Test
    void classificationFloorAndProviderRetentionPostureFailBeforeNetworkDispatch() {
        HttpMediaProcessingProvider noRetention = processingProvider();
        MediaGovernanceContext lowered = new MediaGovernanceContext(
                "consent-a", "vision-analysis", DataClassification.PUBLIC, "us", Set.of("us"),
                true, "one-day", false, false, "", BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
        assertThatThrownBy(() -> noRetention.process(new ProcessingContext(
                request(lowered, Map.of()), artifact(), new Cancellation(),
                verifiedConsent(Set.of("us"), true, false))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("classification floor");

        HttpMediaProcessingProvider retaining = new HttpMediaProcessingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "http://127.0.0.1:1",
                "MEDIA_HTTP_PROVIDER_REGION", "us",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "TRANSIENT"));
        assertThatThrownBy(() -> retaining.process(new ProcessingContext(
                request(governance(true, Set.of("us"), false), Map.of()),
                artifact(), new Cancellation(), verifiedConsent(Set.of("us"), true, false))))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("retention posture");
    }

    @Test
    void unverifiedConsentBlocksRemoteStreamingBeforeNetworkDispatch() {
        HttpMediaStreamingProvider provider = streamingProvider();
        StreamSession session = new StreamSession(
                "tenant-a", "session-a", "principal-a", StreamKind.AUDIO,
                provider.providerId(), StreamState.CONNECTED, -1L, 0L, 1024L, 0,
                Instant.now().plusSeconds(30), Instant.now(), Instant.now(), null, Map.of(), 1);
        StreamContext context = new StreamContext(
                session, new Cancellation(), ConsentDecision.unverified(),
                governance(true, Set.of("us"), false));
        StreamFrame frame = new StreamFrame(
                "tenant-a", "session-a", "token", 0L, new byte[] {1}, false, Instant.now());

        assertThatThrownBy(() -> provider.accept(context, frame))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("Verified");
    }

    private static HttpMediaProcessingProvider processingProvider() {
        return new HttpMediaProcessingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "http://127.0.0.1:1",
                "MEDIA_HTTP_PROVIDER_REGION", "us",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE"));
    }

    private static HttpMediaStreamingProvider streamingProvider() {
        return new HttpMediaStreamingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "http://127.0.0.1:1",
                "MEDIA_HTTP_PROVIDER_REGION", "us",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE"));
    }

    private static ProcessingJobRequest request(
            MediaGovernanceContext governance,
            Map<String, Object> parameters) {
        return new ProcessingJobRequest(
                "request-a", "tenant-a", "principal-a", "correlation-a", "artifact-a",
                JobType.VISION, "", parameters, governance);
    }

    private static MediaArtifact artifact() {
        return new MediaArtifact(
                "tenant-a", "principal-a", "artifact-a", "image.jpg", "image/jpeg", 10L,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "s3://opaque/artifact-a", "CONFIDENTIAL", Instant.now(),
                Instant.now().plus(Duration.ofDays(1)), Map.of());
    }

    private static MediaGovernanceContext governance(
            boolean externalAllowed,
            Set<String> regions,
            boolean biometricAllowed) {
        return new MediaGovernanceContext(
                "consent-a", "vision-analysis", DataClassification.RESTRICTED, "us", regions,
                externalAllowed, "biometric-derived-24h/v1", false, biometricAllowed,
                biometricAllowed ? "explicit-consent" : "",
                biometricAllowed ? BiometricSensitivity.DERIVED : BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
    }

    private static ConsentDecision verifiedConsent(
            Set<String> regions,
            boolean externalAllowed,
            boolean biometricAllowed) {
        return new ConsentDecision(
                true, "consent-authority", "consent-a", Instant.now(), Instant.now().plusSeconds(600),
                Set.of("vision-analysis"), regions, externalAllowed, biometricAllowed);
    }
}
