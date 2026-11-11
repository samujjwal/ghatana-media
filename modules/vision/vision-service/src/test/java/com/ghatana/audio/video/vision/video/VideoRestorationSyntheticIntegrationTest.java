package com.ghatana.audio.video.vision.video;

import com.ghatana.media.production.rendering.PngFrameCodec;
import com.ghatana.media.production.rendering.TemporalVideoRestoration;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;

/** Synthetic local codec-to-restoration exercise; it establishes no source rights or qualified quality. */
class VideoRestorationSyntheticIntegrationTest {
    private static final int WIDTH = 32;
    private static final int HEIGHT = 32;
    private static final int FRAME_COUNT = 3;
    private static final Roi ROI = new Roi(0, 0, WIDTH, HEIGHT);

    @TempDir Path tempDir;

    @Test
    void exactExtractedFramesRetainClockThroughSyntheticRestorationAndReferenceMeasurement() throws Exception {
        Assumptions.assumeTrue(codecAvailable(), "local FFmpeg and FFprobe are required for this synthetic integration");

        Path sourceVideo = tempDir.resolve("synthetic-source.mp4");
        byte[][] pristineFrames = pristineFrames();
        run(List.of("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-video_size", WIDTH + "x" + HEIGHT, "-framerate", "10", "-i", "pipe:0", "-frames:v",
                Integer.toString(FRAME_COUNT), "-an", "-c:v", "mpeg4", "-q:v", "1", "-bf", "0",
                "-threads:v", "1", "-pix_fmt", "yuv420p", "-y", sourceVideo.toString()), noisyFrames(pristineFrames));

        // This test adapter runs only the controlled synthetic commands directly. It does not
        // claim the authenticated OCI worker or production host sandbox is configured.
        VideoFrameExtractor extractor = new VideoFrameExtractor() {
            @Override ProcessResult runProbeProcess(List<String> command, Duration timeout, int maxDiagnosticBytes)
                    throws IOException {
                return runLocalTool(command, new byte[0]);
            }

            @Override ProcessResult runFFmpegProcess(List<String> command, Duration timeout, int maxDiagnosticBytes,
                    Path monitoredOutput, long maxOutputBytes) throws IOException {
                List<String> rawCommand = new ArrayList<>(command.subList(0, command.size() - 2));
                String outputPattern = command.get(command.size() - 2);
                rawCommand.addAll(List.of("-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"));
                Process process = new ProcessBuilder(rawCommand).start();
                byte[] rgb = process.getInputStream().readAllBytes();
                byte[] diagnostics = process.getErrorStream().readAllBytes();
                try {
                    if (!process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)) {
                        process.destroyForcibly();
                        throw new IOException("synthetic frame extraction timed out");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("synthetic frame extraction interrupted", interrupted);
                }
                String diagnosticText = new String(diagnostics, java.nio.charset.StandardCharsets.UTF_8);
                if (process.exitValue() != 0) throw new IOException(diagnosticText);
                if (rgb.length != WIDTH * HEIGHT * 3) throw new IOException("synthetic extraction returned an unexpected RGB frame size");
                BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_RGB);
                for (int pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
                    int offset = pixel * 3;
                    int value = (Byte.toUnsignedInt(rgb[offset]) << 16)
                            | (Byte.toUnsignedInt(rgb[offset + 1]) << 8) | Byte.toUnsignedInt(rgb[offset + 2]);
                    image.setRGB(pixel % WIDTH, pixel / WIDTH, value);
                }
                Path png = Path.of(outputPattern.replace("%04d", "0001"));
                if (!ImageIO.write(image, "PNG", png.toFile())) throw new IOException("JDK PNG writer is unavailable");
                return new ProcessResult(0, false, diagnosticText, false, false);
            }
        };
        List<PngFrameCodec.PngFrame> encodedFrames = new ArrayList<>();
        SourceMediaTimestamp firstTimestamp = null;
        for (int ordinal = 0; ordinal < FRAME_COUNT; ordinal++) {
            Path output = tempDir.resolve("extract-" + ordinal);
            List<VideoFrameExtractor.ExtractedFrame> selected = extractor.extractFrames(sourceVideo, output,
                    VideoFrameExtractor.ExtractionConfig.builder().sourceFrameNumber(ordinal).format("png").build());
            assertThat(selected).hasSize(1);
            VideoFrameExtractor.ExtractedFrame extracted = selected.getFirst();
            assertThat(extracted.getFrameNumber()).isEqualTo(ordinal);
            assertThat(extracted.getSourceTimestamp().isKnown()).isTrue();
            if (firstTimestamp == null) firstTimestamp = extracted.getSourceTimestamp();
            assertThat(extracted.getSourceTimestamp().timeBaseNumerator())
                    .isEqualTo(firstTimestamp.timeBaseNumerator());
            assertThat(extracted.getSourceTimestamp().timeBaseDenominator())
                    .isEqualTo(firstTimestamp.timeBaseDenominator());
            encodedFrames.add(new PngFrameCodec.PngFrame(Files.readAllBytes(extracted.getPath()),
                    new PngFrameCodec.FrameMetadata(ordinal, extracted.getSourceTimestamp().pts(), WIDTH, HEIGHT, ROI)));
        }

