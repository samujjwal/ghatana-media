package com.ghatana.media.production.dubbing;

import com.ghatana.media.runtime.MediaCreationContracts;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Source-version-bound translation and dubbing orchestration through injected admitted capabilities. */
public final class DubbingOrchestrator {
    public static final int MAX_SEGMENTS = 4096;
    /** Largest integer that can cross JSON/JavaScript boundaries without losing source-tick precision. */
    public static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    public static final int MAX_TRANSLATED_TEXT_CODE_POINTS = 100_000;
    public static final int MAX_SEGMENT_AUDIO_BYTES = 16 * 1024 * 1024;
    public static final long MAX_TOTAL_TEXT_CODE_POINTS = 4_000_000L;
    public static final long MAX_TOTAL_AUDIO_BYTES = 256L * 1024 * 1024;

    public enum ResultStatus { COMPLETED, UNAVAILABLE, DENIED, REVOKED, OUTCOME_UNKNOWN }
    public enum Reason {
        RIGHTS_AUTHORITY_UNAVAILABLE, SOURCE_RIGHTS_DENIED, SOURCE_RIGHTS_REVOKED,
        VOICE_RIGHTS_DENIED, VOICE_RIGHTS_REVOKED, TRANSLATION_CAPABILITY_UNAVAILABLE,
        TTS_CAPABILITY_UNAVAILABLE, ALIGNMENT_CAPABILITY_UNAVAILABLE, LANGUAGE_UNAVAILABLE,
        VOICE_UNAVAILABLE, CONTROL_UNAVAILABLE, PROVIDER_OUTCOME_UNKNOWN, INVALID_PROVIDER_RESULT
    }
    public enum RightsKind { SOURCE_DERIVATIVE, VOICE_SYNTHESIS }
    public enum RightsStatus { ALLOW, DENY, REVOKED, UNAVAILABLE }

    public record SourceVersion(String artifactId, String versionId) {
        public SourceVersion {
            artifactId = requiredOpaqueId(artifactId, "artifactId");
            versionId = requiredOpaqueVersionId(versionId, "versionId");
        }
    }

    /** Exact source-tick transcript revision; caller/provider time is not implicitly converted. */
    public record TranscriptSegment(String segmentId, String text, long startTick, long endTick) {
        public TranscriptSegment {
            segmentId = requiredOpaqueId(segmentId, "segmentId");
            text = bounded(text, MAX_TRANSLATED_TEXT_CODE_POINTS, "source transcript text");
            if (!safeNonnegativeTick(startTick) || !safeNonnegativeTick(endTick) || endTick <= startTick) {
                throw new IllegalArgumentException("transcript segment requires a safe positive source-tick interval");
            }
        }
    }

    public record TranscriptRevision(String transcriptVersionId, SourceVersion sourceVersion, String sourceLocale,
                                     String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                     List<TranscriptSegment> segments) {
        public TranscriptRevision {
            transcriptVersionId = requiredOpaqueVersionId(transcriptVersionId, "transcriptVersionId");
            Objects.requireNonNull(sourceVersion, "sourceVersion");
            sourceLocale = locale(sourceLocale);
            sourceClockId = requiredOpaqueId(sourceClockId, "sourceClockId");
            requireSafeClockTuple(ticksPerSecond, sourceDurationTicks, "source clock tuple");
            segments = boundedSegmentCopy(segments, "segments");
            if (segments.isEmpty()) throw new IllegalArgumentException("transcript segment count is outside bounds");
            java.util.Set<String> ids = new java.util.HashSet<>();
            long totalText = 0;
            for (TranscriptSegment segment : segments) {
                if (segment.endTick() > sourceDurationTicks || !ids.add(segment.segmentId())) {
                    throw new IllegalArgumentException("transcript timing exceeds source duration or has duplicate segment identity");
                }
                totalText += segment.text().codePointCount(0, segment.text().length());
                if (totalText > MAX_TOTAL_TEXT_CODE_POINTS) throw new IllegalArgumentException("transcript exceeds total text bound");
            }
        }
    }

    /** Copies at most the contractually bounded prefix; never trusts a caller List's size(). */
    private static <T> List<T> boundedSegmentCopy(List<T> input, String name) {
        Objects.requireNonNull(input, name);
        var iterator = input.iterator();
        List<T> copy = new ArrayList<>();
        while (iterator.hasNext()) {
            if (copy.size() == MAX_SEGMENTS) {
                throw new IllegalArgumentException("transcript segment count is outside bounds");
            }
            copy.add(Objects.requireNonNull(iterator.next(), name + " element"));
        }
        return List.copyOf(copy);
    }

