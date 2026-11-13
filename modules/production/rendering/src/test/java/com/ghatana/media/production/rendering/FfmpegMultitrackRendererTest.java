package com.ghatana.media.production.rendering;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.ghatana.media.production.rendering.BoundedProcessRunner.CancellationSource;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer.ClipSource;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer.Config;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer.Outcome;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer.Reason;
import com.ghatana.media.production.rendering.FfmpegMultitrackRenderer.SourceProvider;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Caption;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Clip;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Graph;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Modality;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Plan;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Time;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Transition;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.TransitionKind;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Real-FFmpeg tests. The executables come from -Dghatana.media.ffmpeg / GHATANA_MEDIA_FFMPEG (and the matching
 * ...ffprobe variables), falling back to ~/.local/bin; tests are skipped with a reason when no working tool exists.
 */
class FfmpegMultitrackRendererTest {
    private static final Map<String, String> ENV = Map.of("PATH", "/usr/bin:/bin");
    private static Path ffmpeg;
    private static Path ffprobe;

    @TempDir Path tmp;

    @BeforeAll
    static void locateTools() {
        ffmpeg = locate("ghatana.media.ffmpeg", "GHATANA_MEDIA_FFMPEG", "ffmpeg");
        ffprobe = locate("ghatana.media.ffprobe", "GHATANA_MEDIA_FFPROBE", "ffprobe");
    }

    private static Path locate(String prop, String env, String name) {
        List<String> candidates = new ArrayList<>();
        if (System.getProperty(prop) != null) candidates.add(System.getProperty(prop));
        if (System.getenv(env) != null) candidates.add(System.getenv(env));
        candidates.add(System.getProperty("user.home") + "/.local/bin/" + name);
        for (String c : candidates) {
            Path p = Path.of(c);
            if (!p.isAbsolute() || !Files.isExecutable(p)) continue;
            try {
                Process proc = new ProcessBuilder(p.toString(), "-version").redirectErrorStream(true).start();
                proc.getInputStream().readAllBytes();
                if (proc.waitFor() == 0) return p;
            } catch (IOException | InterruptedException ignored) {
                // try next candidate
            }
        }
        return null;
    }

    private static void requireTools() {
        assumeTrue(ffmpeg != null && ffprobe != null,
                "SKIPPED: no working ffmpeg/ffprobe (set GHATANA_MEDIA_FFMPEG and GHATANA_MEDIA_FFPROBE)");
    }

    // ------------------------------------------------------------------------------- fixtures

    private static final int[] RED = {255, 0, 0}, GREEN = {0, 255, 0}, BLUE = {0, 0, 255}, WHITE = {255, 255, 255};