        TimeBase timeBase = new TimeBase(Math.toIntExact(firstTimestamp.timeBaseNumerator()),
                Math.toIntExact(firstTimestamp.timeBaseDenominator()));
        PngFrameCodec.DecodedPngFrameSequence decoded = PngFrameCodec.decodeSequence(timeBase, encodedFrames);
        assertThat(decoded.frames()).extracting(Frame::frameIndex).containsExactly(0, 1, 2);
        assertThat(decoded.frames()).extracting(Frame::presentationTicks)
                .containsExactlyElementsOf(encodedFrames.stream().map(frame -> frame.metadata().presentationTicks()).toList());

        String sourceDigest = sha256(Files.readAllBytes(sourceVideo));
        ArtifactBinding source = binding("synthetic-source", "v1", sourceDigest);
        String referenceDigest = sha256(concat(pristineFrames));
        ArtifactBinding reference = binding("synthetic-reference", "v1", referenceDigest);
        List<Frame> referenceFrames = new ArrayList<>();
        for (int index = 0; index < FRAME_COUNT; index++) {
            referenceFrames.add(new Frame(index, decoded.frames().get(index).presentationTicks(), WIDTH, HEIGHT,
                    ROI, pristineFrames[index]));
        }
        DecodedFrameSequence referenceSequence = new DecodedFrameSequence(reference.artifactId(), reference.versionId(),
                reference.sha256(), timeBase, referenceFrames);

        Result result = TemporalVideoRestoration.restore(new RestorationRequest("synthetic-restoration", source),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "SYNTHETIC_TEST_ONLY"),
                PngFrameCodec.asTrustedDecodedFrameSource(requested -> {
                    assertThat(requested).isEqualTo(source);
                    return decoded;
                }),
                Optional.of(new ReferenceRequest("synthetic-reference-comparison", reference)),
                requested -> {
                    assertThat(requested).isEqualTo(reference);
                    return referenceSequence;
                },
                (binding, purpose) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "SYNTHETIC_TEST_ONLY"));

        assertThat(result.outcome()).isEqualTo(Outcome.COMPLETED);
        Candidate candidate = result.candidate().orElseThrow();
        assertThat(candidate.frames()).extracting(CandidateFrame::frameIndex).containsExactly(0, 1, 2);
        assertThat(candidate.frames()).extracting(CandidateFrame::presentationTicks)
                .containsExactlyElementsOf(decoded.frames().stream().map(Frame::presentationTicks).toList());
        assertThat(candidate.sourceDelta().changedSamples()).isPositive();
        assertThat(candidate.referenceMetrics().status()).isEqualTo(MetricStatus.MEASURED);
        assertThat(candidate.referenceMetrics().algorithm()).isEqualTo("GLOBAL_SRGB_LUMA_SSIM_V1+RGB8_SAMPLE_PSNR_V1");
        assertThat(candidate.improvementClaimed()).isFalse();
        assertThat(candidate.lineage().outputDisclosure()).contains("No deblur", "codec output", "quality improvement");
    }

    private static ArtifactBinding binding(String artifactId, String version, String digest) {
        return new ArtifactBinding("synthetic-tenant", "synthetic-principal", artifactId, version, digest,
                "synthetic-test-purpose", List.of("synthetic-test-rights-reference"), "synthetic-test-policy");
    }

    private static byte[][] pristineFrames() {
        byte[][] frames = new byte[FRAME_COUNT][WIDTH * HEIGHT * 3];
        for (int frame = 0; frame < FRAME_COUNT; frame++) {
            for (int pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
                int offset = pixel * 3;
                frames[frame][offset] = (byte) (30 + pixel % 90);
                frames[frame][offset + 1] = (byte) (60 + pixel % 70);
                frames[frame][offset + 2] = (byte) (90 + pixel % 50);
            }
        }
        return frames;
    }

    private static byte[] noisyFrames(byte[][] pristine) {
        byte[] input = new byte[pristine.length * pristine[0].length];
        int[] frameOffsets = {18, -18, 18};
        for (int frame = 0; frame < pristine.length; frame++) {
            for (int sample = 0; sample < pristine[frame].length; sample++) {
                input[frame * pristine[frame].length + sample] = (byte) Math.max(0,
                        Math.min(255, Byte.toUnsignedInt(pristine[frame][sample]) + frameOffsets[frame]));
            }
        }
        return input;
    }

    private static byte[] concat(byte[][] frames) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (byte[] frame : frames) output.write(frame);
        return output.toByteArray();
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static boolean codecAvailable() {
        try {
            run(List.of("ffmpeg", "-version"), new byte[0]);
            run(List.of("ffprobe", "-version"), new byte[0]);
            return true;
        } catch (IOException failure) {
            return false;
        }
    }

    private static void run(List<String> command, byte[] input) throws IOException {
        VideoFrameExtractor.ProcessResult result = runLocalTool(command, input);
        if (result.exitCode() != 0) {
            throw new IOException("synthetic codec process failed: " + result.output());
        }
    }

    private static VideoFrameExtractor.ProcessResult runLocalTool(List<String> command, byte[] input) throws IOException {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        try (var stdin = process.getOutputStream()) {
            stdin.write(input);
        }
        byte[] output = process.getInputStream().readAllBytes();
        try {
            if (!process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IOException("synthetic codec process timed out: " + command.getFirst());
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("synthetic codec process interrupted", interrupted);
        }
        return new VideoFrameExtractor.ProcessResult(process.exitValue(), false,
                new String(output, java.nio.charset.StandardCharsets.UTF_8), false, false);
    }
}