    private static byte[] boundedAudioCopy(byte[] input, String name) {
        Objects.requireNonNull(input, name);
        if (input.length > MAX_SEGMENT_AUDIO_BYTES) {
            throw new IllegalArgumentException(name + " exceeds its size bound");
        }
        return input.clone();
    }

    private static boolean safeNonnegativeTick(long tick) {
        return tick >= 0 && tick <= MAX_SAFE_INTEGER;
    }

    private static void requireSafeClockTuple(long ticksPerSecond, long sourceDurationTicks, String name) {
        if (ticksPerSecond < 1 || ticksPerSecond > MAX_SAFE_INTEGER
                || sourceDurationTicks < 1 || sourceDurationTicks > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(name + " must contain positive safe integers");
        }
    }

    public record VoiceIdentity(String voiceId, String voiceVersionId) {
        public VoiceIdentity {
            voiceId = requiredOpaqueId(voiceId, "voiceId");
            voiceVersionId = requiredOpaqueVersionId(voiceVersionId, "voiceVersionId");
        }
    }

    public record Request(String tenantId, String requestId, SourceVersion sourceVersion,
                          TranscriptRevision transcript, String targetLocale, VoiceIdentity voice,
                          String purpose) {
        public Request {
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            requestId = requiredOpaqueId(requestId, "requestId");
            Objects.requireNonNull(sourceVersion, "sourceVersion");
            Objects.requireNonNull(transcript, "transcript");
            targetLocale = locale(targetLocale);
            Objects.requireNonNull(voice, "voice");
            purpose = required(purpose, "purpose");
            if (!sourceVersion.equals(transcript.sourceVersion())) throw new IllegalArgumentException("transcript must bind the exact requested source artifact version");
            if (transcript.sourceLocale().equalsIgnoreCase(targetLocale)) throw new IllegalArgumentException("target locale must differ from transcript source locale");
        }
    }

    public record RightsScope(String tenantId, String requestId, RightsKind kind, String artifactId,
                              String artifactVersionId, String voiceId, String voiceVersionId,
                              String targetLocale, String purpose) {
        public RightsScope {
            Objects.requireNonNull(kind, "kind");
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            requestId = requiredOpaqueId(requestId, "requestId");
            targetLocale = locale(targetLocale);
            purpose = required(purpose, "purpose");
            if (kind == RightsKind.SOURCE_DERIVATIVE) {
                artifactId = requiredOpaqueId(artifactId, "artifactId");
                artifactVersionId = requiredOpaqueVersionId(artifactVersionId, "artifactVersionId");
            } else {
                voiceId = requiredOpaqueId(voiceId, "voiceId");
                voiceVersionId = requiredOpaqueVersionId(voiceVersionId, "voiceVersionId");
            }
        }
    }

    public record RightsDecision(RightsStatus status, String authorityRef, String decisionRef) {
        public RightsDecision {
            Objects.requireNonNull(status, "status");
            authorityRef = authorityRef == null ? "" : authorityRef.trim();
            decisionRef = decisionRef == null ? "" : decisionRef.trim();
            if (status == RightsStatus.ALLOW && (authorityRef.isBlank() || decisionRef.isBlank())) {
                throw new IllegalArgumentException("allowed rights require decision and authority references");
            }
        }
    }

    public interface RightsConsentPort {
        RightsDecision evaluate(RightsScope scope);
        boolean isCurrent(RightsScope scope, RightsDecision decision);
    }

    public enum CapabilityReason { NONE, LANGUAGE_UNAVAILABLE, PROVIDER_UNAVAILABLE, CONTROL_UNAVAILABLE, NOT_ADMITTED }
    public record Capability(boolean admitted, CapabilityReason reason) {
        public Capability {
            Objects.requireNonNull(reason, "reason");
            if (admitted && reason != CapabilityReason.NONE) throw new IllegalArgumentException("admitted capability cannot carry an unavailable reason");
            if (!admitted && reason == CapabilityReason.NONE) throw new IllegalArgumentException("unavailable capability requires a reason");
        }
        public static Capability available() { return new Capability(true, CapabilityReason.NONE); }
        public static Capability unavailable(CapabilityReason reason) { return new Capability(false, reason); }
    }

