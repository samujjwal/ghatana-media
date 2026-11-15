package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * DEV_ONLY machine translation of one exact speech-transcript artifact version (segments with source-clock times) into
 * a NEW immutable translated-transcript artifact, plus human revision of that translation as a further new version.
 *
 * <p>Translation is segment by segment: each output segment keeps the source segment's id and start/end times, so the
 * translation is bound to the same source timeline. The engine is the already-admitted local Qwen2.5-VL-7B-Instruct in
 * text-only mode (owner decision of the Media owner delegate, 2026-11-15); the admitted target languages are the
 * intersection of the engine's language pairs with the verified languages of the speech manifests. Anything else is a
 * typed {@code LANGUAGE_NOT_ADMITTED} denial before any model runs. Rights: every artifact of the derivation chain needs
 * a current {@code Scope.PROCESSING} admission, re-checked on every call. The durable request ledger gives idempotency.</p>
 *
 * <p>No quality, measurement or approval claim is made; machine translation can be wrong and is unreviewed until a human
 * revises it.</p>
 */
final class MediaDevTranslationRuntime {
    static final String SCHEMA = "media.dev.translation-output.v1";
    static final String DOCUMENT_SCHEMA = "media.dev.translated-transcript.v1";
    static final String KIND_TRANSLATED = "LOCAL_TRANSLATED_TRANSCRIPT";
    static final String KIND_REVISED = "LOCAL_TRANSLATED_TRANSCRIPT_USER_REVISED";
    static final String LANE_TRANSLATE = "translation.translate";
    static final String LANE_REVISE = "translation.revise";
    static final int MAX_SEGMENTS = 200;
    static final int MAX_SEGMENT_CHARS = 800;
    static final long MAX_MILLIS = 24L * 3600 * 1000;
    static final List<String> LINEAGE_KEYS = List.of("translationSchema", "scope", "kind", "requestId", "sourceLanguage",
            "targetLanguage", "sourceTranscript", "source", "parent", "model", "rightsDecision", "segmentCount",
            "inputTextSha256", "outputTextSha256", "editedByPrincipalId", "edit", "note");

    /** The translation engine port: the local Qwen2.5-VL text-only lane in production, a fake in unit tests. */
    interface TranslationEngine {
        /** Language pairs as {@code "en>es"}. */
        Set<String> pairs();

        boolean ready();

        /** Model identity map recorded in lineage; empty when no model is admitted. */
        Map<String, Object> model();

        String translate(String text, String sourceLanguage, String targetLanguage);
    }

