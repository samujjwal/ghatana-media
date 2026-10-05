package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaConsentAuthority;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSessionRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Behavioral proof that consent is refreshed before every external frame and reconnect. */
class MediaConsentRevocationTest {

    @Test
    void revocationStopsNewFramesAndReconnectButStillAllowsResourceTermination() throws Exception {
        var root = Files.createTempDirectory("media-consent-revocation-");
        var authority = new MutableConsentAuthority();
        var provider = new RecordingExternalProvider();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(
                        true, "local", 8093, 1_024, 64, 1_024, Duration.ofSeconds(2), 1,
                        "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                authority,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(provider));

        MediaGovernanceContext governance = new MediaGovernanceContext(
                "consent-1",
                "speech-transcription",
                DataClassification.CONFIDENTIAL,
                "us",
                Set.of("us-west-2"),
                true,
                "short-lived-media",
                false,
                false,
                "",
                BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
        try {
            var registration = runtime.openStream(new StreamSessionRequest(
                    "tenant-a", "principal-a", "correlation-a", StreamKind.AUDIO,
                    provider.providerId(), 128, Duration.ofSeconds(30), Map.of(), governance));
            var connected = runtime.connectStream(
                    "tenant-a", registration.session().sessionId(), registration.connectionToken());
            StreamAck accepted = runtime.acceptFrame(new StreamFrame(
                    "tenant-a", connected.sessionId(), registration.connectionToken(), 0,
                    "first-frame".getBytes(StandardCharsets.UTF_8), false, Instant.now()));
            assertThat(accepted.acceptedSequence()).isZero();
            assertThat(provider.acceptedFrames()).isEqualTo(1);
            assertThat(authority.verifications()).isEqualTo(3);

            authority.revoke();

            assertThatThrownBy(() -> runtime.acceptFrame(new StreamFrame(
                    "tenant-a", connected.sessionId(), registration.connectionToken(), 1,
                    "must-not-leave".getBytes(StandardCharsets.UTF_8), false, Instant.now())))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("not active");
            assertThatThrownBy(() -> runtime.connectStream(
                    "tenant-a", connected.sessionId(), registration.connectionToken()))
                    .isInstanceOf(SecurityException.class)
                    .hasMessageContaining("not active");
            assertThat(provider.acceptedFrames()).isEqualTo(1);
            assertThat(authority.verifications()).isEqualTo(5);

            var closed = runtime.closeStream(
                    "tenant-a", connected.sessionId(), registration.connectionToken());
            assertThat(closed.state()).isEqualTo(StreamState.CLOSED);
            assertThat(provider.closed()).isTrue();
            assertThat(provider.terminationUsedCancellation()).isTrue();
            assertThat(authority.verifications())
                    .as("termination uses prior verified evidence and performs no new disclosure")
                    .isEqualTo(5);
        } finally {
            runtime.close();
        }
    }

    private static final class MutableConsentAuthority implements MediaConsentAuthority {
        private final AtomicBoolean active = new AtomicBoolean(true);
        private final AtomicInteger verifications = new AtomicInteger();

        @Override public String authorityId() { return "mutable-consent-authority"; }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }

        @Override
        public ConsentDecision verify(
                String tenantId,
                String principalId,
                MediaGovernanceContext governance,
                String operation) {
            verifications.incrementAndGet();
            if (!active.get()) return ConsentDecision.unverified();
            return new ConsentDecision(
                    true,
                    authorityId(),
                    governance.consentId(),
                    Instant.now(),
                    Instant.now().plusSeconds(60),
                    Set.of(governance.purpose()),
                    Set.of("us-west-2"),
                    true,
                    false);
        }

        void revoke() { active.set(false); }
        int verifications() { return verifications.get(); }
    }

    private static final class RecordingExternalProvider implements MediaStreamingProvider {
        private final AtomicInteger frames = new AtomicInteger();
        private final AtomicBoolean closed = new AtomicBoolean();
        private final AtomicBoolean terminationCancelled = new AtomicBoolean();

        @Override public String providerId() { return "external-stream-test"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.AUDIO); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
        @Override public String processingRegion() { return "us-west-2"; }
        @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }

        @Override
        public CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame) {
            if (!context.consentDecision().activeAt(Instant.now())) {
                return CompletableFuture.failedFuture(new SecurityException("active consent required"));
            }
            frames.incrementAndGet();
            return CompletableFuture.completedFuture(new StreamAck(
                    frame.sequence(), context.session().bufferedBytes() + frame.payload().length, false));
        }

        @Override
        public void closeSession(StreamContext context) {
            closed.set(true);
            terminationCancelled.set(context.cancellation().cancelled());
        }

        int acceptedFrames() { return frames.get(); }
        boolean closed() { return closed.get(); }
        boolean terminationUsedCancellation() { return terminationCancelled.get(); }
    }
}
