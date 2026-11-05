package com.ghatana.media.production.dubbing;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static com.ghatana.media.production.dubbing.DubbingOrchestrator.*;
import static org.assertj.core.api.Assertions.assertThat;

class DubbingOrchestratorTest {
    @Test
    void sourceRightsDenialStopsBeforeTranslationTtsOrAlignment() {
        Fixture f = new Fixture();
        f.rights.sourceStatus = RightsStatus.DENY;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.DENIED);
        assertThat(result.reason()).contains(Reason.SOURCE_RIGHTS_DENIED);
        assertThat(f.translationCalls.get()).isZero();
        assertThat(f.synthesisCalls.get()).isZero();
        assertThat(f.alignmentCalls.get()).isZero();
    }

    @Test
    void voiceRightsDenialStopsBeforeAnyProviderDispatch() {
        Fixture f = new Fixture();
        f.rights.voiceStatus = RightsStatus.DENY;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.DENIED);
        assertThat(result.reason()).contains(Reason.VOICE_RIGHTS_DENIED);
        assertThat(f.translationCalls.get()).isZero();
        assertThat(f.synthesisCalls.get()).isZero();
    }

    @Test
    void sourceOrVoiceRevocationBeforeDispatchStopsWithoutClaimingCompletedDubbing() {
        Fixture f = new Fixture();
        f.rights.voiceCurrent = false;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.REVOKED);
        assertThat(result.reason()).contains(Reason.VOICE_RIGHTS_REVOKED);
        assertThat(f.translationCalls.get()).isZero();
        assertThat(f.synthesisCalls.get()).isZero();
    }

    @Test
    void sourceRevocationBeforeDispatchAlsoStopsAllProviderEffects() {
        Fixture f = new Fixture();
        f.rights.sourceCurrent = false;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.REVOKED);
        assertThat(result.reason()).contains(Reason.SOURCE_RIGHTS_REVOKED);
        assertThat(f.translationCalls.get()).isZero();
        assertThat(f.synthesisCalls.get()).isZero();
    }

    @Test
    void voiceRevocationAfterTranslationPreventsTtsAndPreservesPartialEffect() {
        Fixture f = new Fixture();
        f.revokeVoiceAfterTranslation = true;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.REVOKED);
        assertThat(result.reason()).contains(Reason.VOICE_RIGHTS_REVOKED);
        assertThat(result.translationDispatched()).isTrue();
        assertThat(result.synthesisDispatchCount()).isZero();
        assertThat(result.segments()).isEmpty();
        assertThat(f.translationCalls.get()).isEqualTo(1);
        assertThat(f.synthesisCalls.get()).isZero();
    }

    @Test
    void exactSourceTranscriptLocaleVoiceAndSourceTimingAreBoundAcrossAllPorts() {
        Fixture f = new Fixture();
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.COMPLETED);
        assertThat(result.sourceVersion()).isEqualTo(f.request().sourceVersion());
        assertThat(result.transcriptVersionId()).isEqualTo("transcript-v3");
        assertThat(result.targetLocale()).isEqualTo("es-MX");
        assertThat(result.ticksPerSecond()).isEqualTo(48_000);
        assertThat(result.sourceDurationTicks()).isEqualTo(10_000);
        assertThat(result.voice()).isEqualTo(new VoiceIdentity("voice-a", "voice-v5"));
        assertThat(result.sourceClockId()).isEqualTo("source-clock-9");
        assertThat(result.segments()).singleElement().satisfies(segment -> {
            assertThat(segment.segmentId()).isEqualTo("seg-1");
            assertThat(segment.sourceStartTick()).isEqualTo(100);
            assertThat(segment.sourceEndTick()).isEqualTo(300);
            assertThat(segment.alignedStartTick()).isEqualTo(120);
            assertThat(segment.alignedEndTick()).isEqualTo(280);
            assertThat(segment.text()).isEqualTo("hola");
        });
    }

    @Test
    void missingLanguageProviderAndAlignmentControlReturnTypedUnavailableBeforeLaterEffects() {
        Fixture noLanguage = new Fixture();
        noLanguage.translationCapability = Capability.unavailable(CapabilityReason.LANGUAGE_UNAVAILABLE);
        assertUnavailable(noLanguage, Reason.LANGUAGE_UNAVAILABLE);
        assertThat(noLanguage.translationCalls.get()).isZero();

        Fixture noTts = new Fixture();
        noTts.synthesisCapability = Capability.unavailable(CapabilityReason.PROVIDER_UNAVAILABLE);
        assertUnavailable(noTts, Reason.VOICE_UNAVAILABLE);
        assertThat(noTts.translationCalls.get()).isZero();

        Fixture noAlignment = new Fixture();
        noAlignment.alignmentCapability = Capability.unavailable(CapabilityReason.CONTROL_UNAVAILABLE);
        assertUnavailable(noAlignment, Reason.CONTROL_UNAVAILABLE);
        assertThat(noAlignment.translationCalls.get()).isZero();
        assertThat(noAlignment.synthesisCalls.get()).isZero();
    }

    @Test
    void translationTimingMismatchCannotBeRelabeledAsSourceAligned() {
        Fixture f = new Fixture();
        f.badTranslationTiming = true;
        DubbingResult result = f.orchestrator().dub(f.request());
        assertThat(result.status()).isEqualTo(ResultStatus.OUTCOME_UNKNOWN);
        assertThat(result.reason()).contains(Reason.INVALID_PROVIDER_RESULT);
        assertThat(result.segments()).isEmpty();
        assertThat(f.synthesisCalls.get()).isZero();
    }

    @Test
    void missingTranslationTtsOrAlignmentPortIsExplicitlyUnavailable() {
        Fixture f = new Fixture();
        assertThat(new DubbingOrchestrator(f.rights, null, f.synthesis(), f.alignment()).dub(f.request()))
                .satisfies(result -> {
                    assertThat(result.status()).isEqualTo(ResultStatus.UNAVAILABLE);
                    assertThat(result.reason()).contains(Reason.TRANSLATION_CAPABILITY_UNAVAILABLE);
                });
        assertThat(new DubbingOrchestrator(f.rights, f.translation(), null, f.alignment()).dub(f.request()).reason())
                .contains(Reason.TTS_CAPABILITY_UNAVAILABLE);
        assertThat(new DubbingOrchestrator(f.rights, f.translation(), f.synthesis(), null).dub(f.request()).reason())
                .contains(Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE);
        assertThat(f.translationCalls.get()).isZero();
        assertThat(f.synthesisCalls.get()).isZero();
    }

    private static void assertUnavailable(Fixture fixture, Reason reason) {
        DubbingResult result = fixture.orchestrator().dub(fixture.request());
        assertThat(result.status()).isEqualTo(ResultStatus.UNAVAILABLE);
        assertThat(result.reason()).contains(reason);
    }

    private static final class Fixture {
        final AtomicInteger translationCalls = new AtomicInteger();
        final AtomicInteger synthesisCalls = new AtomicInteger();
        final AtomicInteger alignmentCalls = new AtomicInteger();
        final TestRights rights = new TestRights();
        Capability translationCapability = Capability.available();
        Capability synthesisCapability = Capability.available();
        Capability alignmentCapability = Capability.available();
        boolean revokeVoiceAfterTranslation;
        boolean badTranslationTiming;
        String lastDigest;

        Request request() {
            SourceVersion source = new SourceVersion("artifact-a", "artifact-version-11");
            TranscriptRevision transcript = new TranscriptRevision("transcript-v3", source, "en-US", "source-clock-9",
                    48_000, 10_000, List.of(new TranscriptSegment("seg-1", "hello", 100, 300)));
            return new Request("tenant-a", "dub-request-1", source, transcript, "es-MX",
                    new VoiceIdentity("voice-a", "voice-v5"), "authorized-dubbing");
        }

        TranslationPort translation() {
            return new TranslationPort() {
                @Override public Capability capability(String sourceLocale, String targetLocale) { return translationCapability; }
                @Override public TranslationResult translate(TranslationRequest request) {
                    translationCalls.incrementAndGet();
                    if (revokeVoiceAfterTranslation) rights.voiceCurrent = false;
                    return new TranslationResult(request.tenantId(), request.requestId(), request.sourceVersion(),
                            request.transcriptVersionId(), request.sourceLocale(), request.targetLocale(), request.sourceClockId(),
                            request.ticksPerSecond(), request.sourceDurationTicks(),
                            List.of(new TranslatedSegment("seg-1", "hola", 100, badTranslationTiming ? 301 : 300)));
                }
            };
        }

        SynthesisPort synthesis() {
            return new SynthesisPort() {
                @Override public Capability capability(String targetLocale, VoiceIdentity voice) { return synthesisCapability; }
                @Override public SynthesizedAudio synthesize(SynthesisRequest request) {
                    synthesisCalls.incrementAndGet();
                    byte[] bytes = new byte[] { 1, 2, 3, 4 };
                    lastDigest = com.ghatana.media.runtime.MediaCreationContracts.sha256(bytes);
                    return new SynthesizedAudio(request.tenantId(), request.requestId(), request.sourceVersion(),
                            request.transcriptVersionId(), request.targetLocale(), request.voice(), request.sourceClockId(),
                            request.ticksPerSecond(), request.sourceDurationTicks(), request.sourceStartTick(),
                            request.sourceEndTick(), request.segmentId(), bytes, lastDigest);
                }
            };
        }

        AlignmentPort alignment() {
            return new AlignmentPort() {
                @Override public Capability capability(String targetLocale) { return alignmentCapability; }
                @Override public AlignmentResult align(AlignmentRequest request) {
                    alignmentCalls.incrementAndGet();
                    return new AlignmentResult(request.tenantId(), request.requestId(), request.sourceVersion(),
                            request.transcriptVersionId(), request.targetLocale(), request.sourceClockId(),
                            request.ticksPerSecond(), request.sourceDurationTicks(),
                            List.of(new AlignedSegment("seg-1", lastDigest, 120, 280)));
                }
            };
        }

        DubbingOrchestrator orchestrator() { return new DubbingOrchestrator(rights, translation(), synthesis(), alignment()); }
    }

    private static final class TestRights implements RightsConsentPort {
        RightsStatus sourceStatus = RightsStatus.ALLOW;
        RightsStatus voiceStatus = RightsStatus.ALLOW;
        boolean sourceCurrent = true;
        boolean voiceCurrent = true;
        @Override public RightsDecision evaluate(RightsScope scope) {
            RightsStatus status = scope.kind() == RightsKind.SOURCE_DERIVATIVE ? sourceStatus : voiceStatus;
            return new RightsDecision(status, status == RightsStatus.ALLOW ? "authority:test" : "", status == RightsStatus.ALLOW ? "decision:test" : "");
        }
        @Override public boolean isCurrent(RightsScope scope, RightsDecision decision) {
            return scope.kind() == RightsKind.SOURCE_DERIVATIVE ? sourceCurrent : voiceCurrent;
        }
    }
}
