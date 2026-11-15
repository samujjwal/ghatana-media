package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.stt.local.WebVttWriter;
import com.ghatana.tts.local.LocalKokoroSynthesizer;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import com.ghatana.tts.local.LocalTtsException;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * DEV_ONLY dubbing of one exact translated-transcript artifact version: every segment is synthesized with a Kokoro
 * stock voice of the target language, fitted to its source time window, and assembled into one timing-aligned mono
 * 24 kHz WAV track. Three NEW immutable artifacts are registered: the dubbed audio, the target-language WebVTT captions
 * (source windows) and the per-segment timing metadata (source window, measured dub duration, tempo factor, overflow).
 *
 * <p>Fit rule (see {@link MediaDevDubTiming}): a segment longer than its window is sped up by a bounded pitch-preserving
 * {@code atempo} factor (at most 1.25); a segment that still does not fit is a typed {@code DUB_TIMING_OVERFLOW} refusal
 * (default policy {@code REFUSE}) or, under {@code ALLOW_SPILL}, kept whole when it does not run into the next segment's
 * window. Audio is never silently truncated. Stock voices only: a voice or likeness reference is refused exactly as in
 * plain synthesis ({@code VOICE_CLONING_NOT_SUPPORTED}), after its own confirmed-consent check. Visual lip timing is not
 * produced; the per-segment source windows are the only lip-timing reference recorded, and the metadata says so.</p>
 *
 * <p>Rights: every artifact in the derivation chain needs a current PROCESSING admission, re-checked on every call. The
 * durable request ledger gives idempotency; a worker that ends abnormally is {@code DUB_OUTCOME_UNKNOWN} with nothing
 * registered, and a retry of the same requestId registers exactly once.</p>
 */
final class MediaDevDubbingRuntime {
    static final String SCHEMA = "media.dev.dub-output.v1";
    static final String TIMING_SCHEMA = "media.dev.dub-timing.v1";
    static final String KIND_AUDIO = "LOCAL_DUBBED_AUDIO";
    static final String KIND_CAPTIONS = "LOCAL_DUBBED_CAPTIONS_UNREVIEWED";
    static final String KIND_TIMING = "LOCAL_DUB_TIMING";
    static final String LANE_DUB = "dub.create";
    static final List<String> LINEAGE_KEYS = List.of("dubSchema", "scope", "kind", "requestId", "targetLanguage",
            "translatedTranscript", "parent", "sourceTranscript", "source", "voice", "voiceCloning", "engine", "model", "runtime",
            "rightsDecision", "audio", "segmentCount", "tempoAdjustedCount", "overflowCount", "overflowPolicy",
            "siblings", "note");
    private static final Duration SEGMENT_BUDGET = Duration.ofMinutes(2);
    private static final Duration TEMPO_BUDGET = Duration.ofSeconds(60);

    /** One synthesized segment: mono 24 kHz samples and the weights digest that produced them. */
    record Synthesized(short[] samples, String weightsSha256) { }

    /** The synthesis port: the local Kokoro worker in production, a deterministic fake in unit tests. */
    interface Synthesizer {
        Set<String> voices();

        Set<String> verifiedLanguages();

        boolean ready();

        Map<String, Object> model();

        Map<String, Object> runtime();

        String engine();

        Synthesized synthesize(String text, String voice);
    }

