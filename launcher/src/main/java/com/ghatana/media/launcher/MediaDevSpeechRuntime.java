package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.stt.local.LocalSpeechException;
import com.ghatana.stt.local.LocalWhisperCppRunner;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.local.WebVttWriter;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tts.local.LocalKokoroSynthesizer;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import com.ghatana.tts.local.LocalTtsException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * DEV_ONLY local speech lane (outside the canonical route manifest/OpenAPI): real Whisper large-v3-turbo
 * (whisper.cpp, MIT) speech-to-text and Kokoro-82M (Apache-2.0, no voice cloning) text-to-speech on this host,
 * per the owner decision recorded in the verified model manifests. Outputs are registered as NEW immutable artifacts
 * through the canonical idempotent upload path with lineage that names the exact source version, model weights
 * digest and runtime. The source artifact is never modified.
 *
 * <ul>
 *   <li>transcription: one exact owner-visible PCM16 WAV artifact version becomes a transcript text artifact and a
 *       derived WebVTT artifact. The WebVTT is an unreviewed rendering of the recognizer segments, not a caption
 *       authority;</li>
 *   <li>synthesis: text becomes a mono 24 kHz PCM16 WAV artifact using a manifest-listed Kokoro voice pack.</li>
 * </ul>
 *
 * <p>Rights are an injectable port ({@link SpeechRightsGate}). The default STT gate asks the runtime's configured
 * source-authorization authority exactly like the canonical STT admission, so an absent authority stays
 * {@code RIGHTS_AUTHORITY_UNAVAILABLE}; the default TTS gate mirrors the canonical job lane (no source artifact
 * exists, so non-production development lanes may proceed with stock voices and production-like profiles refuse).
 * This lane never self-approves rights or consent and makes no quality, measurement or production claim.</p>
 */
public final class MediaDevSpeechRuntime {
    public static final String SCHEMA = "media.dev.speech-output.v1";
    public static final String KIND_TRANSCRIPT = "LOCAL_STT_TRANSCRIPT";
    public static final String KIND_CAPTIONS = "LOCAL_STT_WEBVTT_UNREVIEWED";
    public static final String KIND_SYNTHESIS = "LOCAL_TTS_AUDIO";
    static final int MAX_SOURCE_BYTES = 4 * 1024 * 1024;
    private static final Set<String> WAV_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
    private static final List<String> LINEAGE_KEYS = List.of("speechSchema", "scope", "kind", "requestId", "engine",
            "source", "language", "model", "runtime", "rightsDecision", "voice", "speakingRate", "inputTextSha256",
            "inputTextChars", "audio", "cueCount", "transcriptArtifactId", "note");

    /** Which speech operation a rights decision is requested for. */
    public enum Operation { SPEECH_TO_TEXT, TEXT_TO_SPEECH }

    /** Injectable rights/consent port. An implementation must not approve on its own authority in production. */
    public interface SpeechRightsGate {
        enum Outcome { ALLOWED, DENIED, UNAVAILABLE }

        record Decision(Outcome outcome, String code, String evidenceRef) {
            public Decision {
                Objects.requireNonNull(outcome, "outcome");
                code = code == null ? "" : code;
                evidenceRef = evidenceRef == null ? "" : evidenceRef;
            }
            public static Decision unavailable() {
                return new Decision(Outcome.UNAVAILABLE, "RIGHTS_AUTHORITY_UNAVAILABLE", "");
            }
        }

        /** {@code source} is the exact source artifact for STT and null for synthesis from request text. */
        Decision authorize(String tenantId, String principalId, Operation operation, MediaArtifact source);

        static SpeechRightsGate unavailable() { return (tenant, principal, operation, source) -> Decision.unavailable(); }
    }

    public record TranscribeRequest(String requestId, String artifactId, String artifactVersionId, String language) {
        public TranscribeRequest {
            requestId = boundedId(requestId, "requestId");
            artifactId = Objects.requireNonNull(artifactId, "artifactId");
            artifactVersionId = Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            language = language == null || language.isBlank() ? "en" : language;
            if (!language.matches("[a-z]{2,3}")) throw new IllegalArgumentException("language must be a 2-3 letter tag");
        }
    }