    public record TranslationRequest(String tenantId, String requestId, SourceVersion sourceVersion,
                                     String transcriptVersionId, String sourceLocale, String targetLocale,
                                     String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                     List<TranscriptSegment> segments) {}
    public record TranslatedSegment(String segmentId, String text, long sourceStartTick, long sourceEndTick) {
        public TranslatedSegment {
            segmentId = requiredOpaqueId(segmentId, "segmentId");
            text = bounded(text, MAX_TRANSLATED_TEXT_CODE_POINTS, "translated text");
        }
    }
    public record TranslationResult(String tenantId, String requestId, SourceVersion sourceVersion,
                                    String transcriptVersionId, String sourceLocale, String targetLocale,
                                    String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                    List<TranslatedSegment> segments) {
        public TranslationResult { segments = boundedSegmentCopy(segments, "segments"); }
    }
    public interface TranslationPort {
        Capability capability(String sourceLocale, String targetLocale);
        TranslationResult translate(TranslationRequest request);
    }

    public record SynthesisRequest(String tenantId, String requestId, SourceVersion sourceVersion,
                                   String transcriptVersionId, String targetLocale, VoiceIdentity voice,
                                   String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                   String segmentId, String text, long sourceStartTick, long sourceEndTick) {}
    public record SynthesizedAudio(String tenantId, String requestId, SourceVersion sourceVersion,
                                   String transcriptVersionId, String targetLocale, VoiceIdentity voice,
                                   String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                   long sourceStartTick, long sourceEndTick,
                                   String segmentId, byte[] audioBytes, String digest) {
        public SynthesizedAudio {
            Objects.requireNonNull(sourceVersion, "sourceVersion");
            Objects.requireNonNull(voice, "voice");
            audioBytes = boundedAudioCopy(audioBytes, "synthesized audio");
        }
        @Override public byte[] audioBytes() { return audioBytes.clone(); }
    }
    public interface SynthesisPort {
        Capability capability(String targetLocale, VoiceIdentity voice);
        SynthesizedAudio synthesize(SynthesisRequest request);
    }

    public record AlignedSegment(String segmentId, String audioDigest, long startTick, long endTick) {}
    public record AlignmentRequest(String tenantId, String requestId, SourceVersion sourceVersion,
                                   String transcriptVersionId, String targetLocale, String sourceClockId,
                                   long ticksPerSecond, long sourceDurationTicks,
                                   List<TranscriptSegment> sourceSegments,
                                   List<TranslatedSegment> translatedSegments,
                                   List<SynthesizedAudio> synthesizedAudio) {}
    public record AlignmentResult(String tenantId, String requestId, SourceVersion sourceVersion,
                                  String transcriptVersionId, String targetLocale, String sourceClockId,
                                  long ticksPerSecond, long sourceDurationTicks,
                                  List<AlignedSegment> segments) {
        public AlignmentResult { segments = boundedSegmentCopy(segments, "segments"); }
    }
    public interface AlignmentPort {
        Capability capability(String targetLocale);
        AlignmentResult align(AlignmentRequest request);
    }

    public record DubbedSegment(String segmentId, String text, byte[] audioBytes, String audioDigest,
                                long sourceStartTick, long sourceEndTick, long alignedStartTick, long alignedEndTick) {
        public DubbedSegment { audioBytes = boundedAudioCopy(audioBytes, "dubbed audio"); }
        @Override public byte[] audioBytes() { return audioBytes.clone(); }
    }
    public record DubbingResult(ResultStatus status, Optional<Reason> reason, String tenantId, String requestId,
                                SourceVersion sourceVersion, String transcriptVersionId, String targetLocale,
                                VoiceIdentity voice, String sourceClockId, long ticksPerSecond,
                                long sourceDurationTicks, boolean translationDispatched,
                                int synthesisDispatchCount, List<DubbedSegment> segments) {
        public DubbingResult {
            Objects.requireNonNull(status, "status");
            tenantId = requiredOpaqueId(tenantId, "tenantId");
            requestId = requiredOpaqueId(requestId, "requestId");
            Objects.requireNonNull(sourceVersion, "sourceVersion");
            transcriptVersionId = requiredOpaqueVersionId(transcriptVersionId, "transcriptVersionId");
            targetLocale = locale(targetLocale);
            Objects.requireNonNull(voice, "voice");
            sourceClockId = requiredOpaqueId(sourceClockId, "sourceClockId");
            requireSafeClockTuple(ticksPerSecond, sourceDurationTicks, "dubbing source clock tuple");
            reason = reason == null ? Optional.empty() : reason;
            segments = boundedSegmentCopy(segments == null ? List.of() : segments, "segments");
            if ((status == ResultStatus.COMPLETED) != reason.isEmpty()) throw new IllegalArgumentException("only completed dubbing has no failure reason");
            if (status != ResultStatus.COMPLETED && !segments.isEmpty()) throw new IllegalArgumentException("incomplete dubbing cannot expose a completed segment set");
            if (synthesisDispatchCount < 0 || synthesisDispatchCount > MAX_SEGMENTS) {
                throw new IllegalArgumentException("synthesis dispatch count is outside bounds");
            }
            if (!translationDispatched && synthesisDispatchCount != 0) {
                throw new IllegalArgumentException("synthesis cannot be dispatched before translation");
            }
            if (status == ResultStatus.COMPLETED
                    && (!translationDispatched || synthesisDispatchCount == 0 || synthesisDispatchCount != segments.size())) {
                throw new IllegalArgumentException("completed dubbing must account for every translated synthesis segment");
            }
            if (status == ResultStatus.COMPLETED) validateCompletedSegments(segments, sourceDurationTicks);
        }
    }