    private static byte[] png(int w, int h, int[] rgb) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        int v = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) img.setRGB(x, y, v);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(img, "png", out);
        return out.toByteArray();
    }

    /** 48 kHz mono 16-bit: silence until 0.4 s, 1 kHz tone afterwards, 1.0 s total. */
    private static byte[] wav() {
        int rate = 48000, n = rate;
        ByteBuffer b = ByteBuffer.allocate(44 + n * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + n * 2).put("WAVE".getBytes()).put("fmt ".getBytes()).putInt(16)
                .putShort((short) 1).putShort((short) 1).putInt(rate).putInt(rate * 2).putShort((short) 2)
                .putShort((short) 16).put("data".getBytes()).putInt(n * 2);
        for (int i = 0; i < n; i++) {
            b.putShort((short) (i < rate * 4 / 10 ? 0 : Math.round(16000 * Math.sin(2 * Math.PI * 1000.0 * i / rate))));
        }
        return b.array();
    }

    private static String sha(byte[]... parts) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) d.update(p);
            return HexFormat.of().formatHex(d.digest());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Time t(long n, long d) { return new Time(n, d); }

    private static final class Fixture implements SourceProvider {
        final Map<String, List<byte[]>> video = new HashMap<>();
        byte[] audio;
        final List<Clip> clips = new ArrayList<>();
        final List<Caption> captions = new ArrayList<>();
        final List<Transition> transitions = new ArrayList<>();
        long budget = 50L * 1024 * 1024;

        Fixture video(String id, Time tl, Time ss, Time se, List<Time> pts, List<byte[]> pngs) {
            video.put(id, pngs);
            clips.add(new Clip(id, Modality.VIDEO, "art-" + id, "v1", sha(pngs.toArray(new byte[0][])), tl, ss, se, pts));
            return this;
        }

        Fixture audio(String id, Time ss, Time se, byte[] wav) {
            audio = wav;
            clips.add(new Clip(id, Modality.AUDIO, "art-" + id, "v1", sha(wav), t(0, 1), ss, se, List.of(ss)));
            return this;
        }

        Plan plan() {
            return MultitrackRenderPlanner.plan(new Graph(clips, captions, transitions, budget)).plan();
        }

        @Override public List<byte[]> readVideoFrames(ClipSource clip) { return video.get(clip.clipId()); }
        @Override public byte[] readAudio(ClipSource clip) { return audio; }
    }

    /** red 0-0.2, green 0.2-0.3 | blue 0.3-0.4, white 0.4-0.6 (second clip's source clock starts at 10 s). */
    private static Fixture standard(boolean withAudio, boolean withCaptions) throws IOException {
        Fixture f = new Fixture();
        f.video("a", t(0, 1), t(0, 1), t(3, 10), List.of(t(0, 1), t(1, 5)),
                List.of(png(64, 48, RED), png(64, 48, GREEN)));
        f.video("b", t(3, 10), t(10, 1), t(103, 10), List.of(t(10, 1), t(101, 10)),
                List.of(png(64, 48, BLUE), png(64, 48, WHITE)));
        if (withAudio) f.audio("m", t(1, 10), t(7, 10), wav());
        if (withCaptions) {
            f.captions.add(new Caption("c1", t(1, 10), t(1, 4), "Hello"));
            f.captions.add(new Caption("c2", t(7, 20), t(11, 20), "A & B"));
        }
        return f;
    }

    private Path root() throws IOException {
        Path r = Files.createDirectories(tmp.resolve("tmp-root"));
        return r;
    }

    private Config config(Duration renderTimeout) throws IOException {
        return new Config(ffmpeg, ffprobe, root(), ENV, Duration.ofSeconds(30), renderTimeout, true);
    }

    private FfmpegMultitrackRenderer renderer() throws IOException {
        return new FfmpegMultitrackRenderer(config(Duration.ofSeconds(120)));
    }

    private Path out() throws IOException { return Files.createDirectories(tmp.resolve("out")); }

    private void assertTempEmpty() throws IOException {
        try (var s = Files.list(tmp.resolve("tmp-root"))) {
            assertThat(s.toList()).as("per-render temp directory is cleaned up").isEmpty();
        }
    }

    private static int[] colourAt(Path mp4, double seconds, Path scratch) throws Exception {
        Path png = scratch.resolve("frame-" + seconds + ".png");
        // Resample to a 100 fps constant rate (previous frame is held), so output frame n shows the picture on
        // screen at t = (n - 1) / 100. -ss would instead return the first frame whose PTS is >= the seek time.
        int n = (int) Math.round(seconds * 100) + 1;
        Process p = new ProcessBuilder(ffmpeg.toString(), "-v", "error", "-i", mp4.toString(), "-map", "0:v:0",
                "-r", "100", "-fps_mode", "cfr", "-frames:v", String.valueOf(n), "-f", "image2", "-update", "1",
                png.toString()).redirectErrorStream(true).start();
        p.getInputStream().readAllBytes();
        assertThat(p.waitFor()).isZero();
        BufferedImage img = ImageIO.read(png.toFile());
        int rgb = img.getRGB(img.getWidth() / 2, img.getHeight() / 2);
        return new int[] {(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255};
    }

    private static void assertColour(int[] actual, int[] expected) {
        for (int i = 0; i < 3; i++) assertThat(Math.abs(actual[i] - expected[i])).as("channel " + i + " of " + List.of(actual[0], actual[1], actual[2])).isLessThanOrEqualTo(16);
    }

    private static double[] audioRms(Path mp4, double from, double to) throws Exception {
        Process p = new ProcessBuilder(ffmpeg.toString(), "-v", "error", "-i", mp4.toString(), "-map", "0:a:0", "-f", "s16le",
                "-ac", "1", "-ar", "48000", "-").start();
        byte[] pcm = p.getInputStream().readAllBytes();
        assertThat(p.waitFor()).isZero();
        ByteBuffer b = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
        int a = (int) (from * 48000), z = Math.min((int) (to * 48000), pcm.length / 2);
        double sum = 0;
        for (int i = a; i < z; i++) { double s = b.getShort(i * 2); sum += s * s; }
        return new double[] {Math.sqrt(sum / Math.max(1, z - a)), pcm.length / 2.0 / 48000};
    }

    private String ffprobeText(Path mp4, String entries) throws Exception {
        Process p = new ProcessBuilder(ffprobe.toString(), "-v", "error", "-of", "compact", "-show_entries", entries, mp4.toString()).start();
        String s = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(p.waitFor()).isZero();
        return s;
    }

    // ----------------------------------------------------------------------------------- positive

    @Test
    void rendersPlayableMp4WithVariableFrameTimesAudioAndCaptionsAndVerifiesIt() throws Exception {
        requireTools();
        Fixture f = standard(true, true);
        Plan plan = f.plan();
        var r = renderer().render(plan, f, out(), null);

        assertThat(r.outcome()).as(r.toString()).isEqualTo(Outcome.COMPLETED);
        assertThat(r.ffmpegVersion()).startsWith("ffmpeg version ");
        assertThat(r.ffprobeVersion()).startsWith("ffprobe version ");
        var v = r.verification();
        assertThat(v.streamCount()).isEqualTo(3);
        assertThat(v.videoCodec()).isEqualTo("h264");
        assertThat(v.audioCodec()).isEqualTo("aac");
        assertThat(v.subtitleCodec()).isEqualTo("mov_text");
        assertThat(v.videoFrameCount()).isEqualTo(4);
        assertThat(v.captionCueCount()).isEqualTo(2);
        assertThat(v.videoPtsExact()).isTrue();
        assertThat(v.containerDurationSeconds()).isBetween(0.6 - v.toleranceSeconds(), 0.6 + v.toleranceSeconds());
        assertThat(r.outputSha256()).isEqualTo(sha(Files.readAllBytes(r.outputPath())));
        assertThat(r.outputBytes()).isEqualTo(Files.size(r.outputPath())).isGreaterThan(0);
        assertThat(r.outputPath().getFileName().toString()).isEqualTo(plan.manifestSha256() + ".mp4");
        assertTempEmpty();

        // video frames land on the planned PTS with the planned colours
        assertColour(colourAt(r.outputPath(), 0.1, tmp), RED);
        assertColour(colourAt(r.outputPath(), 0.24, tmp), GREEN);
        assertColour(colourAt(r.outputPath(), 0.35, tmp), BLUE);
        assertColour(colourAt(r.outputPath(), 0.5, tmp), WHITE);

        // audio: silence for the first 0.3 s (source 0.1..0.4), tone afterwards (source 0.4..0.7 -> timeline 0.3..0.6)
        assertThat(audioRms(r.outputPath(), 0.05, 0.25)[0]).isLessThan(300);
        assertThat(audioRms(r.outputPath(), 0.36, 0.55)[0]).isGreaterThan(6000);

        // captions: sidecar and embedded cues share timing
        String vtt = Files.readString(r.captionsSidecarPath());
        assertThat(vtt).contains("00:00:00.100 --> 00:00:00.250\nHello", "00:00:00.350 --> 00:00:00.550\nA &amp; B");
        String subs = ffprobeText(r.outputPath(), "stream=index,codec_type:packet=stream_index,pts_time,size");
        List<String> cueStarts = subs.lines().filter(l -> l.startsWith("packet|stream_index=2|"))
                .filter(l -> !l.endsWith("size=2")).map(l -> l.split("pts_time=")[1].split("\\|")[0]).toList();
        assertThat(cueStarts).hasSize(2);
        assertThat(Double.parseDouble(cueStarts.get(0))).isEqualTo(0.1, org.assertj.core.data.Offset.offset(0.002));
        assertThat(Double.parseDouble(cueStarts.get(1))).isEqualTo(0.35, org.assertj.core.data.Offset.offset(0.002));
    }

    @Test
    void rendersVideoOnlyAsSingleStream() throws Exception {
        requireTools();
        Fixture f = standard(false, false);
        var r = renderer().render(f.plan(), f, out(), null);
        assertThat(r.outcome()).as(r.toString()).isEqualTo(Outcome.COMPLETED);
        assertThat(r.verification().streamCount()).isEqualTo(1);
        assertThat(r.captionsSidecarPath()).isNull();
        assertTempEmpty();
    }

    @Test
    void pipelineReportsAdmissionAndAvailabilityToThePlanner() throws Exception {
        requireTools();
        var pipeline = renderer();
        assertThat(pipeline.admitted()).isTrue();
        assertThat(pipeline.available()).isTrue();
        var missing = new FfmpegMultitrackRenderer(new Config(Path.of("/nonexistent/ffmpeg"), ffprobe, root(), ENV,
                Duration.ofSeconds(5), Duration.ofSeconds(5), true));
        assertThat(missing.available()).isFalse();
    }

    // ----------------------------------------------------------------------------------- negatives

    @Test
    void missingExecutableIsUnavailable() throws Exception {
        Fixture f = standard(false, false);
        var r = new FfmpegMultitrackRenderer(new Config(Path.of("/nonexistent/ffmpeg"), Path.of("/nonexistent/ffprobe"),
                root(), ENV, Duration.ofSeconds(5), Duration.ofSeconds(5), true)).render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.UNAVAILABLE);
        assertThat(r.reason()).isEqualTo(Reason.TOOL_UNAVAILABLE);
        assertThat(r.outputPath()).isNull();
        assertTempEmpty();
    }

    @Test
    void notAdmittedPipelineRendersNothing() throws Exception {
        Fixture f = standard(false, false);
        var r = new FfmpegMultitrackRenderer(new Config(Path.of("/nonexistent/ffmpeg"), Path.of("/nonexistent/ffprobe"),
                root(), ENV, Duration.ofSeconds(5), Duration.ofSeconds(5), false)).render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(r.reason()).isEqualTo(Reason.PIPELINE_NOT_ADMITTED);
    }

    /** A fake ffmpeg that answers capability probes with the real tool and then behaves as given. */
    private Path fakeFfmpeg(String renderBehaviour) throws IOException {
        Path script = tmp.resolve("fake-ffmpeg-" + System.nanoTime() + ".sh");
        Files.writeString(script, "#!/bin/sh\ncase \"$1\" in -version|-hide_banner) exec " + ffmpeg + " \"$@\";; esac\n"
                + renderBehaviour + "\n");
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwx------"));
        return script;
    }

    private static boolean alive(long pid) {
        try {
            String stat = Files.readString(Path.of("/proc/" + pid + "/stat"));
            return !stat.substring(stat.lastIndexOf(')') + 2).startsWith("Z");
        } catch (IOException gone) {
            return false;
        }
    }

    private static void assertEventuallyDead(Path pidFile) throws Exception {
        assertThat(pidFile).exists();
        long pid = Long.parseLong(Files.readString(pidFile).trim());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (alive(pid) && System.nanoTime() < deadline) Thread.sleep(50);
        assertThat(alive(pid)).as("grandchild process was killed with the process tree").isFalse();
    }

    @Test
    void timeoutKillsTheWholeProcessTree() throws Exception {
        requireTools();
        Path pidFile = tmp.resolve("child.pid");
        Path fake = fakeFfmpeg("sleep 60 &\necho $! > " + pidFile + "\nwait");
        Fixture f = standard(false, false);
        var r = new FfmpegMultitrackRenderer(new Config(fake, ffprobe, root(), ENV, Duration.ofSeconds(30),
                Duration.ofMillis(700), true)).render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.FAILED);
        assertThat(r.reason()).isEqualTo(Reason.TIMEOUT);
        assertEventuallyDead(pidFile);
        assertTempEmpty();
        assertThat(out()).isEmptyDirectory();
    }

    @Test
    void cancellationStopsTheRenderAndKillsTheTree() throws Exception {
        requireTools();
        Path pidFile = tmp.resolve("child2.pid");
        Path fake = fakeFfmpeg("sleep 60 &\necho $! > " + pidFile + "\nwait");
        Fixture f = standard(false, false);
        CancellationSource cancel = new CancellationSource();
        new Thread(() -> {
            try {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                while (!Files.exists(pidFile) && System.nanoTime() < deadline) Thread.sleep(20);
                Thread.sleep(200);
            } catch (InterruptedException ignored) { }
            cancel.cancel();
        }).start();
        long start = System.nanoTime();
        var r = new FfmpegMultitrackRenderer(new Config(fake, ffprobe, root(), ENV, Duration.ofSeconds(30),
                Duration.ofSeconds(60), true)).render(f.plan(), f, out(), cancel);
        assertThat(r.outcome()).isEqualTo(Outcome.CANCELLED);
        assertThat(r.reason()).isEqualTo(Reason.CANCELLED);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(20));
        assertEventuallyDead(pidFile);
        assertTempEmpty();
    }

    @Test
    void outputBudgetIsEnforced() throws Exception {
        requireTools();
        Fixture f = standard(true, true);
        f.budget = 1_000;
        var r = renderer().render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.FAILED);
        assertThat(r.reason()).isEqualTo(Reason.OUTPUT_BUDGET_EXCEEDED);
        assertThat(r.outputPath()).isNull();
        assertThat(out()).isEmptyDirectory();
        assertTempEmpty();
    }

    @Test
    void toolStderrIsCountedAndDigestedButNeverSurfaced() throws Exception {
        requireTools();
        Path fake = fakeFfmpeg("echo SECRET-STDERR-MARKER-/home/someone/private >&2\nexit 1");
        Fixture f = standard(false, false);
        var r = new FfmpegMultitrackRenderer(new Config(fake, ffprobe, root(), ENV, Duration.ofSeconds(30),
                Duration.ofSeconds(30), true)).render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.FAILED);
        assertThat(r.reason()).isEqualTo(Reason.PROCESS_FAILED);
        assertThat(r.toolStderrBytes()).isGreaterThan(0);
        assertThat(r.toolStderrSha256()).hasSize(64);
        assertThat(r.toString()).doesNotContain("SECRET-STDERR-MARKER").doesNotContain("/home/someone");
    }

    @Test
    void transitionsAreTypedUnsupported() throws Exception {
        Fixture f = new Fixture();
        f.video("a", t(0, 1), t(0, 1), t(2, 5), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        f.video("b", t(1, 5), t(0, 1), t(2, 5), List.of(t(0, 1)), List.of(png(64, 48, BLUE)));
        f.transitions.add(new Transition("x", "a", "b", TransitionKind.CROSSFADE, t(1, 5), t(1, 10)));
        var r = new FfmpegMultitrackRenderer(new Config(Path.of("/nonexistent/ffmpeg"), Path.of("/nonexistent/ffprobe"),
                root(), ENV, Duration.ofSeconds(5), Duration.ofSeconds(5), true)).render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(r.reason()).isEqualTo(Reason.UNSUPPORTED_TRANSITION);
    }


    @Test
    void unsupportedGraphShapesAreRefusedWithTypedReasons() throws Exception {
        Config cfg = new Config(Path.of("/nonexistent/ffmpeg"), Path.of("/nonexistent/ffprobe"), root(), ENV,
                Duration.ofSeconds(5), Duration.ofSeconds(5), true);
        var r = new FfmpegMultitrackRenderer(cfg);

        // video gap: second clip starts after a hole
        Fixture gap = new Fixture();
        gap.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        gap.video("b", t(3, 10), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(64, 48, BLUE)));
        assertThat(r.render(gap.plan(), gap, out(), null).reason()).isEqualTo(Reason.UNSUPPORTED_VIDEO_TIMELINE);

        // overlapping video clips
        Fixture overlap = new Fixture();
        overlap.video("a", t(0, 1), t(0, 1), t(3, 10), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        overlap.video("b", t(1, 10), t(0, 1), t(3, 10), List.of(t(0, 1)), List.of(png(64, 48, BLUE)));
        assertThat(r.render(overlap.plan(), overlap, out(), null).reason()).isEqualTo(Reason.UNSUPPORTED_VIDEO_TIMELINE);

        // VFR boundary that is not a whole number of microseconds
        Fixture vfr = new Fixture();
        vfr.video("a", t(0, 1), t(0, 1), t(1, 1), List.of(t(0, 1), t(1, 3)),
                List.of(png(64, 48, RED), png(64, 48, BLUE)));
        var vr = r.render(vfr.plan(), vfr, out(), null);
        assertThat(vr.outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(vr.reason()).isEqualTo(Reason.UNSUPPORTED_TIME_PRECISION);

        // graphic layers
        Fixture graphic = new Fixture();
        graphic.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        graphic.clips.add(new Clip("g", Modality.GRAPHIC, "art-g", "v1", sha(new byte[] {1}), t(0, 1), t(0, 1), t(1, 5),
                List.of(t(0, 1))));
        assertThat(r.render(graphic.plan(), graphic, out(), null).reason()).isEqualTo(Reason.UNSUPPORTED_GRAPHIC_CLIP);

        // two audio clips
        Fixture audio2 = new Fixture();
        audio2.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        audio2.audio("m1", t(0, 1), t(1, 5), wav());
        audio2.audio("m2", t(0, 1), t(1, 5), wav());
        assertThat(r.render(audio2.plan(), audio2, out(), null).reason()).isEqualTo(Reason.UNSUPPORTED_AUDIO_LAYOUT);

        // overlapping captions
        Fixture caps = new Fixture();
        caps.video("a", t(0, 1), t(0, 1), t(1, 2), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        caps.captions.add(new Caption("c1", t(0, 1), t(1, 4), "one"));
        caps.captions.add(new Caption("c2", t(1, 8), t(1, 2), "two"));
        assertThat(r.render(caps.plan(), caps, out(), null).reason()).isEqualTo(Reason.UNSUPPORTED_CAPTIONS);
        assertThat(out()).isEmptyDirectory();
    }

    @Test
    void oddFrameGeometryIsRefusedNotScaled() throws Exception {
        requireTools();
        Fixture f = new Fixture();
        f.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(63, 48, RED)));
        var r = renderer().render(f.plan(), f, out(), null);
        assertThat(r.outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(r.reason()).isEqualTo(Reason.UNSUPPORTED_FRAME_GEOMETRY);
        assertTempEmpty();
    }

    @Test
    void corruptOrMismatchedSourcesAreRejected() throws Exception {
        requireTools();
        // PNG signature but garbage body, digest matches the plan
        byte[] bad = new byte[200];
        System.arraycopy(png(64, 48, RED), 0, bad, 0, 33);
        Fixture corrupt = new Fixture();
        corrupt.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(bad));
        var r1 = renderer().render(corrupt.plan(), corrupt, out(), null);
        assertThat(r1.outcome()).isEqualTo(Outcome.FAILED);
        assertThat(r1.reason()).isEqualTo(Reason.SOURCE_INVALID);

        // digest differs from the plan
        Fixture mismatch = standard(false, false);
        Plan plan = mismatch.plan();
        mismatch.video.put("a", List.of(png(64, 48, BLUE), png(64, 48, GREEN)));
        var r2 = renderer().render(plan, mismatch, out(), null);
        assertThat(r2.reason()).isEqualTo(Reason.SOURCE_DIGEST_MISMATCH);

        // unreadable source
        Fixture gone = standard(false, false);
        SourceProvider failing = new SourceProvider() {
            @Override public List<byte[]> readVideoFrames(ClipSource c) throws IOException { throw new IOException("boom"); }
            @Override public byte[] readAudio(ClipSource c) throws IOException { throw new IOException("boom"); }
        };
        assertThat(renderer().render(gone.plan(), failing, out(), null).reason()).isEqualTo(Reason.SOURCE_UNAVAILABLE);

        // truncated WAV whose digest matches
        byte[] wav = wav();
        byte[] truncated = java.util.Arrays.copyOf(wav, 100);
        Fixture badWav = new Fixture();
        badWav.video("a", t(0, 1), t(0, 1), t(1, 5), List.of(t(0, 1)), List.of(png(64, 48, RED)));
        badWav.audio("m", t(0, 1), t(1, 5), truncated);
        assertThat(renderer().render(badWav.plan(), badWav, out(), null).reason()).isEqualTo(Reason.SOURCE_INVALID);

        // frame count differs from the plan
        Fixture count = standard(false, false);
        Plan countPlan = count.plan();
        count.video.put("a", List.of(png(64, 48, RED)));
        assertThat(renderer().render(countPlan, count, out(), null).reason()).isEqualTo(Reason.SOURCE_INVALID);

        assertThat(out()).isEmptyDirectory();
        assertTempEmpty();
    }

    @Test
    void existingOutputIsNeverOverwritten() throws Exception {
        requireTools();
        Fixture f = standard(false, false);
        Plan plan = f.plan();
        Path dir = out();
        assertThat(renderer().render(plan, f, dir, null).outcome()).isEqualTo(Outcome.COMPLETED);
        var again = renderer().render(plan, f, dir, null);
        assertThat(again.outcome()).isEqualTo(Outcome.FAILED);
        assertThat(again.reason()).isEqualTo(Reason.OUTPUT_EXISTS);
    }

    @SuppressWarnings("unused")
    private static final class Dummy { }
}
