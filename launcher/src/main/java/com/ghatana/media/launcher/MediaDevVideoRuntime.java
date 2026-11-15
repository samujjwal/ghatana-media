package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.tracking.VideoTimeline;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * DEV_ONLY real video enhancement and independent measured comparison over exact owner-visible video artifact
 * versions (J-08 {@code media.dev.outcome-video-enhancement}).
 *
 * <p><b>Enhancement</b> ({@link #enhance}): a bounded typed operation set (deinterlace, denoise by hqdn3d or nlmeans,
 * deblock, bounded unsharp, bounded eq colour correction) is turned into ONE FFmpeg filter graph in a fixed canonical
 * order (no request text ever reaches the command line), run with an absolute FFmpeg path, no shell, no inherited
 * environment, a deadline and an output-size ceiling. The video is re-encoded with libx264 and the audio is copied
 * bit for bit. Before anything is registered the output is re-probed with ffprobe: frame count, every frame's
 * presentation timestamp (exact rational equality), geometry and the audio packets (MD5 of the copied packets) must
 * equal the source, otherwise nothing is registered. The result is a NEW immutable artifact whose lineage records the
 * source version digest, the typed operations, the exact filter graph, the encoder settings and the verified timeline.
 *
 * <p><b>Comparison</b> ({@link #compare}): per-frame luma PSNR and SSIM against a clean reference when one is given
 * (frames aligned by exact presentation timestamp; unaligned frames are counted and reported), and always the
 * no-reference noise-sigma estimate and Laplacian variance. Subject {@code 0} is the baseline; every later subject
 * reports its deltas against it, including per-frame regressions, without any smoothing of a worse result.
 *
 * <p>Rights: every source (and the reference) must resolve ADMITTED for {@link Scope#PROCESSING} on every call, a
 * replay included. The durable request ledger maps a requestId to its registered output so a retry after an UNKNOWN
 * outcome (for example FFmpeg killed) registers exactly once.
 *
 * @doc.type class
 * @doc.purpose DEV_ONLY FFmpeg enhancement with verified source timeline and independent PSNR/SSIM comparison
 * @doc.layer product
 * @doc.pattern Service
 */
public final class MediaDevVideoRuntime {
    public static final String ENHANCEMENT_SCHEMA = "media.dev.video-enhancement.v1";
    public static final String COMPARISON_SCHEMA = "media.dev.video-comparison.v1";
    public static final String KIND_ENHANCEMENT = "VIDEO_ENHANCEMENT";
    public static final String KIND_COMPARISON = "VIDEO_QUALITY_COMPARISON";
    static final String LANE_ENHANCE = "video.enhance";
    static final String LANE_COMPARE = "video.compare";
    static final int MAX_SOURCE_BYTES = 128 * 1024 * 1024;
    static final long MAX_OUTPUT_BYTES = 256L * 1024 * 1024;
    static final long MAX_ENHANCE_PIXELS = 2_073_600L;
    static final int MAX_ENHANCE_FRAMES = 1_800;
    static final long MAX_COMPARE_PIXELS = 921_600L;
    static final int MAX_COMPARE_FRAMES = 600;
    static final int MAX_SUBJECTS = 3;
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(120);
    private static final Duration DEFAULT_ENCODE_TIMEOUT = Duration.ofMinutes(10);
    private static final Duration DECODE_TIMEOUT = Duration.ofMinutes(5);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("videoSchema", "scope", "kind", "requestId", "source",
            "sources", "operations", "filterGraph", "encoder", "timeline", "audio", "tools", "rightsDecision",
            "resultSha256", "summary", "reference", "claims");

    // ------------------------------------------------------------------ typed operations

    /** The request carries a parameter outside its declared bound; refused before any source lookup or process. */
    public static final class VideoParameterException extends IllegalArgumentException {
        private final String code;
        private final String parameter;
        VideoParameterException(String code, String parameter, String message) {
            super(message);
            this.code = code;
            this.parameter = parameter;
        }
        public String code() { return code; }
        public String parameter() { return parameter; }
    }

    static double bounded(String parameter, double value, double min, double max) {
        if (!Double.isFinite(value) || value < min || value > max) {
            throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", parameter,
                    parameter + " must be within [" + fmt(min) + ", " + fmt(max) + "]");
        }
        return value;
    }

    /** One bounded filter step. Each type may appear at most once; the runtime fixes the order. */
    public sealed interface Operation permits Deinterlace, Denoise, Deblock, Sharpen, ColourCorrection {
        String type();
        int order();
        String filter();
        Map<String, Object> view();
    }

    public record Deinterlace() implements Operation {
        public String type() { return "deinterlace"; }
        public int order() { return 0; }
        public String filter() { return "yadif=mode=0:parity=-1:deint=0"; }
        public Map<String, Object> view() { return Map.of("type", type()); }
    }

    public enum DenoiseMethod { HQDN3D, NLMEANS }

    public record Denoise(DenoiseMethod method, double strength) implements Operation {
        public Denoise {
            Objects.requireNonNull(method, "method");
            if (method == DenoiseMethod.HQDN3D) bounded("denoise.strength", strength, 0.5, 12.0);
            else bounded("denoise.strength", strength, 1.0, 10.0);
        }
        public String type() { return "denoise"; }
        public int order() { return 1; }
        public String filter() {
            if (method == DenoiseMethod.HQDN3D) {
                return "hqdn3d=" + fmt(strength) + ":" + fmt(strength * 0.75) + ":" + fmt(strength * 1.5) + ":"
                        + fmt(strength * 1.125);
            }
            return "nlmeans=s=" + fmt(strength) + ":p=5:pc=5:r=7:rc=7";
        }
        public Map<String, Object> view() {
            return Map.of("type", type(), "method", method.name().toLowerCase(Locale.ROOT), "strength", strength);
        }
    }

    public record Deblock(double strength) implements Operation {
        public Deblock { bounded("deblock.strength", strength, 0.02, 0.4); }
        public String type() { return "deblock"; }
        public int order() { return 2; }
        public String filter() {
            return "deblock=filter=strong:block=8:alpha=" + fmt(strength) + ":beta=" + fmt(strength / 2)
                    + ":gamma=" + fmt(strength / 2) + ":delta=" + fmt(strength / 2);
        }
        public Map<String, Object> view() { return Map.of("type", type(), "strength", strength); }
    }

    public record Sharpen(double amount) implements Operation {
        public Sharpen { bounded("sharpen.amount", amount, 0.1, 1.5); }
        public String type() { return "sharpen"; }
        public int order() { return 3; }
        public String filter() {
            return "unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=" + fmt(amount)
                    + ":chroma_msize_x=3:chroma_msize_y=3:chroma_amount=0";
        }
        public Map<String, Object> view() { return Map.of("type", type(), "amount", amount); }
    }

    public record ColourCorrection(double brightness, double contrast, double saturation, double gamma)
            implements Operation {
        public ColourCorrection {
            bounded("colourCorrection.brightness", brightness, -0.3, 0.3);
            bounded("colourCorrection.contrast", contrast, 0.5, 2.0);
            bounded("colourCorrection.saturation", saturation, 0.0, 2.5);
            bounded("colourCorrection.gamma", gamma, 0.5, 2.0);
        }
        public String type() { return "colourCorrection"; }
        public int order() { return 4; }
        public String filter() {
            return "eq=brightness=" + fmt(brightness) + ":contrast=" + fmt(contrast) + ":saturation=" + fmt(saturation)
                    + ":gamma=" + fmt(gamma);
        }
        public Map<String, Object> view() {
            return Map.of("type", type(), "brightness", brightness, "contrast", contrast, "saturation", saturation,
                    "gamma", gamma);
        }
    }

    /** Fixed, locale-independent decimal text for filter arguments (never request text). */
    static String fmt(double value) {
        return BigDecimal.valueOf(value).setScale(4, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
    }

    static String filterGraph(List<Operation> operations) {
        return operations.stream().sorted(Comparator.comparingInt(Operation::order)).map(Operation::filter)
                .reduce((a, b) -> a + "," + b).orElseThrow();
    }

    // ------------------------------------------------------------------ requests and results

    public record EnhanceRequest(String requestId, String artifactId, String artifactVersionId,
                                 List<Operation> operations, int crf) {
        public EnhanceRequest {
            requestId = boundedId(requestId);
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (operations == null || operations.isEmpty() || operations.size() > 5) {
                throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "operations",
                        "operations must contain between 1 and 5 entries");
            }
            Set<String> types = new LinkedHashSet<>();
            for (Operation operation : operations) {
                if (!types.add(operation.type())) {
                    throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "operations",
                            "each operation type may appear at most once");
                }
            }
            operations = operations.stream().sorted(Comparator.comparingInt(Operation::order)).toList();
            if (crf < 10 || crf > 30) {
                throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "encoder.crf",
                        "encoder.crf must be within [10, 30]");
            }
        }
    }

    public record SourceRef(String artifactId, String artifactVersionId) {
        public SourceRef {
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
        }
    }

    public record Subject(String label, SourceRef source) {
        public Subject {
            if (label == null || !label.matches("[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}")) {
                throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "subjects.label",
                        "label must be 1-64 characters of letters, digits, space, dot, colon, dash or underscore");
            }
        }
    }

    public record CompareRequest(String requestId, SourceRef reference, List<Subject> subjects) {
        public CompareRequest {
            requestId = boundedId(requestId);
            if (subjects == null || subjects.isEmpty() || subjects.size() > MAX_SUBJECTS) {
                throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "subjects",
                        "subjects must contain between 1 and " + MAX_SUBJECTS + " entries");
            }
            Set<String> labels = new LinkedHashSet<>();
            for (Subject subject : subjects) {
                if (!labels.add(subject.label())) {
                    throw new VideoParameterException("VIDEO_PARAMETER_OUT_OF_RANGE", "subjects.label",
                            "subject labels must be distinct");
                }
            }
            subjects = List.copyOf(subjects);
        }
    }

    /** Durable view of a registered output, reconstructible from the artifact alone. */
    public record VideoResult(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed,
                              Resolution admission) implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    /** A typed refusal with an HTTP status; carries no request content or process output. */
    public static final class VideoRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;
        VideoRefusedException(int status, String code, String message) { this(status, code, message, Map.of()); }
        VideoRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    /** The FFmpeg run did not finish (killed, timed out): the outcome is UNKNOWN and nothing was registered. */
    public static final class VideoOutcomeUnknownException extends RuntimeException {
        VideoOutcomeUnknownException(String phase) {
            super("the " + phase + " process did not finish; the outcome is unknown", null, false, false);
        }
    }

    public static final class VideoRightsNotAdmittedException extends RuntimeException {
        private final String code;
        private final Resolution resolution;
        private final String artifactId;
        VideoRightsNotAdmittedException(String code, Resolution resolution, String artifactId) {
            super("source rights/consent is not admitted for PROCESSING", null, false, false);
            this.code = code;
            this.resolution = resolution;
            this.artifactId = artifactId;
        }
        public String code() { return code; }
        public Resolution resolution() { return resolution; }
        public String artifactId() { return artifactId; }
    }

    public static final class VideoRequestReusedException extends IllegalStateException {
        VideoRequestReusedException() { super("video requestId was already used for a different request"); }
    }

    public static final class VideoRegistrationFailedException extends IllegalStateException {
        VideoRegistrationFailedException(Throwable cause) {
            super("video output could not be registered as an immutable artifact", cause);
        }
    }

    // ------------------------------------------------------------------ composition

    /** Runs one external process; the default is the bounded no-shell runner. Replaceable for fault injection. */
    interface ProcessPort {
        BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                        Path watchedFile, long watchedMaxBytes) throws IOException;

        /** Cancellable variant (J-19 search); a port that ignores the token simply cannot be cancelled. */
        default BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                                Path watchedFile, long watchedMaxBytes,
                                                BoundedProcessRunner.CancellationToken cancellation)
                throws IOException {
            return run(command, dir, timeout, maxStdout, watchedFile, watchedMaxBytes);
        }
    }

    private static final ProcessPort BOUNDED = new ProcessPort() {
        @Override
        public BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                               Path watched, long watchedMax) throws IOException {
            return run(command, dir, timeout, maxStdout, watched, watchedMax,
                    BoundedProcessRunner.CancellationToken.NEVER);
        }

        @Override
        public BoundedProcessRunner.Result run(List<String> command, Path dir, Duration timeout, int maxStdout,
                                               Path watched, long watchedMax,
                                               BoundedProcessRunner.CancellationToken cancellation) throws IOException {
            return BoundedProcessRunner.run(command, dir, Map.of(), timeout, maxStdout, 8192, cancellation, watched,
                    watchedMax);
        }
    };

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;
    private final ProcessPort processes;
    private final Duration encodeTimeout;
    private volatile String ffmpegVersion;

    MediaDevVideoRuntime(MediaRuntime runtime, Path ffmpeg, Path ffprobe, RightsConsentResolver rights,
                         MediaDevProjectRenderRuntime.OutputRegistrar registrar, MediaDevRequestLedger ledger,
                         ProcessPort processes, Duration encodeTimeout) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        if (ffmpeg == null || ffprobe == null || !ffmpeg.isAbsolute() || !ffprobe.isAbsolute()) {
            throw new IllegalArgumentException("ffmpeg and ffprobe must be absolute paths");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.processes = processes == null ? BOUNDED : processes;
        this.encodeTimeout = encodeTimeout == null ? DEFAULT_ENCODE_TIMEOUT : encodeTimeout;
    }

    /** Null when no absolute FFmpeg and FFprobe pair is configured; tools are never resolved through PATH. */
    static MediaDevVideoRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                        RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        if (ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) return null;
        return new MediaDevVideoRuntime(runtime, Path.of(ffmpeg), Path.of(ffprobe), rights,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger, null, null);
    }

    Path ffmpegPath() { return ffmpeg; }

    Duration encodeTimeout() { return encodeTimeout; }

    MediaRuntime mediaRuntime() { return runtime; }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enhancement", true);
        out.put("comparison", true);
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name()));
        out.put("scope", "DEV_ONLY");
        return out;
    }

    // ------------------------------------------------------------------ read

    /** Reopens a registered enhancement or comparison for its owner, or empty. */
    public Optional<VideoResult> reopen(String tenantId, String principalId, String artifactId, String schema) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> schema.equals(artifact.metadata().get("videoSchema")))
                .map(artifact -> new VideoResult(artifact, lineageOf(artifact), true, null));
    }

    private static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    // ------------------------------------------------------------------ enhancement

    public VideoResult enhance(String tenantId, String principalId, EnhanceRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "video_enhance", tenantId,
                () -> executeEnhance(tenantId, principalId, request));
    }

    private VideoResult executeEnhance(String tenantId, String principalId, EnhanceRequest request) {
        MediaArtifact source = source(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        Resolution resolution = admit(tenantId, source);
        requireVideo(source);
        if (source.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new VideoRefusedException(422, "VIDEO_LIMIT_EXCEEDED", "the source exceeds the byte ceiling");
        }
        String graph = filterGraph(request.operations());
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.video.enhance.v1", source.artifactId(),
                source.version().value(), source.sha256(), graph, request.crf());
        return ledger.run(tenantId, principalId, LANE_ENHANCE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, resolution, ENHANCEMENT_SCHEMA, LANE_ENHANCE),
                () -> produceEnhancement(tenantId, principalId, request, source, resolution, graph),
                result -> List.of(new OutputRef("result", result.artifact().artifactId(),
                        result.artifact().version().value())),
                VideoRequestReusedException::new);
    }

    private VideoResult replay(String tenantId, String principalId, List<OutputRef> outputs, Resolution resolution,
                               String schema, String lane) {
        OutputRef ref = outputs.getFirst();
        return reopen(tenantId, principalId, ref.artifactId(), schema)
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .map(found -> new VideoResult(found.artifact(), found.lineage(), true, resolution))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
    }

    private VideoResult produceEnhancement(String tenantId, String principalId, EnhanceRequest request,
                                           MediaArtifact source, Resolution resolution, String graph) {
        Path dir = privateTempDirectory();
        try {
            Path in = dir.resolve("in.bin");
            stage(tenantId, principalId, source, in);
            Probe before = probe(in, dir, MAX_ENHANCE_PIXELS, MAX_ENHANCE_FRAMES);
            Path out = dir.resolve("out.mp4");
            List<String> command = new ArrayList<>(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error",
                    "-xerror", "-i", in.toString(), "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
                    "-vf", graph, "-c:v", "libx264", "-preset", "medium", "-crf", Integer.toString(request.crf()),
                    "-pix_fmt", "yuv420p", "-threads", "4", "-fps_mode", "passthrough",
                    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", "-c:a", "copy"));
            if (before.timeBaseNum == 1) {
                command.addAll(List.of("-video_track_timescale", Long.toString(before.timeBaseDen)));
            }
            command.addAll(List.of("-y", out.toString()));
            BoundedProcessRunner.Result result = runProcess(command, dir, encodeTimeout, 1024, out, MAX_OUTPUT_BYTES,
                    "encode");
            if (result.end() == BoundedProcessRunner.End.WATCHED_FILE_TOO_LARGE) {
                throw new VideoRefusedException(422, "VIDEO_OUTPUT_LIMIT_EXCEEDED",
                        "the enhanced video would exceed the output byte ceiling");
            }
            classify(result, "encode", "VIDEO_ENCODE_FAILED");
            Probe after = probe(out, dir, MAX_ENHANCE_PIXELS, MAX_ENHANCE_FRAMES);
            Map<String, Object> timeline = verifyTimeline(before, after);
            Map<String, Object> audio = verifyAudio(in, out, before, after, dir);
            byte[] bytes = Files.readAllBytes(out);
            return registerEnhancement(tenantId, principalId, request, source, resolution, graph, before, timeline,
                    audio, bytes);
        } catch (IOException failure) {
            throw new VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered");
        } finally {
            deleteTree(dir);
        }
    }

    private Map<String, Object> verifyTimeline(Probe before, Probe after) {
        if (before.width != after.width || before.height != after.height) {
            throw new VideoRefusedException(422, "ENHANCEMENT_TIMELINE_MISMATCH",
                    "the enhanced video geometry differs from the source; nothing was registered");
        }
        List<Long> a = before.timeline.frames().stream().map(VideoTimeline.FrameTime::pts).toList();
        List<Long> b = after.timeline.frames().stream().map(VideoTimeline.FrameTime::pts).toList();
        if (a.size() != b.size()) {
            throw new VideoRefusedException(422, "ENHANCEMENT_TIMELINE_MISMATCH",
                    "the enhanced video frame count differs from the source; nothing was registered",
                    Map.of("sourceFrames", a.size(), "outputFrames", b.size()));
        }
        boolean samePts = before.timeBaseNum == after.timeBaseNum && before.timeBaseDen == after.timeBaseDen;
        for (int i = 0; i < a.size(); i++) {
            if (!equalInstants(a.get(i), before, b.get(i), after)) {
                throw new VideoRefusedException(422, "ENHANCEMENT_TIMELINE_MISMATCH",
                        "an enhanced frame presentation timestamp differs from the source; nothing was registered",
                        Map.of("frameIndex", i));
            }
            if (samePts && !a.get(i).equals(b.get(i))) samePts = false;
        }
        long sourceDuration = before.durationMicros;
        long outputDuration = after.durationMicros;
        long frameInterval = a.size() > 1 ? Math.max(1, before.timeline.ptsMicros(a.get(1) - a.get(0))) : 0;
        if (Math.abs(sourceDuration - outputDuration) > Math.max(frameInterval, 1_000)) {
            throw new VideoRefusedException(422, "ENHANCEMENT_TIMELINE_MISMATCH",
                    "the enhanced video duration differs from the source; nothing was registered",
                    Map.of("sourceDurationMicros", sourceDuration, "outputDurationMicros", outputDuration));
        }
        Map<String, Object> timeline = new LinkedHashMap<>();
        timeline.put("frameCount", a.size());
        timeline.put("width", before.width);
        timeline.put("height", before.height);
        timeline.put("sourceTimeBase", before.timeBaseNum + "/" + before.timeBaseDen);
        timeline.put("outputTimeBase", after.timeBaseNum + "/" + after.timeBaseDen);
        timeline.put("ptsIdenticalTicks", samePts);
        timeline.put("ptsEqualInstants", true);
        timeline.put("firstPtsMicros", before.timeline.ptsMicros(a.getFirst()));
        timeline.put("lastPtsMicros", before.timeline.ptsMicros(a.getLast()));
        timeline.put("sourceDurationMicros", sourceDuration);
        timeline.put("outputDurationMicros", outputDuration);
        timeline.put("verifiedBy", "ffprobe -show_frames on source and output");
        return timeline;
    }

    /** True when pts a (in time base A) and pts b (in time base B) are exactly the same instant. */
    private static boolean equalInstants(long a, Probe pa, long b, Probe pb) {
        BigInteger left = BigInteger.valueOf(a).multiply(BigInteger.valueOf(pa.timeBaseNum))
                .multiply(BigInteger.valueOf(pb.timeBaseDen));
        BigInteger right = BigInteger.valueOf(b).multiply(BigInteger.valueOf(pb.timeBaseNum))
                .multiply(BigInteger.valueOf(pa.timeBaseDen));
        return left.equals(right);
    }

    Map<String, Object> verifyAudio(Path in, Path out, Probe before, Probe after, Path dir) throws IOException {
        Map<String, Object> audio = new LinkedHashMap<>();
        if (before.audio.size() != after.audio.size() || !before.audio.equals(after.audio)) {
            throw new VideoRefusedException(422, "ENHANCEMENT_AUDIO_MISMATCH",
                    "the enhanced output audio streams differ from the source; nothing was registered");
        }
        audio.put("streams", before.audio.size());
        if (before.audio.isEmpty()) {
            audio.put("mode", "NONE");
            return audio;
        }
        String sourceMd5 = audioMd5(in, dir);
        String outputMd5 = audioMd5(out, dir);
        if (!sourceMd5.equals(outputMd5)) {
            throw new VideoRefusedException(422, "ENHANCEMENT_AUDIO_MISMATCH",
                    "the copied audio packets differ from the source; nothing was registered");
        }
        audio.put("mode", "STREAM_COPY");
        audio.put("packetsMd5", sourceMd5);
        audio.put("codecs", before.audio.stream().map(s -> s.get("codec")).toList());
        audio.put("sampleRates", before.audio.stream().map(s -> s.get("sampleRate")).toList());
        audio.put("channels", before.audio.stream().map(s -> s.get("channels")).toList());
        return audio;
    }

    private String audioMd5(Path file, Path dir) throws IOException {
        BoundedProcessRunner.Result result = runProcess(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v",
                "error", "-i", file.toString(), "-map", "0:a", "-c", "copy", "-f", "md5", "-"), dir, PROBE_TIMEOUT,
                4096, null, 0, "audio check");
        classify(result, "audio check", "ENHANCEMENT_AUDIO_MISMATCH");
        String text = new String(result.stdout(), StandardCharsets.US_ASCII).trim();
        if (!text.startsWith("MD5=") || text.length() != 36) {
            throw new VideoRefusedException(422, "ENHANCEMENT_AUDIO_MISMATCH", "the audio packets could not be hashed");
        }
        return text.substring(4);
    }

    private VideoResult registerEnhancement(String tenantId, String principalId, EnhanceRequest request,
                                            MediaArtifact source, Resolution resolution, String graph, Probe before,
                                            Map<String, Object> timeline, Map<String, Object> audio, byte[] bytes) {
        Map<String, Object> lineage = baseLineage(ENHANCEMENT_SCHEMA, KIND_ENHANCEMENT, request.requestId(),
                resolution, bytes);
        lineage.put("source", sourceRef(source));
        lineage.put("operations", request.operations().stream().map(Operation::view).toList());
        lineage.put("filterGraph", graph);
        Map<String, Object> encoder = new LinkedHashMap<>();
        encoder.put("videoCodec", "libx264");
        encoder.put("preset", "medium");
        encoder.put("crf", request.crf());
        encoder.put("pixelFormat", "yuv420p");
        encoder.put("threads", 4);
        encoder.put("container", "mp4");
        encoder.put("audio", "COPY");
        encoder.put("frameRateMode", "PASSTHROUGH_SOURCE_PTS");
        lineage.put("encoder", encoder);
        lineage.put("timeline", timeline);
        lineage.put("audio", audio);
        lineage.put("tools", Map.of("ffmpeg", ffmpegVersion()));
        lineage.put("claims", Map.of("quality", "NONE",
                "note", "Filter output only; use a measured comparison for numbers. No approval, rights or production claim."));
        return register(tenantId, principalId, "enhanced-" + shortHash(request.requestId()) + ".mp4", "video/mp4",
                KIND_ENHANCEMENT, request.requestId(), bytes, lineage, resolution);
    }

    // ------------------------------------------------------------------ comparison

    public VideoResult compare(String tenantId, String principalId, CompareRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "video_compare", tenantId,
                () -> executeCompare(tenantId, principalId, request));
    }

    private VideoResult executeCompare(String tenantId, String principalId, CompareRequest request) {
        List<MediaArtifact> subjectSources = new ArrayList<>();
        for (Subject subject : request.subjects()) {
            subjectSources.add(source(tenantId, principalId, subject.source().artifactId(),
                    subject.source().artifactVersionId()));
        }
        MediaArtifact reference = request.reference() == null ? null
                : source(tenantId, principalId, request.reference().artifactId(),
                        request.reference().artifactVersionId());
        Resolution resolution = null;
        Set<String> admitted = new LinkedHashSet<>();
        List<MediaArtifact> all = new ArrayList<>(subjectSources);
        if (reference != null) all.add(reference);
        for (MediaArtifact artifact : all) {
            requireVideo(artifact);
            if (artifact.sizeBytes() > MAX_SOURCE_BYTES) {
                throw new VideoRefusedException(422, "VIDEO_LIMIT_EXCEEDED", "a source exceeds the byte ceiling");
            }
            if (admitted.add(artifact.artifactId() + "@" + artifact.version().value())) {
                Resolution one = admit(tenantId, artifact);
                if (resolution == null) resolution = one;
            }
        }
        Resolution finalResolution = resolution;
        List<Object> parts = new ArrayList<>();
        parts.add("media.dev.video.compare.v1");
        parts.add(reference == null ? "none" : reference.artifactId() + "@" + reference.version().value() + "@"
                + reference.sha256());
        for (int i = 0; i < subjectSources.size(); i++) {
            MediaArtifact s = subjectSources.get(i);
            parts.add(request.subjects().get(i).label());
            parts.add(s.artifactId() + "@" + s.version().value() + "@" + s.sha256());
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.video.compare.v1", parts.toArray());
        return ledger.run(tenantId, principalId, LANE_COMPARE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, finalResolution, COMPARISON_SCHEMA, LANE_COMPARE),
                () -> produceComparison(tenantId, principalId, request, subjectSources, reference, finalResolution),
                result -> List.of(new OutputRef("result", result.artifact().artifactId(),
                        result.artifact().version().value())),
                VideoRequestReusedException::new);
    }

    /** One decoded luma sequence on disk: raw 8-bit grey frames in PTS order. */
    record Decoded(Probe probe, Path raw) { }

    private VideoResult produceComparison(String tenantId, String principalId, CompareRequest request,
                                          List<MediaArtifact> subjectSources, MediaArtifact referenceSource,
                                          Resolution resolution) {
        Path dir = privateTempDirectory();
        try {
            Decoded reference = referenceSource == null ? null : decode(tenantId, principalId, referenceSource, dir, "ref");
            List<Map<String, Object>> subjectViews = new ArrayList<>();
            List<Map<String, double[]>> perFrame = new ArrayList<>();
            for (int index = 0; index < subjectSources.size(); index++) {
                Decoded subject = decode(tenantId, principalId, subjectSources.get(index), dir, "s" + index);
                if (reference != null && (subject.probe.width != reference.probe.width
                        || subject.probe.height != reference.probe.height)) {
                    throw new VideoRefusedException(422, "VIDEO_GEOMETRY_MISMATCH",
                            "a subject and the reference have different frame sizes; a per-frame comparison "
                                    + "would need scaling, which is not performed",
                            Map.of("subject", request.subjects().get(index).label()));
                }
                Map<String, double[]> byPts = new LinkedHashMap<>();
                subjectViews.add(measure(request.subjects().get(index), subjectSources.get(index), subject, reference,
                        byPts));
                perFrame.add(byPts);
            }
            Map<String, Object> referenceStats = null;
            if (reference != null) referenceStats = noReferenceOnly(reference);
            List<Map<String, Object>> deltas = reference == null ? noReferenceDeltas(request, subjectViews)
                    : deltas(request, subjectViews, perFrame);
            return registerComparison(tenantId, principalId, request, subjectSources, referenceSource, resolution,
                    subjectViews, referenceStats, deltas);
        } catch (IOException failure) {
            throw new VideoRefusedException(503, "VIDEO_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered");
        } finally {
            deleteTree(dir);
        }
    }

    private Decoded decode(String tenantId, String principalId, MediaArtifact source, Path dir, String name)
            throws IOException {
        Path in = dir.resolve(name + ".bin");
        stage(tenantId, principalId, source, in);
        Probe probe = probe(in, dir, MAX_COMPARE_PIXELS, MAX_COMPARE_FRAMES);
        Decoded decoded = decodeLuma(in, probe, dir, name, BoundedProcessRunner.CancellationToken.NEVER);
        Files.deleteIfExists(in);
        return decoded;
    }

    /** Decodes the Y plane of an already staged and probed file into raw 8-bit grey frames in PTS order. */
    Decoded decodeLuma(Path in, Probe probe, Path dir, String name, BoundedProcessRunner.CancellationToken cancel)
            throws IOException {
        Path raw = dir.resolve(name + ".gray");
        long frameBytes = (long) probe.width * probe.height;
        long expected = frameBytes * probe.timeline.frames().size();
        BoundedProcessRunner.Result result = runProcess(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v",
                "error", "-xerror", "-i", in.toString(), "-map", "0:v:0", "-vf", "extractplanes=y", "-pix_fmt", "gray",
                "-f", "rawvideo", "-fps_mode", "passthrough", "-y", raw.toString()), dir, DECODE_TIMEOUT, 1024, raw,
                expected + frameBytes, "decode", cancel);
        if (result.end() == BoundedProcessRunner.End.WATCHED_FILE_TOO_LARGE) {
            throw new VideoRefusedException(422, "SOURCE_VIDEO_CORRUPT",
                    "the decoded frame data is larger than the probed timeline");
        }
        classify(result, "decode", "SOURCE_VIDEO_CORRUPT");
        if (Files.size(raw) != expected) {
            throw new VideoRefusedException(422, "SOURCE_VIDEO_CORRUPT",
                    "the decoded frame count differs from the probed timeline");
        }
        return new Decoded(probe, raw);
    }

    /** Reference frame position by exact rational instant, e.g. {@code "1/25"}. */
    static String instantKey(long pts, Probe probe) {
        BigInteger numerator = BigInteger.valueOf(pts).multiply(BigInteger.valueOf(probe.timeBaseNum));
        BigInteger denominator = BigInteger.valueOf(probe.timeBaseDen);
        BigInteger gcd = numerator.gcd(denominator);
        if (gcd.signum() == 0) gcd = BigInteger.ONE;
        return numerator.divide(gcd) + "/" + denominator.divide(gcd);
    }

    private Map<String, Object> measure(Subject subject, MediaArtifact source, Decoded decoded, Decoded reference,
                                        Map<String, double[]> byInstant) throws IOException {
        Probe probe = decoded.probe;
        int width = probe.width;
        int height = probe.height;
        int frameBytes = width * height;
        Map<String, Integer> referenceIndex = new HashMap<>();
        if (reference != null) {
            List<VideoTimeline.FrameTime> frames = reference.probe.timeline.frames();
            for (int i = 0; i < frames.size(); i++) referenceIndex.put(instantKey(frames.get(i).pts(), reference.probe), i);
        }
        List<Map<String, Object>> frames = new ArrayList<>();
        double psnrSum = 0, ssimSum = 0, noiseSum = 0, lapSum = 0, psnrMin = Double.MAX_VALUE, psnrMax = -1;
        double ssimMin = Double.MAX_VALUE, mseSum = 0;
        int aligned = 0;
        int identical = 0;
        byte[] a = new byte[frameBytes];
        byte[] b = new byte[frameBytes];
        try (RandomAccessFile subjectRaw = new RandomAccessFile(decoded.raw.toFile(), "r");
             RandomAccessFile referenceRaw = reference == null ? null
                     : new RandomAccessFile(reference.raw.toFile(), "r")) {
            List<VideoTimeline.FrameTime> sequence = probe.timeline.frames();
            for (int i = 0; i < sequence.size(); i++) {
                subjectRaw.seek((long) i * frameBytes);
                subjectRaw.readFully(a);
                long pts = sequence.get(i).pts();
                String key = instantKey(pts, probe);
                double noise = MediaDevVideoQualityMetrics.noiseSigma(a, width, height);
                double laplacian = MediaDevVideoQualityMetrics.laplacianVariance(a, width, height);
                noiseSum += noise;
                lapSum += laplacian;
                Map<String, Object> frame = new LinkedHashMap<>();
                frame.put("frameIndex", i);
                frame.put("pts", pts);
                frame.put("ptsMicros", probe.timeline.ptsMicros(pts));
                Integer match = referenceIndex.get(key);
                frame.put("aligned", match != null);
                double psnr = Double.NaN;
                double ssim = Double.NaN;
                if (match != null) {
                    referenceRaw.seek((long) match * frameBytes);
                    referenceRaw.readFully(b);
                    double mse = MediaDevVideoQualityMetrics.mse(a, b, frameBytes);
                    psnr = MediaDevVideoQualityMetrics.psnrFromMse(mse);
                    ssim = MediaDevVideoQualityMetrics.ssim(a, b, width, height);
                    aligned++;
                    if (mse == 0) identical++;
                    mseSum += mse;
                    psnrSum += psnr;
                    ssimSum += ssim;
                    psnrMin = Math.min(psnrMin, psnr);
                    psnrMax = Math.max(psnrMax, psnr);
                    ssimMin = Math.min(ssimMin, ssim);
                    frame.put("psnrY", round(psnr));
                    frame.put("ssimY", round6(ssim));
                }
                frame.put("noiseSigmaY", round(noise));
                frame.put("laplacianVarianceY", round(laplacian));
                frames.add(frame);
                byInstant.put(key, new double[] {psnr, ssim, noise, laplacian});
            }
        }
        int count = frames.size();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("label", subject.label());
        view.put("source", sourceRef(source));
        Map<String, Object> video = new LinkedHashMap<>();
        video.put("width", width);
        video.put("height", height);
        video.put("frameCount", count);
        video.put("timeBase", probe.timeBaseNum + "/" + probe.timeBaseDen);
        view.put("video", video);
        Map<String, Object> noReference = new LinkedHashMap<>();
        noReference.put("meanNoiseSigmaY", round(noiseSum / count));
        noReference.put("meanLaplacianVarianceY", round(lapSum / count));
        view.put("noReference", noReference);
        if (reference != null) {
            Map<String, Object> against = new LinkedHashMap<>();
            against.put("alignedFrames", aligned);
            against.put("unalignedSubjectFrames", count - aligned);
            against.put("unalignedReferenceFrames", reference.probe.timeline.frames().size() - aligned);
            against.put("fullyAligned", aligned == count && aligned == reference.probe.timeline.frames().size());
            if (aligned == 0) {
                throw new VideoRefusedException(422, "PTS_ALIGNMENT_FAILED",
                        "no subject frame has the same presentation instant as a reference frame",
                        Map.of("subject", subject.label()));
            }
            against.put("meanPsnrY", round(psnrSum / aligned));
            against.put("globalPsnrY", round(MediaDevVideoQualityMetrics.psnrFromMse(mseSum / aligned)));
            against.put("minPsnrY", round(psnrMin));
            against.put("maxPsnrY", round(psnrMax));
            against.put("meanSsimY", round6(ssimSum / aligned));
            against.put("minSsimY", round6(ssimMin));
            against.put("identicalFrames", identical);
            view.put("againstReference", against);
        }
        view.put("frames", frames);
        return view;
    }

    private Map<String, Object> noReferenceOnly(Decoded decoded) throws IOException {
        Probe probe = decoded.probe;
        int frameBytes = probe.width * probe.height;
        byte[] a = new byte[frameBytes];
        double noiseSum = 0, lapSum = 0;
        int count = probe.timeline.frames().size();
        try (RandomAccessFile raw = new RandomAccessFile(decoded.raw.toFile(), "r")) {
            for (int i = 0; i < count; i++) {
                raw.readFully(a);
                noiseSum += MediaDevVideoQualityMetrics.noiseSigma(a, probe.width, probe.height);
                lapSum += MediaDevVideoQualityMetrics.laplacianVariance(a, probe.width, probe.height);
            }
        }
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("frameCount", count);
        stats.put("meanNoiseSigmaY", round(noiseSum / count));
        stats.put("meanLaplacianVarianceY", round(lapSum / count));
        return stats;
    }

    private List<Map<String, Object>> deltas(CompareRequest request, List<Map<String, Object>> views,
                                             List<Map<String, double[]>> perFrame) {
        List<Map<String, Object>> deltas = new ArrayList<>();
        Map<String, Object> baseline = views.getFirst();
        @SuppressWarnings("unchecked") Map<String, Object> baseAgainst = (Map<String, Object>) baseline.get("againstReference");
        @SuppressWarnings("unchecked") Map<String, Object> baseNo = (Map<String, Object>) baseline.get("noReference");
        for (int i = 1; i < views.size(); i++) {
            @SuppressWarnings("unchecked") Map<String, Object> against = (Map<String, Object>) views.get(i).get("againstReference");
            @SuppressWarnings("unchecked") Map<String, Object> no = (Map<String, Object>) views.get(i).get("noReference");
            int psnrBetter = 0, psnrWorse = 0, ssimBetter = 0, ssimWorse = 0, common = 0;
            for (Map.Entry<String, double[]> entry : perFrame.get(i).entrySet()) {
                double[] mine = entry.getValue();
                double[] base = perFrame.getFirst().get(entry.getKey());
                if (base == null || Double.isNaN(mine[0]) || Double.isNaN(base[0])) continue;
                common++;
                if (mine[0] > base[0]) psnrBetter++; else if (mine[0] < base[0]) psnrWorse++;
                if (mine[1] > base[1]) ssimBetter++; else if (mine[1] < base[1]) ssimWorse++;
            }
            double dPsnr = ((Number) against.get("meanPsnrY")).doubleValue() - ((Number) baseAgainst.get("meanPsnrY")).doubleValue();
            double dSsim = ((Number) against.get("meanSsimY")).doubleValue() - ((Number) baseAgainst.get("meanSsimY")).doubleValue();
            Map<String, Object> delta = new LinkedHashMap<>();
            delta.put("subject", request.subjects().get(i).label());
            delta.put("baseline", request.subjects().getFirst().label());
            delta.put("comparedFrames", common);
            delta.put("meanPsnrYDeltaDb", round(dPsnr));
            delta.put("meanSsimYDelta", round6(dSsim));
            delta.put("globalPsnrYDeltaDb", round(((Number) against.get("globalPsnrY")).doubleValue()
                    - ((Number) baseAgainst.get("globalPsnrY")).doubleValue()));
            delta.put("meanNoiseSigmaYDelta", round(((Number) no.get("meanNoiseSigmaY")).doubleValue()
                    - ((Number) baseNo.get("meanNoiseSigmaY")).doubleValue()));
            delta.put("meanLaplacianVarianceYDelta", round(((Number) no.get("meanLaplacianVarianceY")).doubleValue()
                    - ((Number) baseNo.get("meanLaplacianVarianceY")).doubleValue()));
            delta.put("framesPsnrImproved", psnrBetter);
            delta.put("framesPsnrRegressed", psnrWorse);
            delta.put("framesSsimImproved", ssimBetter);
            delta.put("framesSsimRegressed", ssimWorse);
            delta.put("verdict", dPsnr > 0 && dSsim > 0 ? "IMPROVED" : dPsnr < 0 && dSsim < 0 ? "REGRESSED" : "MIXED");
            deltas.add(delta);
        }
        return deltas;
    }

    private List<Map<String, Object>> noReferenceDeltas(CompareRequest request, List<Map<String, Object>> views) {
        List<Map<String, Object>> deltas = new ArrayList<>();
        @SuppressWarnings("unchecked") Map<String, Object> baseNo = (Map<String, Object>) views.getFirst().get("noReference");
        for (int i = 1; i < views.size(); i++) {
            @SuppressWarnings("unchecked") Map<String, Object> no = (Map<String, Object>) views.get(i).get("noReference");
            Map<String, Object> delta = new LinkedHashMap<>();
            delta.put("subject", request.subjects().get(i).label());
            delta.put("baseline", request.subjects().getFirst().label());
            delta.put("meanNoiseSigmaYDelta", round(((Number) no.get("meanNoiseSigmaY")).doubleValue()
                    - ((Number) baseNo.get("meanNoiseSigmaY")).doubleValue()));
            delta.put("meanLaplacianVarianceYDelta", round(((Number) no.get("meanLaplacianVarianceY")).doubleValue()
                    - ((Number) baseNo.get("meanLaplacianVarianceY")).doubleValue()));
            delta.put("verdict", "NO_REFERENCE");
            deltas.add(delta);
        }
        return deltas;
    }

    private VideoResult registerComparison(String tenantId, String principalId, CompareRequest request,
                                           List<MediaArtifact> subjectSources, MediaArtifact referenceSource,
                                           Resolution resolution, List<Map<String, Object>> subjectViews,
                                           Map<String, Object> referenceStats, List<Map<String, Object>> deltas) {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", COMPARISON_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("kind", KIND_COMPARISON);
        document.put("requestId", request.requestId());
        Map<String, Object> method = new LinkedHashMap<>();
        method.put("plane", "Y (luma) of the decoded frame, 8-bit");
        method.put("psnr", "10*log10(255^2/MSE) per frame; identical frames are reported as 100 dB and counted");
        method.put("ssim", "mean SSIM over 8x8 uniform windows, stride 4, C1=(0.01*255)^2, C2=(0.03*255)^2");
        method.put("noiseSigma", "Immerkaer fast estimate; edges and texture inflate it");
        method.put("laplacianVariance", "variance of the 3x3 Laplacian; noise also inflates it");
        method.put("alignment", "frames paired by exact presentation instant (rational), not by index");
        method.put("implementation", "Java, independent of FFmpeg psnr/ssim filters");
        document.put("method", method);
        if (referenceSource != null) document.put("reference", sourceRef(referenceSource));
        if (referenceStats != null) document.put("referenceNoReference", referenceStats);
        document.put("subjects", subjectViews);
        document.put("comparisons", deltas);
        document.put("claims", Map.of("quality", "MEASURED_LUMA_ONLY",
                "note", "Luma PSNR/SSIM and no-reference estimates; not a perceptual, rights, approval or production claim."));
        byte[] bytes = jsonBytes(document);

        List<Map<String, Object>> summaries = new ArrayList<>();
        for (Map<String, Object> view : subjectViews) {
            Map<String, Object> summary = new LinkedHashMap<>(view);
            summary.remove("frames");
            summaries.add(summary);
        }
        Map<String, Object> lineage = baseLineage(COMPARISON_SCHEMA, KIND_COMPARISON, request.requestId(), resolution,
                bytes);
        List<Map<String, Object>> sources = new ArrayList<>();
        for (MediaArtifact source : subjectSources) sources.add(sourceRef(source));
        lineage.put("sources", sources);
        if (referenceSource != null) lineage.put("reference", sourceRef(referenceSource));
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("subjects", summaries);
        summary.put("comparisons", deltas);
        if (referenceStats != null) summary.put("referenceNoReference", referenceStats);
        lineage.put("summary", summary);
        lineage.put("claims", Map.of("quality", "MEASURED_LUMA_ONLY"));
        return register(tenantId, principalId, "video-comparison-" + shortHash(request.requestId()) + ".json",
                "application/json", KIND_COMPARISON, request.requestId(), bytes, lineage, resolution);
    }

    // ------------------------------------------------------------------ probing

    /** Everything the enhancement and comparison need to know about one video file. */
    static final class Probe {
        int width;
        int height;
        long timeBaseNum;
        long timeBaseDen;
        long durationMicros;
        VideoTimeline timeline;
        List<Map<String, Object>> audio = new ArrayList<>();
    }

    private Probe probe(Path file, Path dir, long maxPixels, int maxFrames) throws IOException {
        return probe(file, dir, maxPixels, maxFrames, BoundedProcessRunner.CancellationToken.NEVER);
    }

    Probe probe(Path file, Path dir, long maxPixels, int maxFrames, BoundedProcessRunner.CancellationToken cancel)
            throws IOException {
        BoundedProcessRunner.Result streams = runProcess(List.of(ffprobe.toString(), "-v", "error", "-show_entries",
                "stream=index,codec_type,codec_name,sample_rate,channels:stream_side_data=rotation:format=duration",
                "-of", "json", file.toString()), dir, PROBE_TIMEOUT, 4 * 1024 * 1024, null, 0, "probe", cancel);
        if (!streams.succeeded()) {
            if (streams.end() != BoundedProcessRunner.End.EXITED || streams.exitCode() >= 128) {
                throw new VideoOutcomeUnknownException("probe");
            }
            throw corrupt("the source could not be probed as a video container");
        }
        BoundedProcessRunner.Result frames = runProcess(List.of(ffprobe.toString(), "-v", "error", "-select_streams",
                "v:0", "-show_entries", "frame=pts,best_effort_timestamp:stream=width,height,time_base:stream_side_data=rotation",
                "-of", "json", file.toString()), dir, PROBE_TIMEOUT, 24 * 1024 * 1024, null, 0, "probe", cancel);
        if (!frames.succeeded()) {
            if (frames.end() != BoundedProcessRunner.End.EXITED || frames.exitCode() >= 128) {
                throw new VideoOutcomeUnknownException("probe");
            }
            throw corrupt("the source frames could not be read");
        }
        Probe probe = new Probe();
        try {
            JsonNode root = JSON.readTree(new String(streams.stdout(), StandardCharsets.UTF_8));
            int videoStreams = 0;
            for (JsonNode stream : root.path("streams")) {
                String type = stream.path("codec_type").asString("");
                if ("video".equals(type)) {
                    videoStreams++;
                    for (JsonNode side : stream.path("side_data_list")) {
                        if (side.has("rotation") && Math.round(side.path("rotation").asDouble(0)) != 0) {
                            throw new VideoRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                                    "a rotated video (display matrix) is not supported; nothing was processed");
                        }
                    }
                } else if ("audio".equals(type)) {
                    Map<String, Object> audio = new LinkedHashMap<>();
                    audio.put("codec", stream.path("codec_name").asString(""));
                    audio.put("sampleRate", stream.path("sample_rate").asString(""));
                    audio.put("channels", stream.path("channels").asInt(0));
                    probe.audio.add(audio);
                }
            }
            if (videoStreams == 0) throw corrupt("the source has no video stream");
            double seconds = Double.parseDouble(root.path("format").path("duration").asString("0"));
            probe.durationMicros = Math.round(seconds * 1_000_000.0);
            probe.timeline = VideoTimeline.parse(new String(frames.stdout(), StandardCharsets.UTF_8));
        } catch (VideoTimeline.TimelineException | NumberFormatException failure) {
            throw corrupt("the video timeline is not usable");
        }
        probe.width = probe.timeline.width();
        probe.height = probe.timeline.height();
        probe.timeBaseNum = probe.timeline.timeBaseNum();
        probe.timeBaseDen = probe.timeline.timeBaseDen();
        if ((long) probe.width * probe.height > maxPixels) {
            throw new VideoRefusedException(422, "VIDEO_LIMIT_EXCEEDED", "the frame size exceeds the pixel ceiling");
        }
        if (probe.timeline.frames().size() > maxFrames) {
            throw new VideoRefusedException(422, "VIDEO_LIMIT_EXCEEDED", "the video has more frames than the ceiling");
        }
        return probe;
    }

    private static VideoRefusedException corrupt(String message) {
        return new VideoRefusedException(422, "SOURCE_VIDEO_CORRUPT", message + "; nothing was processed");
    }

    // ------------------------------------------------------------------ process and registration helpers

    private BoundedProcessRunner.Result runProcess(List<String> command, Path dir, Duration timeout, int maxStdout,
                                                   Path watched, long watchedMax, String phase) throws IOException {
        return processes.run(command, dir, timeout, maxStdout, watched, watchedMax);
    }

    BoundedProcessRunner.Result runProcess(List<String> command, Path dir, Duration timeout, int maxStdout,
                                           Path watched, long watchedMax, String phase,
                                           BoundedProcessRunner.CancellationToken cancellation) throws IOException {
        return processes.run(command, dir, timeout, maxStdout, watched, watchedMax, cancellation);
    }

    /** Throws unless FFmpeg exited 0. A signal exit or a timeout is UNKNOWN; any other exit is a typed failure. */
    static void classify(BoundedProcessRunner.Result result, String phase, String failureCode) {
        if (result.succeeded()) return;
        boolean signalled = result.end() == BoundedProcessRunner.End.EXITED && (result.exitCode() >= 128
                || result.exitCode() < 0);
        if (result.end() == BoundedProcessRunner.End.TIMED_OUT || result.end() == BoundedProcessRunner.End.CANCELLED
                || signalled) {
            throw new VideoOutcomeUnknownException(phase);
        }
        throw new VideoRefusedException(422, failureCode,
                "the " + phase + " step failed on this input; nothing was registered");
    }

    String ffmpegVersion() {
        String known = ffmpegVersion;
        if (known != null) return known;
        try {
            BoundedProcessRunner.Result result = BOUNDED.run(List.of(ffmpeg.toString(), "-version"), null,
                    Duration.ofSeconds(20), 8192, null, 0);
            String first = new String(result.stdout(), StandardCharsets.UTF_8).lines().findFirst().orElse("ffmpeg");
            known = first.length() > 120 ? first.substring(0, 120) : first;
        } catch (IOException failure) {
            known = "ffmpeg (version unavailable)";
        }
        ffmpegVersion = known;
        return known;
    }

    MediaArtifact source(String tenantId, String principalId, String artifactId, String versionId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
    }

    Resolution admit(String tenantId, MediaArtifact source) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, source.artifactId(), source.version().value(),
                    source.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (!resolution.admitted()) {
            throw new VideoRightsNotAdmittedException(resolution.verdict() == Verdict.UNAVAILABLE
                    ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_" + resolution.verdict().name(), resolution,
                    source.artifactId());
        }
        return resolution;
    }

    static void requireVideo(MediaArtifact source) {
        if (!source.contentType().toLowerCase(Locale.ROOT).startsWith("video/")) {
            throw new VideoRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "a video/* artifact version is required");
        }
    }

    void stage(String tenantId, String principalId, MediaArtifact source, Path target) throws IOException {
        try (OutputStream out = Files.newOutputStream(target)) {
            runtime.copyArtifactContent(tenantId, principalId, source.artifactId(), source.version(), out,
                    MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        }
    }

    static Map<String, Object> sourceRef(MediaArtifact source) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("artifactId", source.artifactId());
        ref.put("artifactVersionId", source.version().value());
        ref.put("sha256", source.sha256());
        ref.put("contentType", source.contentType());
        return ref;
    }

    static Map<String, Object> baseLineage(String schema, String kind, String requestId, Resolution resolution,
                                                   byte[] bytes) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("videoSchema", schema);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("requestId", requestId);
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("verdict", resolution.verdict().name());
        rightsDecision.put("resolverId", resolution.resolverId());
        rightsDecision.put("productionGrant", false);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("resultSha256", MediaDevProjectRenderRuntime.sha256Hex(bytes));
        return lineage;
    }

    VideoResult register(String tenantId, String principalId, String fileName, String contentType, String kind,
                                 String requestId, byte[] bytes, Map<String, Object> lineage, Resolution resolution) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "video-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, fileName, contentType, bytes.length, sha256,
                "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-video:" + kind + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new VideoRequestReusedException();
            }
            logRegistrationFailure(kind, conflict);
            throw new VideoRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            logRegistrationFailure(kind, failure);
            throw new VideoRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new VideoRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new VideoResult(artifact, lineage, registered.replayed(), resolution);
    }

    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(MediaDevVideoRuntime.class);

    private static void logRegistrationFailure(String kind, RuntimeException failure) {
        String message = String.valueOf(failure.getMessage());
        LOG.warn("DEV video output registration failed kind={} cause={} message={}", kind,
                failure.getClass().getSimpleName(), message.length() > 200 ? message.substring(0, 200) : message);
    }

    static byte[] jsonBytes(Object document) {
        try {
            return JSON.writeValueAsString(document).getBytes(StandardCharsets.UTF_8);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("comparison document could not be serialized", failure);
        }
    }

    static double round(double value) { return Math.round(value * 10_000.0) / 10_000.0; }

    static double round6(double value) { return Math.round(value * 1_000_000.0) / 1_000_000.0; }

    static String shortHash(String value) {
        return MediaDevProjectRenderRuntime.sha256Hex(value).substring(0, 12);
    }

    static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-video-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) under the OS temp root
        }
    }

    static String boundedId(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("requestId must be a 1-128 character opaque id");
        }
        return value;
    }
}