    /** Validates the public completed-result constructor, not only the provider assembly path. */
    private static void validateCompletedSegments(List<DubbedSegment> segments, long sourceDurationTicks) {
        java.util.Set<String> segmentIds = new java.util.HashSet<>();
        long totalTextCodePoints = 0;
        long totalAudioBytes = 0;
        for (DubbedSegment segment : segments) {
            String id = requiredOpaqueId(segment.segmentId(), "dubbed segmentId");
            if (!segmentIds.add(id)) throw new IllegalArgumentException("completed dubbing contains duplicate segment identities");
            String text = bounded(segment.text(), MAX_TRANSLATED_TEXT_CODE_POINTS, "dubbed text");
            if (text.isBlank()) throw new IllegalArgumentException("completed dubbing segment text must not be blank");
            if (!safeNonnegativeTick(segment.sourceStartTick()) || !safeNonnegativeTick(segment.sourceEndTick())
                    || !safeNonnegativeTick(segment.alignedStartTick()) || !safeNonnegativeTick(segment.alignedEndTick())
                    || segment.sourceStartTick() < 0 || segment.sourceEndTick() > sourceDurationTicks
                    || segment.sourceEndTick() <= segment.sourceStartTick()
                    || segment.alignedStartTick() < segment.sourceStartTick()
                    || segment.alignedEndTick() > segment.sourceEndTick()
                    || segment.alignedEndTick() <= segment.alignedStartTick()) {
                throw new IllegalArgumentException("completed dubbing segment timing is outside its exact source interval");
            }
            byte[] audio = segment.audioBytes;
            if (audio.length == 0 || audio.length > MAX_SEGMENT_AUDIO_BYTES
                    || !MediaCreationContracts.sha256(audio).equals(segment.audioDigest())) {
                throw new IllegalArgumentException("completed dubbing segment audio digest does not match its bounded bytes");
            }
            totalTextCodePoints += text.codePointCount(0, text.length());
            totalAudioBytes += audio.length;
            if (totalTextCodePoints > MAX_TOTAL_TEXT_CODE_POINTS || totalAudioBytes > MAX_TOTAL_AUDIO_BYTES) {
                throw new IllegalArgumentException("completed dubbing result exceeds aggregate output bounds");
            }
        }
    }

    private final RightsConsentPort rights;
    private final TranslationPort translation;
    private final SynthesisPort synthesis;
    private final AlignmentPort alignment;

    /** Null ports are explicit unavailable capabilities; this class does not supply providers. */
    public DubbingOrchestrator(RightsConsentPort rights, TranslationPort translation,
                               SynthesisPort synthesis, AlignmentPort alignment) {
        this.rights = rights;
        this.translation = translation;
        this.synthesis = synthesis;
        this.alignment = alignment;
    }

