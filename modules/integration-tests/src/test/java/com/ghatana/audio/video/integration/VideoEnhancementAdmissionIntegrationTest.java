package com.ghatana.audio.video.integration;

import com.ghatana.media.production.rendering.TemporalVideoRestoration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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

    @Test
    void sourceRightsAndDecoderReceiveTheExactTenantPrincipalAndRightsBinding() {
        AtomicReference<ArtifactBinding> authorityBinding = new AtomicReference<>();
        AtomicReference<String> authorizedOperation = new AtomicReference<>();
        AtomicReference<ArtifactBinding> decoderBinding = new AtomicReference<>();
        Result failedRead = TemporalVideoRestoration.restore(
                new RestorationRequest("request-j08-exact-source-owner", SOURCE),
                (binding, operation) -> {
                    authorityBinding.set(binding);
                    authorizedOperation.set(operation);
                    return new AuthorityDecision(AuthorityStatus.ALLOWED, "source-allow-j08");
                },
                binding -> {
                    decoderBinding.set(binding);
                    throw new IllegalStateException("source decoder unavailable");
                },
                Optional.empty(),
                null,
                null);

        assertThat(failedRead.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(failedRead.reason()).contains(Reason.SOURCE_READ_UNAVAILABLE);
        assertThat(failedRead.candidate()).isEmpty();
        assertThat(authorityBinding.get()).isSameAs(SOURCE);
        assertThat(authorityBinding.get().tenantId()).isEqualTo("tenant-j08");
        assertThat(authorityBinding.get().principalId()).isEqualTo("editor-j08");
        assertThat(authorityBinding.get().purposeRef()).isEqualTo("purpose:video-enhancement");
        assertThat(authorityBinding.get().rightsEvidenceRefs()).containsExactly("rights-evidence:j08");
        assertThat(authorizedOperation.get()).isEqualTo(OPERATION_ID);
        assertThat(decoderBinding.get()).isSameAs(SOURCE);
        assertThat(SOURCE.sha256()).isEqualTo("d".repeat(64));
    }

    @Test
    void decoderReturningDifferentSourceDigestIsRejectedBeforeCandidateCreation() {
        ArtifactBinding originalBinding = SOURCE;
        AtomicInteger decoderCalls = new AtomicInteger();
        DecodedFrameSequence differentArtifactBytes = new DecodedFrameSequence(
                SOURCE.artifactId(), SOURCE.versionId(), "e".repeat(64), new TimeBase(1, 30), List.of(
                        new Frame(0, 0, 1, 1, new Roi(0, 0, 1, 1), new byte[] {1, 2, 3}),
                        new Frame(1, 1, 1, 1, new Roi(0, 0, 1, 1), new byte[] {4, 5, 6}),
                        new Frame(2, 2, 1, 1, new Roi(0, 0, 1, 1), new byte[] {7, 8, 9})));

        assertThatThrownBy(() -> TemporalVideoRestoration.restore(
                new RestorationRequest("request-j08-source-digest-mismatch", SOURCE),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "source-allow-j08"),
                binding -> {
                    decoderCalls.incrementAndGet();
                    return differentArtifactBytes;
                },
                Optional.empty(),
                null,
                null))
                .isInstanceOf(InvalidRestorationInputException.class)
                .hasMessageContaining("exact requested source artifact version");

        assertThat(decoderCalls).hasValue(1);
        assertThat(SOURCE).isSameAs(originalBinding);
        assertThat(SOURCE.sha256()).isEqualTo("d".repeat(64));
    }
}
