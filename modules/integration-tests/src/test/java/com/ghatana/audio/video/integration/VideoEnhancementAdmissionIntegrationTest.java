package com.ghatana.audio.video.integration;

import com.ghatana.media.production.rendering.TemporalVideoRestoration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Source-free J-08 scenario boundary checks. These verify fail-closed status
 * handling; they do not exercise a real decoder, encoder, provider, or quality reference.
 */
class VideoEnhancementAdmissionIntegrationTest {
    private static final ArtifactBinding SOURCE = new ArtifactBinding(
            "tenant-j08", "editor-j08", "source-j08", "version-4", "d".repeat(64),
            "purpose:video-enhancement", List.of("rights-evidence:j08"), "policy-decision:j08");

    @Test
    void missingDecoderAndUnavailableOrDeniedRightsNeverProduceCandidateOrChangeSourceBinding() {
        ArtifactBinding originalBinding = SOURCE;
        AtomicInteger decoderCalls = new AtomicInteger();
        RestorationRequest request = new RestorationRequest("request-j08-missing-decoder", SOURCE);

        Result noDecoder = TemporalVideoRestoration.restore(
                request,
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "source-allow-j08"),
                null,
                Optional.empty(),
                null,
                null);

        assertThat(noDecoder.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(noDecoder.reason()).contains(Reason.SOURCE_READ_UNAVAILABLE);
        assertThat(noDecoder.candidate()).isEmpty();
        assertThat(decoderCalls).hasValue(0);
        assertThat(SOURCE).isSameAs(originalBinding);
        assertThat(SOURCE).isEqualTo(originalBinding);

        AtomicInteger sourceReads = new AtomicInteger();
        Result unknownAuthority = TemporalVideoRestoration.restore(
                new RestorationRequest("request-j08-unknown-source-rights", SOURCE),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.UNAVAILABLE, ""),
                binding -> {
                    sourceReads.incrementAndGet();
                    throw new AssertionError("source must not be read when source rights are unknown");
                },
                Optional.empty(),
                null,
                null);

        assertThat(unknownAuthority.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(unknownAuthority.reason()).contains(Reason.SOURCE_AUTHORITY_UNAVAILABLE);
        assertThat(unknownAuthority.candidate()).isEmpty();
        assertThat(sourceReads).hasValue(0);
        assertThat(decoderCalls).hasValue(0);
        assertThat(SOURCE).isSameAs(originalBinding);
        assertThat(SOURCE).isEqualTo(originalBinding);

        Result denied = TemporalVideoRestoration.restore(
                new RestorationRequest("request-j08-denied", SOURCE),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.DENIED, ""),
                binding -> {
                    decoderCalls.incrementAndGet();
                    throw new AssertionError("decoder must not run when source rights are denied");
                },
                Optional.empty(),
                null,
                null);

        assertThat(denied.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(denied.reason()).contains(Reason.SOURCE_RIGHTS_DENIED);
        assertThat(denied.candidate()).isEmpty();
        assertThat(decoderCalls).hasValue(0);
        assertThat(SOURCE).isSameAs(originalBinding);
        assertThat(SOURCE.sha256()).isEqualTo("d".repeat(64));
    }

    @Test
    void decoderReadFailureReturnsUnavailableWithoutCandidateOrSourceMutation() {
        ArtifactBinding originalBinding = SOURCE;
        AtomicInteger decoderCalls = new AtomicInteger();
        Result failedRead = TemporalVideoRestoration.restore(
                new RestorationRequest("request-j08-decoder-read-failure", SOURCE),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "source-allow-j08"),
                binding -> {
                    decoderCalls.incrementAndGet();
                    throw new IllegalStateException("source decoder unavailable");
                },
                Optional.empty(),
                null,
                null);

        assertThat(failedRead.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(failedRead.reason()).contains(Reason.SOURCE_READ_UNAVAILABLE);
        assertThat(failedRead.candidate()).isEmpty();
        assertThat(decoderCalls).hasValue(1);
        assertThat(SOURCE).isSameAs(originalBinding);
        assertThat(SOURCE.sha256()).isEqualTo("d".repeat(64));
    }
}