    public DubbingResult dub(Request request) {
        Objects.requireNonNull(request, "request");
        RightsScope sourceScope = sourceScope(request);
        RightsScope voiceScope = voiceScope(request);
        RightsDecision sourceDecision = decision(sourceScope);
        DubbingResult sourceGate = rightsFailure(request, sourceDecision, true, false, 0);
        if (sourceGate != null) return sourceGate;
        RightsDecision voiceDecision = decision(voiceScope);
        DubbingResult voiceGate = rightsFailure(request, voiceDecision, false, false, 0);
        if (voiceGate != null) return voiceGate;

        if (translation == null) return unavailable(request, Reason.TRANSLATION_CAPABILITY_UNAVAILABLE, false, 0);
        Capability translationCapability = safeCapability(() -> translation.capability(request.transcript().sourceLocale(), request.targetLocale()));
        if (translationCapability == null || !translationCapability.admitted()) {
            return unavailable(request, mapCapability(translationCapability, Reason.TRANSLATION_CAPABILITY_UNAVAILABLE), false, 0);
        }
        if (synthesis == null) return unavailable(request, Reason.TTS_CAPABILITY_UNAVAILABLE, false, 0);
        Capability synthesisCapability = safeCapability(() -> synthesis.capability(request.targetLocale(), request.voice()));
        if (synthesisCapability == null || !synthesisCapability.admitted()) {
            return unavailable(request, mapCapability(synthesisCapability, Reason.TTS_CAPABILITY_UNAVAILABLE), false, 0);
        }
        if (alignment == null) return unavailable(request, Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE, false, 0);
        Capability alignmentCapability = safeCapability(() -> alignment.capability(request.targetLocale()));
        if (alignmentCapability == null || !alignmentCapability.admitted()) {
            return unavailable(request, mapCapability(alignmentCapability, Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE), false, 0);
        }

        DubbingResult beforeTranslation = recheck(request, sourceScope, voiceScope, sourceDecision, voiceDecision, false, 0);
        if (beforeTranslation != null) return beforeTranslation;
        TranslationResult translated;
        try {
            translated = translation.translate(new TranslationRequest(request.tenantId(), request.requestId(),
                    request.sourceVersion(), request.transcript().transcriptVersionId(), request.transcript().sourceLocale(),
                    request.targetLocale(), request.transcript().sourceClockId(), request.transcript().ticksPerSecond(),
                    request.transcript().sourceDurationTicks(), request.transcript().segments()));
        } catch (RuntimeException unknown) {
            return unknown(request, true, 0);
        }
        if (!validTranslation(request, translated)) return invalid(request, true, 0);
        // Provider list order is not an identity or timing guarantee; align every
        // downstream list to the exact transcript revision's source segment order.
        translated = sourceOrder(request, translated);

        Map<String, SynthesizedAudio> audioBySegment = new HashMap<>();
        int dispatched = 0;
        long totalAudioBytes = 0;
        for (TranslatedSegment segment : translated.segments()) {
            DubbingResult beforeSynthesis = recheck(request, sourceScope, voiceScope, sourceDecision, voiceDecision, true, dispatched);
            if (beforeSynthesis != null) return beforeSynthesis;
            SynthesizedAudio audio;
            try {
                dispatched++;
                audio = synthesis.synthesize(new SynthesisRequest(request.tenantId(), request.requestId(),
                        request.sourceVersion(), request.transcript().transcriptVersionId(), request.targetLocale(),
                        request.voice(), request.transcript().sourceClockId(), request.transcript().ticksPerSecond(),
                        request.transcript().sourceDurationTicks(), segment.segmentId(), segment.text(),
                        segment.sourceStartTick(), segment.sourceEndTick()));
            } catch (RuntimeException unknown) {
                return unknown(request, true, dispatched);
            }
            if (audio == null) return invalid(request, true, dispatched);
            byte[] audioBytes = audio.audioBytes();
            if (!validAudio(request, segment, audio, audioBytes)) return invalid(request, true, dispatched);
            totalAudioBytes += audioBytes.length;
            if (totalAudioBytes > MAX_TOTAL_AUDIO_BYTES) return invalid(request, true, dispatched);
            audioBySegment.put(segment.segmentId(), audio);
        }
        DubbingResult beforeAlignment = recheck(request, sourceScope, voiceScope, sourceDecision, voiceDecision, true, dispatched);
        if (beforeAlignment != null) return beforeAlignment;
        AlignmentResult aligned;
        try {
            aligned = alignment.align(new AlignmentRequest(request.tenantId(), request.requestId(), request.sourceVersion(),
                    request.transcript().transcriptVersionId(), request.targetLocale(), request.transcript().sourceClockId(),
                    request.transcript().ticksPerSecond(), request.transcript().sourceDurationTicks(),
                    request.transcript().segments(), translated.segments(), orderedAudio(request, audioBySegment)));
        } catch (RuntimeException unknown) {
            return unknown(request, true, dispatched);
        }
        DubbingResult afterAlignment = recheck(request, sourceScope, voiceScope, sourceDecision, voiceDecision, true, dispatched);
        if (afterAlignment != null) return afterAlignment;
        List<DubbedSegment> output = validateAlignment(request, translated, audioBySegment, aligned);
        if (output == null) return invalid(request, true, dispatched);
        return new DubbingResult(ResultStatus.COMPLETED, Optional.empty(), request.tenantId(), request.requestId(),
                request.sourceVersion(), request.transcript().transcriptVersionId(), request.targetLocale(), request.voice(),
                request.transcript().sourceClockId(), request.transcript().ticksPerSecond(),
                request.transcript().sourceDurationTicks(), true, dispatched, output);
    }