    public record SynthesizeRequest(String requestId, String text, String voice, double speakingRate) {
        public SynthesizeRequest {
            requestId = boundedId(requestId, "requestId");
            if (text == null || text.isBlank() || text.length() > LocalKokoroSynthesizer.MAX_TEXT_CHARS) {
                throw new IllegalArgumentException("text must be 1-" + LocalKokoroSynthesizer.MAX_TEXT_CHARS
                        + " characters");
            }
            voice = voice == null || voice.isBlank() ? LocalKokoroTtsProvider.DEFAULT_VOICE : voice;
            if (!Double.isFinite(speakingRate) || speakingRate < 0.5 || speakingRate > 2.0) {
                throw new IllegalArgumentException("speakingRate must be within [0.5, 2.0]");
            }
        }
    }

    /** Durable view of a registered speech output, reconstructible from the artifact alone after restart. */
    public record SpeechOutput(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) { }

    public record TranscriptionResult(SpeechOutput transcript, SpeechOutput captions, String text, int cueCount) { }

    /** Typed refusal. {@code code} is surfaced to the caller; no tool output or content is carried. */
    public static final class SpeechRefusedException extends RuntimeException {
        private final String code;
        private final int status;
        private final Map<String, Object> details;
        SpeechRefusedException(int status, String code, String message) { this(status, code, message, Map.of()); }
        SpeechRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    public static final class SpeechRequestReusedException extends IllegalStateException {
        SpeechRequestReusedException(Throwable cause) {
            super("speech requestId was already used for a different request", cause);
        }
    }

    public static final class SpeechRegistrationFailedException extends IllegalStateException {
        SpeechRegistrationFailedException(Throwable cause) {
            super("speech output could not be registered as an immutable artifact", cause);
        }
    }

    private final MediaRuntime runtime;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final LocalWhisperCppSttProvider stt;
    private final LocalKokoroTtsProvider tts;
    private final SpeechRightsGate sttGate;
    private final SpeechRightsGate ttsGate;

    MediaDevSpeechRuntime(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                          LocalWhisperCppSttProvider stt, LocalKokoroTtsProvider tts,
                          SpeechRightsGate sttGate, SpeechRightsGate ttsGate) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.stt = stt;
        this.tts = tts;
        this.sttGate = Objects.requireNonNull(sttGate, "sttGate");
        this.ttsGate = Objects.requireNonNull(ttsGate, "ttsGate");
    }

