package com.ghatana.media.production.rendering;

import com.ghatana.media.production.rendering.BoundedProcessRunner.CancellationToken;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.MappedFrame;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Modality;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Plan;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Time;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Bounded FFmpeg-backed renderer for the supported subset of a {@link MultitrackRenderPlanner.Plan}.
 *
 * <h2>Supported scope</h2>
 * <ul>
 *   <li>VIDEO clips whose sources are PNG stills (one PNG per planned source frame), contiguous on the
 *       timeline from 0, each first frame at the clip's source start, all PNGs one even-sized geometry,
 *       every frame boundary an exact multiple of one microsecond. Each frame is shown from its mapped
 *       timeline PTS until the next frame (or the clip end); variable frame durations are preserved.</li>
 *   <li>At most one AUDIO clip: 16-bit PCM mono/stereo WAV starting at timeline 0, any source start.</li>
 *   <li>Non-overlapping captions with millisecond-exact times, emitted as embedded mov_text and a
 *       sidecar WebVTT file.</li>
 * </ul>
 * Transitions, GRAPHIC clips, overlapping/gapped video, multiple audio clips, and sub-resolution times
 * return a typed {@link Outcome#UNSUPPORTED} result; nothing is approximated.
 *
 * <p>Source binding: for a VIDEO clip {@code sourceSha256} is the SHA-256 of the concatenated PNG bytes
 * in frame order; for an AUDIO clip it is the SHA-256 of the WAV file. The host {@link SourceProvider}
 * owns authorization; this class verifies digests, structure and counts.
 */
public final class FfmpegMultitrackRenderer implements MultitrackRenderPlanner.CodecPipeline {
    public static final int MAX_STDOUT_BYTES = 8 * 1024 * 1024;
    public static final int MAX_STDERR_BYTES = 16 * 1024;
    public static final long MAX_TOTAL_SOURCE_BYTES = 256L * 1024 * 1024;
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final Set<Integer> AAC_RATES = Set.of(8000, 11025, 16000, 22050, 24000, 32000, 44100,
            48000, 64000, 88200, 96000);

    public enum Outcome { COMPLETED, NOT_ADMITTED, UNSUPPORTED, UNAVAILABLE, CANCELLED, FAILED }

    public enum Reason {
        PIPELINE_NOT_ADMITTED,
        TOOL_UNAVAILABLE, ENCODER_UNAVAILABLE,
        UNSUPPORTED_TRANSITION, UNSUPPORTED_GRAPHIC_CLIP, UNSUPPORTED_AUDIO_LAYOUT, UNSUPPORTED_VIDEO_TIMELINE,
        UNSUPPORTED_TIME_PRECISION, UNSUPPORTED_FRAME_GEOMETRY, UNSUPPORTED_CAPTIONS, UNSUPPORTED_AUDIO_FORMAT,
        NO_VIDEO,
        SOURCE_UNAVAILABLE, SOURCE_DIGEST_MISMATCH, SOURCE_INVALID,
        TIMEOUT, OUTPUT_BUDGET_EXCEEDED, CANCELLED, PROCESS_FAILED, VERIFICATION_FAILED, OUTPUT_EXISTS, IO_ERROR
    }

    /**
     * @param ffmpeg absolute path of the ffmpeg executable (never resolved through PATH)
     * @param ffprobe absolute path of the ffprobe executable
     * @param tempRoot existing directory under which a private per-render directory is created
     * @param environment explicit environment for the tools (the process environment is otherwise empty)
     * @param admitted host admission decision for this pipeline
     */
    public record Config(Path ffmpeg, Path ffprobe, Path tempRoot, Map<String, String> environment,
            Duration probeTimeout, Duration renderTimeout, boolean admitted) {
        public Config {
            Objects.requireNonNull(ffmpeg, "ffmpeg");
            Objects.requireNonNull(ffprobe, "ffprobe");
            Objects.requireNonNull(tempRoot, "tempRoot");
            environment = Map.copyOf(Objects.requireNonNull(environment, "environment"));
            Objects.requireNonNull(probeTimeout, "probeTimeout");
            Objects.requireNonNull(renderTimeout, "renderTimeout");
            if (!ffmpeg.isAbsolute() || !ffprobe.isAbsolute() || !tempRoot.isAbsolute()) {
                throw new IllegalArgumentException("ffmpeg, ffprobe and tempRoot must be absolute paths");
            }
            if (probeTimeout.isZero() || probeTimeout.isNegative() || renderTimeout.isZero()
                    || renderTimeout.isNegative()) {
                throw new IllegalArgumentException("timeouts must be positive");
            }
        }
    }

    /** Identity of one clip's source as recorded in the plan. */
    public record ClipSource(String clipId, String artifactId, String version, String sha256, int frameCount) { }

    /** Host adapter that returns exact source bytes; failures must throw {@link IOException}. */
    public interface SourceProvider {
        /** One PNG per planned frame, in frame order. */
        List<byte[]> readVideoFrames(ClipSource clip) throws IOException;

        /** The complete WAV file. */
        byte[] readAudio(ClipSource clip) throws IOException;
    }

    public record Verification(int streamCount, String videoCodec, String audioCodec, String subtitleCodec,
            int videoFrameCount, int width, int height, int captionCueCount, double containerDurationSeconds,
            double expectedDurationSeconds, double toleranceSeconds, boolean videoPtsExact) { }

    public record Result(Outcome outcome, Reason reason, String detail, Path outputPath, Path captionsSidecarPath,
            String outputSha256, long outputBytes, String ffmpegVersion, String ffprobeVersion,
            Verification verification, long toolStderrBytes, String toolStderrSha256) {
        boolean completed() { return outcome == Outcome.COMPLETED; }
    }

    private final Config config;
    private volatile String ffmpegVersion;
    private volatile String ffprobeVersion;
    private volatile boolean capabilitiesChecked;

    public FfmpegMultitrackRenderer(Config config) {
        this.config = Objects.requireNonNull(config, "config");
    }

    @Override public boolean admitted() { return config.admitted(); }

    @Override public boolean available() { return probeTools() == null; }

    // ------------------------------------------------------------------------------------------ render

    public Result render(Plan plan, SourceProvider sources, Path outputDirectory, CancellationToken cancellation) {
        Objects.requireNonNull(plan, "plan");
        Objects.requireNonNull(sources, "sources");
        Objects.requireNonNull(outputDirectory, "outputDirectory");
        CancellationToken token = cancellation == null ? CancellationToken.NEVER : cancellation;
        if (!config.admitted()) return refuse(Outcome.NOT_ADMITTED, Reason.PIPELINE_NOT_ADMITTED, "pipeline not admitted");

        Analysis analysis;
        try {
            analysis = analyze(plan);
        } catch (Unsupported u) {
            return refuse(Outcome.UNSUPPORTED, u.reason, u.getMessage());
        }

        Result unavailable = probeTools();
        if (unavailable != null) return unavailable;
        if (token.isCancelled()) return refuse(Outcome.CANCELLED, Reason.CANCELLED, "cancelled before start");

        String base = plan.manifestSha256();
        Path finalVideo = outputDirectory.resolve(base + ".mp4");
        Path finalCaptions = outputDirectory.resolve(base + ".vtt");
        if (!Files.isDirectory(outputDirectory, LinkOption.NOFOLLOW_LINKS)) {
            return fail(Reason.IO_ERROR, "output directory is not a directory");
        }
        if (Files.exists(finalVideo, LinkOption.NOFOLLOW_LINKS)
                || (analysis.captions.size() > 0 && Files.exists(finalCaptions, LinkOption.NOFOLLOW_LINKS))) {
            return fail(Reason.OUTPUT_EXISTS, "output already exists");
        }

        Path temp = null;
        try {
            temp = Files.createTempDirectory(config.tempRoot(), "mux-");
            return renderIn(temp, analysis, plan, sources, token, finalVideo, finalCaptions);
        } catch (Unsupported u) {
            return refuse(Outcome.UNSUPPORTED, u.reason, u.getMessage());
        } catch (IOException e) {
            return fail(Reason.IO_ERROR, "temporary storage failure");
        } finally {
            if (temp != null) deleteTree(temp);
        }
    }

    private Result renderIn(Path temp, Analysis a, Plan plan, SourceProvider sources, CancellationToken token,
            Path finalVideo, Path finalCaptions) throws IOException {
        // 1. Source acquisition and validation.
        long totalBytes = 0;
        // The image2 demuxer inside concat otherwise quantizes PTS to 1/25 s; a 1 MHz frame rate keeps the
        // microsecond-exact durations. "option" directives require -safe 0, which is acceptable because the
        // list contains only generated relative names inside the private temp directory.
        List<String> concat = new ArrayList<>(List.of("ffconcat version 1.0"));
        int frameNo = 0;
        int width = -1, height = -1;
        List<VideoClip> videoClips = a.videoClips;
        for (int c = 0; c < videoClips.size(); c++) {
            VideoClip clip = videoClips.get(c);
            ClipSource ref = new ClipSource(clip.line.id, clip.line.artifact, clip.line.version, clip.line.sha,
                    clip.frames.size());
            List<byte[]> pngs;
            try {
                pngs = sources.readVideoFrames(ref);
            } catch (IOException | RuntimeException e) {
                return fail(Reason.SOURCE_UNAVAILABLE, "video source unavailable");
            }
            if (pngs == null || pngs.size() != clip.frames.size()) {
                return fail(Reason.SOURCE_INVALID, "video source frame count differs from plan");
            }
            MessageDigest digest = sha256Digest();
            for (byte[] png : pngs) {
                if (png == null) return fail(Reason.SOURCE_INVALID, "video source frame missing");
                digest.update(png);
                totalBytes += png.length;
            }
            if (totalBytes > MAX_TOTAL_SOURCE_BYTES) return fail(Reason.SOURCE_INVALID, "source bytes exceed bound");
            if (!HexFormat.of().formatHex(digest.digest()).equals(clip.line.sha)) {
                return fail(Reason.SOURCE_DIGEST_MISMATCH, "video source digest differs from plan");
            }
            for (int i = 0; i < pngs.size(); i++) {
                int[] dims;
                try {
                    dims = validatePng(pngs.get(i), frameNo);
                } catch (IllegalArgumentException invalid) {
                    return fail(Reason.SOURCE_INVALID, "video source frame is not a valid PNG");
                }
                if (dims[0] % 2 != 0 || dims[1] % 2 != 0) {
                    return refuse(Outcome.UNSUPPORTED, Reason.UNSUPPORTED_FRAME_GEOMETRY, "frame dimensions must be even");
                }
                if (width < 0) { width = dims[0]; height = dims[1]; }
                else if (width != dims[0] || height != dims[1]) {
                    return refuse(Outcome.UNSUPPORTED, Reason.UNSUPPORTED_FRAME_GEOMETRY, "frame dimensions differ");
                }
                String name = "f" + frameNo + ".png";
                Files.write(temp.resolve(name), pngs.get(i));
                concat.add("file '" + name + "'");
                concat.add("option framerate " + MICROS_PER_SECOND);
                concat.add("duration " + micros(clip.durations.get(i)));
                frameNo++;
            }
        }
        // Repeat the last file so its duration is honoured; -t trims the repeated frame.
        concat.add(concat.get(concat.size() - 3));
        concat.add(concat.get(concat.size() - 3));
        Files.write(temp.resolve("video.ffconcat"), concat, StandardCharsets.UTF_8);

        WavInfo wav = null;
        if (a.audio != null) {
            ClipSource ref = new ClipSource(a.audio.id, a.audio.artifact, a.audio.version, a.audio.sha, 1);
            byte[] wavBytes;
            try {
                wavBytes = sources.readAudio(ref);
            } catch (IOException | RuntimeException e) {
                return fail(Reason.SOURCE_UNAVAILABLE, "audio source unavailable");
            }
            if (wavBytes == null) return fail(Reason.SOURCE_INVALID, "audio source missing");
            totalBytes += wavBytes.length;
            if (totalBytes > MAX_TOTAL_SOURCE_BYTES) return fail(Reason.SOURCE_INVALID, "source bytes exceed bound");
            if (!HexFormat.of().formatHex(sha256Digest().digest(wavBytes)).equals(a.audio.sha)) {
                return fail(Reason.SOURCE_DIGEST_MISMATCH, "audio source digest differs from plan");
            }
            try {
                wav = parseWav(wavBytes);
            } catch (IllegalArgumentException invalid) {
                return fail(Reason.SOURCE_INVALID, "audio source is not valid PCM WAV");
            }
            if (!AAC_RATES.contains(wav.rate)) {
                return refuse(Outcome.UNSUPPORTED, Reason.UNSUPPORTED_AUDIO_FORMAT, "unsupported sample rate");
            }
            // sourceEnd must lie inside the WAV: sourceEnd * rate <= frames
            if (a.audio.sourceEnd.numerator() * wav.rate > wav.frames * a.audio.sourceEnd.denominator()) {
                return fail(Reason.SOURCE_INVALID, "audio source shorter than the selected interval");
            }
            Files.write(temp.resolve("audio.wav"), wavBytes);
        }
        if (!a.captions.isEmpty()) {
            Files.writeString(temp.resolve("captions.vtt"), webVtt(a.captions), StandardCharsets.UTF_8);
        }

        // 2. Encode.
        Path out = temp.resolve("out.mp4");
        long budget = plan.declaredOutputBudgetBytes();
        long sidecarBytes = a.captions.isEmpty() ? 0 : Files.size(temp.resolve("captions.vtt"));
        if (sidecarBytes >= budget) return fail(Reason.OUTPUT_BUDGET_EXCEEDED, "output budget exceeded");
        long videoBudget = budget - sidecarBytes;
        List<String> cmd = new ArrayList<>(List.of(config.ffmpeg().toString(), "-nostdin", "-hide_banner",
                "-loglevel", "error", "-nostats", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file", "-i", "video.ffconcat"));
        int next = 1;
        int audioIdx = -1, subIdx = -1;
        if (wav != null) { cmd.addAll(List.of("-i", "audio.wav")); audioIdx = next++; }
        if (!a.captions.isEmpty()) { cmd.addAll(List.of("-f", "webvtt", "-i", "captions.vtt")); subIdx = next++; }
        cmd.addAll(List.of("-map", "0:v:0"));
        if (audioIdx >= 0) cmd.addAll(List.of("-map", audioIdx + ":a:0"));
        if (subIdx >= 0) cmd.addAll(List.of("-map", subIdx + ":s:0"));
        cmd.addAll(List.of("-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-bf", "0", "-g", "250",
                "-fps_mode", "passthrough", "-video_track_timescale", String.valueOf(MICROS_PER_SECOND)));
        if (audioIdx >= 0) {
            cmd.addAll(List.of("-c:a", "aac", "-b:a", "128k", "-af",
                    "atrim=start=" + nanos(a.audio.sourceStart) + ":end=" + nanos(a.audio.sourceEnd)
                            + ",asetpts=PTS-STARTPTS"));
        }
        if (subIdx >= 0) cmd.addAll(List.of("-c:s", "mov_text"));
        cmd.addAll(List.of("-t", nanos(plan.duration()), "-fs", String.valueOf(videoBudget + 1),
                "-movflags", "+faststart", "-f", "mp4", out.toString()));

        BoundedProcessRunner.Result run;
        try {
            run = BoundedProcessRunner.run(cmd, temp, config.environment(), config.renderTimeout(),
                    0, MAX_STDERR_BYTES, token, out, videoBudget);
        } catch (IOException e) {
            return refuse(Outcome.UNAVAILABLE, Reason.TOOL_UNAVAILABLE, "ffmpeg could not be started");
        }
        switch (run.end()) {
            case TIMED_OUT: return withStderr(fail(Reason.TIMEOUT, "render exceeded wall-clock limit"), run);
            case CANCELLED: return withStderr(refuse(Outcome.CANCELLED, Reason.CANCELLED, "render cancelled"), run);
            case WATCHED_FILE_TOO_LARGE:
                return withStderr(fail(Reason.OUTPUT_BUDGET_EXCEEDED, "output budget exceeded"), run);
            case STDOUT_OVERFLOW: return withStderr(fail(Reason.PROCESS_FAILED, "tool output exceeded bound"), run);
            default: break;
        }
        if (run.exitCode() != 0 || !Files.isRegularFile(out, LinkOption.NOFOLLOW_LINKS)) {
            return withStderr(fail(Reason.PROCESS_FAILED, "ffmpeg exited unsuccessfully"), run);
        }
        long outBytes = Files.size(out);
        if (outBytes > videoBudget) return withStderr(fail(Reason.OUTPUT_BUDGET_EXCEEDED, "output budget exceeded"), run);

        // 3. Independent verification with ffprobe.
        Verification v;
        try {
            v = verify(out, a, wav, width, height, token);
        } catch (VerificationFailure f) {
            return withStderr(fail(f.reason, f.getMessage()), run);
        }

        // 4. Hash and publish (no overwrite).
        String sha = sha256File(out);
        try {
            Files.move(out, finalVideo);
            if (!a.captions.isEmpty()) Files.move(temp.resolve("captions.vtt"), finalCaptions);
        } catch (java.nio.file.FileAlreadyExistsException exists) {
            return fail(Reason.OUTPUT_EXISTS, "output already exists");
        }
        return new Result(Outcome.COMPLETED, null, "rendered and verified", finalVideo,
                a.captions.isEmpty() ? null : finalCaptions, sha, outBytes, ffmpegVersion, ffprobeVersion, v,
                run.stderrBytes(), run.stderrSha256());
    }

    // ---------------------------------------------------------------------------------- verification

    private static final class VerificationFailure extends Exception {
        final Reason reason;
        VerificationFailure(String message) { super(message); this.reason = Reason.VERIFICATION_FAILED; }
    }

    private Verification verify(Path file, Analysis a, WavInfo wav, int width, int height, CancellationToken token)
            throws VerificationFailure, IOException {
        BoundedProcessRunner.Result probe = BoundedProcessRunner.run(List.of(config.ffprobe().toString(), "-v", "error",
                "-of", "compact", "-show_entries",
                "stream=index,codec_name,codec_type,width,height,pix_fmt,sample_rate,channels,duration,time_base,start_time"
                        + ":packet=stream_index,pts,size:format=format_name,duration,size,nb_streams",
                file.toString()), file.getParent(), config.environment(), config.probeTimeout(), MAX_STDOUT_BYTES,
                MAX_STDERR_BYTES, token, null, 0);
        if (!probe.succeeded()) throw new VerificationFailure("ffprobe could not decode the output");
        Map<Integer, Map<String, String>> streams = new TreeMap<>();
        List<long[]> videoPts = new ArrayList<>();
        Map<Integer, Integer> packets = new TreeMap<>();
        int subtitleCues = 0;
        Map<String, String> format = Map.of();
        Map<Integer, String> types = new TreeMap<>();
        List<Object[]> rawPackets = new ArrayList<>();
        for (String line : new String(probe.stdout(), StandardCharsets.UTF_8).split("\n")) {
            if (line.isBlank()) continue;
            String[] parts = line.split("\\|");
            Map<String, String> kv = new java.util.HashMap<>();
            for (int i = 1; i < parts.length; i++) {
                int eq = parts[i].indexOf('=');
                if (eq > 0) kv.put(parts[i].substring(0, eq), parts[i].substring(eq + 1));
            }
            switch (parts[0]) {
                case "stream" -> {
                    int idx = Integer.parseInt(kv.get("index"));
                    streams.put(idx, kv);
                    types.put(idx, kv.get("codec_type"));
                }
                case "packet" -> rawPackets.add(new Object[] {Integer.parseInt(kv.get("stream_index")),
                        kv.get("pts"), kv.get("size")});
                case "format" -> format = kv;
                default -> { }
            }
        }
        int expectedStreams = 1 + (wav != null ? 1 : 0) + (a.captions.isEmpty() ? 0 : 1);
        if (streams.size() != expectedStreams || !String.valueOf(expectedStreams).equals(format.get("nb_streams"))) {
            throw new VerificationFailure("stream count differs from the plan");
        }
        Map<String, String> video = null, audio = null, sub = null;
        for (Map<String, String> s : streams.values()) {
            switch (String.valueOf(s.get("codec_type"))) {
                case "video" -> video = video == null ? s : null;
                case "audio" -> audio = audio == null ? s : null;
                case "subtitle" -> sub = sub == null ? s : null;
                default -> throw new VerificationFailure("unexpected stream type");
            }
        }
        if (video == null || !"h264".equals(video.get("codec_name"))) throw new VerificationFailure("video codec mismatch");
        if (!"yuv420p".equals(video.get("pix_fmt"))
                || !String.valueOf(width).equals(video.get("width")) || !String.valueOf(height).equals(video.get("height"))) {
            throw new VerificationFailure("video geometry or pixel format mismatch");
        }
        if ((wav != null) != (audio != null) || (wav != null && !"aac".equals(audio.get("codec_name")))) {
            throw new VerificationFailure("audio stream mismatch");
        }
        if (wav != null && (!String.valueOf(wav.rate).equals(audio.get("sample_rate"))
                || !String.valueOf(wav.channels).equals(audio.get("channels")))) {
            throw new VerificationFailure("audio format mismatch");
        }
        if ((!a.captions.isEmpty()) != (sub != null) || (sub != null && !"mov_text".equals(sub.get("codec_name")))) {
            throw new VerificationFailure("caption stream mismatch");
        }
        int videoIdx = Integer.parseInt(video.get("index"));
        int subIdx = sub == null ? -1 : Integer.parseInt(sub.get("index"));
        String[] tb = video.get("time_base").split("/");
        BigInteger tbN = new BigInteger(tb[0]), tbD = new BigInteger(tb[1]);
        for (Object[] p : rawPackets) {
            int si = (Integer) p[0];
            if (si == videoIdx) {
                if ("N/A".equals(p[1]) || p[1] == null) throw new VerificationFailure("video packet without PTS");
                videoPts.add(new long[] {Long.parseLong((String) p[1])});
            } else if (si == subIdx && p[2] != null && Integer.parseInt((String) p[2]) > 2) {
                subtitleCues++;
            }
        }
        videoPts.sort(Comparator.comparingLong(x -> x[0]));
        if (videoPts.size() != a.frames.size()) throw new VerificationFailure("video frame count differs from the plan");
        boolean exact = true;
        for (int i = 0; i < videoPts.size(); i++) {
            Time expected = a.frames.get(i).timelinePts();
            // pts * tbN / tbD == expected.n / expected.d
            BigInteger lhs = BigInteger.valueOf(videoPts.get(i)[0]).multiply(tbN)
                    .multiply(BigInteger.valueOf(expected.denominator()));
            BigInteger rhs = BigInteger.valueOf(expected.numerator()).multiply(tbD);
            if (!lhs.equals(rhs)) { exact = false; break; }
        }
        if (!exact) throw new VerificationFailure("video frame PTS differs from the plan");
        if (subtitleCues != a.captions.size()) throw new VerificationFailure("caption cue count differs from the plan");

        double expectedDuration = toDouble(a.duration);
        double longestFrame = a.durations.stream().mapToDouble(FfmpegMultitrackRenderer::toDouble).max().orElse(0);
        double aacFrame = wav == null ? 0 : 1024.0 / wav.rate;
        double tolerance = Math.max(longestFrame, aacFrame);
        double containerDuration;
        try {
            containerDuration = Double.parseDouble(format.get("duration"));
        } catch (RuntimeException e) {
            throw new VerificationFailure("container duration unavailable");
        }
        if (Math.abs(containerDuration - expectedDuration) > tolerance) {
            throw new VerificationFailure("container duration differs from the plan beyond one frame");
        }
        if (audio != null) {
            double audioDuration = Double.parseDouble(audio.getOrDefault("duration", "NaN"));
            double expectedAudio = toDouble(a.audio.sourceEnd.minus(a.audio.sourceStart));
            if (!(Math.abs(audioDuration - expectedAudio) <= tolerance)) {
                throw new VerificationFailure("audio duration differs from the plan beyond one frame");
            }
            if (Math.abs(Double.parseDouble(audio.getOrDefault("start_time", "NaN"))) > tolerance) {
                throw new VerificationFailure("audio start offset exceeds one frame");
            }
        }
        return new Verification(streams.size(), video.get("codec_name"), audio == null ? null : audio.get("codec_name"),
                sub == null ? null : sub.get("codec_name"), videoPts.size(), width, height, subtitleCues,
                containerDuration, expectedDuration, tolerance, true);
    }

    // ------------------------------------------------------------------------------- tool probing

    /** Returns null when ffmpeg/ffprobe are usable, else a typed UNAVAILABLE result. */
    private Result probeTools() {
        try {
            if (ffmpegVersion == null || ffprobeVersion == null) {
                ffmpegVersion = versionOf(config.ffmpeg(), "ffmpeg");
                ffprobeVersion = versionOf(config.ffprobe(), "ffprobe");
            }
            if (!capabilitiesChecked) {
                String encoders = capture(config.ffmpeg(), "-hide_banner", "-encoders");
                for (String enc : List.of("libx264", "aac", "mov_text")) {
                    if (!Pattern.compile("(?m)^\\s*[VAS][.A-Z]{5}\\s+" + enc + "\\s").matcher(encoders).find()) {
                        return refuse(Outcome.UNAVAILABLE, Reason.ENCODER_UNAVAILABLE, "required encoder missing");
                    }
                }
                String muxers = capture(config.ffmpeg(), "-hide_banner", "-muxers");
                if (!Pattern.compile("(?m)^\\s*\\S*E\\S*\\s+mp4\\s").matcher(muxers).find()) {
                    return refuse(Outcome.UNAVAILABLE, Reason.ENCODER_UNAVAILABLE, "mp4 muxer missing");
                }
                capabilitiesChecked = true;
            }
            return null;
        } catch (IOException | RuntimeException e) {
            return refuse(Outcome.UNAVAILABLE, Reason.TOOL_UNAVAILABLE, "ffmpeg/ffprobe unavailable");
        }
    }

    private String versionOf(Path exe, String name) throws IOException {
        String first = capture(exe, "-version").lines().findFirst().orElse("");
        if (!first.startsWith(name + " version ")) throw new IOException("not " + name);
        return first.length() > 200 ? first.substring(0, 200) : first;
    }

    private String capture(Path exe, String... args) throws IOException {
        if (!Files.isRegularFile(exe) || !Files.isExecutable(exe)) throw new IOException("not executable");
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.toString());
        cmd.addAll(List.of(args));
        BoundedProcessRunner.Result r = BoundedProcessRunner.run(cmd, config.tempRoot(), config.environment(),
                config.probeTimeout(), MAX_STDOUT_BYTES, MAX_STDERR_BYTES, null, null, 0);
        if (!r.succeeded()) throw new IOException("tool probe failed");
        return new String(r.stdout(), StandardCharsets.UTF_8);
    }

    // ---------------------------------------------------------------------------------- analysis

    private static final class Unsupported extends RuntimeException {
        final Reason reason;
        Unsupported(Reason reason, String message) { super(message); this.reason = reason; }
    }

    private record ClipLine(String id, Modality modality, String artifact, String version, String sha,
            Time timelineStart, Time sourceStart, Time sourceEnd) {
        Time timelineEnd() { return timelineStart.plus(sourceEnd.minus(sourceStart)); }
    }

    private record VideoClip(ClipLine line, List<MappedFrame> frames, List<Time> durations) { }

    private record CaptionCue(Time start, Time end, String text) { }

    private static final class Analysis {
        List<VideoClip> videoClips = new ArrayList<>();
        List<MappedFrame> frames = new ArrayList<>();   // timeline order
        List<Time> durations = new ArrayList<>();       // parallel to frames
        ClipLine audio;
        List<CaptionCue> captions = new ArrayList<>();
        Time duration;
    }

    private static Analysis analyze(Plan plan) {
        Analysis a = new Analysis();
        a.duration = plan.duration();
        List<ClipLine> clips = new ArrayList<>();
        for (String line : plan.canonicalManifest().split("\n")) {
            if (line.startsWith("transition=")) {
                throw new Unsupported(Reason.UNSUPPORTED_TRANSITION, "transitions cannot be rendered exactly");
            }
            if (line.startsWith("clip=")) {
                String[] f = line.substring(5).split("\\|", -1);
                clips.add(new ClipLine(f[0], Modality.valueOf(f[1]), f[2], f[3], f[4], time(f[5]), time(f[6]), time(f[7])));
            } else if (line.startsWith("caption=")) {
                String[] f = line.substring(8).split("\\|", -1);
                String text = new String(Base64.getUrlDecoder().decode(f[3]), StandardCharsets.UTF_8);
                a.captions.add(new CaptionCue(time(f[1]), time(f[2]), text));
            }
        }
        for (ClipLine c : clips) {
            if (c.modality == Modality.GRAPHIC) {
                throw new Unsupported(Reason.UNSUPPORTED_GRAPHIC_CLIP, "graphic clips are not rendered");
            }
        }
        List<ClipLine> audioClips = clips.stream().filter(c -> c.modality == Modality.AUDIO).toList();
        if (audioClips.size() > 1) throw new Unsupported(Reason.UNSUPPORTED_AUDIO_LAYOUT, "only one audio clip is supported");
        if (audioClips.size() == 1) {
            ClipLine au = audioClips.get(0);
            if (au.timelineStart.numerator() != 0) {
                throw new Unsupported(Reason.UNSUPPORTED_AUDIO_LAYOUT, "audio must start at timeline zero");
            }
            nanos(au.sourceStart);
            nanos(au.sourceEnd);
            a.audio = au;
        }
        List<ClipLine> videos = clips.stream().filter(c -> c.modality == Modality.VIDEO)
                .sorted(Comparator.comparing(ClipLine::timelineStart)).toList();
        if (videos.isEmpty()) throw new Unsupported(Reason.NO_VIDEO, "plan has no video clip");
        Map<String, List<MappedFrame>> byClip = new TreeMap<>();
        for (MappedFrame f : plan.frameMap()) byClip.computeIfAbsent(f.clipId(), k -> new ArrayList<>()).add(f);
        Time cursor = new Time(0, 1);
        for (ClipLine v : videos) {
            if (v.timelineStart.compareTo(cursor) != 0) {
                throw new Unsupported(Reason.UNSUPPORTED_VIDEO_TIMELINE, "video clips must be contiguous from zero");
            }
            List<MappedFrame> frames = byClip.getOrDefault(v.id, List.of());
            if (frames.isEmpty() || frames.get(0).sourcePts().compareTo(v.sourceStart) != 0) {
                throw new Unsupported(Reason.UNSUPPORTED_VIDEO_TIMELINE, "first frame must start at the clip source start");
            }
            List<Time> durations = new ArrayList<>();
            for (int i = 0; i < frames.size(); i++) {
                Time end = i + 1 < frames.size() ? frames.get(i + 1).timelinePts() : v.timelineEnd();
                Time d = end.minus(frames.get(i).timelinePts());
                micros(frames.get(i).timelinePts());
                micros(d);
                durations.add(d);
            }
            a.videoClips.add(new VideoClip(v, frames, durations));
            a.frames.addAll(frames);
            a.durations.addAll(durations);
            cursor = v.timelineEnd();
        }
        if (cursor.compareTo(plan.duration()) != 0) {
            throw new Unsupported(Reason.UNSUPPORTED_VIDEO_TIMELINE, "video must cover the full plan duration");
        }
        nanos(plan.duration());
        // Captions.
        a.captions.sort(Comparator.comparing(CaptionCue::start));
        Time prevEnd = null;
        for (CaptionCue c : a.captions) {
            if (millis(c.start) == null || millis(c.end) == null) {
                throw new Unsupported(Reason.UNSUPPORTED_TIME_PRECISION, "caption times must be whole milliseconds");
            }
            if (prevEnd != null && c.start.compareTo(prevEnd) < 0) {
                throw new Unsupported(Reason.UNSUPPORTED_CAPTIONS, "overlapping captions are not supported");
            }
            if (c.text.contains("-->") || c.text.contains("\r") || Pattern.compile("\n\\s*\n").matcher(c.text).find()
                    || c.text.startsWith("\n") || c.text.endsWith("\n")) {
                throw new Unsupported(Reason.UNSUPPORTED_CAPTIONS, "caption text cannot be represented as a WebVTT cue");
            }
            prevEnd = c.end;
        }
        return a;
    }

    // ------------------------------------------------------------------------------------- helpers

    private static Time time(String s) {
        int slash = s.indexOf('/');
        return new Time(Long.parseLong(s.substring(0, slash)), Long.parseLong(s.substring(slash + 1)));
    }

    private static double toDouble(Time t) {
        return new BigDecimal(t.numerator()).divide(new BigDecimal(t.denominator()), 12, java.math.RoundingMode.HALF_EVEN)
                .doubleValue();
    }

    private static BigInteger scaled(Time t, long unitsPerSecond) {
        BigInteger u = BigInteger.valueOf(unitsPerSecond);
        BigInteger[] qr = BigInteger.valueOf(t.numerator()).multiply(u).divideAndRemainder(BigInteger.valueOf(t.denominator()));
        return qr[1].signum() == 0 ? qr[0] : null;
    }

    private static Time requireExact(Time t, long unitsPerSecond, String unit) {
        if (scaled(t, unitsPerSecond) == null) {
            throw new Unsupported(Reason.UNSUPPORTED_TIME_PRECISION, "time " + t + " is not a whole number of " + unit);
        }
        return t;
    }

    private static BigInteger millis(Time t) { return scaled(t, 1000); }

    private static String micros(Time t) {
        requireExact(t, MICROS_PER_SECOND, "microseconds");
        return decimal(scaled(t, MICROS_PER_SECOND), 6);
    }

    private static String nanos(Time t) {
        requireExact(t, 1_000_000_000L, "nanoseconds");
        return decimal(scaled(t, 1_000_000_000L), 9);
    }

    private static String decimal(BigInteger units, int fraction) {
        return new BigDecimal(units, fraction).toPlainString();
    }

    private static String webVtt(List<CaptionCue> cues) {
        StringBuilder sb = new StringBuilder("WEBVTT\n\n");
        int n = 1;
        for (CaptionCue c : cues) {
            sb.append(n++).append('\n').append(stamp(c.start)).append(" --> ").append(stamp(c.end)).append('\n')
                    .append(c.text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")).append("\n\n");
        }
        return sb.toString();
    }

    private static String stamp(Time t) {
        long ms = millis(t).longValueExact();
        return String.format("%02d:%02d:%02d.%03d", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    }

    private static final byte[] PNG_SIG = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};

    /** Validates the PNG through the module codec and returns {width, height}. */
    private static int[] validatePng(byte[] png, int index) {
        if (png.length < 33 || !java.util.Arrays.equals(java.util.Arrays.copyOf(png, 8), PNG_SIG)) {
            throw new IllegalArgumentException("not a PNG");
        }
        ByteBuffer b = ByteBuffer.wrap(png).order(ByteOrder.BIG_ENDIAN);
        int width = b.getInt(16);
        int height = b.getInt(20);
        if (width < 1 || height < 1 || width > TemporalVideoRestoration.MAX_FRAME_DIMENSION
                || height > TemporalVideoRestoration.MAX_FRAME_DIMENSION) {
            throw new IllegalArgumentException("PNG geometry out of bounds");
        }
        PngFrameCodec.decode(png, new PngFrameCodec.FrameMetadata(Math.min(index, TemporalVideoRestoration.MAX_FRAMES - 1),
                0, width, height, new TemporalVideoRestoration.Roi(0, 0, width, height)));
        return new int[] {width, height};
    }

    private record WavInfo(int rate, int channels, long frames) { }

    private static WavInfo parseWav(byte[] data) {
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        if (data.length < 44 || b.getInt(0) != 0x46464952 || b.getInt(8) != 0x45564157) {
            throw new IllegalArgumentException("not RIFF/WAVE");
        }
        int pos = 12;
        int rate = -1, channels = -1;
        while (pos + 8 <= data.length) {
            int id = b.getInt(pos);
            long size = b.getInt(pos + 4) & 0xFFFFFFFFL;
            int body = pos + 8;
            if (id == 0x20746d66) { // "fmt "
                if (size < 16 || body + 16 > data.length) throw new IllegalArgumentException("bad fmt");
                int tag = b.getShort(body) & 0xFFFF;
                channels = b.getShort(body + 2) & 0xFFFF;
                rate = b.getInt(body + 4);
                int bits = b.getShort(body + 14) & 0xFFFF;
                if (tag != 1 || bits != 16 || channels < 1 || channels > 2 || rate < 8000) {
                    throw new IllegalArgumentException("only 16-bit PCM mono/stereo is supported");
                }
            } else if (id == 0x61746164) { // "data"
                if (rate < 0) throw new IllegalArgumentException("data before fmt");
                if (body + size > data.length) throw new IllegalArgumentException("truncated data chunk");
                long frames = size / (2L * channels);
                if (frames == 0) throw new IllegalArgumentException("empty audio");
                return new WavInfo(rate, channels, frames);
            }
            pos = (int) Math.min(Integer.MAX_VALUE, body + size + (size & 1));
        }
        throw new IllegalArgumentException("no data chunk");
    }

    private Result refuse(Outcome outcome, Reason reason, String detail) {
        return new Result(outcome, reason, detail, null, null, null, 0, ffmpegVersion, ffprobeVersion, null, 0, null);
    }

    private Result fail(Reason reason, String detail) {
        return refuse(Outcome.FAILED, reason, detail);
    }

    private static Result withStderr(Result r, BoundedProcessRunner.Result run) {
        return new Result(r.outcome, r.reason, r.detail, null, null, null, 0, r.ffmpegVersion, r.ffprobeVersion, null,
                run.stderrBytes(), run.stderrSha256());
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String sha256File(Path file) throws IOException {
        MessageDigest d = sha256Digest();
        try (var in = Files.newInputStream(file)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) >= 0) d.update(buf, 0, n);
        }
        return HexFormat.of().formatHex(d.digest());
    }

    private static void deleteTree(Path root) {
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override public FileVisitResult visitFile(Path f, BasicFileAttributes at) throws IOException {
                    Files.deleteIfExists(f);
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException {
                    Files.deleteIfExists(d);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException ignored) {
            // best effort; the directory is private to this render
        }
    }
}