    private DubbingResult recheck(Request r, RightsScope sourceScope, RightsScope voiceScope,
                                  RightsDecision source, RightsDecision voice, boolean translated, int count) {
        if (rights == null) return result(r, ResultStatus.UNAVAILABLE, Reason.RIGHTS_AUTHORITY_UNAVAILABLE, translated, count);
        RightsStatus sourceCurrent = currentness(sourceScope, source);
        if (sourceCurrent != RightsStatus.ALLOW) return result(r,
                sourceCurrent == RightsStatus.REVOKED ? ResultStatus.REVOKED : ResultStatus.UNAVAILABLE,
                sourceCurrent == RightsStatus.REVOKED ? Reason.SOURCE_RIGHTS_REVOKED : Reason.RIGHTS_AUTHORITY_UNAVAILABLE,
                translated, count);
        RightsStatus voiceCurrent = currentness(voiceScope, voice);
        if (voiceCurrent != RightsStatus.ALLOW) return result(r,
                voiceCurrent == RightsStatus.REVOKED ? ResultStatus.REVOKED : ResultStatus.UNAVAILABLE,
                voiceCurrent == RightsStatus.REVOKED ? Reason.VOICE_RIGHTS_REVOKED : Reason.RIGHTS_AUTHORITY_UNAVAILABLE,
                translated, count);
        return null;
    }

    private RightsStatus currentness(RightsScope scope, RightsDecision decision) {
        try { return rights != null && rights.isCurrent(scope, decision) ? RightsStatus.ALLOW : RightsStatus.REVOKED; }
        catch (RuntimeException unavailable) { return RightsStatus.UNAVAILABLE; }
    }

    private RightsDecision decision(RightsScope scope) {
        if (rights == null) return new RightsDecision(RightsStatus.UNAVAILABLE, "", "");
        try {
            RightsDecision decision = rights.evaluate(scope);
            return decision == null ? new RightsDecision(RightsStatus.UNAVAILABLE, "", "") : decision;
        } catch (RuntimeException unavailable) { return new RightsDecision(RightsStatus.UNAVAILABLE, "", ""); }
    }

    private DubbingResult rightsFailure(Request r, RightsDecision decision, boolean source, boolean translated, int count) {
        if (decision.status() == RightsStatus.ALLOW) return null;
        Reason reason = switch (decision.status()) {
            case ALLOW -> throw new IllegalStateException("allow has no failure reason");
            case DENY -> source ? Reason.SOURCE_RIGHTS_DENIED : Reason.VOICE_RIGHTS_DENIED;
            case REVOKED -> source ? Reason.SOURCE_RIGHTS_REVOKED : Reason.VOICE_RIGHTS_REVOKED;
            case UNAVAILABLE -> Reason.RIGHTS_AUTHORITY_UNAVAILABLE;
        };
        ResultStatus status = decision.status() == RightsStatus.DENY ? ResultStatus.DENIED
                : decision.status() == RightsStatus.REVOKED ? ResultStatus.REVOKED : ResultStatus.UNAVAILABLE;
        return result(r, status, reason, translated, count);
    }