    /** Adapter over the local vision engine (Qwen2.5-VL, text-only). */
    static TranslationEngine localEngine(LocalVisionEngine engine) {
        return new TranslationEngine() {
            @Override public Set<String> pairs() { return LocalVisionEngine.TRANSLATION_PAIRS; }

            @Override public boolean ready() { return engine.qwenAdmission().qualified(); }

            @Override public Map<String, Object> model() {
                var admission = engine.qwenAdmission();
                if (!admission.qualified()) return Map.of();
                var manifest = admission.manifest();
                Map<String, Object> model = new LinkedHashMap<>();
                model.put("modelId", manifest.modelId());
                model.put("revision", manifest.source().revision());
                model.put("fileSetSha256", manifest.fileSetSha256());
                model.put("licenseSpdx", manifest.license().spdx());
                model.put("runtime", manifest.runtime().name() + "/" + manifest.runtime().version());
                model.put("mode", "TEXT_ONLY");
                return model;
            }

            @Override public String translate(String text, String sourceLanguage, String targetLanguage) {
                try {
                    return String.valueOf(engine.translate(text, sourceLanguage, targetLanguage).get("translation"));
                } catch (LocalVisionEngine.NotAdmittedException notAdmitted) {
                    throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "TRANSLATION_MODEL_NOT_ADMITTED",
                            "the local translation model is not digest-qualified; nothing was dispatched",
                            Map.of("modelId", notAdmitted.modelId(), "reason", notAdmitted.code()));
                } catch (LocalVisionSidecarClient.SidecarUnavailableException unreachable) {
                    throw unknown();
                } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
                    if (rejected.status() >= 500 || "MALFORMED_RESPONSE".equals(rejected.code())) throw unknown();
                    throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "TRANSLATION_INPUT_REJECTED",
                            "the translation engine rejected the input", Map.of("reason", rejected.code()));
                }
            }
        };
    }

    private static MediaDevSpeechRuntime.SpeechRefusedException unknown() {
        return new MediaDevSpeechRuntime.SpeechRefusedException(503, "TRANSLATION_OUTCOME_UNKNOWN",
                "the local translation engine ended without a verified result; whether it completed is unknown and "
                        + "nothing was registered. Retry the same requestId: registration is idempotent by requestId",
                Map.of("registered", false, "retrySafe", true));
    }

    record TranslateRequest(String requestId, String transcriptArtifactId, String transcriptArtifactVersionId,
                            String sourceLanguage, String targetLanguage) {
        TranslateRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            Objects.requireNonNull(transcriptArtifactId, "transcriptArtifactId");
            Objects.requireNonNull(transcriptArtifactVersionId, "transcriptArtifactVersionId");
            sourceLanguage = language(sourceLanguage, "sourceLanguage");
            targetLanguage = language(targetLanguage, "targetLanguage");
        }
    }

    record SegmentText(String segmentId, String text) {
        SegmentText {
            Objects.requireNonNull(segmentId, "segmentId");
            Objects.requireNonNull(text, "text");
        }
    }

    record ReviseRequest(String requestId, String baseArtifactId, String baseArtifactVersionId,
                         List<SegmentText> segments) {
        ReviseRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            Objects.requireNonNull(baseArtifactId, "baseArtifactId");
            Objects.requireNonNull(baseArtifactVersionId, "baseArtifactVersionId");
            if (segments == null || segments.isEmpty() || segments.size() > MAX_SEGMENTS) {
                throw new IllegalArgumentException("segments must list 1-" + MAX_SEGMENTS + " entries");
            }
            segments = List.copyOf(segments);
        }
    }

    /** One translated segment of a translated-transcript document. */
    record Segment(String segmentId, long startMillis, long endMillis, String sourceText, String text) { }

    /** A registered translated transcript with its document. */
    record Translation(MediaDevDubSupport.Output output, String sourceLanguage, String targetLanguage,
                       List<Segment> segments) { }

    private static String language(String value, String field) {
        if (value == null || !value.matches("[a-z]{2,3}")) {
            throw new IllegalArgumentException(field + " must be a 2-3 letter lower-case language tag");
        }
        return value;
    }

    private final MediaRuntime runtime;
    private final MediaDevDubSupport support;
    private final TranslationEngine engine;
    private final MediaDevRequestLedger ledger;
    private final java.util.function.Supplier<Set<String>> speechLanguages;

    /**
     * @param speechLanguages the languages verified by the speech manifests (the intersection of Whisper and Kokoro);
     *                        a target language must be among them as well as among the engine's pairs
     */
    MediaDevTranslationRuntime(MediaRuntime runtime, MediaDevDubSupport support, TranslationEngine engine,
                               java.util.function.Supplier<Set<String>> speechLanguages, MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.support = Objects.requireNonNull(support, "support");
        this.engine = engine;
        this.speechLanguages = Objects.requireNonNull(speechLanguages, "speechLanguages");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /** Target languages for which the source language may be translated: engine pairs within the verified languages. */
    Set<String> admittedTargets(String sourceLanguage) {
        Set<String> targets = new TreeSet<>();
        if (engine == null) return targets;
        Set<String> verified = speechLanguages.get();
        for (String pair : engine.pairs()) {
            String[] parts = pair.split(">");
            if (parts[0].equals(sourceLanguage) && verified.contains(parts[0]) && verified.contains(parts[1])) {
                targets.add(parts[1]);
            }
        }
        return targets;
    }

    Map<String, Object> capabilities() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("ready", engine != null && engine.ready());
        view.put("engine", engine == null ? Map.of() : engine.model());
        view.put("pairs", engine == null ? List.of() : new TreeSet<>(engine.pairs()));
        view.put("admittedTargets", Map.of("en", List.copyOf(admittedTargets("en"))));
        view.put("verifiedSpeechLanguages", new TreeSet<>(speechLanguages.get()));
        view.put("maxSegments", MAX_SEGMENTS);
        view.put("maxSegmentChars", MAX_SEGMENT_CHARS);
        view.put("note", "DEV_ONLY machine translation by the local Qwen2.5-VL-7B-Instruct in text-only mode; unreviewed, "
                + "not a quality, measurement or approval claim");
        return view;
    }

    // ---- translate ----

    Translation translate(String tenantId, String principalId, TranslateRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "translation_translate", tenantId,
                () -> translateAdmitted(tenantId, principalId, request));
    }

    private Translation translateAdmitted(String tenantId, String principalId, TranslateRequest request) {
        if (engine == null) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "TRANSLATION_UNAVAILABLE",
                    "no local translation engine is configured for this server");
        }
        Set<String> admitted = admittedTargets(request.sourceLanguage());
        if (!admitted.contains(request.targetLanguage())) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "LANGUAGE_NOT_ADMITTED",
                    "this language pair is not admitted for the DEV_ONLY translation and dubbing lanes",
                    Map.of("sourceLanguage", request.sourceLanguage(), "targetLanguage", request.targetLanguage(),
                            "admittedTargets", List.copyOf(admitted)));
        }
        if (!engine.ready()) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(503, "TRANSLATION_UNAVAILABLE",
                    "no verified local translation model is available for this server");
        }
        MediaArtifact source = support.exact(tenantId, principalId, request.transcriptArtifactId(),
                request.transcriptArtifactVersionId());
        if (!MediaDevSpeechRuntime.SCHEMA.equals(source.metadata().get("speechSchema"))
                || !MediaDevSpeechRuntime.KIND_TRANSCRIPT.equals(source.metadata().get("kind"))) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_NOT_A_TRANSCRIPT",
                    "translation requires a speech transcript artifact version produced by the speech lane");
        }
        JsonNode document = support.readDocument(tenantId, principalId, source);
        if (!request.sourceLanguage().equals(document.path("language").asString(""))) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_LANGUAGE_MISMATCH",
                    "the transcript is not in the requested source language",
                    Map.of("transcriptLanguage", document.path("language").asString(""),
                            "sourceLanguage", request.sourceLanguage()));
        }
        List<Segment> segments = sourceSegments(document);
        MediaDevDubSupport.Rights rights = support.requireProcessing(tenantId, principalId, source);
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.translation.translate.v1", source.artifactId(),
                source.version().value(), source.sha256(), request.sourceLanguage(), request.targetLanguage());
        return ledger.run(tenantId, principalId, LANE_TRANSLATE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, LANE_TRANSLATE),
                () -> produceTranslation(tenantId, principalId, request, source, segments, rights),
                translation -> List.of(new OutputRef("translation", translation.output().artifact().artifactId(),
                        translation.output().artifact().version().value())),
                () -> new MediaDevSpeechRuntime.SpeechRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    /** Segments of an STT transcript document with generated stable ids; times are the recognizer's source offsets. */
    private static List<Segment> sourceSegments(JsonNode document) {
        JsonNode nodes = document.path("segments");
        if (!nodes.isArray() || nodes.isEmpty() || nodes.size() > MAX_SEGMENTS) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED",
                    "the transcript must have 1-" + MAX_SEGMENTS + " segments");
        }
        List<Segment> segments = new ArrayList<>();
        long previousStart = -1;
        for (int i = 0; i < nodes.size(); i++) {
            JsonNode node = nodes.get(i);
            long start = node.path("startMillis").asLong(-1);
            long end = node.path("endMillis").asLong(-1);
            String text = node.path("text").asString("").strip();
            if (start < 0 || end <= start || end > MAX_MILLIS || start < previousStart) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "TRANSCRIPT_TIMING_INVALID",
                        "a transcript segment has a missing, empty, unordered or out-of-range time window",
                        Map.of("segmentIndex", i));
            }
            if (text.isEmpty()) continue;
            if (text.length() > MAX_SEGMENT_CHARS) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED",
                        "a transcript segment exceeds the text ceiling", Map.of("segmentIndex", i));
            }
            previousStart = start;
            segments.add(new Segment(String.format("seg-%04d", segments.size() + 1), start, end, text, ""));
        }
        if (segments.isEmpty()) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SPEECH_NO_SPEECH_DETECTED",
                    "the transcript has no text segments to translate");
        }
        return segments;
    }

    private Translation produceTranslation(String tenantId, String principalId, TranslateRequest request,
                                           MediaArtifact source, List<Segment> segments,
                                           MediaDevDubSupport.Rights rights) {
        List<Segment> translated = new ArrayList<>();
        for (Segment segment : segments) {
            String text = engine.translate(segment.sourceText(), request.sourceLanguage(), request.targetLanguage());
            text = text == null ? "" : text.replaceAll("\\s+", " ").strip();
            if (text.isEmpty() || text.length() > MAX_SEGMENT_CHARS) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "TRANSLATION_EMPTY_OR_TOO_LONG",
                        "the engine produced no usable translation for a segment; nothing was registered",
                        Map.of("segmentId", segment.segmentId()));
            }
            translated.add(new Segment(segment.segmentId(), segment.startMillis(), segment.endMillis(),
                    segment.sourceText(), text));
        }
        Map<String, Object> lineage = baseLineage(request.requestId(), request.sourceLanguage(),
                request.targetLanguage(), KIND_TRANSLATED, rights, translated);
        Map<String, Object> transcriptRef = MediaDevDubSupport.ref(source);
        lineage.put("sourceTranscript", transcriptRef);
        lineage.put("parent", transcriptRef); // erasure and rights follow parent/source references to derived outputs
        Object original = source.metadata().get("source");
        if (original instanceof Map<?, ?> originalMap) lineage.put("source", originalMap);
        lineage.put("model", engine.model());
        lineage.put("note", "Machine translation of the exact transcript version, segment by segment, keeping segment "
                + "ids and source-clock times; unreviewed and not a quality, measurement or approval claim. The source "
                + "transcript version is unchanged.");
        MediaDevDubSupport.Output output = register(tenantId, principalId, source.classification(), LANE_TRANSLATE,
                request.requestId(), request.sourceLanguage(), request.targetLanguage(), translated, lineage,
                "translation-" + MediaDevDubSupport.safeName(source.artifactId()));
        return new Translation(output, request.sourceLanguage(), request.targetLanguage(), translated);
    }

    private Map<String, Object> baseLineage(String requestId, String sourceLanguage, String targetLanguage, String kind,
                                            MediaDevDubSupport.Rights rights, List<Segment> segments) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("translationSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("requestId", requestId);
        lineage.put("sourceLanguage", sourceLanguage);
        lineage.put("targetLanguage", targetLanguage);
        lineage.put("rightsDecision", rights.evidenceRef());
        lineage.put("segmentCount", segments.size());
        // The text itself is user content: only digests are recorded in lineage.
        lineage.put("inputTextSha256", MediaDevProjectRenderRuntime.sha256Hex(
                String.join("\n", segments.stream().map(Segment::sourceText).toList()).getBytes(StandardCharsets.UTF_8)));
        lineage.put("outputTextSha256", MediaDevProjectRenderRuntime.sha256Hex(
                String.join("\n", segments.stream().map(Segment::text).toList()).getBytes(StandardCharsets.UTF_8)));
        return lineage;
    }

    private MediaDevDubSupport.Output register(String tenantId, String principalId, String classification, String lane,
                                               String requestId, String sourceLanguage, String targetLanguage,
                                               List<Segment> segments, Map<String, Object> lineage, String namePrefix) {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", DOCUMENT_SCHEMA);
        // The artifact store refuses a second artifact with identical bytes in a tenant (unique sha256 and size), so each
        // request's output carries its own requestId and a second request over the same input registers its own output.
        document.put("requestId", requestId);
        document.put("sourceLanguage", sourceLanguage);
        document.put("targetLanguage", targetLanguage);
        document.put("segmentTimeBase", "inherited from the source transcript: milliseconds from the start of the "
                + "decoded source audio; unqualified");
        List<Map<String, Object>> list = new ArrayList<>();
        for (Segment segment : segments) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("segmentId", segment.segmentId());
            entry.put("startMillis", segment.startMillis());
            entry.put("endMillis", segment.endMillis());
            entry.put("sourceText", segment.sourceText());
            entry.put("text", segment.text());
            list.add(entry);
        }
        document.put("segments", list);
        return support.register(tenantId, principalId, classification, lane, requestId,
                MediaDevDubSupport.json(document), "application/json", "json", namePrefix, "translated-transcript", lineage);
    }

    private Translation replay(String tenantId, String principalId, List<OutputRef> outputs, String lane) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("translation")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.output().artifact().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
    }

    // ---- revise ----

    /**
     * A human revision of a translated transcript: the same segment ids, times and source texts with new translation
     * text, registered as a NEW version whose lineage names its parent. No model runs; rights are re-checked.
     */
    Translation revise(String tenantId, String principalId, ReviseRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "translation_revise", tenantId,
                () -> reviseAdmitted(tenantId, principalId, request));
    }

    private Translation reviseAdmitted(String tenantId, String principalId, ReviseRequest request) {
        MediaArtifact base = support.exact(tenantId, principalId, request.baseArtifactId(), request.baseArtifactVersionId());
        if (!SCHEMA.equals(base.metadata().get("translationSchema"))) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_NOT_A_TRANSLATION",
                    "revision requires a translated transcript artifact version");
        }
        Translation current = readTranslation(tenantId, principalId, base);
        if (request.segments().size() != current.segments().size()) {
            throw segmentMismatch();
        }
        List<Segment> revised = new ArrayList<>();
        int changed = 0;
        for (int i = 0; i < current.segments().size(); i++) {
            Segment before = current.segments().get(i);
            SegmentText edit = request.segments().get(i);
            if (!before.segmentId().equals(edit.segmentId())) throw segmentMismatch();
            String text = edit.text().replaceAll("\\s+", " ").strip();
            if (text.isEmpty() || text.length() > MAX_SEGMENT_CHARS
                    || text.chars().anyMatch(c -> c < 0x20 && c != '\n' && c != '\t')) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "TRANSLATION_TEXT_INVALID",
                        "segment text must be 1-" + MAX_SEGMENT_CHARS + " printable characters",
                        Map.of("segmentId", before.segmentId()));
            }
            if (!text.equals(before.text())) changed++;
            revised.add(new Segment(before.segmentId(), before.startMillis(), before.endMillis(), before.sourceText(), text));
        }
        if (changed == 0) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "TRANSLATION_NOT_CHANGED",
                    "the revision does not change any segment text; nothing was registered");
        }
        MediaDevDubSupport.Rights rights = support.requireProcessing(tenantId, principalId, base);
        StringBuilder texts = new StringBuilder();
        for (Segment segment : revised) texts.append(segment.segmentId()).append('=').append(segment.text()).append('\n');
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.translation.revise.v1", base.artifactId(),
                base.version().value(), base.sha256(), MediaDevProjectRenderRuntime.sha256Hex(texts.toString()));
        final int changedSegments = changed;
        return ledger.run(tenantId, principalId, LANE_REVISE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, LANE_REVISE),
                () -> {
                    Map<String, Object> lineage = baseLineage(request.requestId(), current.sourceLanguage(),
                            current.targetLanguage(), KIND_REVISED, rights, revised);
                    lineage.put("parent", MediaDevDubSupport.ref(base));
                    for (String key : List.of("sourceTranscript", "source")) {
                        if (base.metadata().get(key) instanceof Map<?, ?> inherited) lineage.put(key, inherited);
                    }
                    lineage.put("model", base.metadata().getOrDefault("model", Map.of()));
                    lineage.put("editedByPrincipalId", principalId);
                    lineage.put("edit", Map.of("changedSegments", changedSegments, "segmentCount", revised.size()));
                    lineage.put("note", "Human revision of the translated transcript as a new version; segment ids, "
                            + "times and source texts are unchanged. Not a review decision or approval.");
                    MediaDevDubSupport.Output output = register(tenantId, principalId, base.classification(), LANE_REVISE,
                            request.requestId(), current.sourceLanguage(), current.targetLanguage(), revised, lineage,
                            "translation-revised-" + MediaDevDubSupport.safeName(base.artifactId()));
                    return new Translation(output, current.sourceLanguage(), current.targetLanguage(), revised);
                },
                translation -> List.of(new OutputRef("translation", translation.output().artifact().artifactId(),
                        translation.output().artifact().version().value())),
                () -> new MediaDevSpeechRuntime.SpeechRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    private static MediaDevSpeechRuntime.SpeechRefusedException segmentMismatch() {
        return new MediaDevSpeechRuntime.SpeechRefusedException(422, "SEGMENT_SET_MISMATCH",
                "a revision must list exactly the segment ids of its base version, in order");
    }

    // ---- readback ----

    /** Reopens a translated-transcript artifact (any version) for its owner, with its document. */
    Optional<Translation> reopen(String tenantId, String principalId, String artifactId) {
        return support.reopen(tenantId, principalId, artifactId, "translationSchema", SCHEMA, LINEAGE_KEYS)
                .map(output -> readTranslation(tenantId, principalId, output));
    }

    Translation readTranslation(String tenantId, String principalId, MediaArtifact artifact) {
        return readTranslation(tenantId, principalId, new MediaDevDubSupport.Output(artifact, lineageOf(artifact), true));
    }

    private static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    private Translation readTranslation(String tenantId, String principalId, MediaDevDubSupport.Output output) {
        JsonNode document = support.readDocument(tenantId, principalId, output.artifact());
        if (!DOCUMENT_SCHEMA.equals(document.path("schema").asString(""))) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_DOCUMENT_INVALID",
                    "the artifact is not a translated transcript document");
        }
        List<Segment> segments = new ArrayList<>();
        Set<String> ids = new java.util.HashSet<>();
        for (JsonNode node : document.path("segments")) {
            String id = node.path("segmentId").asString("");
            long start = node.path("startMillis").asLong(-1);
            long end = node.path("endMillis").asLong(-1);
            String text = node.path("text").asString("");
            if (id.isEmpty() || !ids.add(id) || start < 0 || end <= start || end > MAX_MILLIS || text.isBlank()
                    || segments.size() >= MAX_SEGMENTS) {
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_DOCUMENT_INVALID",
                        "the translated transcript document has an invalid segment");
            }
            segments.add(new Segment(id, start, end, node.path("sourceText").asString(""), text));
        }
        if (segments.isEmpty()) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_DOCUMENT_INVALID",
                    "the translated transcript document has no segments");
        }
        return new Translation(output, document.path("sourceLanguage").asString(""),
                document.path("targetLanguage").asString(""), segments);
    }
}
