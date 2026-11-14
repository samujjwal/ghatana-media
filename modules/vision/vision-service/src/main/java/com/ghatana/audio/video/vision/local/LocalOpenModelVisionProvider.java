package com.ghatana.audio.video.vision.local;

import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Canonical {@link MediaProcessingProvider} for {@link JobType#VISION} backed by the owner-selected
 * local open models: Florence-2 (caption, object detection, scene text) and, when the job carries a
 * {@code question}, Qwen2.5-VL-7B-Instruct. Local processing boundary, no provider data retention.
 *
 * <p>The provider is {@code ready} only when the sidecar is healthy and the Florence manifest digests
 * verify; it is {@code productionEligible} only when, in addition, both models are digest-qualified and a
 * real {@link LocalVisionRightsAuthority} is ready. Source bytes are read only through the runtime's
 * verified, rights-rechecking reader and are bound to the result by SHA-256. A definite refusal
 * (unsupported analysis type, model not admitted, sidecar rejection) is reported as a final failure;
 * an unreachable sidecar, timeout or unprovable source read is UNKNOWN, never a fabricated result.
 *
 * @doc.type class
 * @doc.purpose Local Florence-2/Qwen2.5-VL canonical vision provider
 * @doc.layer product
 * @doc.pattern Provider
 */
public final class LocalOpenModelVisionProvider implements MediaProcessingProvider {

    public static final String PROVIDER_ID = "local-open-vision";
    private static final long MAX_SOURCE_BYTES = 256L * 1024 * 1024;
    private static final long READY_CACHE_NANOS = 5_000_000_000L;

    /** Resolves one still frame (PNG bytes) from a video source at an exact millisecond position. */
    @FunctionalInterface
    public interface FrameExtractor {
        byte[] extractPng(byte[] video, long timeMillis) throws IOException;
    }

    private final LocalVisionEngine engine;
    private final FrameExtractor frames;
    private volatile long readyAt;
    private volatile boolean lastReady;

    public LocalOpenModelVisionProvider(LocalVisionEngine engine, FrameExtractor frames) {
        this.engine = Objects.requireNonNull(engine, "engine");
        this.frames = frames;
    }

    @Override public String providerId() { return PROVIDER_ID; }

    @Override public String providerVersion() {
        LocalModelAdmission.Admission florence = engine.florenceAdmission();
        LocalModelAdmission.Admission qwen = engine.qwenAdmission();
        String f = florence.manifest() == null ? "unverified" : florence.manifest().revision().substring(0, 12);
        String q = qwen.manifest() == null ? "unverified" : qwen.manifest().revision().substring(0, 12);
        return "florence2-large@" + f + "+qwen2.5-vl-7b@" + q;
    }

    @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }

    @Override public boolean ready() {
        long now = System.nanoTime();
        if (now - readyAt < READY_CACHE_NANOS) return lastReady;
        boolean ready = engine.florenceAdmission().qualified() && engine.sidecarHealthy();
        lastReady = ready;
        readyAt = now;
        return ready;
    }

    @Override public boolean productionEligible() {
        return ready() && engine.qwenAdmission().qualified() && engine.rights().productionReady();
    }

    @Override public int priority() { return 10; }

    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }

    @Override public String processingRegion() { return "local"; }

    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }

    /**
     * Map channel used by development hosts whose job store has no durable attempt fencing. It runs the same
     * bounded, source-verified inference; a refusal or failure completes exceptionally and is never a result.
     */
    @Override
    public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
        Objects.requireNonNull(context, "context");
        return CompletableFuture.supplyAsync(() -> {
            Execution execution = execute(context, context.request().tenantId(), context.request().requestId());
            if (execution.finality() != AttemptFinality.SUCCEEDED) {
                throw new IllegalStateException("VISION job did not complete: " + execution.finality());
            }
            return execution.result();
        });
    }

    @Override
    public CompletableFuture<ProviderSubmission> processAttempt(ProcessingContext context, ProviderAttemptContext attempt) {
        Objects.requireNonNull(context, "context");
        Objects.requireNonNull(attempt, "attempt");
        return CompletableFuture.supplyAsync(() -> {
            if (!context.request().tenantId().equals(attempt.tenantId())
                    || !context.request().requestId().equals(attempt.requestId())) {
                throw new IllegalStateException("VISION attempt does not match tenant or job request");
            }
            Execution execution = execute(context, attempt.tenantId(), attempt.requestId());
            return new ProviderSubmission(execution.finality(),
                    "local-vision-op:" + attempt.jobId() + ":" + attempt.attemptNumber(),
                    "local-vision-receipt:" + attempt.jobId() + ":" + attempt.attemptNumber(),
                    execution.result(), execution.digest(), Instant.now());
        });
    }

    /** Final disposition of one inference attempt before it is wrapped for either channel. */
    private record Execution(AttemptFinality finality, Map<String, Object> result, String digest) { }

    private Execution execute(ProcessingContext context, String tenantId, String requestId) {
        var request = context.request();
        var artifact = context.artifact();
        if (request.jobType() != JobType.VISION
                || !request.tenantId().equals(artifact.tenantId())
                || !request.principalId().equals(artifact.principalId())
                || !request.artifactId().equals(artifact.artifactId())
                || !request.tenantId().equals(tenantId)
                || !request.requestId().equals(requestId)
                || request.expectedArtifactVersion().isBlank()
                || !request.expectedArtifactVersion().equals(artifact.version().value())) {
            throw new IllegalStateException("VISION attempt does not match tenant, principal, job, or pinned source version");
        }
        final Plan plan;
        try {
            plan = Plan.from(request.parameters());
        } catch (IllegalArgumentException refused) {
            return new Execution(AttemptFinality.NO_EFFECT_PROVEN, Map.of(), zeroDigest());
        }
        byte[] source;
        String sourceSha;
        try {
            ByteArrayOutputStream sink = new ByteArrayOutputStream();
            var receipt = context.copySourceContentTo(sink, MAX_SOURCE_BYTES);
            source = sink.toByteArray();
            sourceSha = sha256(source);
            if (receipt == null || !receipt.version().value().equals(request.expectedArtifactVersion())
                    || !receipt.sha256().equals(artifact.sha256()) || !receipt.sha256().equals(sourceSha)
                    || receipt.bytesCopied() != source.length) {
                throw new IllegalStateException("source receipt does not match the pinned artifact");
            }
        } catch (IOException | RuntimeException unproven) {
            throw new IllegalStateException("VISION source read could not be proven byte-exact", unproven);
        }
        byte[] image = source;
        Map<String, Object> frame = null;
        if (!LocalVisionEngine.looksLikeImage(source)) {
            if (frames == null || !artifact.contentType().toLowerCase().startsWith("video/")) {
                return new Execution(AttemptFinality.NO_EFFECT_PROVEN, Map.of(), zeroDigest());
            }
            try {
                image = frames.extractPng(source, plan.frameTimeMillis());
            } catch (IOException | RuntimeException extractionFailed) {
                return new Execution(AttemptFinality.NO_EFFECT_PROVEN, Map.of(), zeroDigest());
            }
            frame = new LinkedHashMap<>();
            frame.put("sourceVideoSha256", sourceSha);
            frame.put("timeMillis", plan.frameTimeMillis());
            frame.put("frameSha256", sha256(image));
        }
        String imageSha = sha256(image);
        try {
            Map<String, Object> result = new LinkedHashMap<>();
            if (!plan.florenceTasks().isEmpty()) {
                result.put("analysis", engine.analyze(image, imageSha, plan.florenceTasks()));
            }
            if (plan.question() != null) {
                result.put("question", engine.ask(image, imageSha, plan.question()));
            }
            if (frame != null) result.put("frame", frame);
            groundedTopLevel(result);
            result.put("sourceArtifactSha256", sourceSha);
            return new Execution(AttemptFinality.SUCCEEDED, result, imageSha);
        } catch (LocalVisionEngine.NotAdmittedException notAdmitted) {
            return new Execution(AttemptFinality.NO_EFFECT_PROVEN, Map.of(), zeroDigest());
        } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
            if (rejected.status() >= 500) {
                throw new IllegalStateException("local vision sidecar outcome is not proven", rejected);
            }
            return new Execution(AttemptFinality.FAILED, Map.of(), imageSha);
        }
        // SidecarUnavailableException and any other runtime failure propagate: OUTCOME_UNKNOWN.
    }

    /**
     * The canonical VISION result contract requires grounded top-level fields (caption, objects, labels,
     * description); the full bound documents stay nested under {@code analysis} and {@code question}.
     */
    private static void groundedTopLevel(Map<String, Object> result) {
        List<Object> models = new ArrayList<>();
        Object analysisDoc = result.remove("analysis");
        Object questionDoc = result.remove("question");
        if (analysisDoc instanceof Map<?, ?> analysis) {
            models.add(analysis.get("model"));
            result.put("input", analysis.get("input"));
            if (analysis.get("results") instanceof Map<?, ?> results) {
                if (results.get("caption") != null) result.put("caption", results.get("caption"));
                if (results.get("objects") != null) result.put("objects", results.get("objects"));
                if (results.get("sceneText") instanceof Map<?, ?> text) {
                    result.put("sceneText", text);
                    List<String> labels = new ArrayList<>();
                    if (text.get("regions") instanceof List<?> regions) {
                        for (Object region : regions) {
                            if (region instanceof Map<?, ?> m && m.get("text") != null) {
                                labels.add(String.valueOf(m.get("text")));
                            }
                        }
                    }
                    result.put("labels", labels);
                }
            }
        }
        if (questionDoc instanceof Map<?, ?> question && question.get("answer") != null) {
            models.add(question.get("model"));
            result.putIfAbsent("input", question.get("input"));
            result.put("question", question.get("question"));
            result.put("answer", question.get("answer"));
            result.put("description", question.get("answer"));
        }
        result.put("models", models);
    }

    private static String zeroDigest() { return "0".repeat(64); }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    /** Validated job parameters: which Florence tasks, an optional question, an optional frame position. */
    record Plan(Set<String> florenceTasks, String question, long frameTimeMillis) {
        static Plan from(Map<String, Object> parameters) {
            Set<String> tasks = new LinkedHashSet<>();
            Object raw = parameters.get("analysisTypes");
            if (raw != null) {
                if (!(raw instanceof List<?> types) || types.isEmpty() || types.size() > 8) {
                    throw new IllegalArgumentException("analysisTypes is invalid");
                }
                for (Object type : types) {
                    switch (String.valueOf(type)) {
                        case "OBJECT_DETECTION" -> tasks.add("detect");
                        case "OCR" -> tasks.add("ocr");
                        case "SCENE_CLASSIFICATION", "LABEL_DETECTION" -> tasks.add("caption");
                        default -> throw new IllegalArgumentException("analysis type is not supported: " + type);
                    }
                }
            }
            String question = null;
            if (parameters.get("question") instanceof String q && !q.isBlank()) question = q;
            else if (parameters.containsKey("question")) throw new IllegalArgumentException("question is invalid");
            if (tasks.isEmpty() && question == null) tasks.add("detect");
            long time = 0;
            if (parameters.get("frameTimeMs") instanceof Number n) {
                time = n.longValue();
                if (time < 0 || time > 24L * 3600 * 1000) throw new IllegalArgumentException("frameTimeMs is invalid");
            }
            return new Plan(Set.copyOf(tasks), question, time);
        }
    }

    @Override public java.util.Optional<com.ghatana.media.runtime.MediaRuntimeContracts.ProviderObservation>
            reconcileAttempt(String tenantId, String jobId, String requestId, int attemptNumber) {
        // Local inference leaves no external receipt store; an honest UNKNOWN, never an inferred result.
        return java.util.Optional.empty();
    }

    @Override public void close() { }
}
