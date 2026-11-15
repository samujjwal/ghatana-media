package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.tracking.VideoTimeline;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.InMemoryMediaHeadLedger;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Applied;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Event;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedger;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedgerFactory;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadMovedException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadState;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.LineageOwnershipException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.NothingToUndoException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.RequestReusedException;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * DEV_ONLY bounded quality optimization of a stored video (J-19 {@code media.dev.outcome-bounded-quality-improvement}).
 *
 * <p>The caller names ONE exact owner-visible video version and a target: either the smallest file whose measured
 * luma SSIM or PSNR against the source stays at or above a threshold ({@code MIN_BYTES_AT_QUALITY}), or the highest
 * measured quality whose file stays within a byte budget ({@code MAX_QUALITY_UNDER_BYTES}). The runtime runs a bounded,
 * deterministic bisection over a CRF ladder ({@link MediaDevQualitySearch}): every attempt is a REAL FFmpeg libx264
 * encode of the source (single-threaded and bit-exact so identical inputs give identical bytes; audio copied bit for
 * bit), whose decoded luma is compared frame by frame with the decoded source (pairing by exact presentation instant)
 * using the same independent Java PSNR/SSIM as the J-08 comparison. Every attempt is written to a deterministic report.
 *
 * <p>Outcomes are typed. {@code SELECTED}: the best attempt that satisfied the target becomes a NEW immutable artifact
 * version and the lineage head moves to it (an {@code APPLY} event in the append-only head ledger); the source is never
 * touched. {@code ABSTAINED}: no attempt satisfied the target inside the bounds, nothing is chosen, nothing is
 * versioned and the head does not move; a failing attempt is never presented as a success. {@code undo} appends an
 * {@code UNDO} event so the previous head (the very same immutable version) is the head again.
 *
 * <p>Rights: the source must resolve ADMITTED for PROCESSING on every call, a replay included. The derived version gets
 * no attestation of its own. Cancellation: {@link #cancel} stops a search in flight (the FFmpeg process is killed) before
 * anything is registered; once registration has begun the run is past its cancellation point.
 *
 * @doc.type class
 * @doc.purpose DEV_ONLY bounded real-encode quality search with measured report, reversible head and undo
 * @doc.layer product
 * @doc.pattern Service
 */
final class MediaDevQualityOptimizationRuntime implements AutoCloseable {
    static final String REPORT_SCHEMA = "media.dev.quality-optimization-report.v1";
    static final String VIDEO_SCHEMA = "media.dev.quality-optimized-video.v1";
    static final String REGISTERED_REPORT_SCHEMA = "media.dev.quality-optimization-report-record.v1";
    static final String KIND_REPORT = "QUALITY_OPTIMIZATION_REPORT";
    static final String KIND_VIDEO = "QUALITY_OPTIMIZED_VIDEO";
    static final String LANE = "quality.optimize";
    static final int MAX_ATTEMPTS = 8;
    static final int CRF_FLOOR = 12;
    static final int CRF_CEILING = 45;
    static final int DEFAULT_CRF_MIN = 16;
    static final int DEFAULT_CRF_MAX = 40;
    static final int DEFAULT_ATTEMPTS = 6;
    static final long MIN_BYTE_BUDGET = 4_096L;
    private static final Duration AUDIO_TIMEOUT = Duration.ofMinutes(2);
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    // ------------------------------------------------------------------ requests and results

    enum Metric {
        SSIM("ssim", 0.5, 0.9999), PSNR("psnr", 20.0, 80.0);

        final String wire;
        final double min;
        final double max;

        Metric(String wire, double min, double max) { this.wire = wire; this.min = min; this.max = max; }

        static Metric parse(String text) {
            for (Metric metric : values()) if (metric.wire.equals(text)) return metric;
            throw parameter("target.metric", "target.metric must be ssim or psnr");
        }
    }

    /** Declared target; exactly one of {@code minQuality} / {@code maxBytes} is meaningful per goal. */
    record Target(MediaDevQualitySearch.Goal goal, Metric metric, double minQuality, long maxBytes) {
        Target {
            Objects.requireNonNull(goal, "goal");
            Objects.requireNonNull(metric, "metric");
            if (goal == MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY) {
                if (!Double.isFinite(minQuality) || minQuality < metric.min || minQuality > metric.max) {
                    throw parameter("target.minQuality", "target.minQuality for " + metric.wire + " must be within ["
                            + metric.min + ", " + metric.max + "]");
                }
            } else if (maxBytes < MIN_BYTE_BUDGET || maxBytes > MediaDevVideoRuntime.MAX_OUTPUT_BYTES) {
                throw parameter("target.maxBytes", "target.maxBytes must be within [" + MIN_BYTE_BUDGET + ", "
                        + MediaDevVideoRuntime.MAX_OUTPUT_BYTES + "]");
            }
        }

        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("type", goal.name());
            view.put("metric", metric.wire);
            if (goal == MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY) view.put("minQuality", minQuality);
            else view.put("maxBytes", maxBytes);
            return view;
        }
    }

    record OptimizeRequest(String requestId, String lineageId, String artifactId, String artifactVersionId,
                           Target target, int crfMin, int crfMax, int maxAttempts) {
        OptimizeRequest {
            requestId = shortId(requestId, "requestId");
            lineageId = shortId(lineageId, "lineageId");
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            Objects.requireNonNull(target, "target");
            if (crfMin < CRF_FLOOR || crfMax > CRF_CEILING || crfMin > crfMax) {
                throw parameter("search.crf", "search.crfMin and search.crfMax must satisfy " + CRF_FLOOR
                        + " <= crfMin <= crfMax <= " + CRF_CEILING);
            }
            if (maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
                throw parameter("search.maxAttempts", "search.maxAttempts must be within [1, " + MAX_ATTEMPTS + "]");
            }
        }
    }

    /** Durable view of one optimization: the report, the chosen version (when SELECTED) and the head event. */
    record QualityResult(MediaArtifact report, Map<String, Object> reportLineage, Map<String, Object> document,
                         MediaArtifact chosen, Map<String, Object> chosenLineage, Event applied, boolean replayed,
                         Resolution admission) implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
        boolean selected() { return chosen != null; }
    }

    record LineageView(String lineageId, List<Event> events, HeadState state) { }

    record UndoResult(Event undone, Event head, boolean replayed, HeadState state) { }

    static final class QualityParameterException extends IllegalArgumentException {
        private final String parameter;
        QualityParameterException(String parameter, String message) { super(message); this.parameter = parameter; }
        String code() { return "QUALITY_PARAMETER_OUT_OF_RANGE"; }
        String parameter() { return parameter; }
    }

    static final class QualityRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;
        QualityRefusedException(int status, String code, String message) { this(status, code, message, Map.of()); }
        QualityRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    /** The search was cancelled before anything was registered. */
    static final class QualityCancelledException extends RuntimeException {
        QualityCancelledException() { super("the optimization was cancelled before anything was registered", null, false, false); }
    }

    private static QualityParameterException parameter(String name, String message) {
        return new QualityParameterException(name, message);
    }

    private static String shortId(String value, String field) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,99}")) {
            throw parameter(field, field + " must be a 1-100 character opaque id");
        }
        return value;
    }

    // ------------------------------------------------------------------ composition

    /** One in-flight search: RUNNING, CANCELLED (stop requested) or COMMITTING (registration has begun). */
    private static final class Run {
        static final int RUNNING = 0;
        static final int CANCELLED = 1;
        static final int COMMITTING = 2;
        final BoundedProcessRunner.CancellationSource token = new BoundedProcessRunner.CancellationSource();
        final AtomicInteger state = new AtomicInteger(RUNNING);

        boolean cancel() {
            if (state.compareAndSet(RUNNING, CANCELLED)) {
                token.cancel();
                return true;
            }
            return state.get() == CANCELLED;
        }

        boolean cancelled() { return state.get() == CANCELLED; }

        boolean commit() { return state.compareAndSet(RUNNING, COMMITTING); }
    }

    private final MediaDevVideoRuntime video;
    private final MediaRuntime runtime;
    private final MediaDevRequestLedger ledger;
    private final HeadLedger heads;
    private final Map<String, Run> inflight = new ConcurrentHashMap<>();

    MediaDevQualityOptimizationRuntime(MediaDevVideoRuntime video, MediaDevRequestLedger ledger, HeadLedger heads) {
        this.video = Objects.requireNonNull(video, "video");
        this.runtime = video.mediaRuntime();
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.heads = Objects.requireNonNull(heads, "heads");
    }

    /**
     * Null when no absolute FFmpeg/FFprobe pair is configured. The head ledger is durable (PostgreSQL V041) exactly when
     * the request ledger is; otherwise it is a process-local ledger that is explicitly non-durable.
     */
    static MediaDevQualityOptimizationRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                                      RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        MediaDevVideoRuntime video = MediaDevVideoRuntime.compose(runtime, environment, rights, ledger);
        if (video == null) return null;
        HeadLedger heads = ledger.durable() ? openPostgresql(environment) : new InMemoryMediaHeadLedger();
        return new MediaDevQualityOptimizationRuntime(video, ledger, heads);
    }

    private static HeadLedger openPostgresql(Map<String, String> environment) {
        List<HeadLedgerFactory> factories = ServiceLoader.load(HeadLedgerFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-head-ledger".equals(factory.factoryId())).toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY head ledger factory is required");
        }
        return factories.getFirst().createDevOnly(Map.copyOf(environment));
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("optimization", true);
        out.put("goals", List.of(MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY.name(),
                MediaDevQualitySearch.Goal.MAX_QUALITY_UNDER_BYTES.name()));
        out.put("metrics", List.of(Metric.SSIM.wire, Metric.PSNR.wire));
        out.put("bounds", Map.of("maxAttempts", MAX_ATTEMPTS, "crfFloor", CRF_FLOOR, "crfCeiling", CRF_CEILING,
                "maxFrames", MediaDevVideoRuntime.MAX_COMPARE_FRAMES, "maxPixels", MediaDevVideoRuntime.MAX_COMPARE_PIXELS));
        out.put("headLedger", Map.of("ledgerId", heads.ledgerId(), "ready", heads.ready(),
                "durable", ledger.durable()));
        out.put("scope", "DEV_ONLY");
        return out;
    }

    // ------------------------------------------------------------------ read

    /** Reopens a registered report (with its parsed document) for its owner, or empty. */
    Optional<QualityResult> reopenReport(String tenantId, String principalId, String reportArtifactId) {
        Optional<MediaArtifact> found = runtime.artifact(tenantId, principalId, reportArtifactId)
                .filter(artifact -> REPORT_SCHEMA.equals(artifact.metadata().get("videoSchema")));
        if (found.isEmpty()) return Optional.empty();
        MediaArtifact report = found.get();
        Map<String, Object> lineage = lineageOf(report);
        Map<String, Object> document = readDocument(tenantId, principalId, report);
        MediaArtifact chosen = null;
        Map<String, Object> chosenLineage = Map.of();
        if (lineage.get("chosenOutput") instanceof Map<?, ?> ref && ref.get("artifactId") instanceof String id) {
            Optional<MediaArtifact> output = runtime.artifact(tenantId, principalId, id)
                    .filter(artifact -> VIDEO_SCHEMA.equals(artifact.metadata().get("videoSchema")));
            if (output.isPresent()) {
                chosen = output.get();
                chosenLineage = lineageOf(chosen);
            }
        }
        return Optional.of(new QualityResult(report, lineage, document, chosen, chosenLineage, null, true, null));
    }

    private Map<String, Object> readDocument(String tenantId, String principalId, MediaArtifact report) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            runtime.copyArtifactContent(tenantId, principalId, report.artifactId(), report.version(), out, 4L << 20)
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            Map<String, Object> record = JSON.readValue(out.toByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { });
            if (!(record.get("report") instanceof Map<?, ?> inner)) throw new IllegalStateException("not a report record");
            Map<String, Object> document = new LinkedHashMap<>();
            inner.forEach((k, v) -> document.put(String.valueOf(k), v));
            return document;
        } catch (IOException | RuntimeException failure) {
            throw MediaDevRequestLedger.outputUnavailable(LANE);
        }
    }

    private static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>(artifact.metadata());
        lineage.remove("purpose");
        return lineage;
    }

    Optional<LineageView> lineage(String tenantId, String principalId, String lineageId) {
        List<Event> events = readEvents(tenantId, principalId, lineageId);
        return events.isEmpty() ? Optional.empty()
                : Optional.of(new LineageView(lineageId, events, HeadState.of(events)));
    }

    private List<Event> readEvents(String tenantId, String principalId, String lineageId) {
        try {
            return heads.events(tenantId, principalId, lineageId);
        } catch (IllegalStateException failure) {
            throw new QualityRefusedException(503, "HEAD_LEDGER_UNAVAILABLE",
                    "the head ledger could not be read; nothing was changed");
        }
    }

    // ------------------------------------------------------------------ cancellation

    /** True when the search for this requestId was running (or already cancelled) in this process. */
    boolean cancel(String tenantId, String principalId, String requestId) {
        Run run = inflight.get(runKey(tenantId, principalId, requestId));
        if (run == null) return false;
        if (!run.cancel()) {
            throw new QualityRefusedException(409, "OPTIMIZATION_PAST_CANCELLATION_POINT",
                    "the search finished and registration has begun; it can no longer be cancelled "
                            + "(use undo to move the head back)");
        }
        return true;
    }

    private static String runKey(String tenantId, String principalId, String requestId) {
        return tenantId + "\u0000" + principalId + "\u0000" + requestId;
    }

    // ------------------------------------------------------------------ optimize

    QualityResult optimize(String tenantId, String principalId, OptimizeRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "quality_optimize", tenantId,
                () -> execute(tenantId, principalId, request));
    }

    private QualityResult execute(String tenantId, String principalId, OptimizeRequest request) {
        MediaArtifact source = video.source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        Resolution resolution = video.admit(tenantId, source);
        MediaDevVideoRuntime.requireVideo(source);
        if (source.sizeBytes() > MediaDevVideoRuntime.MAX_SOURCE_BYTES) {
            throw new QualityRefusedException(422, "VIDEO_LIMIT_EXCEEDED", "the source exceeds the byte ceiling");
        }
        Target target = request.target();
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.quality.optimize.v1", request.lineageId(),
                source.artifactId(), source.version().value(), source.sha256(), target.goal(), target.metric(),
                target.goal() == MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY ? target.minQuality() : target.maxBytes(),
                request.crfMin(), request.crfMax(), request.maxAttempts());
        return ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, request, outputs, resolution),
                () -> produce(tenantId, principalId, request, source, resolution),
                result -> {
                    List<OutputRef> refs = new ArrayList<>();
                    refs.add(new OutputRef("result", result.report().artifactId(), result.report().version().value()));
                    if (result.chosen() != null) {
                        refs.add(new OutputRef("chosen", result.chosen().artifactId(), result.chosen().version().value()));
                    }
                    return refs;
                },
                MediaDevVideoRuntime.VideoRequestReusedException::new);
    }

    private QualityResult replay(String tenantId, String principalId, OptimizeRequest request, List<OutputRef> outputs,
                                 Resolution resolution) {
        OutputRef reportRef = outputs.getFirst();
        QualityResult found = reopenReport(tenantId, principalId, reportRef.artifactId())
                .filter(r -> r.report().version().value().equals(reportRef.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
        Event applied = null;
        if (found.chosen() != null) {
            applied = readEvents(tenantId, principalId, request.lineageId()).stream()
                    .filter(e -> e.kind() == Kind.APPLY && e.requestId().equals(request.requestId())).findFirst()
                    .orElse(null);
        }
        return new QualityResult(found.report(), found.reportLineage(), found.document(), found.chosen(),
                found.chosenLineage(), applied, true, resolution);
    }

    /** One finished attempt held on disk until the search ends. */
    private record Attempt(int index, int crf, long bytes, String sha256, Path file, Map<String, Object> view,
                           MediaDevQualitySearch.Candidate candidate, MediaDevVideoRuntime.Probe probe) { }

    private QualityResult produce(String tenantId, String principalId, OptimizeRequest request, MediaArtifact source,
                                  Resolution resolution) {
        Run run = new Run();
        String key = runKey(tenantId, principalId, request.requestId());
        if (inflight.putIfAbsent(key, run) != null) {
            throw new QualityRefusedException(409, "REQUEST_IN_PROGRESS",
                    "the same requestId is already searching in this process; retry the same requestId");
        }
        Path dir = MediaDevVideoRuntime.privateTempDirectory();
        try {
            return search(tenantId, principalId, request, source, resolution, run, dir);
        } catch (MediaDevVideoRuntime.VideoOutcomeUnknownException unknown) {
            if (run.cancelled()) throw new QualityCancelledException();
            throw unknown;
        } catch (IOException failure) {
            throw new MediaDevVideoRuntime.VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered");
        } finally {
            inflight.remove(key, run);
            MediaDevVideoRuntime.deleteTree(dir);
        }
    }

    private QualityResult search(String tenantId, String principalId, OptimizeRequest request, MediaArtifact source,
                                 Resolution resolution, Run run, Path dir) throws IOException {
        headPrecheck(tenantId, principalId, request, source);
        Path in = dir.resolve("source.bin");
        video.stage(tenantId, principalId, source, in);
        MediaDevVideoRuntime.Probe before = video.probe(in, dir, MediaDevVideoRuntime.MAX_COMPARE_PIXELS,
                MediaDevVideoRuntime.MAX_COMPARE_FRAMES, run.token);
        MediaDevVideoRuntime.Decoded reference = video.decodeLuma(in, before, dir, "source", run.token);
        Target target = request.target();
        String comment = containerComment(tenantId, principalId, request.requestId());
        MediaDevQualitySearch ladder = new MediaDevQualitySearch(target.goal(), request.crfMin(), request.crfMax(),
                request.maxAttempts());
        List<Attempt> attempts = new ArrayList<>();
        while (!ladder.done()) {
            if (run.cancelled()) throw new QualityCancelledException();
            int crf = ladder.next();
            Attempt attempt = attempt(source, before, reference, in, dir, request, crf, attempts.size() + 1, run, comment);
            attempts.add(attempt);
            ladder.record(crf, attempt.candidate().feasible());
        }
        if (run.cancelled()) throw new QualityCancelledException();
        Optional<MediaDevQualitySearch.Candidate> best = MediaDevQualitySearch.choose(target.goal(),
                attempts.stream().map(Attempt::candidate).toList());
        Attempt chosen = best.map(c -> attempts.get(c.index() - 1)).orElse(null);
        Map<String, Object> audio = null;
        if (chosen != null) audio = verifyAudio(in, chosen, before, dir, run);
        Map<String, Object> document = document(source, before, request, attempts, chosen, ladder.stopReason(), audio);
        if (!run.commit()) throw new QualityCancelledException();
        return register(tenantId, principalId, request, source, resolution, chosen, document);
    }

    /** The lineage head (when the lineage exists) must be the named source; checked before any process runs. */
    private void headPrecheck(String tenantId, String principalId, OptimizeRequest request, MediaArtifact source) {
        List<Event> log = readEvents(tenantId, principalId, request.lineageId());
        if (log.isEmpty()) return;
        Event head = HeadState.of(log).head().orElseThrow();
        if (!head.artifactVersionId().equals(source.version().value())) throw headMoved(head);
    }

    private static QualityRefusedException headMoved(Event head) {
        return new QualityRefusedException(409, "LINEAGE_HEAD_MOVED",
                "the lineage head is not the named source version; optimize the current head or undo",
                Map.of("head", eventView(head)));
    }

    // ------------------------------------------------------------------ one attempt

    private Attempt attempt(MediaArtifact source, MediaDevVideoRuntime.Probe before,
                            MediaDevVideoRuntime.Decoded reference, Path in, Path dir, OptimizeRequest request, int crf,
                            int index, Run run, String comment) throws IOException {
        Path out = dir.resolve("attempt-" + index + ".mp4");
        List<String> command = new ArrayList<>(List.of(video.ffmpegPath().toString(), "-nostdin", "-hide_banner", "-v",
                "error", "-xerror", "-i", in.toString(), "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
                "-c:v", "libx264", "-preset", "medium", "-crf", Integer.toString(crf), "-pix_fmt", "yuv420p",
                "-threads", "1", "-fps_mode", "passthrough", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                "-map_metadata", "-1", "-metadata", "comment=" + comment, "-c:a", "copy"));
        if (before.timeBaseNum == 1) {
            command.addAll(List.of("-video_track_timescale", Long.toString(before.timeBaseDen)));
        }
        command.addAll(List.of("-y", out.toString()));
        BoundedProcessRunner.Result result = video.runProcess(command, dir, video.encodeTimeout(), 1024, out,
                MediaDevVideoRuntime.MAX_OUTPUT_BYTES, "encode", run.token);
        if (result.end() == BoundedProcessRunner.End.WATCHED_FILE_TOO_LARGE) {
            throw new MediaDevVideoRuntime.VideoRefusedException(422, "VIDEO_OUTPUT_LIMIT_EXCEEDED",
                    "an attempt would exceed the output byte ceiling");
        }
        MediaDevVideoRuntime.classify(result, "encode", "VIDEO_ENCODE_FAILED");
        MediaDevVideoRuntime.Probe after = video.probe(out, dir, MediaDevVideoRuntime.MAX_COMPARE_PIXELS,
                MediaDevVideoRuntime.MAX_COMPARE_FRAMES, run.token);
        requireSameTimeline(before, after);
        MediaDevVideoRuntime.Decoded decoded = video.decodeLuma(out, after, dir, "attempt-" + index, run.token);
        Measured measured = measure(before, reference, decoded);
        Files.deleteIfExists(decoded.raw());
        long bytes = Files.size(out);
        String sha = MediaDevProjectRenderRuntime.sha256Hex(Files.readAllBytes(out));
        String streamSha = videoStreamSha256(out, dir, run);
        Target target = request.target();
        double quality = target.metric() == Metric.SSIM ? measured.meanSsim : measured.globalPsnr;
        boolean feasible;
        String verdict;
        if (target.goal() == MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY) {
            if (quality < target.minQuality()) { feasible = false; verdict = "BELOW_QUALITY_TARGET"; }
            else if (bytes >= source.sizeBytes()) { feasible = false; verdict = "NOT_SMALLER_THAN_SOURCE"; }
            else { feasible = true; verdict = "MEETS_TARGET"; }
        } else if (bytes > target.maxBytes()) {
            feasible = false;
            verdict = "OVER_BYTE_BUDGET";
        } else {
            feasible = true;
            verdict = "MEETS_TARGET";
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("attempt", index);
        view.put("crf", crf);
        view.put("bytes", bytes);
        view.put("sizeRatioVsSource", MediaDevVideoRuntime.round6(bytes / (double) source.sizeBytes()));
        view.put("videoStreamSha256", streamSha);
        view.put("alignedFrames", measured.frames);
        view.put("meanPsnrY", measured.meanPsnr);
        view.put("globalPsnrY", measured.globalPsnr);
        view.put("minPsnrY", measured.minPsnr);
        view.put("meanSsimY", measured.meanSsim);
        view.put("minSsimY", measured.minSsim);
        view.put("identicalFrames", measured.identical);
        view.put("qualityMetric", target.metric().wire);
        view.put("qualityValue", quality);
        view.put("feasible", feasible);
        view.put("verdict", verdict);
        return new Attempt(index, crf, bytes, sha, out, view,
                new MediaDevQualitySearch.Candidate(index, crf, bytes, quality, feasible), after);
    }

    /**
     * A fixed-length per-request container comment. The artifact store keys identical bytes to one governed identity
     * (file name, metadata, retention within a minute), so two requests that choose the very same encode would otherwise
     * collide; the comment makes every registered file unique to its request without changing a single video packet.
     */
    static String containerComment(String tenantId, String principalId, String requestId) {
        return "media-dev-quality " + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId).substring(0, 32);
    }

    /** SHA-256 of the encoded video packets only (container and comment excluded): identical for identical encodes. */
    private String videoStreamSha256(Path file, Path dir, Run run) throws IOException {
        BoundedProcessRunner.Result result = video.runProcess(List.of(video.ffmpegPath().toString(), "-nostdin",
                "-hide_banner", "-v", "error", "-i", file.toString(), "-map", "0:v:0", "-c", "copy", "-f", "hash",
                "-hash", "sha256", "-"), dir, AUDIO_TIMEOUT, 4096, null, 0, "stream hash", run.token);
        MediaDevVideoRuntime.classify(result, "stream hash", "VIDEO_ENCODE_FAILED");
        String text = new String(result.stdout(), StandardCharsets.US_ASCII).trim();
        if (!text.startsWith("SHA256=") || text.length() != 71) {
            throw new MediaDevVideoRuntime.VideoRefusedException(422, "VIDEO_ENCODE_FAILED",
                    "the encoded video packets could not be hashed; nothing was registered");
        }
        return text.substring(7);
    }

    private static void requireSameTimeline(MediaDevVideoRuntime.Probe before, MediaDevVideoRuntime.Probe after) {
        List<VideoTimeline.FrameTime> a = before.timeline.frames();
        List<VideoTimeline.FrameTime> b = after.timeline.frames();
        boolean same = before.width == after.width && before.height == after.height && a.size() == b.size();
        for (int i = 0; same && i < a.size(); i++) {
            same = MediaDevVideoRuntime.instantKey(a.get(i).pts(), before)
                    .equals(MediaDevVideoRuntime.instantKey(b.get(i).pts(), after));
        }
        if (!same) {
            throw new MediaDevVideoRuntime.VideoRefusedException(422, "OPTIMIZATION_TIMELINE_MISMATCH",
                    "an encoded attempt does not keep the source frame count, geometry and presentation instants; "
                            + "nothing was registered");
        }
    }

    private record Measured(int frames, double meanPsnr, double globalPsnr, double minPsnr, double meanSsim,
                            double minSsim, int identical) { }

    /** Per-frame luma PSNR/SSIM of the attempt against the source, frames paired by index (timeline already verified). */
    private static Measured measure(MediaDevVideoRuntime.Probe probe, MediaDevVideoRuntime.Decoded reference,
                                    MediaDevVideoRuntime.Decoded attempt) throws IOException {
        int frameBytes = probe.width * probe.height;
        int count = probe.timeline.frames().size();
        byte[] a = new byte[frameBytes];
        byte[] b = new byte[frameBytes];
        double psnrSum = 0, ssimSum = 0, mseSum = 0, psnrMin = Double.MAX_VALUE, ssimMin = Double.MAX_VALUE;
        int identical = 0;
        try (RandomAccessFile left = new RandomAccessFile(reference.raw().toFile(), "r");
             RandomAccessFile right = new RandomAccessFile(attempt.raw().toFile(), "r")) {
            for (int i = 0; i < count; i++) {
                left.readFully(a);
                right.readFully(b);
                double mse = MediaDevVideoQualityMetrics.mse(a, b, frameBytes);
                double psnr = MediaDevVideoQualityMetrics.psnrFromMse(mse);
                double ssim = MediaDevVideoQualityMetrics.ssim(a, b, probe.width, probe.height);
                if (mse == 0) identical++;
                mseSum += mse;
                psnrSum += psnr;
                ssimSum += ssim;
                psnrMin = Math.min(psnrMin, psnr);
                ssimMin = Math.min(ssimMin, ssim);
            }
        }
        return new Measured(count, MediaDevVideoRuntime.round(psnrSum / count),
                MediaDevVideoRuntime.round(MediaDevVideoQualityMetrics.psnrFromMse(mseSum / count)),
                MediaDevVideoRuntime.round(psnrMin), MediaDevVideoRuntime.round6(ssimSum / count),
                MediaDevVideoRuntime.round6(ssimMin), identical);
    }

    private Map<String, Object> verifyAudio(Path in, Attempt chosen, MediaDevVideoRuntime.Probe before, Path dir,
                                            Run run) throws IOException {
        return video.verifyAudio(in, chosen.file(), before, chosen.probe(), dir);
    }

    // ------------------------------------------------------------------ report and registration

    private Map<String, Object> document(MediaArtifact source, MediaDevVideoRuntime.Probe before, OptimizeRequest request,
                                         List<Attempt> attempts, Attempt chosen, MediaDevQualitySearch.StopReason stop,
                                         Map<String, Object> audio) {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", REPORT_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("kind", KIND_REPORT);
        Map<String, Object> method = new LinkedHashMap<>();
        method.put("metrics", "mean luma SSIM (8x8 windows, stride 4) and global luma PSNR (10*log10(255^2/mean MSE), "
                + "identical frames capped at 100 dB) of the DECODED attempt against the DECODED source, frames paired by "
                + "exact presentation instant; independent of FFmpeg's psnr/ssim filters");
        method.put("search", "deterministic bisection over the integer CRF range; each attempt is a real encode; the "
                + "chosen attempt is always a measured attempt that satisfied the target");
        method.put("encoder", ordered("videoCodec", "libx264", "preset", "medium", "pixelFormat", "yuv420p",
                "threads", 1, "bitexact", true, "container", "mp4", "audio", "COPY",
                "frameRateMode", "PASSTHROUGH_SOURCE_PTS",
                "containerComment", "fixed-length per-request digest written to the MP4 comment so identical encodes of two "
                        + "requests are distinct stored files; the video packets, and so every number here, are unaffected"));
        method.put("tools", ordered("ffmpeg", video.ffmpegVersion()));
        document.put("method", method);
        Map<String, Object> src = new LinkedHashMap<>();
        src.put("artifactId", source.artifactId());
        src.put("artifactVersionId", source.version().value());
        src.put("sha256", source.sha256());
        src.put("sizeBytes", source.sizeBytes());
        src.put("width", before.width);
        src.put("height", before.height);
        src.put("frameCount", before.timeline.frames().size());
        src.put("timeBase", before.timeBaseNum + "/" + before.timeBaseDen);
        document.put("source", src);
        document.put("target", request.target().view());
        Map<String, Object> bounds = new LinkedHashMap<>();
        bounds.put("crfMin", request.crfMin());
        bounds.put("crfMax", request.crfMax());
        bounds.put("maxAttempts", request.maxAttempts());
        document.put("bounds", bounds);
        document.put("feasibility", request.target().goal() == MediaDevQualitySearch.Goal.MIN_BYTES_AT_QUALITY
                ? "an attempt is feasible when its " + request.target().metric().wire
                        + " is at least the target and its file is smaller than the source; the smallest feasible file "
                        + "(then the lowest CRF) is chosen"
                : "an attempt is feasible when its file is within the byte budget; the feasible attempt with the highest "
                        + request.target().metric().wire + " (then the fewest bytes, then the lowest CRF) is chosen");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Attempt attempt : attempts) rows.add(attempt.view());
        document.put("attempts", rows);
        document.put("stopReason", stop.name());
        document.put("outcome", chosen == null ? "ABSTAINED" : "SELECTED");
        document.put("chosenAttempt", chosen == null ? null : chosen.index());
        document.put("abstainReason", chosen == null ? "NO_ATTEMPT_MET_TARGET" : null);
        if (audio != null) document.put("audio", audio);
        document.put("claims", ordered("quality", "MEASURED_LUMA_ONLY",
                "note", "Luma SSIM/PSNR of real encodes against the decoded source; not perceptual, rights, approval "
                        + "or production claims. A bounded search proves nothing about untried CRFs."));
        return document;
    }

    /**
     * Insertion-ordered map for the report document. {@code Map.of} iterates in an order that is randomised per JVM, which
     * would make the same report serialize to different bytes after a launcher restart.
     */
    private static Map<String, Object> ordered(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) map.put((String) keyValues[i], keyValues[i + 1]);
        return map;
    }

    private QualityResult register(String tenantId, String principalId, OptimizeRequest request, MediaArtifact source,
                                   Resolution resolution, Attempt chosen, Map<String, Object> document) {
        MediaArtifact chosenArtifact = null;
        Map<String, Object> chosenLineage = Map.of();
        if (chosen != null) {
            byte[] bytes;
            try {
                bytes = Files.readAllBytes(chosen.file());
            } catch (IOException failure) {
                throw new MediaDevVideoRuntime.VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                        "the chosen attempt could not be read; nothing was registered");
            }
            Map<String, Object> lineage = MediaDevVideoRuntime.baseLineage(VIDEO_SCHEMA, KIND_VIDEO,
                    request.requestId(), resolution, bytes);
            lineage.put("source", MediaDevVideoRuntime.sourceRef(source));
            lineage.put("optimization", Map.of("target", request.target().view(), "attempt", chosen.index(),
                    "crf", chosen.crf(), "measured", chosen.view()));
            lineage.put("encoder", Map.of("videoCodec", "libx264", "preset", "medium", "crf", chosen.crf(),
                    "pixelFormat", "yuv420p", "threads", 1, "audio", "COPY"));
            lineage.put("claims", Map.of("quality", "MEASURED_LUMA_ONLY"));
            lineage.put("containerComment", containerComment(tenantId, principalId, request.requestId()));
            MediaDevVideoRuntime.VideoResult registered = video.register(tenantId, principalId,
                    "optimized-" + MediaDevVideoRuntime.shortHash(request.requestId()) + ".mp4", "video/mp4",
                    KIND_VIDEO, request.requestId(), bytes, lineage, resolution);
            chosenArtifact = registered.artifact();
            chosenLineage = registered.lineage();
        }
        String reportSha256 = MediaDevProjectRenderRuntime.sha256Hex(MediaDevVideoRuntime.jsonBytes(document));
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("schema", REGISTERED_REPORT_SCHEMA);
        record.put("requestId", request.requestId());
        record.put("reportSha256", reportSha256);
        record.put("report", document);
        byte[] reportBytes = MediaDevVideoRuntime.jsonBytes(record);
        Map<String, Object> lineage = MediaDevVideoRuntime.baseLineage(REPORT_SCHEMA, KIND_REPORT, request.requestId(),
                resolution, reportBytes);
        lineage.put("reportSha256", reportSha256);
        lineage.put("source", MediaDevVideoRuntime.sourceRef(source));
        lineage.put("target", request.target().view());
        lineage.put("outcome", document.get("outcome"));
        lineage.put("attemptCount", ((List<?>) document.get("attempts")).size());
        lineage.put("lineageId", request.lineageId());
        if (chosenArtifact != null) {
            lineage.put("chosenOutput", MediaDevVideoRuntime.sourceRef(chosenArtifact));
            lineage.put("chosenAttempt", document.get("chosenAttempt"));
        }
        lineage.put("claims", Map.of("quality", "MEASURED_LUMA_ONLY"));
        MediaDevVideoRuntime.VideoResult report = video.register(tenantId, principalId,
                "quality-report-" + MediaDevVideoRuntime.shortHash(request.requestId()) + ".json", "application/json",
                KIND_REPORT, request.requestId(), reportBytes, lineage, resolution);
        Event applied = null;
        if (chosenArtifact != null) applied = applyHead(tenantId, principalId, request, source, chosenArtifact,
                report.artifact());
        return new QualityResult(report.artifact(), report.lineage(), document, chosenArtifact, chosenLineage, applied,
                false, resolution);
    }

    private Event applyHead(String tenantId, String principalId, OptimizeRequest request, MediaArtifact source,
                            MediaArtifact chosen, MediaArtifact report) {
        try {
            Applied applied = heads.apply(tenantId, principalId, request.lineageId(), request.requestId(),
                    source.artifactId(), source.version().value(), chosen.artifactId(), chosen.version().value(),
                    report.artifactId());
            return applied.event();
        } catch (HeadMovedException moved) {
            throw headMoved(moved.head());
        } catch (LineageOwnershipException concealed) {
            throw new QualityRefusedException(404, "QUALITY_LINEAGE_NOT_FOUND", "No such lineage for this principal");
        } catch (RequestReusedException reused) {
            throw new MediaDevVideoRuntime.VideoRequestReusedException();
        } catch (IllegalStateException failure) {
            throw new QualityRefusedException(503, "HEAD_LEDGER_UNAVAILABLE",
                    "the head ledger could not be updated; retry the same requestId to resume");
        }
    }

    // ------------------------------------------------------------------ undo

    /**
     * Restores the previous head. The version being restored must still be readable by the principal and match its
     * recorded digest, so the head can never point at content that is gone.
     */
    UndoResult undo(String tenantId, String principalId, String lineageId, String requestId,
                    String expectedHeadVersionId) {
        shortId(lineageId, "lineageId");
        shortId(requestId, "requestId");
        List<Event> log = readEvents(tenantId, principalId, lineageId);
        if (log.isEmpty()) throw new QualityRefusedException(404, "QUALITY_LINEAGE_NOT_FOUND", "No such lineage for this principal");
        boolean recorded = log.stream().anyMatch(e -> e.requestId().equals(requestId));
        if (!recorded) {
            HeadState state = HeadState.of(log);
            if (state.undoable()) {
                Event previous = state.stack().get(state.stack().size() - 2);
                boolean readable = runtime.artifact(tenantId, principalId, previous.artifactId())
                        .filter(a -> a.version().value().equals(previous.artifactVersionId())).isPresent();
                if (!readable) {
                    throw new QualityRefusedException(409, "HEAD_VERSION_UNAVAILABLE",
                            "the version that undo would restore is no longer readable; the head was not changed",
                            Map.of("version", eventView(previous)));
                }
            }
        }
        try {
            Applied applied = heads.undo(tenantId, principalId, lineageId, requestId, expectedHeadVersionId);
            Event event = applied.event();
            Event restored = applied.state().head().orElseThrow();
            Event removed = log.stream().filter(e -> e.seq() == event.undoesSeq()).findFirst().orElse(null);
            return new UndoResult(removed, restored, applied.replayed(), applied.state());
        } catch (HeadMovedException moved) {
            throw headMoved(moved.head());
        } catch (NothingToUndoException nothing) {
            throw new QualityRefusedException(409, "NOTHING_TO_UNDO",
                    "the lineage head is the original source version; there is nothing to undo");
        } catch (LineageOwnershipException concealed) {
            throw new QualityRefusedException(404, "QUALITY_LINEAGE_NOT_FOUND", "No such lineage for this principal");
        } catch (RequestReusedException reused) {
            throw new QualityRefusedException(409, "QUALITY_REQUEST_ID_REUSED",
                    "requestId was already used for a different head operation");
        } catch (IllegalStateException failure) {
            throw new QualityRefusedException(503, "HEAD_LEDGER_UNAVAILABLE",
                    "the head ledger could not be updated; retry the same requestId");
        }
    }

    static Map<String, Object> eventView(Event event) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("seq", event.seq());
        view.put("kind", event.kind().name());
        view.put("requestId", event.requestId());
        view.put("artifactId", event.artifactId());
        view.put("artifactVersionId", event.artifactVersionId());
        if (event.reportArtifactId() != null) view.put("reportArtifactId", event.reportArtifactId());
        if (event.undoesSeq() != null) view.put("undoesSeq", event.undoesSeq());
        view.put("createdAt", event.createdAt().toString());
        return view;
    }

    @Override public void close() {
        heads.close();
    }
}