    /** Adapter over the verified local Kokoro install (persistent worker). */
    static Synthesizer localSynthesizer(LocalKokoroTtsProvider tts) {
        return new Synthesizer() {
            @Override public Set<String> voices() {
                LocalKokoroSynthesizer synthesizer = tts.synthesizer();
                return synthesizer == null ? Set.of() : synthesizer.voices();
            }

            @Override public Set<String> verifiedLanguages() {
                return tts.install() != null && tts.install().usable() ? tts.install().manifest().verifiedLanguages()
                        : Set.of();
            }

            @Override public boolean ready() { return tts.synthesizer() != null && tts.ready(); }

            @Override public Map<String, Object> model() {
                return MediaDevSpeechRuntime.modelRef(tts.install(), tts.install().manifest()
                        .first(com.ghatana.media.runtime.localmodel.LocalModelManifest.FileRole.WEIGHTS).sha256());
            }

            @Override public Map<String, Object> runtime() { return MediaDevSpeechRuntime.runtimeRef(tts.install()); }

            @Override public String engine() { return "kokoro/" + tts.providerVersion(); }

            @Override public Synthesized synthesize(String text, String voice) {
                try {
                    LocalKokoroSynthesizer.Synthesis result = tts.synthesizer().synthesize(text, voice, 1.0,
                            SEGMENT_BUDGET, BoundedProcessRunner.CancellationToken.NEVER);
                    if (!tts.install().stillCurrent()) {
                        throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                                "the local model changed during synthesis; the output was discarded");
                    }
                    return new Synthesized(MediaDevDubTiming.decodeWav(result.wav()), result.modelSha256());
                } catch (LocalTtsException failure) {
                    throw switch (failure.code()) {
                        case INVALID_INPUT -> new MediaDevSpeechRuntime.SpeechRefusedException(422, "SPEECH_INPUT_INVALID",
                                failure.getMessage());
                        case VOICE_NOT_ADMITTED -> new MediaDevSpeechRuntime.SpeechRefusedException(422,
                                "VOICE_NOT_ADMITTED", failure.getMessage());
                        case TIMEOUT -> new MediaDevSpeechRuntime.SpeechRefusedException(504, "SPEECH_TIMEOUT",
                                "local synthesis exceeded its time budget");
                        case CANCELLED -> new MediaDevSpeechRuntime.SpeechRefusedException(503, "SPEECH_CANCELLED",
                                "local synthesis was cancelled");
                        case PROCESS_FAILED, OUTPUT_INVALID, WORKER_UNAVAILABLE -> unknown();
                        default -> new MediaDevSpeechRuntime.SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                                "local synthesis failed");
                    };
                }
            }
        };
    }

    static MediaDevSpeechRuntime.SpeechRefusedException unknown() {
        return new MediaDevSpeechRuntime.SpeechRefusedException(503, "DUB_OUTCOME_UNKNOWN",
                "the synthesis worker ended abnormally; whether it completed is unknown and nothing was registered. "
                        + "Retry the same requestId: registration is idempotent by requestId",
                Map.of("registered", false, "retrySafe", true));
    }

    /** ffmpeg {@code atempo} (pitch-preserving) between files in a private temporary directory. */
    static MediaDevDubTiming.TempoAdjuster ffmpegTempo(Path ffmpeg) {
        return (samples, tempo) -> {
            Path work = Files.createTempDirectory("media-dev-dub-tempo-");
            try {
                Path in = work.resolve("in.wav");
                Path out = work.resolve("out.wav");
                Files.write(in, MediaDevDubTiming.encodeWav(samples));
                BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-v",
                        "error", "-i", in.toString(), "-filter:a", String.format(Locale.ROOT, "atempo=%.4f", tempo),
                        "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "-y", out.toString()),
                        work, Map.of(), TEMPO_BUDGET, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, out,
                        64L * 1024 * 1024);
                if (!result.succeeded() || !Files.isRegularFile(out)) {
                    throw new IOException("ffmpeg atempo did not produce an output");
                }
                return MediaDevDubTiming.decodeWav(Files.readAllBytes(out));
            } finally {
                try (var files = Files.walk(work)) {
                    files.sorted(java.util.Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
                }
            }
        };
    }

    enum OverflowPolicy { REFUSE, ALLOW_SPILL }

    record DubRequest(String requestId, String translatedArtifactId, String translatedArtifactVersionId, String voice,
                      OverflowPolicy overflowPolicy, MediaDevSpeechRuntime.ArtifactVersionRef voiceReference,
                      MediaDevSpeechRuntime.ArtifactVersionRef likenessReference) {
        DubRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            Objects.requireNonNull(translatedArtifactId, "translatedArtifactId");
            Objects.requireNonNull(translatedArtifactVersionId, "translatedArtifactVersionId");
            overflowPolicy = overflowPolicy == null ? OverflowPolicy.REFUSE : overflowPolicy;
            if (voice != null && !voice.matches("[a-z]{2}_[a-z]{2,16}")) {
                throw new IllegalArgumentException("voice must be a stock voice id");
            }
        }
    }

    /** The three registered outputs of one dub and the timing document read back from the timing artifact. */
    record Dub(MediaDevDubSupport.Output audio, MediaDevDubSupport.Output captions, MediaDevDubSupport.Output timing,
               Map<String, Object> timingDocument) {
        boolean replayed() { return audio.replayed() && captions.replayed() && timing.replayed(); }
    }

    private final MediaRuntime runtime;
    private final MediaDevDubSupport support;
    private final MediaDevTranslationRuntime translations;
    private final MediaDevSpeechRuntime speech;
    private final Synthesizer synthesizer;
    private final MediaDevDubTiming.TempoAdjuster tempo;
    private final MediaDevSpeechRuntime.SpeechRightsGate ttsGate;
    private final MediaDevRequestLedger ledger;

    MediaDevDubbingRuntime(MediaRuntime runtime, MediaDevDubSupport support, MediaDevTranslationRuntime translations,
                           MediaDevSpeechRuntime speech, Synthesizer synthesizer,
                           MediaDevDubTiming.TempoAdjuster tempo, MediaDevSpeechRuntime.SpeechRightsGate ttsGate,
                           MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.support = Objects.requireNonNull(support, "support");
        this.translations = Objects.requireNonNull(translations, "translations");
        this.speech = speech;
        this.synthesizer = synthesizer;
        this.tempo = tempo;
        this.ttsGate = Objects.requireNonNull(ttsGate, "ttsGate");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    Map<String, Object> capabilities() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("ready", synthesizer != null && synthesizer.ready());
        Map<String, String> voices = new java.util.TreeMap<>();
        if (synthesizer != null) {
            for (String voice : synthesizer.voices()) {
                String language = MediaDevSpeechRuntime.voiceLanguage(voice);
                if (!language.equals("en")) voices.put(voice, language);
            }
        }
        view.put("voices", voices);
        view.put("voiceCloning", "NOT_SUPPORTED");
        view.put("verifiedLanguages", synthesizer == null ? Set.of() : new TreeSet<>(synthesizer.verifiedLanguages()));
        view.put("tempo", Map.of("available", tempo != null, "minFactor", MediaDevDubTiming.MIN_TEMPO,
                "maxFactor", MediaDevDubTiming.MAX_TEMPO, "usedFor", "speed-up of a segment longer than its window"));
        view.put("overflowPolicies", List.of(OverflowPolicy.REFUSE.name(), OverflowPolicy.ALLOW_SPILL.name()));
        view.put("sampleRate", MediaDevDubTiming.SAMPLE_RATE);
        view.put("lipTiming", Map.of("status", "SOURCE_WINDOWS_ONLY", "note", "Only each segment's source speech window is "
                + "recorded as the lip-timing reference; no viseme or lip-sync alignment is produced."));
        return view;
    }

    Dub dub(String tenantId, String principalId, DubRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "dub_create", tenantId,
                () -> dubAdmitted(tenantId, principalId, request));
    }

    private Dub dubAdmitted(String tenantId, String principalId, DubRequest request) {
        if (synthesizer == null || !synthesizer.ready()) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                    "no verified local text-to-speech model is installed for this server");
        }
        if (speech != null) {
            speech.refuseReferences(tenantId, principalId, request.voiceReference(), request.likenessReference());
        } else if (request.voiceReference() != null || request.likenessReference() != null) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "VOICE_CLONING_NOT_SUPPORTED",
                    "the pinned text-to-speech model has no voice cloning or likeness synthesis");
        }
        MediaArtifact base = support.exact(tenantId, principalId, request.translatedArtifactId(),
                request.translatedArtifactVersionId());
        if (!MediaDevTranslationRuntime.SCHEMA.equals(base.metadata().get("translationSchema"))) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_NOT_A_TRANSLATION",
                    "dubbing requires a translated transcript artifact version");
        }
        MediaDevTranslationRuntime.Translation translation = translations.readTranslation(tenantId, principalId, base);
        String target = translation.targetLanguage();
        if (!synthesizer.verifiedLanguages().contains(target) || "en".equals(target)) {
            Set<String> admitted = new TreeSet<>(synthesizer.verifiedLanguages());
            admitted.remove("en");
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "LANGUAGE_NOT_ADMITTED",
                    "the target language is not admitted for the DEV_ONLY dubbing lane",
                    Map.of("targetLanguage", target, "admittedTargets", List.copyOf(admitted)));
        }
        String voice = request.voice() != null ? request.voice() : MediaDevSpeechRuntime.SynthesizeRequest.defaultVoiceFor(target);
        if (!synthesizer.voices().contains(voice)) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "VOICE_NOT_ADMITTED",
                    "the voice is not part of the verified model installation; voice cloning is not supported");
        }
        if (!MediaDevSpeechRuntime.voiceLanguage(voice).equals(target)) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "VOICE_LOCALE_MISMATCH",
                    "the stock voice does not speak the target language",
                    Map.of("voice", voice, "voiceLanguage", MediaDevSpeechRuntime.voiceLanguage(voice),
                            "targetLanguage", target));
        }
        var gate = ttsGate.authorize(tenantId, principalId, MediaDevSpeechRuntime.Operation.TEXT_TO_SPEECH, null);
        if (gate.outcome() != MediaDevSpeechRuntime.SpeechRightsGate.Outcome.ALLOWED) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(
                    gate.outcome() == MediaDevSpeechRuntime.SpeechRightsGate.Outcome.UNAVAILABLE ? 422 : 403,
                    gate.code().isBlank() ? "RIGHTS_AUTHORITY_UNAVAILABLE" : gate.code(),
                    "synthesis is not admitted for this profile");
        }
        MediaDevDubSupport.Rights rights = support.requireProcessing(tenantId, principalId, base);
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.dub.create.v1", base.artifactId(),
                base.version().value(), base.sha256(), voice, request.overflowPolicy().name());
        return ledger.run(tenantId, principalId, LANE_DUB, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs),
                () -> produce(tenantId, principalId, request, base, translation, voice, rights, gate.evidenceRef()),
                dub -> List.of(
                        new OutputRef("audio", dub.audio().artifact().artifactId(), dub.audio().artifact().version().value()),
                        new OutputRef("captions", dub.captions().artifact().artifactId(),
                                dub.captions().artifact().version().value()),
                        new OutputRef("timing", dub.timing().artifact().artifactId(),
                                dub.timing().artifact().version().value())),
                () -> new MediaDevSpeechRuntime.SpeechRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    private Dub produce(String tenantId, String principalId, DubRequest request, MediaArtifact base,
                        MediaDevTranslationRuntime.Translation translation, String voice,
                        MediaDevDubSupport.Rights rights, String ttsEvidence) {
        List<MediaDevDubTiming.Placed> placed = new ArrayList<>();
        String weights = "";
        long lastEnd = 0;
        for (MediaDevTranslationRuntime.Segment segment : translation.segments()) {
            Synthesized synthesized = synthesizer.synthesize(segment.text(), voice);
            weights = synthesized.weightsSha256();
            try {
                placed.add(MediaDevDubTiming.fit(new MediaDevDubTiming.Segment(segment.segmentId(), segment.startMillis(),
                        segment.endMillis(), synthesized.samples()), tempo));
            } catch (IOException failure) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "DUB_TEMPO_UNAVAILABLE",
                        "the tempo adjustment step failed; nothing was registered");
            }
            lastEnd = Math.max(lastEnd, segment.endMillis());
        }
        List<MediaDevDubTiming.Overflow> refused = MediaDevDubTiming.unaccommodated(placed,
                request.overflowPolicy() == OverflowPolicy.ALLOW_SPILL);
        if (!refused.isEmpty()) {
            List<Map<String, Object>> overflowing = refused.stream().map(MediaDevDubTiming.Overflow::view).toList();
            List<Map<String, Object>> fit = placed.stream().map(MediaDevDubTiming.Placed::view).toList();
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "DUB_TIMING_OVERFLOW",
                    "at least one dubbed segment does not fit its source window at the maximum tempo factor; nothing was "
                            + "registered and no audio was truncated. Shorten the translation or allow spill",
                    Map.of("overflowPolicy", request.overflowPolicy().name(), "maxTempoFactor", MediaDevDubTiming.MAX_TEMPO,
                            "overflowSegments", overflowing, "segments", fit));
        }
        short[] track = MediaDevDubTiming.assemble(placed, lastEnd);
        // The artifact store refuses a second artifact with identical bytes in a tenant, so a second dub request over the same
        // translation must differ in bytes: the final sample of the track, when it is silence, carries a request-derived
        // value of 1 to 8 LSB (inaudible, about -84 dBFS or less) and the captions and timing documents name the requestId.
        if (track.length > 0 && track[track.length - 1] == 0) {
            track[track.length - 1] = (short) (1 + (request.requestId().hashCode() & 7));
        }
        byte[] wav = MediaDevDubTiming.encodeWav(track);
        long trackMillis = MediaDevDubTiming.millis((wav.length - 44) / 2);
        int overflowCount = (int) placed.stream().filter(MediaDevDubTiming.Placed::overflow).count();
        int adjusted = (int) placed.stream().filter(p -> p.tempoFactor() > 1.0).count();

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("dubSchema", SCHEMA);
        shared.put("scope", "DEV_ONLY");
        shared.put("requestId", request.requestId());
        shared.put("targetLanguage", translation.targetLanguage());
        shared.put("translatedTranscript", MediaDevDubSupport.ref(base));
        shared.put("parent", MediaDevDubSupport.ref(base)); // erasure follows parent/source references
        for (String key : List.of("sourceTranscript", "source")) {
            if (base.metadata().get(key) instanceof Map<?, ?> inherited) shared.put(key, inherited);
        }
        shared.put("voice", voice);
        shared.put("voiceCloning", "NOT_SUPPORTED");
        shared.put("engine", synthesizer.engine());
        shared.put("model", synthesizer.model());
        shared.put("runtime", synthesizer.runtime());
        shared.put("rightsDecision", rights.evidenceRef() + ";" + ttsEvidence);
        shared.put("segmentCount", placed.size());
        shared.put("tempoAdjustedCount", adjusted);
        shared.put("overflowCount", overflowCount);
        shared.put("overflowPolicy", request.overflowPolicy().name());

        Map<String, Object> audioLineage = new LinkedHashMap<>(shared);
        audioLineage.put("kind", KIND_AUDIO);
        audioLineage.put("audio", Map.of("sampleRate", MediaDevDubTiming.SAMPLE_RATE, "channels", 1, "bitsPerSample", 16,
                "durationMillis", trackMillis, "voiceCloning", "NOT_SUPPORTED"));
        audioLineage.put("note", "Timing-aligned dubbed track: each segment is placed at its source window start. "
                + "Synthesized with a stock Kokoro voice, no voice cloning; synthesized-speech disclosure applies to "
                + "downstream use; not a quality, lip-sync or approval claim.");
        MediaDevDubSupport.Output audio = support.register(tenantId, principalId, "INTERNAL", "dub.audio",
                request.requestId(), wav, "audio/wav", "wav", "dub-" + translation.targetLanguage() + "-" + voice,
                "dub-output", audioLineage);

        List<WebVttWriter.Cue> cues = new ArrayList<>();
        for (MediaDevTranslationRuntime.Segment segment : translation.segments()) {
            cues.add(new WebVttWriter.Cue(segment.startMillis(), segment.endMillis(), segment.text()));
        }
        Map<String, Object> captionLineage = new LinkedHashMap<>(shared);
        captionLineage.put("kind", KIND_CAPTIONS);
        captionLineage.put("note", "WebVTT of the translated segments over their source windows; unreviewed machine or "
                + "human-revised translation, not a caption authority.");
        MediaDevDubSupport.Output captions = support.register(tenantId, principalId, "INTERNAL", "dub.captions",
                request.requestId(), withRequestNote(WebVttWriter.write(cues), request.requestId()), "text/vtt", "vtt",
                "dub-captions-" + translation.targetLanguage(), "dub-output", captionLineage);

        Map<String, Object> timingDocument = new LinkedHashMap<>();
        timingDocument.put("schema", TIMING_SCHEMA);
        timingDocument.put("requestId", request.requestId());
        timingDocument.put("targetLanguage", translation.targetLanguage());
        timingDocument.put("voice", voice);
        timingDocument.put("sampleRate", MediaDevDubTiming.SAMPLE_RATE);
        timingDocument.put("tempoBounds", Map.of("min", MediaDevDubTiming.MIN_TEMPO, "max", MediaDevDubTiming.MAX_TEMPO));
        timingDocument.put("overflowPolicy", request.overflowPolicy().name());
        timingDocument.put("timeBase", "milliseconds from the start of the source transcript clock (unqualified); the "
                + "track starts at 0 on that clock");
        List<Map<String, Object>> segmentViews = new ArrayList<>();
        for (int i = 0; i < placed.size(); i++) {
            Map<String, Object> view = new LinkedHashMap<>(placed.get(i).view());
            view.put("textChars", translation.segments().get(i).text().length());
            segmentViews.add(view);
        }
        timingDocument.put("segments", segmentViews);
        timingDocument.put("totals", Map.of("trackDurationMillis", trackMillis, "segmentCount", placed.size(),
                "tempoAdjustedCount", adjusted, "overflowCount", overflowCount));
        timingDocument.put("lipTiming", Map.of("status", "SOURCE_WINDOWS_ONLY", "note", "Only each segment's source "
                + "speech window (sourceStartMillis/sourceEndMillis) is recorded as the lip-timing reference; no viseme "
                + "or lip-sync alignment is produced."));
        Map<String, Object> timingLineage = new LinkedHashMap<>(shared);
        timingLineage.put("kind", KIND_TIMING);
        timingLineage.put("siblings", Map.of("audio", MediaDevDubSupport.ref(audio.artifact()),
                "captions", MediaDevDubSupport.ref(captions.artifact())));
        timingLineage.put("note", "Per-segment timing metadata of the dub; measured durations of the registered track.");
        MediaDevDubSupport.Output timing = support.register(tenantId, principalId, "INTERNAL", "dub.timing",
                request.requestId(), MediaDevDubSupport.json(timingDocument), "application/json", "json",
                "dub-timing-" + translation.targetLanguage(), "dub-output", timingLineage);
        return new Dub(audio, captions, timing, timingDocument);
    }

    /** Inserts a WebVTT NOTE block naming the request after the header (so identical captions differ per request). */
    private static byte[] withRequestNote(byte[] vtt, String requestId) {
        String text = new String(vtt, StandardCharsets.UTF_8);
        int headerEnd = text.indexOf("\n\n");
        if (headerEnd < 0) return vtt;
        return (text.substring(0, headerEnd + 2) + "NOTE dub request " + requestId + "\n\n"
                + text.substring(headerEnd + 2)).getBytes(StandardCharsets.UTF_8);
    }

    // ---- readback ----

    private Dub replay(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("timing")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_DUB));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.timing().artifact().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_DUB));
    }

    /** Reopens a dub from its timing artifact id: the siblings are named by the timing lineage. */
    Optional<Dub> reopen(String tenantId, String principalId, String timingArtifactId) {
        Optional<MediaDevDubSupport.Output> timing = support.reopen(tenantId, principalId, timingArtifactId, "dubSchema",
                SCHEMA, LINEAGE_KEYS).filter(output -> KIND_TIMING.equals(output.lineage().get("kind")));
        if (timing.isEmpty()) return Optional.empty();
        Map<?, ?> siblings = (Map<?, ?>) timing.get().lineage().get("siblings");
        if (siblings == null) return Optional.empty();
        Optional<MediaDevDubSupport.Output> audio = sibling(tenantId, principalId, siblings.get("audio"));
        Optional<MediaDevDubSupport.Output> captions = sibling(tenantId, principalId, siblings.get("captions"));
        if (audio.isEmpty() || captions.isEmpty()) return Optional.empty();
        JsonNode document = support.readDocument(tenantId, principalId, timing.get().artifact());
        Map<String, Object> asMap = MediaDevDubSupport.JSON.convertValue(document,
                new tools.jackson.core.type.TypeReference<LinkedHashMap<String, Object>>() { });
        return Optional.of(new Dub(audio.get(), captions.get(), timing.get(), asMap));
    }

    private Optional<MediaDevDubSupport.Output> sibling(String tenantId, String principalId, Object ref) {
        if (!(ref instanceof Map<?, ?> map) || !(map.get("artifactId") instanceof String id)
                || !(map.get("artifactVersionId") instanceof String version)) return Optional.empty();
        return support.reopen(tenantId, principalId, id, "dubSchema", SCHEMA, LINEAGE_KEYS)
                .filter(output -> output.artifact().version().value().equals(version));
    }
}