    /**
     * Production-shaped composition from the server-owned environment: verified providers from the manifests, the
     * runtime's own source-authorization authority for STT, and the canonical-job-lane rule for TTS.
     */
    static MediaDevSpeechRuntime compose(MediaRuntime runtime, Map<String, String> environment) {
        return new MediaDevSpeechRuntime(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime),
                LocalWhisperCppSttProvider.fromEnvironment(environment),
                LocalKokoroTtsProvider.fromEnvironment(environment),
                runtimeAuthorityGate(runtime), canonicalJobLaneTtsGate(runtime));
    }

    /** Asks the runtime's configured source-authorization authority (the same one canonical STT admission uses). */
    static SpeechRightsGate runtimeAuthorityGate(MediaRuntime runtime) {
        return (tenantId, principalId, operation, source) -> {
            if (operation != Operation.SPEECH_TO_TEXT || source == null) return SpeechRightsGate.Decision.unavailable();
            try {
                MediaSourceAuthorizationContracts.Decision decision = runtime.resolveSourceAuthorization(
                        tenantId, principalId, source.artifactId(), source.version(), JobType.SPEECH_TO_TEXT,
                        "transcription", new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                                tenantId, principalId, Instant.now()));
                if (decision == null) return SpeechRightsGate.Decision.unavailable();
                return switch (decision.status()) {
                    case ALLOWED -> new SpeechRightsGate.Decision(SpeechRightsGate.Outcome.ALLOWED, "",
                            "source-authorization:" + decision.evidence().decisionId());
                    case UNAVAILABLE -> SpeechRightsGate.Decision.unavailable();
                    default -> new SpeechRightsGate.Decision(SpeechRightsGate.Outcome.DENIED,
                            "RIGHTS_DECISION_" + decision.status().name(), "");
                };
            } catch (RuntimeException unavailable) {
                return SpeechRightsGate.Decision.unavailable();
            }
        };
    }

    /**
     * The canonical job lane needs source-rights evidence for TEXT_TO_SPEECH only in production-like profiles and
     * there is no source artifact for request text. Mirror that: refuse in production-like profiles, allow stock
     * voices elsewhere with an explicit non-evidence marker.
     */
    static SpeechRightsGate canonicalJobLaneTtsGate(MediaRuntime runtime) {
        return (tenantId, principalId, operation, source) -> runtime.config().productionLike()
                ? SpeechRightsGate.Decision.unavailable()
                : new SpeechRightsGate.Decision(SpeechRightsGate.Outcome.ALLOWED, "",
                        "dev-lane:no-source-artifact;stock-voice;no-cloning");
    }

    // ---- capabilities ----

    /** Read-only readiness view. No filesystem path, weight location or tool output is exposed. */
    public Map<String, Object> capabilities() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("speechToText", engineView(stt == null ? null : stt.install(), stt != null && stt.ready(), null));
        view.put("textToSpeech", engineView(tts == null ? null : tts.install(), tts != null && tts.ready(),
                tts == null ? Set.of() : tts.voices()));
        return view;
    }

    private static Map<String, Object> engineView(LocalModelInstall install, boolean ready, Set<String> voices) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("ready", ready);
        view.put("installState", install == null ? "NOT_CONFIGURED" : install.state().name());
        if (install != null && install.usable()) {
            view.put("modelId", install.manifest().modelId());
            view.put("revision", install.manifest().source().revision());
            view.put("licenseSpdx", install.manifest().license().spdx());
            view.put("manifestSha256", install.manifestSha256());
            view.put("productionEligible", install.manifest().admission().productionEligible());
        }
        if (voices != null) view.put("voices", new java.util.TreeSet<>(voices));
        return view;
    }

    // ---- transcription ----

    public TranscriptionResult transcribe(String tenantId, String principalId, TranscribeRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "speech_transcribe", tenantId,
                () -> transcribeAdmitted(tenantId, principalId, request));
    }

    private TranscriptionResult transcribeAdmitted(String tenantId, String principalId, TranscribeRequest request) {
        LocalWhisperCppRunner runner = stt == null ? null : stt.runner();
        if (runner == null) {
            throw new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                    "no verified local speech-to-text model is installed for this server");
        }
        MediaArtifact source = runtime.artifact(tenantId, principalId, request.artifactId())
                .filter(found -> found.version().value().equals(request.artifactVersionId()))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        if (!WAV_TYPES.contains(source.contentType().toLowerCase(Locale.ROOT))) {
            throw new SpeechRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "speech-to-text requires an audio/wav (PCM16) source artifact version");
        }
        if (source.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED", "source exceeds the byte ceiling");
        }
        if (!stt.install().manifest().verifiedLanguages().contains(request.language())) {
            throw new SpeechRefusedException(422, "LANGUAGE_UNSUPPORTED",
                    "this local profile has no verified qualification for language " + request.language());
        }
        SpeechRightsGate.Decision rights = sttGate.authorize(tenantId, principalId, Operation.SPEECH_TO_TEXT, source);
        requireAllowed(rights, Operation.SPEECH_TO_TEXT);

        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) source.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, source.artifactId(), source.version(), staged,
                    MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        final LocalWhisperCppRunner.Transcription result;
        try {
            byte[] mono16k = PcmWav.toMono16k(staged.toByteArray());
            result = runner.transcribe(mono16k, request.language(), Duration.ofMinutes(5),
                    BoundedProcessRunner.CancellationToken.NEVER);
        } catch (LocalSpeechException failure) {
            throw speechFailure(failure);
        }
        if (!stt.install().stillCurrent()) {
            throw new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                    "the local model changed during inference; the output was discarded");
        }
        if (result.text().isBlank()) {
            throw new SpeechRefusedException(422, "SPEECH_NO_SPEECH_DETECTED",
                    "the recognizer produced no text for this source; nothing was registered");
        }

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("speechSchema", SCHEMA);
        shared.put("scope", "DEV_ONLY");
        shared.put("requestId", request.requestId());
        shared.put("engine", "whisper.cpp/" + stt.providerVersion() + "+" + LocalWhisperCppSttProvider.MODEL_KEY);
        Map<String, Object> sourceRef = new LinkedHashMap<>();
        sourceRef.put("artifactId", source.artifactId());
        sourceRef.put("artifactVersionId", source.version().value());
        sourceRef.put("sha256", source.sha256());
        sourceRef.put("contentType", source.contentType());
        shared.put("source", sourceRef);
        shared.put("language", request.language());
        shared.put("model", modelRef(stt.install(), result.modelSha256()));
        shared.put("runtime", runtimeRef(stt.install()));
        shared.put("rightsDecision", rights.evidenceRef());

        Map<String, Object> transcriptLineage = new LinkedHashMap<>(shared);
        transcriptLineage.put("kind", KIND_TRANSCRIPT);
        transcriptLineage.put("cueCount", result.segments().size());
        transcriptLineage.put("note", "Recognizer output for the exact source version; unreviewed and not a quality, "
                + "measurement or approval claim. The source artifact version is unchanged.");
        byte[] transcriptBytes = (result.text() + "\n").getBytes(StandardCharsets.UTF_8);
        SpeechOutput transcript = register(tenantId, principalId, source.classification(), "stt-transcript",
                request.requestId(), transcriptBytes, "text/plain", "txt",
                "transcript-" + safeName(source.artifactId()), transcriptLineage);

        List<WebVttWriter.Cue> cues = new ArrayList<>();
        for (LocalWhisperCppRunner.Segment segment : result.segments()) {
            cues.add(new WebVttWriter.Cue(segment.startMillis(), segment.endMillis(), segment.text()));
        }
        Map<String, Object> captionLineage = new LinkedHashMap<>(shared);
        captionLineage.put("kind", KIND_CAPTIONS);
        captionLineage.put("cueCount", cues.size());
        captionLineage.put("transcriptArtifactId", transcript.artifact().artifactId());
        captionLineage.put("note", "Derived WebVTT rendering of recognizer segments (times relative to the start of the "
                + "decoded audio); not reviewed, not a caption authority, and not source-clock bound.");
        SpeechOutput captions = register(tenantId, principalId, source.classification(), "stt-webvtt",
                request.requestId(), WebVttWriter.write(cues), "text/vtt", "vtt",
                "captions-" + safeName(source.artifactId()), captionLineage);
        return new TranscriptionResult(transcript, captions, result.text(), cues.size());
    }

    // ---- synthesis ----

    public SpeechOutput synthesize(String tenantId, String principalId, SynthesizeRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "speech_synthesize", tenantId,
                () -> synthesizeAdmitted(tenantId, principalId, request));
    }

    private SpeechOutput synthesizeAdmitted(String tenantId, String principalId, SynthesizeRequest request) {
        LocalKokoroSynthesizer synthesizer = tts == null ? null : tts.synthesizer();
        if (synthesizer == null) {
            throw new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                    "no verified local text-to-speech model is installed for this server");
        }
        if (!synthesizer.voices().contains(request.voice())) {
            throw new SpeechRefusedException(422, "VOICE_NOT_ADMITTED",
                    "the voice is not part of the verified model installation; voice cloning is not supported");
        }
        SpeechRightsGate.Decision rights = ttsGate.authorize(tenantId, principalId, Operation.TEXT_TO_SPEECH, null);
        requireAllowed(rights, Operation.TEXT_TO_SPEECH);
        final LocalKokoroSynthesizer.Synthesis result;
        try {
            result = synthesizer.synthesize(request.text(), request.voice(), request.speakingRate(),
                    Duration.ofMinutes(3), BoundedProcessRunner.CancellationToken.NEVER);
        } catch (LocalTtsException failure) {
            throw speechFailure(failure);
        }
        if (!tts.install().stillCurrent()) {
            throw new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                    "the local model changed during synthesis; the output was discarded");
        }
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("speechSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_SYNTHESIS);
        lineage.put("requestId", request.requestId());
        lineage.put("engine", "kokoro/" + tts.providerVersion());
        lineage.put("model", modelRef(tts.install(), result.modelSha256()));
        lineage.put("runtime", runtimeRef(tts.install()));
        lineage.put("rightsDecision", rights.evidenceRef());
        lineage.put("voice", result.voice());
        lineage.put("speakingRate", request.speakingRate());
        // The input text is user content: only its digest and length are recorded, never the text itself.
        lineage.put("inputTextSha256", MediaDevProjectRenderRuntime.sha256Hex(
                request.text().getBytes(StandardCharsets.UTF_8)));
        lineage.put("inputTextChars", request.text().length());
        lineage.put("audio", Map.of("sampleRate", result.sampleRate(), "channels", 1, "bitsPerSample", 16,
                "durationMillis", result.durationMillis(), "voiceCloning", "NOT_SUPPORTED"));
        lineage.put("note", "Synthesized with a stock Kokoro voice pack; no voice cloning. Synthesized-speech "
                + "disclosure applies to downstream use; not a quality or approval claim.");
        return register(tenantId, principalId, "INTERNAL", "tts-audio", request.requestId(), result.wav(),
                "audio/wav", "wav", "speech-" + request.voice(), lineage);
    }

    // ---- shared ----

    private static void requireAllowed(SpeechRightsGate.Decision rights, Operation operation) {
        if (rights.outcome() == SpeechRightsGate.Outcome.ALLOWED) return;
        throw new SpeechRefusedException(rights.outcome() == SpeechRightsGate.Outcome.UNAVAILABLE ? 422 : 403,
                rights.code().isBlank() ? "RIGHTS_AUTHORITY_UNAVAILABLE" : rights.code(),
                "source rights and consent do not admit this " + operation.name() + " request",
                Map.of("operation", operation.name()));
    }

    private static Map<String, Object> modelRef(LocalModelInstall install, String weightsSha256) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("modelId", install.manifest().modelId());
        model.put("revision", install.manifest().source().revision());
        model.put("weightsSha256", weightsSha256);
        model.put("manifestSha256", install.manifestSha256());
        model.put("licenseSpdx", install.manifest().license().spdx());
        model.put("ownerDecisionDate", install.manifest().ownerDecision().date());
        return model;
    }

    private static Map<String, Object> runtimeRef(LocalModelInstall install) {
        var binding = install.manifest().runtime();
        Map<String, Object> ref = new LinkedHashMap<>();
        if (binding != null) {
            ref.put("name", binding.name());
            ref.put("version", binding.version());
            ref.put("revision", binding.revision());
        }
        return ref;
    }

    private static SpeechRefusedException speechFailure(LocalSpeechException failure) {
        return switch (failure.code()) {
            case INVALID_INPUT -> new SpeechRefusedException(422, "SPEECH_INPUT_INVALID", failure.getMessage());
            case TIMEOUT -> new SpeechRefusedException(504, "SPEECH_TIMEOUT", "local inference exceeded its time budget");
            case CANCELLED -> new SpeechRefusedException(503, "SPEECH_CANCELLED", "local inference was cancelled");
            case OUTPUT_TOO_LARGE -> new SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED", "output exceeded its ceiling");
            default -> new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE", "local inference failed");
        };
    }

    private static SpeechRefusedException speechFailure(LocalTtsException failure) {
        return switch (failure.code()) {
            case INVALID_INPUT -> new SpeechRefusedException(422, "SPEECH_INPUT_INVALID", failure.getMessage());
            case VOICE_NOT_ADMITTED -> new SpeechRefusedException(422, "VOICE_NOT_ADMITTED", failure.getMessage());
            case TIMEOUT -> new SpeechRefusedException(504, "SPEECH_TIMEOUT", "local synthesis exceeded its time budget");
            case CANCELLED -> new SpeechRefusedException(503, "SPEECH_CANCELLED", "local synthesis was cancelled");
            case OUTPUT_TOO_LARGE -> new SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED", "output exceeded its ceiling");
            default -> new SpeechRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE", "local synthesis failed");
        };
    }

    private SpeechOutput register(String tenantId, String principalId, String classification, String lane,
                                  String requestId, byte[] bytes, String contentType, String extension,
                                  String namePrefix, Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "speech-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, classification, Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-speech:" + lane + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                (tenantId + "\u0000" + principalId + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8));
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new SpeechRequestReusedException(conflict);
            }
            throw new SpeechRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new SpeechRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new SpeechRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new SpeechOutput(artifact, lineage, registered.replayed());
    }

    /** Reopens a registered speech output for its owner; anything else is absent. */
    public Optional<SpeechOutput> reopen(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("speechSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new SpeechOutput(artifact, lineage, true);
                });
    }

    private static String safeName(String value) {
        String safe = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.length() > 64 ? safe.substring(0, 64) : safe;
    }

    private static String boundedId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }
}
