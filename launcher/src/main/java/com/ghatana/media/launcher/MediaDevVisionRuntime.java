package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * DEV_ONLY local vision lane: analyze an exact owner-visible image (or one frame of an exact video version)
 * with Florence-2, or ask Qwen2.5-VL a question about it, and register the structured result as an immutable
 * {@code application/json} artifact through the canonical idempotent upload path. Lineage binds the result to
 * the exact source artifact version, its SHA-256, the frame position and digest when a video frame was used, and
 * the exact digest-qualified model identity (id, revision, SPDX licence, file-set digest).
 *
 * <p>Rights: every request first resolves the exact source version and digest for {@code Scope.PROCESSING} through
 * the injectable {@link RightsConsentResolver}; anything other than ADMITTED (including an unconfigured authority)
 * is refused before any byte is read or any model is called. No face or person identification is offered, so
 * VOICE_OR_LIKENESS_USE is never needed. The canonical VISION job admission still requires the
 * source-authorization authority and is unchanged. Inference is greedy and the registered bytes carry no timestamps,
 * so a retry with the same requestId re-derives identical bytes; if the model ever produced different bytes the
 * upload idempotency fingerprint refuses the replay.
 *
 * @doc.type class
 * @doc.purpose DEV_ONLY Florence-2/Qwen2.5-VL analysis registered as a lineage-bound JSON artifact
 * @doc.layer product
 * @doc.pattern Service
 */
public final class MediaDevVisionRuntime {
    public static final String SCHEMA = "media.dev.vision-output.v1";
    public static final String KIND_ANALYSIS = "LOCAL_VISION_ANALYSIS";
    public static final String KIND_QUESTION = "LOCAL_VISION_QUESTION";
    static final int MAX_SOURCE_BYTES = 128 * 1024 * 1024;
    private static final List<String> LINEAGE_KEYS = List.of("visionSchema", "scope", "kind", "requestId", "source",
            "frame", "models", "tasks", "question", "rightsDecision", "resultSha256");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    public record AnalyzeRequest(String requestId, String artifactId, String artifactVersionId, Set<String> tasks,
                                 long frameTimeMs) {
        public AnalyzeRequest {
            requestId = boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (tasks == null || tasks.isEmpty() || !LocalVisionEngine.FLORENCE_TASKS.containsAll(tasks)) {
                throw new IllegalArgumentException("tasks must be a non-empty subset of caption, detect, ocr");
            }
            tasks = Set.copyOf(tasks);
            if (frameTimeMs < 0 || frameTimeMs > 24L * 3600 * 1000) {
                throw new IllegalArgumentException("frameTimeMs must be within [0, 86400000]");
            }
        }
    }

    public record AskRequest(String requestId, String artifactId, String artifactVersionId, String question,
                             long frameTimeMs) {
        public AskRequest {
            requestId = boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (question == null || question.isBlank() || question.length() > LocalVisionEngine.MAX_QUESTION_CHARS) {
                throw new IllegalArgumentException("question must be 1-" + LocalVisionEngine.MAX_QUESTION_CHARS
                        + " characters");
            }
            if (frameTimeMs < 0 || frameTimeMs > 24L * 3600 * 1000) {
                throw new IllegalArgumentException("frameTimeMs must be within [0, 86400000]");
            }
        }
    }