    private boolean validTranslation(Request r, TranslationResult result) {
        if (result == null || !r.tenantId().equals(result.tenantId()) || !r.requestId().equals(result.requestId())
                || !r.sourceVersion().equals(result.sourceVersion())
                || !r.transcript().transcriptVersionId().equals(result.transcriptVersionId())
                || !r.transcript().sourceLocale().equals(result.sourceLocale())
                || !r.targetLocale().equals(result.targetLocale())
                || !r.transcript().sourceClockId().equals(result.sourceClockId())
                || r.transcript().ticksPerSecond() != result.ticksPerSecond()
                || r.transcript().sourceDurationTicks() != result.sourceDurationTicks()
                || result.segments().size() != r.transcript().segments().size()) return false;
        Map<String, TranscriptSegment> source = new HashMap<>();
        r.transcript().segments().forEach(s -> source.put(s.segmentId(), s));
        java.util.Set<String> seen = new java.util.HashSet<>();
        long totalText = 0;
        for (TranslatedSegment segment : result.segments()) {
            TranscriptSegment original = source.get(segment.segmentId());
            if (original == null || !seen.add(segment.segmentId()) || original.startTick() != segment.sourceStartTick()
                    || original.endTick() != segment.sourceEndTick() || segment.text().isBlank()) return false;
            totalText += segment.text().codePointCount(0, segment.text().length());
            if (totalText > MAX_TOTAL_TEXT_CODE_POINTS) return false;
        }
        return true;
    }

    private static TranslationResult sourceOrder(Request request, TranslationResult result) {
        Map<String, TranslatedSegment> bySegmentId = new HashMap<>();
        result.segments().forEach(segment -> bySegmentId.put(segment.segmentId(), segment));
        List<TranslatedSegment> ordered = request.transcript().segments().stream()
                .map(source -> bySegmentId.get(source.segmentId())).toList();
        return new TranslationResult(result.tenantId(), result.requestId(), result.sourceVersion(),
                result.transcriptVersionId(), result.sourceLocale(), result.targetLocale(), result.sourceClockId(),
                result.ticksPerSecond(), result.sourceDurationTicks(), ordered);
    }

    private boolean validAudio(Request r, TranslatedSegment segment, SynthesizedAudio audio, byte[] audioBytes) {
        return r.tenantId().equals(audio.tenantId()) && r.requestId().equals(audio.requestId())
                && r.sourceVersion().equals(audio.sourceVersion())
                && r.transcript().transcriptVersionId().equals(audio.transcriptVersionId())
                && r.targetLocale().equals(audio.targetLocale()) && r.voice().equals(audio.voice())
                && r.transcript().sourceClockId().equals(audio.sourceClockId())
                && r.transcript().ticksPerSecond() == audio.ticksPerSecond()
                && r.transcript().sourceDurationTicks() == audio.sourceDurationTicks()
                && segment.sourceStartTick() == audio.sourceStartTick()
                && segment.sourceEndTick() == audio.sourceEndTick()
                && segment.segmentId().equals(audio.segmentId()) && audioBytes.length > 0
                && audioBytes.length <= MAX_SEGMENT_AUDIO_BYTES
                && MediaCreationContracts.sha256(audioBytes).equals(audio.digest());
    }

    private List<DubbedSegment> validateAlignment(Request r, TranslationResult translated,
                                                   Map<String, SynthesizedAudio> audio,
                                                   AlignmentResult result) {
        if (result == null || !r.tenantId().equals(result.tenantId()) || !r.requestId().equals(result.requestId())
                || !r.sourceVersion().equals(result.sourceVersion())
                || !r.transcript().transcriptVersionId().equals(result.transcriptVersionId())
                || !r.targetLocale().equals(result.targetLocale())
                || !r.transcript().sourceClockId().equals(result.sourceClockId())
                || r.transcript().ticksPerSecond() != result.ticksPerSecond()
                || r.transcript().sourceDurationTicks() != result.sourceDurationTicks()
                || result.segments().size() != r.transcript().segments().size()) return null;
        Map<String, TranscriptSegment> source = new HashMap<>();
        r.transcript().segments().forEach(s -> source.put(s.segmentId(), s));
        Map<String, TranslatedSegment> localized = new HashMap<>();
        translated.segments().forEach(s -> localized.put(s.segmentId(), s));
        java.util.Set<String> seen = new java.util.HashSet<>();
        Map<String, DubbedSegment> outputBySegmentId = new HashMap<>();
        for (AlignedSegment segment : result.segments()) {
            TranscriptSegment original = source.get(segment.segmentId());
            SynthesizedAudio synthesized = audio.get(segment.segmentId());
            TranslatedSegment translatedSegment = localized.get(segment.segmentId());
            if (original == null || synthesized == null || translatedSegment == null || !seen.add(segment.segmentId())
                    || !synthesized.digest().equals(segment.audioDigest())
                    || segment.startTick() < original.startTick() || segment.endTick() > original.endTick()
                    || segment.endTick() <= segment.startTick()) return null;
            outputBySegmentId.put(segment.segmentId(), new DubbedSegment(segment.segmentId(), translatedSegment.text(), synthesized.audioBytes(),
                    synthesized.digest(), original.startTick(), original.endTick(), segment.startTick(), segment.endTick()));
        }
        return r.transcript().segments().stream().map(segment -> outputBySegmentId.get(segment.segmentId())).toList();
    }

