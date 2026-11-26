package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevCompositePlan.CaptionMode;
import com.ghatana.media.launcher.MediaDevCompositePlan.Planned;
import com.ghatana.media.launcher.MediaDevCompositePlan.Spec;
import com.ghatana.media.launcher.MediaDevCompositePlan.Timed;
import com.ghatana.media.launcher.MediaDevSpeechRuntime.SpeechRefusedException;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Track;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY multitrack composite render (journey J-18, {@code media.dev.outcome-multitrack-finished-master}): one exact
 * immutable project revision is rendered by real FFmpeg into one MP4 (H.264 + AAC, optional mov_text subtitle track)
 * from real VIDEO clips (trimmed, placed, conformed to the output frame rate and geometry), AUDIO clips with per-clip
 * gain and exact placement, WebVTT captions (muxed and/or burned), PNG overlay graphics with position and opacity, and
 * a colour adjustment, registered as an immutable artifact whose {@code sources[]} lineage names every exact source
 * version (so erasure follows it).
 *
 * <p>Truthfulness and safety: every source needs a current ADMITTED PROCESSING rights decision (never self-approved);
 * nothing is retimed, resampled or rounded silently; the produced file is probed and refused unless frame count, codecs,
 * geometry, frame rate and duration match the plan; a cancelled, timed-out, killed or over-budget render registers
 * nothing and leaves no process or temp file behind (a launcher that is killed mid-render leaves an orphan that the next
 * start sweeps). Idempotency comes from the durable request ledger plus the canonical upload idempotency key. A video
 * clip's embedded audio is not used: sound comes only from explicit AUDIO-track clips.
 *
 * <p>Peak protection: the AUDIO tracks are summed to float PCM in a separate FFmpeg pass and measured with the J-17 master
 * DSP ({@link MediaDevMasterDsp}, 8x oversampled true peak). Policy LIMIT (default) caps that sum with the master peak
 * guard at {@code truePeakCeilingDbtp} before it is encoded; REFUSE returns a typed 422 {@code COMPOSITE_AUDIO_CLIPS}
 * instead. The pre- and post-limit true peaks and the gain reduction are recorded in the lineage. A quiet sum is passed
 * to the encoder sample for sample.
 */