    /** Durable view of a registered vision output, reconstructible from the artifact alone. */
    public record VisionResult(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    /** The required local model is not digest-qualified; nothing was dispatched. */
    public static final class VisionNotAdmittedException extends RuntimeException {
        private final String code;
        private final String modelId;
        VisionNotAdmittedException(String modelId, String code) {
            super("local model is not admitted: " + modelId);
            this.modelId = modelId;
            this.code = code;
        }
        public String code() { return code; }
        public String modelId() { return modelId; }
    }

    /** The loopback sidecar cannot be reached or timed out. */
    /**
     * The exact source version has no current PROCESSING rights/consent admission. {@code code} is
     * RIGHTS_AUTHORITY_UNAVAILABLE for an unconfigured or failing authority, otherwise RIGHTS_ plus the verdict.
     */
    public static final class VisionRightsNotAdmittedException extends RuntimeException {
        private final String code;
        private final Resolution resolution;
        VisionRightsNotAdmittedException(String code, Resolution resolution) {
            super("source rights/consent is not admitted for PROCESSING");
            this.code = code;
            this.resolution = resolution;
        }
        public String code() { return code; }
        public Resolution resolution() { return resolution; }
    }

    public static final class VisionUnavailableException extends RuntimeException {
        VisionUnavailableException(Throwable cause) { super("local vision sidecar is unavailable", cause); }
    }

    public static final class VisionUnsupportedException extends IllegalArgumentException {
        private final String code;
        VisionUnsupportedException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }

    public static final class VisionRegistrationFailedException extends IllegalStateException {
        VisionRegistrationFailedException(Throwable cause) {
            super("vision output could not be registered as an immutable artifact", cause);
        }
    }

    public static final class VisionRequestReusedException extends IllegalStateException {
        VisionRequestReusedException(Throwable cause) {
            super("vision output requestId was already used for a different request", cause);
        }
    }

    private final MediaRuntime runtime;
    private final LocalVisionEngine engine;
    private final LocalOpenModelVisionProvider.FrameExtractor frames;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver rights;

    /** Fail-closed: with no resolver every request is refused as RIGHTS_AUTHORITY_UNAVAILABLE. */
    public MediaDevVisionRuntime(MediaRuntime runtime, LocalVisionEngine engine,
                                 LocalOpenModelVisionProvider.FrameExtractor frames,
                                 RightsConsentResolver rights) {
        this(runtime, engine, frames, rights, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime));
    }

    MediaDevVisionRuntime(MediaRuntime runtime, LocalVisionEngine engine,
                          LocalOpenModelVisionProvider.FrameExtractor frames, RightsConsentResolver rights,
                          MediaDevProjectRenderRuntime.OutputRegistrar registrar) {
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.engine = Objects.requireNonNull(engine, "engine");
        this.frames = frames;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
    }