    private static Capability safeCapability(java.util.function.Supplier<Capability> lookup) {
        try { return lookup.get(); } catch (RuntimeException unavailable) { return null; }
    }
    private static Reason mapCapability(Capability capability, Reason defaultReason) {
        if (capability == null) return defaultReason;
        return switch (capability.reason()) {
            case LANGUAGE_UNAVAILABLE -> Reason.LANGUAGE_UNAVAILABLE;
            case CONTROL_UNAVAILABLE -> Reason.CONTROL_UNAVAILABLE;
            case PROVIDER_UNAVAILABLE -> defaultReason == Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE
                    ? Reason.ALIGNMENT_CAPABILITY_UNAVAILABLE
                    : defaultReason == Reason.TTS_CAPABILITY_UNAVAILABLE ? Reason.VOICE_UNAVAILABLE : Reason.TRANSLATION_CAPABILITY_UNAVAILABLE;
            case NOT_ADMITTED, NONE -> defaultReason;
        };
    }
    private static List<SynthesizedAudio> orderedAudio(Request r, Map<String, SynthesizedAudio> audio) {
        return r.transcript().segments().stream().map(segment -> audio.get(segment.segmentId())).toList();
    }
    private static RightsScope sourceScope(Request r) {
        return new RightsScope(r.tenantId(), r.requestId(), RightsKind.SOURCE_DERIVATIVE,
                r.sourceVersion().artifactId(), r.sourceVersion().versionId(), null, null, r.targetLocale(), r.purpose());
    }
    private static RightsScope voiceScope(Request r) {
        return new RightsScope(r.tenantId(), r.requestId(), RightsKind.VOICE_SYNTHESIS,
                null, null, r.voice().voiceId(), r.voice().voiceVersionId(), r.targetLocale(), r.purpose());
    }
    private static DubbingResult unavailable(Request r, Reason reason, boolean translated, int count) {
        return result(r, ResultStatus.UNAVAILABLE, reason, translated, count);
    }
    private static DubbingResult unknown(Request r, boolean translated, int count) {
        return result(r, ResultStatus.OUTCOME_UNKNOWN, Reason.PROVIDER_OUTCOME_UNKNOWN, translated, count);
    }
    private static DubbingResult invalid(Request r, boolean translated, int count) {
        return result(r, ResultStatus.OUTCOME_UNKNOWN, Reason.INVALID_PROVIDER_RESULT, translated, count);
    }
    private static DubbingResult result(Request r, ResultStatus status, Reason reason, boolean translated, int count) {
        return new DubbingResult(status, Optional.of(reason), r.tenantId(), r.requestId(), r.sourceVersion(),
                r.transcript().transcriptVersionId(), r.targetLocale(), r.voice(), r.transcript().sourceClockId(),
                r.transcript().ticksPerSecond(), r.transcript().sourceDurationTicks(), translated, count, List.of());
    }
    private static String locale(String value) {
        String normalized = required(value, "locale");
        if (normalized.length() < 2 || normalized.length() > 63
                || !normalized.matches("[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*")) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 tag");
        }
        java.util.Locale parsed;
        try {
            parsed = new java.util.Locale.Builder().setLanguageTag(normalized).build();
        } catch (java.util.IllformedLocaleException malformed) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 tag", malformed);
        }
        if (parsed.getLanguage().isBlank() || parsed.toLanguageTag().equals("und")) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 tag");
        }
        return parsed.toLanguageTag();
    }
    private static String bounded(String value, int maxCodePoints, String field) {
        Objects.requireNonNull(value, field);
        if (value.codePointCount(0, value.length()) > maxCodePoints) throw new IllegalArgumentException(field + " exceeds its size bound");
        return value;
    }
    private static String required(String value, String field) {
        Objects.requireNonNull(value, field);
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException(field + " must be non-empty and contain no control characters");
        return normalized;
    }

    private static String requiredOpaqueId(String value, String field) {
        Objects.requireNonNull(value, field);
        if (!value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(field + " must be a 1-128 character opaque id");
        }
        return value;
    }

    private static String requiredOpaqueVersionId(String value, String field) {
        Objects.requireNonNull(value, field);
        if (!value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(field + " must be a 1-128 character opaque version id");
        }
        return value;
    }
}