final class MediaDevCompositeRenderRuntime {
    static final String SCHEMA = "media.dev.composite-render.v1";
    static final String LANE = "composite-render";
    static final String ENGINE = "ffmpeg/filter_complex+libx264+aac";
    static final String TEMP_ROOT_ENV = "MEDIA_DEV_COMPOSITE_TEMP_ROOT";
    static final String PRESET_ENV = "MEDIA_DEV_COMPOSITE_X264_PRESET";
    static final String MAX_SECONDS_ENV = "MEDIA_DEV_COMPOSITE_MAX_SECONDS";
    static final String MAX_OUTPUT_ENV = "MEDIA_DEV_COMPOSITE_MAX_OUTPUT_BYTES";
    static final String SPACE_RESERVE_ENV = "MEDIA_DEV_COMPOSITE_SPACE_RESERVE_BYTES";
    static final String MAX_SOURCE_ENV = "MEDIA_DEV_COMPOSITE_MAX_SOURCE_BYTES";
    static final String WORK_PREFIX = "media-dev-composite-";
    /**
     * Headroom kept below the requested ceiling when the sum is limited. The encoder (AAC) adds inter-sample overshoot after
     * the guard has measured the float mix; measured on the decoded master with ffmpeg ebur128=peak=true, a 0.1 dB margin
     * left the decoded true peak at -0.9 dBTP against a -1.0 ceiling, so the composite keeps 0.5 dB.
     */
    static final double ENCODE_OVERSHOOT_MARGIN_DB = 0.5;
    /** The summed audio is measured and limited in memory (about 16 bytes per stereo sample frame); bounded accordingly. */
    static final double MAX_PEAK_GUARDED_SECONDS = 600.0;
    private static final Pattern WORK_DIR = Pattern.compile("^" + WORK_PREFIX + "(\\d+)-.*$");
    private static final Set<String> VIDEO_TYPES = Set.of("video/mp4", "video/quicktime", "video/webm", "video/x-matroska");
    private static final Set<String> AUDIO_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg",
            "audio/mp4", "audio/aac", "audio/flac", "audio/ogg");
    private static final Set<String> PRESETS = Set.of("ultrafast", "superfast", "veryfast", "faster", "fast", "medium",
            "slow", "slower", "veryslow", "placebo");
    private static final List<String> LINEAGE_KEYS = List.of("renderSchema", "scope", "engine", "projectId", "revisionId",
            "timelineId", "timelineSemanticVersionId", "requestId", "width", "height", "framesPerSecond", "frameCount",
            "durationSeconds", "format", "sources", "parent", "composition", "segments", "encoding", "rightsDecision",
            "annotations", "note");

    /** Server-side ceilings and tool locations. */
    record Config(Path ffmpeg, Path ffprobe, Path tempRoot, Duration timeout, long maxSourceBytes, long maxTotalSourceBytes,
                  long maxOutputBytes, long spaceReserveBytes, int maxClips, double maxSeconds, String preset) {
        Config {
            Objects.requireNonNull(ffmpeg, "ffmpeg");
            Objects.requireNonNull(ffprobe, "ffprobe");
            Objects.requireNonNull(tempRoot, "tempRoot");
            if (!PRESETS.contains(preset)) throw new IllegalArgumentException("unsupported x264 preset");
        }
    }

    /** One composite render request; every parameter is part of the idempotency fingerprint. */
    record Request(String requestId, String projectId, String revisionId, String timelineId, Spec spec,
                   long maxOutputBytes, Map<String, Object> annotations) {
        Request(String requestId, String projectId, String revisionId, String timelineId, Spec spec, long maxOutputBytes) {
            this(requestId, projectId, revisionId, timelineId, spec, maxOutputBytes, Map.of());
        }

        Request {
            annotations = annotations == null ? Map.of() : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(annotations));
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            projectId = MediaDevDubSupport.boundedId(projectId, "projectId");
            revisionId = MediaDevDubSupport.boundedId(revisionId, "revisionId");
            timelineId = MediaDevDubSupport.boundedId(timelineId, "timelineId");
            Objects.requireNonNull(spec, "spec");
        }
    }

    record Result(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    private record Resolved(Clip clip, TrackKind kind, MediaArtifact artifact) { }

    private record Probe(double durationSeconds, int width, int height, int channels, int sampleRate,
                         boolean hasVideo, boolean hasAudio) { }

    private final MediaRuntime runtime;
    private final MediaDevProjectTimelineRuntime projects;
    private final MediaDevDubSupport support;
    private final MediaDevRequestLedger ledger;
    private final Config config;
    private final LongSupplier freeSpace;
    private final ConcurrentHashMap<String, BoundedProcessRunner.CancellationSource> inFlight = new ConcurrentHashMap<>();
    private volatile MediaDevCaptionRuntime.CaptionUseGate captionUseGate;
    private volatile String ffmpegVersion;

    MediaDevCompositeRenderRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects, MediaDevDubSupport support,
                                   MediaDevRequestLedger ledger, Config config, LongSupplier freeSpace) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.projects = Objects.requireNonNull(projects, "projects");
        this.support = Objects.requireNonNull(support, "support");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.config = Objects.requireNonNull(config, "config");
        this.freeSpace = Objects.requireNonNull(freeSpace, "freeSpace");
    }

    /** Requires every CAPTION clip's exact version to pass the gate (reviewed, rights still admitted). */
    void requireReviewedCaptions(MediaDevCaptionRuntime.CaptionUseGate gate) {
        this.captionUseGate = gate;
    }

    Config config() { return config; }

    // ---------------------------------------------------------------- composition

    /** Absent FFmpeg configuration yields null: the routes then do not exist, nothing is faked. */
    static MediaDevCompositeRenderRuntime compose(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                                                  Map<String, String> environment,
                                                  com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver resolver,
                                                  MediaDevRequestLedger ledger) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        if (projects == null || ledger == null || ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) {
            return null;
        }
        Path ffmpegPath = Path.of(ffmpeg);
        Path ffprobePath = Path.of(ffprobe);
        if (!ffmpegPath.isAbsolute() || !ffprobePath.isAbsolute()) {
            throw new IllegalArgumentException("MEDIA_DEV_RENDER_FFMPEG and MEDIA_DEV_RENDER_FFPROBE must be absolute paths");
        }
        String rootValue = environment.get(TEMP_ROOT_ENV);
        Path root = rootValue == null || rootValue.isBlank()
                ? Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath() : Path.of(rootValue);
        if (!root.isAbsolute()) throw new IllegalArgumentException(TEMP_ROOT_ENV + " must be an absolute path");
        try {
            Files.createDirectories(root);
        } catch (IOException failure) {
            throw new IllegalStateException(TEMP_ROOT_ENV + " is not usable", failure);
        }
        Config config = new Config(ffmpegPath, ffprobePath, root,
                MediaDevProjectRenderRuntime.renderTimeoutFrom(environment),
                longEnv(environment, MAX_SOURCE_ENV, 128L << 20, 1L << 10, 2L << 30),
                longEnv(environment, MAX_SOURCE_ENV, 128L << 20, 1L << 10, 2L << 30) * 4,
                longEnv(environment, MAX_OUTPUT_ENV, 64L << 20, 1L << 10, 2L << 30),
                longEnv(environment, SPACE_RESERVE_ENV, 512L << 20, 0, 1L << 50), 64,
                longEnv(environment, MAX_SECONDS_ENV, 120, 1, 3_600),
                environment.getOrDefault(PRESET_ENV, "medium"));
        MediaDevCompositeRenderRuntime composite = new MediaDevCompositeRenderRuntime(runtime, projects,
                new MediaDevDubSupport(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), resolver),
                ledger, config, () -> root.toFile().getUsableSpace());
        composite.sweepOrphans();
        return composite;
    }

    private static long longEnv(Map<String, String> environment, String name, long fallback, long min, long max) {
        String raw = environment.get(name);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            long value = Long.parseLong(raw.trim());
            if (value < min || value > max) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(name + " must be an integer within [" + min + ", " + max + "]");
        }
    }

    Map<String, Object> capabilities() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("schema", SCHEMA);
        view.put("engine", ENGINE);
        view.put("videoSourceTypes", new java.util.TreeSet<>(VIDEO_TYPES));
        view.put("audioSourceTypes", new java.util.TreeSet<>(AUDIO_TYPES));
        view.put("overlaySourceTypes", List.of("image/png"));
        view.put("captionSourceTypes", List.of("text/vtt"));
        view.put("captionModes", List.of("MUX", "BURN", "BOTH"));
        view.put("gapPolicies", List.of("REFUSE", "BLACK"));
        view.put("audioPeakPolicies", List.of("LIMIT", "REFUSE"));
        view.put("truePeakCeilingDbtp", Map.of("default", MediaDevCompositePlan.DEFAULT_TRUE_PEAK_CEILING_DBTP,
                "min", MediaDevCompositePlan.MIN_TRUE_PEAK_CEILING_DBTP, "max", MediaDevCompositePlan.MAX_TRUE_PEAK_CEILING_DBTP));
        view.put("limits", Map.of("maxClips", config.maxClips(), "maxTimelineSeconds", config.maxSeconds(),
                "maxOutputBytes", config.maxOutputBytes(), "maxSourceBytes", config.maxSourceBytes(),
                "maxFramesPerSecond", MediaDevCompositePlan.MAX_FPS, "maxWidth", 1920, "maxHeight", 1080));
        view.put("note", "A video clip's embedded audio is not used; sound comes only from AUDIO-track clips.");
        return view;
    }

    // ---------------------------------------------------------------- request path

    Result render(String tenantId, String principalId, Request request) {
        Objects.requireNonNull(request, "request");
        io.micrometer.core.instrument.Timer.Sample renderSample = runtime.startWorkflowStage();
        try {
            return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_RENDER, "composite", tenantId,
                    () -> renderAdmitted(tenantId, principalId, request));
        } finally {
            runtime.stopWorkflowStage(renderSample,
                    com.ghatana.audiovideo.observability.MediaWorkflowMetrics.Stage.RENDER);
        }
    }

    private Result renderAdmitted(String tenantId, String principalId, Request request) {
        Revision revision = projects.revision(tenantId, principalId, request.projectId(), request.revisionId());
        TimelineSnapshot timeline = revision.timelines().stream()
                .filter(snapshot -> snapshot.timelineId().equals(request.timelineId())).findFirst()
                .orElseThrow(() -> MediaDevCompositePlan.bad("timelineId", "TIMELINE_NOT_FOUND",
                        "timeline is not part of the requested revision"));
        if (request.maxOutputBytes() < 1 || request.maxOutputBytes() > config.maxOutputBytes()) {
            throw MediaDevCompositePlan.bad("limits.maxOutputBytes", "RENDER_OUTPUT_BUDGET_EXCEEDED",
                    "maxOutputBytes must be within [1, " + config.maxOutputBytes() + "]");
        }
        Planned planned = MediaDevCompositePlan.plan(timeline, request.spec(),
                new MediaDevCompositePlan.Limits(config.maxClips(), config.maxSeconds()));
        Map<String, Track> tracks = new LinkedHashMap<>();
        for (Track track : timeline.graph().tracks()) tracks.put(track.trackId(), track);
        List<Resolved> sources = resolve(tenantId, principalId, planned, tracks);
        // Rights are checked for every distinct exact version on every call, a replay included.
        List<String> evidence = new ArrayList<>();
        Set<String> checked = new LinkedHashSet<>();
        for (Resolved source : sources) {
            if (checked.add(source.artifact().artifactId() + "@" + source.artifact().version().value())) {
                evidence.add(support.requireProcessing(tenantId, principalId, source.artifact()).evidenceRef());
            }
        }
        if (captionUseGate != null) {
            for (Resolved source : sources) {
                if (source.kind() == TrackKind.CAPTION) captionUseGate.requireReviewed(tenantId, principalId, source.artifact());
            }
        }
        List<Object> fingerprintParts = new ArrayList<>(List.of(request.projectId(), request.revisionId(),
                request.timelineId(), timeline.semanticVersionId(), request.spec().width(), request.spec().height(),
                request.spec().fps(), request.spec().gap(), request.spec().captions(), request.spec().color(),
                request.spec().overlays(), request.spec().gains(), request.maxOutputBytes(),
                request.spec().audioPeakPolicy().name(), request.spec().truePeakCeilingDbtp()));
        if (!request.annotations().isEmpty()) fingerprintParts.add("annotations=" + request.annotations());
        for (Resolved source : sources) {
            fingerprintParts.add(source.clip().clipId() + "|" + source.artifact().artifactId() + "|"
                    + source.artifact().version().value() + "|" + source.artifact().sha256());
        }
        String fingerprint = MediaDevRequestLedger.fingerprint(SCHEMA, fingerprintParts.toArray());
        return ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs),
                () -> produce(tenantId, principalId, request, revision, timeline, planned, sources, evidence),
                result -> List.of(new OutputRef("render", result.artifact().artifactId(),
                        result.artifact().version().value())),
                () -> new MediaDevSpeechRuntime.SpeechRequestReusedException(
                        new IllegalArgumentException("requestId used with a different request")));
    }

    private List<Resolved> resolve(String tenantId, String principalId, Planned planned, Map<String, Track> tracks) {
        List<Clip> ordered = new ArrayList<>();
        for (var segment : planned.video()) if (!segment.black()) ordered.add(segment.clip());
        for (Timed overlay : planned.overlays()) ordered.add(overlay.clip());
        ordered.addAll(planned.audio());
        ordered.addAll(planned.captions());
        List<Resolved> resolved = new ArrayList<>();
        long total = 0;
        for (Clip clip : ordered) {
            TrackKind kind = tracks.get(clip.trackId()).kind();
            MediaArtifact artifact = support.exact(tenantId, principalId, clip.source().artifactId(),
                    clip.source().artifactVersionId());
            String type = baseType(artifact.contentType());
            boolean admitted = switch (kind) {
                case VIDEO -> VIDEO_TYPES.contains(type);
                case AUDIO -> AUDIO_TYPES.contains(type);
                case OVERLAY -> type.equals("image/png");
                case CAPTION -> type.equals("text/vtt");
            };
            if (!admitted) {
                throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"), "SOURCE_FORMAT_NOT_SUPPORTED",
                        "the " + kind + " source type " + type + " is not supported by the composite render");
            }
            if (artifact.sizeBytes() > config.maxSourceBytes()) {
                throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"), "RENDER_LIMIT_EXCEEDED",
                        "the source exceeds the " + config.maxSourceBytes() + " byte ceiling");
            }
            total += artifact.sizeBytes();
            resolved.add(new Resolved(clip, kind, artifact));
        }
        if (total > config.maxTotalSourceBytes()) {
            throw MediaDevCompositePlan.bad("timeline.clips", "RENDER_LIMIT_EXCEEDED",
                    "the sources exceed the aggregate " + config.maxTotalSourceBytes() + " byte budget");
        }
        return resolved;
    }

    private static String baseType(String contentType) {
        String lower = contentType.toLowerCase(Locale.ROOT);
        int parameters = lower.indexOf(';');
        return (parameters < 0 ? lower : lower.substring(0, parameters)).trim();
    }

    // ---------------------------------------------------------------- production

    private Result produce(String tenantId, String principalId, Request request, Revision revision,
                           TimelineSnapshot timeline, Planned planned, List<Resolved> sources, List<String> evidence) {
        Spec spec = request.spec();
        String key = tenantId + "\u0000" + principalId + "\u0000" + request.requestId();
        BoundedProcessRunner.CancellationSource cancellation = new BoundedProcessRunner.CancellationSource();
        if (inFlight.putIfAbsent(key, cancellation) != null) {
            throw new SpeechRefusedException(409, "REQUEST_IN_PROGRESS",
                    "the same requestId is already rendering in this process; retry the same requestId");
        }
        Path work = null;
        try {
            long staged = 0;
            for (Resolved source : sources) staged += source.artifact().sizeBytes();
            long audioScratch = planned.audio().isEmpty() ? 0
                    : 2L * (planned.totalFrames() * MediaDevCompositePlan.AUDIO_RATE * 8L / spec.fps() + 1);
            long required = staged + audioScratch + request.maxOutputBytes() + config.spaceReserveBytes();
            long free = freeSpace.getAsLong();
            if (free < required) {
                throw MediaDevCompositePlan.bad("limits.space", "RENDER_SPACE_BUDGET",
                        "not enough free space for the sources, the output budget and the reserve (" + required
                                + " bytes needed, " + free + " available); nothing was staged");
            }
            work = Files.createTempDirectory(config.tempRoot(), WORK_PREFIX + ProcessHandle.current().pid() + "-");
            cancelled(cancellation);
            Map<String, Path> files = new LinkedHashMap<>();
            Map<String, Probe> probes = new LinkedHashMap<>();
            int index = 0;
            for (Resolved source : sources) {
                String ref = source.artifact().artifactId() + "@" + source.artifact().version().value();
                if (files.containsKey(ref) || source.kind() == TrackKind.CAPTION) continue;
                Path file = work.resolve("src-" + (index++) + extension(source));
                stage(tenantId, principalId, source.artifact(), file);
                files.put(ref, file);
                probes.put(ref, probe(file, cancellation));
                cancelled(cancellation);
            }
            validateSources(planned, sources, probes, request.spec());
            List<MediaDevWebVtt.Cue> cues = captions(tenantId, principalId, planned, sources, request.spec());
            cancelled(cancellation);
            AudioMix mix = mixAudio(request, planned, sources, files, probes, work, cancellation);
            Built built = build(request, planned, sources, files, probes, cues, work, mix);
            Path output = work.resolve("out.mp4");
            run(built.command(), work, output, request.maxOutputBytes(), cancellation);
            cancelled(cancellation);
            Map<String, Object> measured = verify(output, request.spec(), planned, built, cancellation);
            byte[] bytes = Files.readAllBytes(output);
            cancelled(cancellation);
            return register(tenantId, principalId, request, revision, timeline, planned, sources, evidence, built,
                    measured, bytes, cues.size());
        } catch (IOException failure) {
            throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("IO_ERROR");
        } finally {
            inFlight.remove(key);
            deleteTree(work);
        }
    }

    /** Cooperatively cancels an in-flight render of this principal; false when nothing of this requestId is running here. */
    boolean cancel(String tenantId, String principalId, String requestId) {
        BoundedProcessRunner.CancellationSource source =
                inFlight.get(tenantId + "\u0000" + principalId + "\u0000" + requestId);
        if (source == null) return false;
        source.cancel();
        return true;
    }

    int inFlightCount() { return inFlight.size(); }

    private static void cancelled(BoundedProcessRunner.CancellationToken token) {
        if (token.isCancelled()) throw new SpeechRefusedException(409, "RENDER_CANCELLED",
                "the render was cancelled; the encoder was stopped and nothing was registered");
    }

    private static String extension(Resolved source) {
        return switch (source.kind()) {
            case VIDEO -> ".bin";
            case AUDIO -> ".aud";
            case OVERLAY -> ".png";
            case CAPTION -> ".vtt";
        };
    }

    private void stage(String tenantId, String principalId, MediaArtifact artifact, Path file) throws IOException {
        MessageDigest digest = digest();
        try (OutputStream out = new DigestOutputStream(Files.newOutputStream(file), digest)) {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), out,
                    config.maxSourceBytes()).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        }
        if (!HexFormat.of().formatHex(digest.digest()).equals(artifact.sha256())) {
            throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("SOURCE_DIGEST_MISMATCH");
        }
    }

    // ---------------------------------------------------------------- probing and validation

    private Probe probe(Path file, BoundedProcessRunner.CancellationToken cancellation) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(config.ffprobe().toString(), "-v", "error",
                "-show_entries", "stream=codec_type,width,height,channels,sample_rate,duration:format=duration",
                "-of", "json", file.toString()), file.getParent(), Map.of(), Duration.ofSeconds(30), 1 << 20, 1 << 16,
                cancellation, null, 0);
        if (result.end() == BoundedProcessRunner.End.CANCELLED) cancelled(() -> true);
        if (!result.succeeded()) {
            throw new SpeechRefusedException(422, "SOURCE_NOT_DECODABLE", "a source could not be probed by FFprobe");
        }
        JsonNode root;
        try {
            root = MediaDevDubSupport.JSON.readTree(result.stdout());
        } catch (RuntimeException malformed) {
            throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("PROBE_UNREADABLE");
        }
        double duration = number(root.path("format").path("duration"));
        int width = 0, height = 0, channels = 0, rate = 0;
        boolean video = false, audio = false;
        for (JsonNode stream : root.path("streams")) {
            String type = stream.path("codec_type").asString("");
            if (type.equals("video") && !video) {
                video = true;
                width = stream.path("width").asInt(0);
                height = stream.path("height").asInt(0);
                double streamDuration = number(stream.path("duration"));
                if (streamDuration > 0) duration = streamDuration;
            } else if (type.equals("audio") && !audio) {
                audio = true;
                channels = stream.path("channels").asInt(0);
                rate = (int) number(stream.path("sample_rate"));
                double streamDuration = number(stream.path("duration"));
                if (streamDuration > 0 && !video) duration = streamDuration;
            }
        }
        return new Probe(duration, width, height, channels, rate, video, audio);
    }

    private static double number(JsonNode node) {
        if (node.isNumber()) return node.asDouble();
        try {
            return Double.parseDouble(node.asString(""));
        } catch (NumberFormatException none) {
            return 0;
        }
    }

    private void validateSources(Planned planned, List<Resolved> sources, Map<String, Probe> probes, Spec spec) {
        List<Timed> overlayTimes = planned.overlays();
        for (Resolved source : sources) {
            Probe probe = probes.get(source.artifact().artifactId() + "@" + source.artifact().version().value());
            Clip clip = source.clip();
            switch (source.kind()) {
                case VIDEO -> {
                    if (!probe.hasVideo()) throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"),
                            "SOURCE_NOT_VIDEO", "the source has no video stream");
                    trimRange(clip, probe);
                }
                case AUDIO -> {
                    if (!probe.hasAudio()) throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"),
                            "SOURCE_NOT_AUDIO", "the source has no audio stream");
                    if (probe.channels() < 1 || probe.channels() > 2) {
                        throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"),
                                "RENDER_UNSUPPORTED_AUDIO_LAYOUT",
                                "audio sources must be mono or stereo (" + probe.channels() + " channels); no down-mix is applied");
                    }
                    trimRange(clip, probe);
                }
                case OVERLAY -> {
                    int i = overlayIndex(spec, clip.clipId());
                    var placement = spec.overlays().get(i);
                    if (probe.width() < 1 || probe.height() < 1) {
                        throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"), "SOURCE_NOT_DECODABLE",
                                "the overlay image could not be decoded");
                    }
                    if (placement.x() + probe.width() > spec.width() || placement.y() + probe.height() > spec.height()) {
                        throw MediaDevCompositePlan.bad("composition.overlays[" + i + "]", "OVERLAY_OUT_OF_FRAME",
                                "the " + probe.width() + "x" + probe.height() + " graphic at (" + placement.x() + ","
                                        + placement.y() + ") does not fit the " + spec.width() + "x" + spec.height() + " frame");
                    }
                }
                case CAPTION -> { }
            }
        }
        Objects.requireNonNull(overlayTimes);
    }

    private static void trimRange(Clip clip, Probe probe) {
        double out = MediaDevCompositePlan.doubleSeconds(clip.sourceOut());
        if (out > probe.durationSeconds() + 0.0005) {
            throw new SpeechRefusedException(422, "TRIM_OUT_OF_RANGE",
                    "sourceOut is after the end of the source (" + probe.durationSeconds() + " s)",
                    Map.of("path", MediaDevCompositePlan.path(clip, "sourceOut"),
                            "sourceDurationSeconds", probe.durationSeconds()));
        }
    }

    private static int overlayIndex(Spec spec, String clipId) {
        for (int i = 0; i < spec.overlays().size(); i++) if (spec.overlays().get(i).clipId().equals(clipId)) return i;
        throw new IllegalStateException("overlay placement missing");
    }

    // ---------------------------------------------------------------- captions

    /** Cues mapped onto the story clock (whole milliseconds), in clip order. */
    private List<MediaDevWebVtt.Cue> captions(String tenantId, String principalId, Planned planned, List<Resolved> sources,
                                              Spec spec) {
        List<MediaDevWebVtt.Cue> mapped = new ArrayList<>();
        for (Resolved source : sources) {
            if (source.kind() != TrackKind.CAPTION) continue;
            Clip clip = source.clip();
            long in = millis(clip.sourceIn(), clip, "sourceIn");
            long out = millis(clip.sourceOut(), clip, "sourceOut");
            long start = millis(clip.storyStart(), clip, "storyStart");
            if (spec.captions().burn() && (start % 10 != 0 || in % 10 != 0 || out % 10 != 0)) {
                throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "storyStart"),
                        "CAPTION_TIME_NOT_CENTISECOND_EXACT", "burned captions need centisecond-exact clip times");
            }
            byte[] bytes = support.read(tenantId, principalId, source.artifact());
            List<MediaDevWebVtt.Cue> cues;
            try {
                cues = MediaDevWebVtt.parse(bytes);
            } catch (MediaDevWebVtt.WebVttException refused) {
                throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"), refused.code(), refused.getMessage());
            }
            for (MediaDevWebVtt.Cue cue : cues) {
                long from = Math.max(cue.startMillis(), in);
                long to = Math.min(cue.endMillis(), out);
                if (to <= from) continue;
                long shift = start - in;
                if (spec.captions().burn() && ((from + shift) % 10 != 0 || (to + shift) % 10 != 0)) {
                    throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, "source"),
                            "CAPTION_TIME_NOT_CENTISECOND_EXACT", "a burned cue does not fall on a centisecond");
                }
                mapped.add(new MediaDevWebVtt.Cue(from + shift, to + shift, cue.text()));
            }
        }
        return mapped;
    }

    private static long millis(com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime time, Clip clip,
                               String field) {
        var fraction = MediaDevCompositePlan.fraction(time);
        var division = fraction[0].multiply(java.math.BigInteger.valueOf(1000)).divideAndRemainder(fraction[1]);
        if (division[1].signum() != 0) {
            throw MediaDevCompositePlan.bad(MediaDevCompositePlan.path(clip, field), "CAPTION_TIME_NOT_MS_EXACT",
                    "caption clip times must be whole milliseconds");
        }
        return division[0].longValueExact();
    }

    // ---------------------------------------------------------------- command construction

    /** The summed AUDIO tracks as float PCM (the file the encoder reads) and what the peak policy measured on it. */
    private record AudioMix(Path file, double preTruePeakDbtp, double postTruePeakDbtp, double maxGainReductionDb,
                            long limitedFrames, boolean limiterApplied, double internalCeilingDbtp) { }

    private record Built(List<String> command, String filterGraphSha256, boolean audio, boolean subtitles, boolean burned,
                         String preset, int audioClipCount, AudioMix audioMix) { }

    private Built build(Request request, Planned planned, List<Resolved> sources, Map<String, Path> files,
                        Map<String, Probe> probes, List<MediaDevWebVtt.Cue> cues, Path work, AudioMix mix)
            throws IOException {
        Spec spec = request.spec();
        int fps = spec.fps();
        int w = spec.width(), h = spec.height();
        Map<String, Resolved> byClip = new LinkedHashMap<>();
        for (Resolved source : sources) byClip.put(source.clip().clipId(), source);
        List<String> inputs = new ArrayList<>();
        List<String> graph = new ArrayList<>();
        int input = 0;
        List<String> videoLabels = new ArrayList<>();
        int segmentIndex = 0;
        for (var segment : planned.video()) {
            String label = "[v" + segmentIndex++ + "]";
            if (segment.black()) {
                graph.add("color=c=black:s=" + w + "x" + h + ":r=" + fps + ":d=" + seconds(segment.frames() + 1, fps)
                        + ",format=yuv420p,setsar=1,trim=end_frame=" + segment.frames() + ",setpts=PTS-STARTPTS" + label);
            } else {
                Clip clip = segment.clip();
                Resolved source = byClip.get(clip.clipId());
                inputs.addAll(List.of("-i", files.get(ref(source)).toString()));
                graph.add("[" + input++ + ":v]trim=start=" + MediaDevCompositePlan.decimalSeconds(clip.sourceIn()) + ":end="
                        + MediaDevCompositePlan.decimalSeconds(clip.sourceOut()) + ",setpts=PTS-STARTPTS,fps=" + fps
                        + ",scale=" + w + ":" + h + ":force_original_aspect_ratio=decrease:force_divisible_by=2,pad=" + w + ":"
                        + h + ":(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=2,trim=end_frame="
                        + segment.frames() + ",setpts=PTS-STARTPTS" + label);
            }
            videoLabels.add(label);
        }
        graph.add(String.join("", videoLabels) + "concat=n=" + videoLabels.size() + ":v=1:a=0[vcat]");
        String current = "[vcat]";
        if (!spec.color().neutral()) {
            graph.add(current + "eq=brightness=" + num(spec.color().brightness()) + ":contrast="
                    + num(spec.color().contrast()) + ":saturation=" + num(spec.color().saturation()) + "[vgrade]");
            current = "[vgrade]";
        }
        double totalSeconds = (double) planned.totalFrames() / fps;
        String totalDecimal = seconds(planned.totalFrames(), fps);
        int overlayIndex = 0;
        for (Timed overlay : planned.overlays()) {
            Resolved source = byClip.get(overlay.clip().clipId());
            var placement = spec.overlays().get(overlayIndex(spec, overlay.clip().clipId()));
            inputs.addAll(List.of("-loop", "1", "-framerate", Integer.toString(fps), "-t", totalDecimal, "-i",
                    files.get(ref(source)).toString()));
            String graphic = "[g" + overlayIndex + "]";
            String next = "[o" + overlayIndex + "]";
            graph.add("[" + input++ + ":v]format=rgba,colorchannelmixer=aa=" + num(placement.opacity()) + graphic);
            graph.add(current + graphic + "overlay=x=" + placement.x() + ":y=" + placement.y() + ":enable='gte(t,"
                    + halfFrame(overlay.startFrame(), fps) + ")*lt(t," + halfFrame(overlay.endFrame(), fps)
                    + ")':eof_action=pass" + next);
            current = next;
            overlayIndex++;
        }
        boolean burned = spec.captions().burn() && !cues.isEmpty();
        if (burned) {
            Path ass = work.resolve("burn.ass");
            Files.writeString(ass, ass(cues, w, h), StandardCharsets.UTF_8);
            graph.add(current + "ass=filename=" + ass + "[vburn]");
            current = "[vburn]";
        }
        graph.add(current + "null[vfinal]");
        // ---- audio: the peak-guarded float mix of the AUDIO tracks, read as one raw input (see mixAudio) ----
        boolean audio = !planned.audio().isEmpty();
        int audioInput = -1;
        if (audio) {
            inputs.addAll(List.of("-f", "f32le", "-ar", Integer.toString(MediaDevCompositePlan.AUDIO_RATE), "-ac", "2", "-i",
                    mix.file().toString()));
            audioInput = input++;
        }
        boolean subtitles = spec.captions().mux() && !cues.isEmpty();
        int subtitleInput = -1;
        if (subtitles) {
            Path srt = work.resolve("mux.srt");
            Files.writeString(srt, srt(cues), StandardCharsets.UTF_8);
            inputs.addAll(List.of("-i", srt.toString()));
            subtitleInput = input++;
        }
        String script = String.join(";\n", graph);
        Path scriptFile = work.resolve("graph.txt");
        Files.writeString(scriptFile, script, StandardCharsets.UTF_8);
        List<String> command = new ArrayList<>(List.of(config.ffmpeg().toString(), "-nostdin", "-hide_banner",
                "-loglevel", "error", "-y", "-filter_complex_threads", "1"));
        command.addAll(inputs);
        command.addAll(List.of("-filter_complex_script", scriptFile.toString(), "-map", "[vfinal]"));
        if (audio) command.addAll(List.of("-map", audioInput + ":a"));
        if (subtitles) command.addAll(List.of("-map", subtitleInput + ":0"));
        command.addAll(List.of("-c:v", "libx264", "-preset", config.preset(), "-crf", "18", "-pix_fmt", "yuv420p",
                "-r", Integer.toString(fps), "-fps_mode", "cfr", "-frames:v", Long.toString(planned.totalFrames()),
                "-threads", "2"));
        if (audio) command.addAll(List.of("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"));
        if (subtitles) command.addAll(List.of("-c:s", "mov_text", "-metadata:s:s:0", "language=und"));
        command.addAll(List.of("-movflags", "+faststart", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a",
                "+bitexact", "-metadata", "comment=media.dev.composite-render request=" + request.requestId(),
                "-fs", Long.toString(request.maxOutputBytes()), work.resolve("out.mp4").toString()));
        Objects.requireNonNull(totalSeconds);
        return new Built(List.copyOf(command), MediaDevProjectRenderRuntime.sha256Hex(script), audio, subtitles, burned,
                config.preset(), planned.audio().size(), audio ? mix : null);
    }

    // ---------------------------------------------------------------- audio peak policy

    /**
     * Sums the AUDIO tracks to float PCM (the same clip chain as before: trim, layout, 48 kHz, gain, placement, amix), measures
     * the true peak with the J-17 meter and applies the peak policy. LIMIT caps the sum with the master peak guard; REFUSE
     * refuses it with 422 COMPOSITE_AUDIO_CLIPS. Returns null when there are no AUDIO clips.
     */
    private AudioMix mixAudio(Request request, Planned planned, List<Resolved> sources, Map<String, Path> files,
                              Map<String, Probe> probes, Path work, BoundedProcessRunner.CancellationSource cancellation)
            throws IOException {
        if (planned.audio().isEmpty()) return null;
        Spec spec = request.spec();
        if ((double) planned.totalFrames() / spec.fps() > MAX_PEAK_GUARDED_SECONDS) {
            throw MediaDevCompositePlan.bad("timeline", "RENDER_LIMIT_EXCEEDED",
                    "audio peak protection is limited to " + (long) MAX_PEAK_GUARDED_SECONDS + " s of timeline");
        }
        Map<String, Resolved> byClip = new LinkedHashMap<>();
        for (Resolved source : sources) byClip.put(source.clip().clipId(), source);
        Path raw = work.resolve("audio-mix.f32");
        long bound = (planned.totalFrames() * MediaDevCompositePlan.AUDIO_RATE * 8L / spec.fps()) + (1L << 20);
        run(audioMixCommand(planned, spec, byClip, files, probes, work, raw), work, raw, bound, cancellation);
        cancelled(cancellation);
        int frames;
        double[] left;
        double[] right;
        try (var channel = java.nio.channels.FileChannel.open(raw)) {
            frames = Math.toIntExact(channel.size() / 8);
        }
        left = new double[frames];
        right = new double[frames];
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(Files.readAllBytes(raw)).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        for (int n = 0; n < frames; n++) {
            left[n] = buffer.getFloat();
            right[n] = buffer.getFloat();
        }
        double ceiling = spec.truePeakCeilingDbtp();
        double pre = MediaDevMasterDsp.truePeakDbtp(left, right);
        if (spec.audioPeakPolicy() == MediaDevCompositePlan.AudioPeakPolicy.REFUSE && pre > ceiling) {
            throw new SpeechRefusedException(422, "COMPOSITE_AUDIO_CLIPS",
                    "the summed AUDIO clips reach " + finiteDb(pre) + " dBTP, above the " + ceiling + " dBTP ceiling; "
                            + "lower the clip gains or use audioPeakPolicy LIMIT",
                    Map.of("path", "composition.audio", "measuredTruePeakDbtp", finiteDb(pre),
                            "truePeakCeilingDbtp", ceiling));
        }
        MediaDevMasterDsp.PeakGuarded guarded = MediaDevMasterDsp.truePeakGuard(left, right, ceiling, ENCODE_OVERSHOOT_MARGIN_DB);
        if (!guarded.honoured()) {
            throw new SpeechRefusedException(422, "AUDIO_PEAK_CEILING_UNREACHABLE",
                    "the summed AUDIO clips could not be limited under the " + ceiling + " dBTP ceiling",
                    Map.of("path", "composition.audio", "measuredTruePeakDbtp", finiteDb(pre),
                            "truePeakCeilingDbtp", ceiling));
        }
        Path file = raw;
        if (guarded.maxGainReductionDb() > 0.0) {
            // Re-serialize the limited samples exactly as the verified values; the raw mix is kept until the render ends.
            file = work.resolve("audio-mix-limited.f32");
            java.nio.ByteBuffer out = java.nio.ByteBuffer.allocate(frames * 8).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            for (int n = 0; n < frames; n++) {
                out.putFloat((float) guarded.left()[n]);
                out.putFloat((float) guarded.right()[n]);
            }
            Files.write(file, out.array());
        }
        return new AudioMix(file, finiteDb(guarded.preTruePeakDbtp()), finiteDb(guarded.postTruePeakDbtp()),
                guarded.maxGainReductionDb(), guarded.limitedFrames(), guarded.maxGainReductionDb() > 0.0,
                guarded.internalCeilingDbtp());
    }

    private List<String> audioMixCommand(Planned planned, Spec spec, Map<String, Resolved> byClip, Map<String, Path> files,
                                         Map<String, Probe> probes, Path work, Path output) throws IOException {
        String totalDecimal = seconds(planned.totalFrames(), spec.fps());
        List<String> inputs = new ArrayList<>();
        List<String> graph = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        int input = 0;
        for (Clip clip : planned.audio()) {
            Resolved source = byClip.get(clip.clipId());
            Probe probe = probes.get(ref(source));
            inputs.addAll(List.of("-i", files.get(ref(source)).toString()));
            double gain = 0.0;
            for (var entry : spec.gains()) if (entry.clipId().equals(clip.clipId())) gain = entry.gainDb();
            String start = MediaDevCompositePlan.samples(clip.storyStart(), "").toString();
            String label = "[a" + labels.size() + "]";
            graph.add("[" + input++ + ":a]atrim=start=" + MediaDevCompositePlan.decimalSeconds(clip.sourceIn()) + ":end="
                    + MediaDevCompositePlan.decimalSeconds(clip.sourceOut()) + ",asetpts=PTS-STARTPTS,"
                    + (probe.channels() == 1 ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo")
                    + ",aresample=" + MediaDevCompositePlan.AUDIO_RATE + ",aformat=sample_fmts=fltp,volume=" + num(gain)
                    + "dB,adelay=" + start + "S|" + start + "S" + label);
            labels.add(label);
        }
        graph.add(String.join("", labels) + "amix=inputs=" + labels.size() + ":normalize=0:duration=longest"
                + ",apad=whole_dur=" + totalDecimal + ",atrim=end=" + totalDecimal + ",asetpts=PTS-STARTPTS[aout]");
        Path script = work.resolve("audio-graph.txt");
        Files.writeString(script, String.join(";\n", graph), StandardCharsets.UTF_8);
        List<String> command = new ArrayList<>(List.of(config.ffmpeg().toString(), "-nostdin", "-hide_banner",
                "-loglevel", "error", "-y", "-filter_complex_threads", "1"));
        command.addAll(inputs);
        command.addAll(List.of("-filter_complex_script", script.toString(), "-map", "[aout]", "-f", "f32le", "-ar",
                Integer.toString(MediaDevCompositePlan.AUDIO_RATE), "-ac", "2", output.toString()));
        return List.copyOf(command);
    }

    /** dBTP of a measurement, with silence floored at -120 dBTP so the lineage stays finite JSON. */
    private static double finiteDb(double value) {
        return Double.isInfinite(value) ? -120.0 : value;
    }

    private static String ref(Resolved source) {
        return source.artifact().artifactId() + "@" + source.artifact().version().value();
    }

    private static String num(double value) {
        return BigDecimal.valueOf(value).setScale(6, RoundingMode.HALF_EVEN).stripTrailingZeros().toPlainString();
    }

    private static String seconds(long frames, int fps) {
        return new BigDecimal(frames).divide(new BigDecimal(fps), 9, RoundingMode.HALF_EVEN).toPlainString();
    }

    /** The midpoint before a frame boundary: robust against rounding of frame timestamps in an enable expression. */
    private static String halfFrame(long frame, int fps) {
        return new BigDecimal(frame).subtract(new BigDecimal("0.5")).divide(new BigDecimal(fps), 9, RoundingMode.HALF_EVEN)
                .toPlainString();
    }

    private static String srt(List<MediaDevWebVtt.Cue> cues) {
        StringBuilder out = new StringBuilder();
        int index = 1;
        for (MediaDevWebVtt.Cue cue : cues) {
            out.append(index++).append('\n').append(stamp(cue.startMillis(), ',')).append(" --> ")
                    .append(stamp(cue.endMillis(), ',')).append('\n').append(cue.text()).append("\n\n");
        }
        return out.toString();
    }

    private static String ass(List<MediaDevWebVtt.Cue> cues, int width, int height) {
        int size = Math.max(14, height / 12);
        StringBuilder out = new StringBuilder("[Script Info]\nScriptType: v4.00+\nPlayResX: " + width + "\nPlayResY: " + height
                + "\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
                + "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
                + "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
                + "MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans," + size
                + ",&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,20,20," + Math.max(8, height / 14)
                + ",1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
        for (MediaDevWebVtt.Cue cue : cues) {
            out.append("Dialogue: 0,").append(assStamp(cue.startMillis())).append(',').append(assStamp(cue.endMillis()))
                    .append(",Default,,0,0,0,,")
                    .append(cue.text().replace("{", "\\{").replace("}", "\\}").replace("\r", "").replace("\n", "\\N"))
                    .append('\n');
        }
        return out.toString();
    }

    private static String stamp(long millis, char separator) {
        return String.format(Locale.ROOT, "%02d:%02d:%02d%c%03d", millis / 3_600_000, millis / 60_000 % 60,
                millis / 1000 % 60, separator, millis % 1000);
    }

    private static String assStamp(long millis) {
        return String.format(Locale.ROOT, "%d:%02d:%02d.%02d", millis / 3_600_000, millis / 60_000 % 60,
                millis / 1000 % 60, millis % 1000 / 10);
    }

    // ---------------------------------------------------------------- execution and verification

    private void run(List<String> command, Path work, Path output, long maxOutputBytes,
                     BoundedProcessRunner.CancellationSource cancellation) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, work, Map.of(), config.timeout(), 8192, 65_536,
                cancellation, output, maxOutputBytes);
        switch (result.end()) {
            case CANCELLED -> throw new SpeechRefusedException(409, "RENDER_CANCELLED",
                    "the render was cancelled; the encoder was stopped and nothing was registered");
            case TIMED_OUT -> throw new MediaDevProjectRenderRuntime.RenderTimeoutException();
            case WATCHED_FILE_TOO_LARGE -> throw new SpeechRefusedException(422, "RENDER_OUTPUT_BUDGET_EXCEEDED",
                    "the encoded output exceeded the " + maxOutputBytes + " byte budget; the encoder was stopped and "
                            + "nothing was registered", Map.of("path", "limits.maxOutputBytes"));
            case STDOUT_OVERFLOW -> throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("STDOUT_OVERFLOW");
            case EXITED -> {
                if (result.exitCode() > 128 || result.exitCode() < 0) {
                    throw new MediaDevProjectRenderRuntime.RenderOutcomeUnknownException();
                }
                if (result.exitCode() != 0) {
                    throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("FFMPEG_EXIT_" + result.exitCode());
                }
            }
        }
        if (!Files.isRegularFile(output)) throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("NO_OUTPUT");
    }

    private Map<String, Object> verify(Path output, Spec spec, Planned planned, Built built,
                                       BoundedProcessRunner.CancellationToken cancellation) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(config.ffprobe().toString(), "-v", "error",
                "-count_frames", "-show_entries",
                "stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames,duration,channels,"
                        + "sample_rate:format=duration,format_name", "-of", "json", output.toString()), output.getParent(),
                Map.of(), Duration.ofSeconds(60), 1 << 20, 1 << 16, cancellation, null, 0);
        if (!result.succeeded()) throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("OUTPUT_NOT_PROBEABLE");
        JsonNode root = MediaDevDubSupport.JSON.readTree(result.stdout());
        JsonNode video = null, audio = null, subtitle = null;
        int videoStreams = 0, audioStreams = 0, subtitleStreams = 0;
        for (JsonNode stream : root.path("streams")) {
            switch (stream.path("codec_type").asString("")) {
                case "video" -> { video = stream; videoStreams++; }
                case "audio" -> { audio = stream; audioStreams++; }
                case "subtitle" -> { subtitle = stream; subtitleStreams++; }
                default -> { }
            }
        }
        long frames = planned.totalFrames();
        double expected = (double) frames / spec.fps();
        double formatDuration = number(root.path("format").path("duration"));
        boolean ok = videoStreams == 1 && "h264".equals(video.path("codec_name").asString(""))
                && "yuv420p".equals(video.path("pix_fmt").asString("")) && video.path("width").asInt(0) == spec.width()
                && video.path("height").asInt(0) == spec.height()
                && (spec.fps() + "/1").equals(video.path("r_frame_rate").asString(""))
                && Long.toString(frames).equals(video.path("nb_read_frames").asString(""))
                && audioStreams == (built.audio() ? 1 : 0) && subtitleStreams == (built.subtitles() ? 1 : 0)
                && Math.abs(formatDuration - expected) <= 0.05;
        double audioDuration = 0;
        if (ok && built.audio()) {
            audioDuration = number(audio.path("duration"));
            ok = "aac".equals(audio.path("codec_name").asString("")) && audio.path("channels").asInt(0) == 2
                    && (int) number(audio.path("sample_rate")) == MediaDevCompositePlan.AUDIO_RATE
                    && Math.abs(audioDuration - expected) <= 0.05;
        }
        if (ok && built.subtitles()) ok = "mov_text".equals(subtitle.path("codec_name").asString(""));
        if (!ok) throw new MediaDevProjectRenderRuntime.RenderExecutionFailedException("OUTPUT_VERIFICATION_FAILED");
        Map<String, Object> measured = new LinkedHashMap<>();
        measured.put("videoCodec", "h264");
        measured.put("audioCodec", built.audio() ? "aac" : "none");
        measured.put("subtitleCodec", built.subtitles() ? "mov_text" : "none");
        measured.put("videoFrameCount", frames);
        measured.put("formatDurationSeconds", formatDuration);
        measured.put("audioDurationSeconds", audioDuration);
        measured.put("expectedDurationSeconds", expected);
        return measured;
    }

    private String ffmpegVersion() {
        String known = ffmpegVersion;
        if (known != null) return known;
        try {
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(config.ffmpeg().toString(), "-version"),
                    config.tempRoot(), Map.of(), Duration.ofSeconds(10), 4096, 4096, BoundedProcessRunner.CancellationToken.NEVER,
                    null, 0);
            String first = new String(result.stdout(), StandardCharsets.UTF_8).lines().findFirst().orElse("unknown");
            ffmpegVersion = first.length() > 120 ? first.substring(0, 120) : first;
        } catch (IOException unavailable) {
            ffmpegVersion = "unknown";
        }
        return ffmpegVersion;
    }

    // ---------------------------------------------------------------- registration and readback

    private Result register(String tenantId, String principalId, Request request, Revision revision,
                            TimelineSnapshot timeline, Planned planned, List<Resolved> sources, List<String> evidence,
                            Built built, Map<String, Object> measured, byte[] bytes, int cueCount) {
        Spec spec = request.spec();
        List<Map<String, Object>> sourceViews = new ArrayList<>();
        for (Resolved source : sources) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("clipId", source.clip().clipId());
            view.put("trackId", source.clip().trackId());
            view.put("trackKind", source.kind().name());
            view.put("artifactId", source.artifact().artifactId());
            view.put("artifactVersionId", source.artifact().version().value());
            view.put("sha256", source.artifact().sha256());
            view.put("sourceInSeconds", MediaDevCompositePlan.decimalSeconds(source.clip().sourceIn()));
            view.put("sourceOutSeconds", MediaDevCompositePlan.decimalSeconds(source.clip().sourceOut()));
            view.put("storyStartSeconds", MediaDevCompositePlan.decimalSeconds(source.clip().storyStart()));
            view.put("storyDurationSeconds", MediaDevCompositePlan.decimalSeconds(source.clip().storyDuration()));
            sourceViews.add(view);
        }
        List<Map<String, Object>> segments = new ArrayList<>();
        for (var segment : planned.video()) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("kind", segment.black() ? "BLACK" : "VIDEO");
            if (!segment.black()) view.put("clipId", segment.clip().clipId());
            view.put("startFrame", segment.startFrame());
            view.put("frames", segment.frames());
            segments.add(view);
        }
        Map<String, Object> composition = new LinkedHashMap<>();
        composition.put("gapPolicy", spec.gap().name());
        composition.put("captionMode", spec.captions().name());
        composition.put("captionCueCount", cueCount);
        composition.put("color", Map.of("brightness", spec.color().brightness(), "contrast", spec.color().contrast(),
                "saturation", spec.color().saturation(), "filter", "eq"));
        composition.put("overlays", spec.overlays().stream().map(o -> Map.<String, Object>of("clipId", o.clipId(),
                "x", o.x(), "y", o.y(), "opacity", o.opacity())).toList());
        composition.put("audio", spec.gains().stream().map(g -> Map.<String, Object>of("clipId", g.clipId(),
                "gainDb", g.gainDb())).toList());
        Map<String, Object> audioPeak = new LinkedHashMap<>();
        audioPeak.put("policy", spec.audioPeakPolicy().name());
        audioPeak.put("truePeakCeilingDbtp", spec.truePeakCeilingDbtp());
        audioPeak.put("measurement", "ghatana-media.master-dsp true peak, 8x oversampled, on the float mix before encoding");
        if (built.audioMix() == null) {
            audioPeak.put("status", "NO_AUDIO_CLIPS");
        } else {
            AudioMix mix = built.audioMix();
            audioPeak.put("status", "MEASURED");
            audioPeak.put("preLimitTruePeakDbtp", mix.preTruePeakDbtp());
            audioPeak.put("postLimitTruePeakDbtp", mix.postTruePeakDbtp());
            audioPeak.put("maxGainReductionDb", mix.maxGainReductionDb());
            audioPeak.put("limitedFrames", mix.limitedFrames());
            audioPeak.put("limiterApplied", mix.limiterApplied());
            audioPeak.put("internalCeilingDbtp", mix.internalCeilingDbtp());
        }
        composition.put("audioPeak", audioPeak);
        Map<String, Object> encoding = new LinkedHashMap<>(measured);
        encoding.put("preset", built.preset());
        encoding.put("crf", 18);
        encoding.put("filterGraphSha256", built.filterGraphSha256());
        encoding.put("ffmpegVersion", ffmpegVersion());
        encoding.put("captionsBurned", built.burned());
        encoding.put("embeddedClipAudioUsed", false);
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("renderSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("engine", ENGINE);
        lineage.put("projectId", request.projectId());
        lineage.put("revisionId", revision.revisionId());
        lineage.put("timelineId", timeline.timelineId());
        lineage.put("timelineSemanticVersionId", timeline.semanticVersionId());
        lineage.put("requestId", request.requestId());
        lineage.put("width", spec.width());
        lineage.put("height", spec.height());
        lineage.put("framesPerSecond", spec.fps());
        lineage.put("frameCount", planned.totalFrames());
        lineage.put("durationSeconds", seconds(planned.totalFrames(), spec.fps()));
        lineage.put("format", "mp4");
        lineage.put("sources", sourceViews);
        lineage.put("parent", sourceViews.getFirst());
        lineage.put("composition", composition);
        lineage.put("segments", segments);
        lineage.put("encoding", encoding);
        lineage.put("rightsDecision", String.join(";", evidence));
        if (!request.annotations().isEmpty()) lineage.put("annotations", request.annotations());
        lineage.put("note", "DEV_ONLY finished master rendered by FFmpeg from exact source versions; rights are the "
                + "sources' own attestations, not a quality, delivery or approval claim.");
        MediaDevDubSupport.Output output = support.register(tenantId, principalId, "INTERNAL", "composite.render",
                request.requestId(), bytes, "video/mp4", "mp4",
                "composite-" + MediaDevDubSupport.safeName(revision.revisionId()), "project-composite-render", lineage);
        return new Result(output.artifact(), lineage, output.replayed());
    }

    private Result replay(String tenantId, String principalId, List<OutputRef> outputs) {
        for (OutputRef ref : outputs) {
            if (!"render".equals(ref.role())) continue;
            return runtime.artifact(tenantId, principalId, ref.artifactId())
                    .filter(artifact -> artifact.version().value().equals(ref.versionId()))
                    .filter(artifact -> SCHEMA.equals(artifact.metadata().get("renderSchema")))
                    .map(MediaDevCompositeRenderRuntime::view)
                    .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
        }
        throw MediaDevRequestLedger.outputUnavailable(LANE);
    }

    private static Result view(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return new Result(artifact, lineage, true);
    }

    /** Reopens a registered composite render for its owner; anything else is absent. */
    Optional<Result> reopen(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("renderSchema")))
                .filter(artifact -> {
                    try {
                        projects.project(tenantId, principalId, String.valueOf(artifact.metadata().get("projectId")));
                        return true;
                    } catch (RuntimeException inaccessible) {
                        return false;
                    }
                })
                .map(MediaDevCompositeRenderRuntime::view);
    }

    // ---------------------------------------------------------------- inspection

    /** What a stored source decodes to (immutable per exact version, so cached). */
    record Facts(double durationSeconds, boolean hasVideo, boolean hasAudio, int channels) { }

    private final ConcurrentHashMap<String, Facts> factsCache = new ConcurrentHashMap<>();

    /**
     * Decodes the exact stored version with FFprobe (never trusting a declared duration) so a caller can state, before any
     * render, whether the source can serve a clip. Refuses with the same typed codes a render would.
     */
    Facts inspect(String tenantId, String principalId, MediaArtifact artifact) {
        String key = tenantId + "\u0000" + artifact.artifactId() + "@" + artifact.version().value();
        Facts known = factsCache.get(key);
        if (known != null) return known;
        if (artifact.sizeBytes() > config.maxSourceBytes()) {
            throw new SpeechRefusedException(422, "RENDER_LIMIT_EXCEEDED",
                    "the source exceeds the " + config.maxSourceBytes() + " byte ceiling", Map.of());
        }
        Path work = null;
        try {
            work = Files.createTempDirectory(config.tempRoot(), WORK_PREFIX + ProcessHandle.current().pid() + "-inspect-");
            Path file = work.resolve("source.bin");
            stage(tenantId, principalId, artifact, file);
            Probe probe = probe(file, new BoundedProcessRunner.CancellationSource());
            Facts facts = new Facts(probe.durationSeconds(), probe.hasVideo(), probe.hasAudio(), probe.channels());
            factsCache.put(key, facts);
            return facts;
        } catch (IOException failure) {
            throw new SpeechRefusedException(422, "SOURCE_NOT_DECODABLE", "the source could not be staged for inspection",
                    Map.of());
        } finally {
            deleteTree(work);
        }
    }

    // ---------------------------------------------------------------- housekeeping

    /**
     * Removes the work directories (and kills the FFmpeg processes) of launcher processes that no longer exist. A launcher
     * that was killed mid-render cannot clean up after itself; the next start does, before any request is served.
     */
    int sweepOrphans() {
        int swept = 0;
        try (var children = Files.list(config.tempRoot())) {
            for (Path dir : (Iterable<Path>) children::iterator) {
                Matcher matcher = WORK_DIR.matcher(dir.getFileName().toString());
                if (!matcher.matches() || !Files.isDirectory(dir)) continue;
                long pid = Long.parseLong(matcher.group(1));
                if (pid == ProcessHandle.current().pid() || ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)) {
                    continue;
                }
                String marker = dir.toString();
                ProcessHandle.allProcesses().filter(handle -> handle.info().commandLine()
                        .map(line -> line.contains(marker)).orElse(false)).forEach(ProcessHandle::destroyForcibly);
                deleteTree(dir);
                swept++;
            }
        } catch (IOException | RuntimeException failure) {
            // best effort: housekeeping must never stop the launcher from starting
        }
        return swept;
    }

    private static void deleteTree(Path directory) {
        if (directory == null) return;
        try (var paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        } catch (IOException ignored) {
            // already removed
        }
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }
}
