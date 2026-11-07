package com.ghatana.media.production.dubbing;

import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntFunction;

import static com.ghatana.media.production.dubbing.DubbingOrchestrator.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DubbingOrchestratorTest {
    @Test
    void localeValidationRejectsMalformedSuffixInsteadOfAcceptingParsedPrefix() {
        SourceVersion source = new SourceVersion("artifact-a", "version-a");

        assertThatThrownBy(() -> new TranscriptRevision("transcript-v1", source, "en-US-!", "clock", 1,
                1, List.of(new TranscriptSegment("seg-1", "hello", 0, 1))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("valid BCP-47");

        TranscriptRevision transcript = new TranscriptRevision("transcript-v1", source, "en-US", "clock", 1,
                1, List.of(new TranscriptSegment("seg-1", "hello", 0, 1)));
        assertThatThrownBy(() -> new Request("tenant", "request", source, transcript, "es-MX-!",
                new VoiceIdentity("voice", "voice-v1"), "authorized-dubbing"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("valid BCP-47");
    }

    @Test
    void transcriptRejectsUnderreportedListWithoutTraversingPastSegmentLimit() {
        AtomicInteger yielded = new AtomicInteger();
        List<TranscriptSegment> underreported = underreportedList(yielded,
                current -> new TranscriptSegment("seg-" + current, "text", current, current + 1L));

        assertThatThrownBy(() -> new TranscriptRevision("transcript-v1",
                new SourceVersion("artifact-a", "version-a"), "en-US", "clock", 1,
                MAX_SEGMENTS + 100L, underreported))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("segment count");
        assertThat(yielded).hasValue(MAX_SEGMENTS);
    }

    @Test
    void providerResultListsRejectUnderreportedContentsAtTheSharedSegmentLimit() {
        SourceVersion source = new SourceVersion("artifact-a", "version-a");
        AtomicInteger translatedYielded = new AtomicInteger();
        assertThatThrownBy(() -> new TranslationResult("tenant", "request", source, "transcript-v1",
                "en-US", "es-MX", "clock", 1, MAX_SEGMENTS + 100L,
                underreportedList(translatedYielded, current -> new TranslatedSegment("seg-" + current, "text", current, current + 1L))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("segment count");
        assertThat(translatedYielded).hasValue(MAX_SEGMENTS);

        AtomicInteger alignedYielded = new AtomicInteger();
        assertThatThrownBy(() -> new AlignmentResult("tenant", "request", source, "transcript-v1",
                "es-MX", "clock", 1, MAX_SEGMENTS + 100L,
                underreportedList(alignedYielded, current -> new AlignedSegment("seg-" + current, "digest", current, current + 1L))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("segment count");
        assertThat(alignedYielded).hasValue(MAX_SEGMENTS);

        AtomicInteger dubbedYielded = new AtomicInteger();
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", new VoiceIdentity("voice", "voice-v1"), "clock", 1,
                MAX_SEGMENTS + 100L, true, MAX_SEGMENTS,
                underreportedList(dubbedYielded, current -> new DubbedSegment("seg-" + current, "text", new byte[0],
                        "digest", current, current + 1L, current, current + 1L))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("segment count");
        assertThat(dubbedYielded).hasValue(MAX_SEGMENTS);
    }

    @Test
    void audioRecordsRejectOversizedSegmentsBeforeDefensiveCopying() {
        SourceVersion source = new SourceVersion("artifact-a", "version-a");
        VoiceIdentity voice = new VoiceIdentity("voice-a", "voice-v1");
        byte[] oversized = new byte[MAX_SEGMENT_AUDIO_BYTES + 1];

        assertThatThrownBy(() -> new SynthesizedAudio("tenant", "request", source, "transcript-v1",
                "es-MX", voice, "clock", 48_000, 10_000, 100, 300,
                "seg-1", oversized, "digest"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("synthesized audio");
        assertThatThrownBy(() -> new DubbedSegment("seg-1", "hola", oversized, "digest",
                100, 300, 120, 280))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("dubbed audio");
    }

    @Test
    void completedResultCannotOmitTranslationOrSynthesisFinalityAccounting() {
        SourceVersion source = new SourceVersion("artifact-a", "version-a");
        VoiceIdentity voice = new VoiceIdentity("voice-a", "voice-v1");
        List<DubbedSegment> segments = List.of(new DubbedSegment("seg-1", "hola", new byte[] { 1 },
                "digest", 100, 300, 120, 280));

        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                false, 1, segments))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("synthesis cannot be dispatched before translation");
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                true, 0, segments))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("every translated synthesis segment");
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                true, 2, segments))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("every translated synthesis segment");
    }

    @Test
    void publicCompletedResultRejectsMalformedStatusTimingAndAudioBinding() {
        SourceVersion source = new SourceVersion("artifact-a", "version-a");
        VoiceIdentity voice = new VoiceIdentity("voice-a", "voice-v1");
        byte[] audio = { 1 };
        String digest = com.ghatana.media.runtime.MediaCreationContracts.sha256(audio);
        DubbedSegment valid = new DubbedSegment("seg-1", "hola", audio, digest,
                100, 300, 120, 280);

        assertThatThrownBy(() -> new DubbingResult(null, Optional.of(Reason.PROVIDER_OUTCOME_UNKNOWN), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                false, 0, List.of()))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("status");
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                true, 1, List.of(new DubbedSegment("seg-1", "hola", audio, "0".repeat(64),
                        100, 300, 120, 280))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("audio digest");
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                true, 1, List.of(new DubbedSegment("seg-1", "hola", audio, digest,
                        100, 10_001, 120, 280))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("timing");
        assertThatThrownBy(() -> new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), "tenant", "request",
                source, "transcript-v1", "es-MX", voice, "clock", 48_000, 10_000,
                true, 2, List.of(valid, valid)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("duplicate segment");
    }

    private static <T> List<T> underreportedList(AtomicInteger yielded, IntFunction<T> elementFactory) {
        return new AbstractList<>() {
            @Override public T get(int index) { throw new UnsupportedOperationException(); }
            @Override public int size() { return 1; }
            @Override public Iterator<T> iterator() {
                return new Iterator<>() {
                    private int index;
                    @Override public boolean hasNext() { return index < MAX_SEGMENTS + 50; }
                    @Override public T next() {
                        if (!hasNext()) throw new NoSuchElementException();
                        yielded.incrementAndGet();
                        return elementFactory.apply(index++);
                    }
                };
            }
        };
    }

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
    void providerSegmentOrderCannotChangeSynthesisAlignmentOrFinalCueOrder() {
        Fixture f = new Fixture();
        Request original = f.request();
        List<TranscriptSegment> sourceSegments = List.of(
                new TranscriptSegment("seg-1", "hello", 100, 300),
                new TranscriptSegment("seg-2", "world", 400, 800));
        TranscriptRevision transcript = new TranscriptRevision("transcript-v3", original.sourceVersion(),
                "en-US", "source-clock-9", 48_000, 10_000, sourceSegments);
        Request request = new Request(original.tenantId(), original.requestId(), original.sourceVersion(), transcript,
                "es-MX", original.voice(), original.purpose());
        List<String> synthesisOrder = new ArrayList<>();
        List<String> alignmentTranslationOrder = new ArrayList<>();
        List<String> alignmentAudioOrder = new ArrayList<>();
        Map<String, String> digests = new java.util.HashMap<>();

        TranslationPort translation = new TranslationPort() {
            @Override public Capability capability(String sourceLocale, String targetLocale) { return Capability.available(); }
            @Override public TranslationResult translate(TranslationRequest input) {
                return new TranslationResult(input.tenantId(), input.requestId(), input.sourceVersion(),
                        input.transcriptVersionId(), input.sourceLocale(), input.targetLocale(), input.sourceClockId(),
                        input.ticksPerSecond(), input.sourceDurationTicks(), List.of(
                        new TranslatedSegment("seg-2", "mundo", 400, 800),
                        new TranslatedSegment("seg-1", "hola", 100, 300)));
            }
        };
        SynthesisPort synthesis = new SynthesisPort() {
            @Override public Capability capability(String targetLocale, VoiceIdentity voice) { return Capability.available(); }
            @Override public SynthesizedAudio synthesize(SynthesisRequest input) {
                synthesisOrder.add(input.segmentId());
                byte[] bytes = new byte[] { (byte) (input.segmentId().equals("seg-1") ? 1 : 2) };
                String digest = com.ghatana.media.runtime.MediaCreationContracts.sha256(bytes);
                digests.put(input.segmentId(), digest);
                return new SynthesizedAudio(input.tenantId(), input.requestId(), input.sourceVersion(),
                        input.transcriptVersionId(), input.targetLocale(), input.voice(), input.sourceClockId(),
                        input.ticksPerSecond(), input.sourceDurationTicks(), input.sourceStartTick(),
                        input.sourceEndTick(), input.segmentId(), bytes, digest);
            }
        };
        AlignmentPort alignment = new AlignmentPort() {
            @Override public Capability capability(String targetLocale) { return Capability.available(); }
            @Override public AlignmentResult align(AlignmentRequest input) {
                input.translatedSegments().forEach(segment -> alignmentTranslationOrder.add(segment.segmentId()));
                input.synthesizedAudio().forEach(segment -> alignmentAudioOrder.add(segment.segmentId()));
                return new AlignmentResult(input.tenantId(), input.requestId(), input.sourceVersion(),
                        input.transcriptVersionId(), input.targetLocale(), input.sourceClockId(),
                        input.ticksPerSecond(), input.sourceDurationTicks(), List.of(
                        new AlignedSegment("seg-2", digests.get("seg-2"), 450, 700),
                        new AlignedSegment("seg-1", digests.get("seg-1"), 120, 280)));
            }
        };

        DubbingResult result = new DubbingOrchestrator(f.rights, translation, synthesis, alignment).dub(request);

        assertThat(result.status()).isEqualTo(ResultStatus.COMPLETED);
        assertThat(synthesisOrder).containsExactly("seg-1", "seg-2");
        assertThat(alignmentTranslationOrder).containsExactly("seg-1", "seg-2");
        assertThat(alignmentAudioOrder).containsExactly("seg-1", "seg-2");
        assertThat(result.segments()).extracting(DubbedSegment::segmentId).containsExactly("seg-1", "seg-2");
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
