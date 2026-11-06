package com.ghatana.media.production.dubbing;

import com.ghatana.media.production.dubbing.DubbingOrchestrator.*;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

/** Source-free J-16 negative scenario; test-only rights decisions are not authority evidence. */
class J16TranslatedDubbedVideoCapabilityScenarioTest {
    private enum MissingCapability { TRANSLATION, TTS, FORCED_ALIGNMENT }

    @Test
    void missingTranslationTtsOrForcedAlignmentStaysTypedUnavailableAndKeepsSourceBinding() {
        for (MissingCapability missing : MissingCapability.values()) {
            Request request = request();
            List<TranscriptSegment> expectedSourceOrder = List.of(
                    new TranscriptSegment("fixture-seg-2", "synthetic source text two", 12_000, 18_000),
                    new TranscriptSegment("fixture-seg-1", "synthetic source text one", 1_200, 6_000));
            DubbingOrchestrator orchestrator = new DubbingOrchestrator(
                    new FixtureRights(),
                    translation(missing != MissingCapability.TRANSLATION),
                    synthesis(missing != MissingCapability.TTS),
                    alignment(missing != MissingCapability.FORCED_ALIGNMENT));

            DubbingResult result = orchestrator.dub(request);

            Reason expectedReason = switch (missing) {
                case TRANSLATION -> Reason.TRANSLATION_CAPABILITY_UNAVAILABLE;
                case TTS -> Reason.TTS_CAPABILITY_UNAVAILABLE;
                case FORCED_ALIGNMENT -> Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE;
            };
            assertThat(result.status()).as("missing %s", missing).isEqualTo(ResultStatus.UNAVAILABLE);
            assertThat(result.reason()).contains(expectedReason);
            assertThat(result.sourceVersion()).isEqualTo(request.sourceVersion());
            assertThat(result.transcriptVersionId()).isEqualTo(request.transcript().transcriptVersionId());
            assertThat(result.sourceClockId()).isEqualTo(request.transcript().sourceClockId());
            assertThat(result.ticksPerSecond()).isEqualTo(request.transcript().ticksPerSecond());
            assertThat(result.sourceDurationTicks()).isEqualTo(request.transcript().sourceDurationTicks());
            assertThat(request.transcript().segments()).containsExactlyElementsOf(expectedSourceOrder);
            assertThat(result.translationDispatched()).isFalse();
            assertThat(result.synthesisDispatchCount()).isZero();
            assertThat(result.segments()).isEmpty();
        }
    }

    @Test
    void voiceConsentRevokedAfterTranslationPreventsSynthesisAndReturnsNoPartialDub() {
        Request request = request();
        AtomicBoolean voiceCurrent = new AtomicBoolean(true);
        RightsConsentPort rights = new RightsConsentPort() {
            @Override public RightsDecision evaluate(RightsScope scope) {
                return new RightsDecision(RightsStatus.ALLOW, "fixture-authority", "fixture-decision");
            }
            @Override public boolean isCurrent(RightsScope scope, RightsDecision decision) {
                return scope.kind() != RightsKind.VOICE_SYNTHESIS || voiceCurrent.get();
            }
        };
        TranslationPort translation = new TranslationPort() {
            @Override public Capability capability(String sourceLocale, String targetLocale) {
                return Capability.available();
            }
            @Override public TranslationResult translate(TranslationRequest input) {
                voiceCurrent.set(false);
                return new TranslationResult(input.tenantId(), input.requestId(), input.sourceVersion(),
                        input.transcriptVersionId(), input.sourceLocale(), input.targetLocale(),
                        input.sourceClockId(), input.ticksPerSecond(), input.sourceDurationTicks(),
                        input.segments().stream().map(segment -> new TranslatedSegment(
                                segment.segmentId(), "synthetic translated text", segment.startTick(), segment.endTick())).toList());
            }
        };
        AtomicBoolean synthesisCalled = new AtomicBoolean();
        SynthesisPort synthesis = new SynthesisPort() {
            @Override public Capability capability(String targetLocale, VoiceIdentity voice) {
                return Capability.available();
            }
            @Override public SynthesizedAudio synthesize(SynthesisRequest input) {
                synthesisCalled.set(true);
                throw new AssertionError("revoked voice consent must prevent synthesis dispatch");
            }
        };
        AlignmentPort alignment = alignment(true);

        DubbingResult result = new DubbingOrchestrator(rights, translation, synthesis, alignment).dub(request);

        assertThat(result.status()).isEqualTo(ResultStatus.REVOKED);
        assertThat(result.reason()).contains(Reason.VOICE_RIGHTS_REVOKED);
        assertThat(result.translationDispatched()).isTrue();
        assertThat(result.synthesisDispatchCount()).isZero();
        assertThat(result.segments()).isEmpty();
        assertThat(synthesisCalled).isFalse();
    }

    private static Request request() {
        SourceVersion source = new SourceVersion("fixture-source-video", "fixture-source-v7");
        TranscriptRevision transcript = new TranscriptRevision("fixture-transcript-v3", source, "en-US",
                "fixture-source-pts-clock", 48_000, 48_000,
                List.of(new TranscriptSegment("fixture-seg-2", "synthetic source text two", 12_000, 18_000),
                        new TranscriptSegment("fixture-seg-1", "synthetic source text one", 1_200, 6_000)));
        return new Request("fixture-tenant", "fixture-j16-request", source, transcript, "es-MX",
                new VoiceIdentity("fixture-voice", "fixture-voice-v1"), "fixture-purpose");
    }

    private static TranslationPort translation(boolean admitted) {
        return new TranslationPort() {
            @Override public Capability capability(String sourceLocale, String targetLocale) {
                return admitted ? Capability.available() : Capability.unavailable(CapabilityReason.NOT_ADMITTED);
            }
            @Override public TranslationResult translate(TranslationRequest request) {
                throw new AssertionError("unavailable scenario must not fabricate or dispatch a translation");
            }
        };
    }

    private static SynthesisPort synthesis(boolean admitted) {
        return new SynthesisPort() {
            @Override public Capability capability(String targetLocale, VoiceIdentity voice) {
                return admitted ? Capability.available() : Capability.unavailable(CapabilityReason.NOT_ADMITTED);
            }
            @Override public SynthesizedAudio synthesize(SynthesisRequest request) {
                throw new AssertionError("unavailable scenario must not fabricate or dispatch audio");
            }
        };
    }

    private static AlignmentPort alignment(boolean admitted) {
        return new AlignmentPort() {
            @Override public Capability capability(String targetLocale) {
                return admitted ? Capability.available() : Capability.unavailable(CapabilityReason.NOT_ADMITTED);
            }
            @Override public AlignmentResult align(AlignmentRequest request) {
                throw new AssertionError("unavailable scenario must not claim forced alignment");
            }
        };
    }

    /** Synthetic local fixture only: this does not authorize real source or voice use. */
    private static final class FixtureRights implements RightsConsentPort {
        @Override public RightsDecision evaluate(RightsScope scope) {
            return new RightsDecision(RightsStatus.ALLOW, "fixture-authority", "fixture-decision");
        }
        @Override public boolean isCurrent(RightsScope scope, RightsDecision decision) { return true; }
    }
}