    /** Admission summary for the DEV status route; never discloses paths or content. */
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("florence", admissionView(engine.florenceAdmission()));
        out.put("qwen", admissionView(engine.qwenAdmission()));
        out.put("sidecarHealthy", engine.sidecarHealthy());
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name(), "productionReady", engine.rights().productionReady(),
                "reason", rights.ready() ? "ATTESTATION_REQUIRED_PER_SOURCE_VERSION" : "RIGHTS_AUTHORITY_UNAVAILABLE"));
        out.put("frameExtractionAvailable", frames != null);
        out.put("scope", "DEV_ONLY");
        return out;
    }

    private static Map<String, Object> admissionView(LocalModelAdmission.Admission admission) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("state", admission.state().name());
        view.put("reason", admission.reasonCode());
        if (admission.manifest() != null) {
            view.put("modelId", admission.manifest().modelId());
            view.put("revision", admission.manifest().revision());
            view.put("spdxLicense", admission.manifest().spdxLicense());
        }
        return view;
    }

    public VisionResult analyze(String tenantId, String principalId, AnalyzeRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "vision_analyze", tenantId,
                () -> execute(tenantId, principalId, request.requestId(), request.artifactId(),
                        request.artifactVersionId(), request.frameTimeMs(), KIND_ANALYSIS, request.tasks(), null));
    }

    public VisionResult ask(String tenantId, String principalId, AskRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "vision_ask", tenantId,
                () -> execute(tenantId, principalId, request.requestId(), request.artifactId(),
                        request.artifactVersionId(), request.frameTimeMs(), KIND_QUESTION, null, request.question()));
    }

    private VisionResult execute(String tenantId, String principalId, String requestId, String artifactId,
                                 String versionId, long frameTimeMs, String kind, Set<String> tasks,
                                 String question) {
        MediaArtifact source = runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, source.artifactId(), source.version().value(),
                    source.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (!resolution.admitted()) {
            throw new VisionRightsNotAdmittedException(
                    resolution.verdict() == com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict.UNAVAILABLE
                            ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_" + resolution.verdict().name(), resolution);
        }
        if (source.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new VisionUnsupportedException("VISION_LIMIT_EXCEEDED", "source exceeds the byte ceiling");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) Math.min(source.sizeBytes(), 1 << 26));
        try {
            runtime.copyArtifactContent(tenantId, principalId, source.artifactId(), source.version(), staged,
                    MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        byte[] sourceBytes = staged.toByteArray();
        byte[] image = sourceBytes;
        Map<String, Object> frame = null;
        String contentType = source.contentType().toLowerCase(Locale.ROOT);
        if (contentType.startsWith("video/")) {
            if (frames == null) {
                throw new VisionUnsupportedException("FRAME_EXTRACTION_UNAVAILABLE",
                        "video frame extraction requires MEDIA_DEV_RENDER_FFMPEG");
            }
            try {
                image = frames.extractPng(sourceBytes, frameTimeMs);
            } catch (IOException | RuntimeException failure) {
                throw new VisionUnsupportedException("FRAME_EXTRACTION_FAILED",
                        "the requested frame could not be extracted from the exact video version");
            }
            frame = new LinkedHashMap<>();
            frame.put("timeMillis", frameTimeMs);
            frame.put("frameSha256", MediaDevProjectRenderRuntime.sha256Hex(image));
        } else if (!contentType.startsWith("image/")) {
            throw new VisionUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                    "vision requires an image/* or video/* source artifact version");
        }
        String imageSha = MediaDevProjectRenderRuntime.sha256Hex(image);

        Map<String, Object> inference;
        try {
            inference = tasks != null ? engine.analyze(image, imageSha, tasks) : engine.ask(image, imageSha, question);
        } catch (LocalVisionEngine.NotAdmittedException refusal) {
            throw new VisionNotAdmittedException(refusal.modelId(), refusal.code());
        } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
            throw new VisionUnavailableException(unavailable);
        } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
            throw new VisionUnsupportedException("LOCAL_VISION_REJECTED",
                    "the local vision sidecar rejected the request (" + rejected.code() + ")");
        } catch (IllegalArgumentException invalid) {
            throw new VisionUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED", invalid.getMessage());
        }

        Map<String, Object> sourceRef = new LinkedHashMap<>();
        sourceRef.put("artifactId", source.artifactId());
        sourceRef.put("artifactVersionId", source.version().value());
        sourceRef.put("sha256", source.sha256());
        sourceRef.put("contentType", source.contentType());

        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("kind", kind);
        document.put("requestId", requestId);
        document.put("source", sourceRef);
        if (frame != null) document.put("frame", frame);
        document.put("inference", inference);
        byte[] bytes = JSON.writeValueAsString(document).getBytes(StandardCharsets.UTF_8);

        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("visionSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("requestId", requestId);
        lineage.put("source", sourceRef);
        if (frame != null) lineage.put("frame", frame);
        lineage.put("models", List.of(inference.get("model")));
        if (tasks != null) lineage.put("tasks", tasks.stream().sorted().toList());
        if (question != null) lineage.put("question", question);
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("verdict", resolution.verdict().name());
        rightsDecision.put("attestationIds", resolution.attestationIds());
        rightsDecision.put("resolverId", resolution.resolverId());
        rightsDecision.put("productionGrant", false);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("resultSha256", MediaDevProjectRenderRuntime.sha256Hex(bytes));
        return register(tenantId, principalId, kind, requestId, bytes, lineage);
    }

    private VisionResult register(String tenantId, String principalId, String kind, String requestId, byte[] bytes,
                                  Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "vision-output");
        String name = KIND_ANALYSIS.equals(kind) ? "vision-analysis" : "vision-question";
        UploadRequest upload = new UploadRequest(tenantId, principalId, name + ".json", "application/json",
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-vision:" + kind + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new VisionRequestReusedException(conflict);
            }
            throw new VisionRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new VisionRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new VisionRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new VisionResult(artifact, lineage, registered.replayed());
    }

    /** Reopens a registered vision output for its owner (with its content) or returns empty. */
    public Optional<VisionResult> reopen(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("visionSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new VisionResult(artifact, lineage, true);
                });
    }

    private static String boundedId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must be a 1-128 character opaque id");
        }
        return value;
    }
}
