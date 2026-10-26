package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

class VideoFrameExtractorProcessTest {
    @TempDir Path tempDir;

    @Test
    void audioDemuxSelectsOneBoundedAudioStreamAndReturnsDefensivePcm() throws Exception {
        byte[] input = new byte[] {0, 0, 0, 8, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'};
        byte[] pcm = new byte[] {1, 2, 3, 4};
        VideoFrameExtractor extractor = new VideoFrameExtractor() {
            @Override
            ProcessResult runProbeProcess(List<String> command, Duration timeout, int maxDiagnosticBytes) {
                assertThat(command).containsSubsequence("-select_streams", "a:0", "-show_entries");
                assertThat(command).doesNotContain("-nostdin");
                return new ProcessResult(0, false,
                        "index=1\ntime_base=1/48000\nstart_pts=1024\nsample_rate=48000\nchannels=2\nduration_ts=480000");
            }

            @Override
            ProcessResult runFFmpegProcess(List<String> command, Duration timeout, int maxDiagnosticBytes,
                    Path monitoredOutput, long maxOutputBytes) throws java.io.IOException {
                assertThat(command).containsSubsequence("-map", "0:1", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", "-fs", Long.toString(16_000L * 2L * 300L));
                Files.write(monitoredOutput.resolve("audio.pcm"), pcm);
                return new ProcessResult(0, false, "");
            }
        };

        VideoFrameExtractor.ExtractedAudioTrack result = extractor.extractAudioTrack(input);

        assertThat(result.pcmS16le()).containsExactly(pcm);
        assertThat(result.sampleCount()).isEqualTo(2);
        assertThat(result.sampleRate()).isEqualTo(16_000);
        assertThat(result.channels()).isEqualTo(1);
        assertThat(result.sourceStreamIndex()).isEqualTo(1);
        assertThat(result.sourceStartKnown()).isTrue();
        assertThat(result.sourceStartPts()).isEqualTo(1024);
        assertThat(result.sourceTimeBaseNumerator()).isEqualTo(1);
        assertThat(result.sourceTimeBaseDenominator()).isEqualTo(48_000);
        byte[] exposed = result.pcmS16le();
        exposed[0] = 99;
        assertThat(result.pcmS16le()).containsExactly(pcm);
    }

    @Test
    void rejectsUnrecognizedContainersBeforeProbingForAudio() {
        VideoFrameExtractor extractor = new VideoFrameExtractor() {
            @Override
            ProcessResult runProbeProcess(List<String> command, Duration timeout, int maxDiagnosticBytes) {
                throw new AssertionError("unknown container must fail before ffprobe");
            }
        };
        assertThatThrownBy(() -> extractor.extractAudioTrack(new byte[] {1, 2, 3, 4}))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("signature");
    }

    @Test
    void rejectsMultipleAudioStreamRecordsInsteadOfSelectingTheLastOne() {
        String stream = "index=1\ntime_base=1/48000\nstart_pts=0\nsample_rate=48000\n"
                + "channels=2\nduration_ts=480000\n";

        assertThatThrownBy(() -> VideoFrameExtractor.parseAudioStreamMetadata(stream + stream))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("multiple audio stream records");
    }

    @Test
    void rejectsOutputThatReachedFfmpegFileSizeCapAsPotentiallyTruncated() throws Exception {
        Path staging = Files.createDirectory(tempDir.resolve("audio-cap-staging"));
        Path output = staging.resolve("audio.pcm");
        Files.write(output, new byte[16_000 * 2 * 300]);

        assertThatThrownBy(() -> VideoFrameExtractor.validateAudioOutput(output, staging))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("bounded S16LE");
    }

    @Test
    void rejectsUnboundedFrameExtractionSettings() {
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().fps(0))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().maxFrames(10_001))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(8193, 1080))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(4096, 4096))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> VideoFrameExtractor.ExtractionConfig.builder().resolution(1920, -1))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void diagnosticSpamIsByteBoundedAndTerminatesChild() throws Exception {
        var result = VideoFrameExtractor.runProcess(childCommand("noise"), Duration.ofSeconds(5), 128);

        assertThat(result.diagnosticExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
        assertThat(result.output()).hasSize(128);
        assertThat(result.output().chars().allMatch(character -> character == 'x')).isTrue();
    }

    @Test
    void ffprobeRejectsValidLookingMetadataWhenDiagnosticBudgetWasExceeded() {
        String plausibleMetadata = "width=640\nheight=480\nduration=1.0\nnb_frames=1\nr_frame_rate=1/1\ntime_base=1/1000\n";
        var result = new VideoFrameExtractor.ProcessResult(0, false, plausibleMetadata, false, true);

        assertThatThrownBy(() -> VideoFrameExtractor.parseProbeResult(result))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("diagnostic output exceeded");
    }

    @Test
    void enforcesTimeoutEvenWhenChildKeepsItsOutputPipeOpen() throws Exception {
        long startedAt = System.nanoTime();
        var result = VideoFrameExtractor.runProcess(childCommand("sleep"), Duration.ofMillis(100), 128);
        long elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000;

        assertThat(result.timedOut()).isTrue();
        assertThat(elapsedMillis).isLessThan(3_000);
    }

    @Test
    void rejectsConcurrentCodecProcessesOnceBoundedSlotsAreOccupied() throws Exception {
        Path firstMarker = tempDir.resolve("first.pid");
        Path secondMarker = tempDir.resolve("second.pid");
        java.util.concurrent.atomic.AtomicReference<Throwable> firstFailure = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<Throwable> secondFailure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread first = new Thread(() -> runMarkedChild(firstMarker, firstFailure), "first-media-child-test");
        Thread second = new Thread(() -> runMarkedChild(secondMarker, secondFailure), "second-media-child-test");
        first.start();
        second.start();
        try {
            awaitFile(firstMarker);
            awaitFile(secondMarker);

            assertThatThrownBy(() -> VideoFrameExtractor.runProcess(
                    childCommand("sleep"), Duration.ofSeconds(1), 128))
                    .isInstanceOf(java.io.IOException.class).hasMessageContaining("capacity is exhausted");
        } finally {
            first.interrupt();
            second.interrupt();
            first.join(3_000);
            second.join(3_000);
        }
        assertThat(first.isAlive()).isFalse();
        assertThat(second.isAlive()).isFalse();
        assertThat(firstFailure.get()).isInstanceOf(java.io.IOException.class).hasMessageContaining("interrupted");
        assertThat(secondFailure.get()).isInstanceOf(java.io.IOException.class).hasMessageContaining("interrupted");
    }

    private static void runMarkedChild(Path marker, java.util.concurrent.atomic.AtomicReference<Throwable> failure) {
        try {
            VideoFrameExtractor.runProcess(childCommand("sleep-mark", marker.toString()), Duration.ofSeconds(30), 128);
        } catch (Throwable thrown) {
            failure.set(thrown);
        }
    }

    private static void awaitFile(Path path) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (!Files.exists(path) && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(path).exists();
    }

    @Test
    void rejectsSymlinkedVideoInputBeforeStartingFfmpeg() throws Exception {
        Path target = tempDir.resolve("source.mp4");
        Files.write(target, new byte[] {1});
        Path link = tempDir.resolve("linked.mp4");
        try {
            Files.createSymbolicLink(link, target);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                link, tempDir.resolve("out"), VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
    }

    @Test
    void rejectsVideoInputBeneathSymlinkedAncestorBeforeStartingFfmpeg() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("input-target"));
        Path target = actual.resolve("source.mp4");
        Files.write(target, new byte[] {1});
        Path link = tempDir.resolve("input-parent-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            Assumptions.abort("Symlink creation is unavailable on this filesystem");
        }
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                link.resolve("source.mp4"), tempDir.resolve("out-parent-link"),
                VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
    }

    @Test
    void rejectsProtocolAndOptionLikeInputNamesBeforeStartingFfmpeg() throws Exception {
        for (String filename : List.of("http:evil.mp4", "-evil.mp4")) {
            Path file = tempDir.resolve(filename);
            Files.write(file, new byte[] {1});
            assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                    file, tempDir.resolve("out-" + filename.hashCode()), VideoFrameExtractor.ExtractionConfig.builder().build()))
                    .isInstanceOf(java.io.IOException.class).hasMessageContaining("allow-listed");
        }
    }

    @Test
    void rejectsSymlinkOutputDirectory() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("actual"));
        Path link = tempDir.resolve("output-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        Path input = tempDir.resolve("ok.mp4");
        Files.write(input, new byte[] {1});
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                input, link, VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("symlink");
    }

    @Test
    void batchOutputRootIsTightenedToOwnerOnly() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("per-call-output-root"));
        var posix = Files.getFileAttributeView(output,
                java.nio.file.attribute.PosixFileAttributeView.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue(posix != null, "POSIX permissions are required for this test");
        posix.setPermissions(java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));

        VideoFrameExtractor.prepareOutputDirectory(output);

        assertThat(java.nio.file.attribute.PosixFilePermissions.toString(posix.readAttributes().permissions()))
                .isEqualTo("rwx------");
    }

    @Test
    void rejectsNonStickySharedWritableParentBeforeCreatingOutput() throws Exception {
        Path parent = Files.createDirectory(tempDir.resolve("unsafe-shared-parent"));
        var posix = Files.getFileAttributeView(parent,
                java.nio.file.attribute.PosixFileAttributeView.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue(posix != null, "POSIX permissions are required for this test");
        posix.setPermissions(java.util.EnumSet.allOf(java.nio.file.attribute.PosixFilePermission.class));
        Path output = parent.resolve("frames");

        assertThatThrownBy(() -> VideoFrameExtractor.prepareOutputDirectory(output))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("shared-writable");
        assertThat(Files.exists(output)).isFalse();
        posix.setPermissions(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
    }

    @Test
    void allowsStickySharedTemporaryParentButKeepsOutputRootPrivate() throws Exception {
        Path parent = Path.of("/tmp").toRealPath();
        var posix = Files.getFileAttributeView(parent,
                java.nio.file.attribute.PosixFileAttributeView.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue(posix != null, "POSIX permissions are required for this test");
        int mode = (Integer) Files.getAttribute(parent, "unix:mode", java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue((mode & 0022) != 0 && (mode & 01000) != 0,
                "/tmp must be a shared-writable sticky temporary root");
        Path output = parent.resolve("media-vis04-sticky-" + java.util.UUID.randomUUID());

        try {
            VideoFrameExtractor.prepareOutputDirectory(output);

            Path realOutput = output.toRealPath(java.nio.file.LinkOption.NOFOLLOW_LINKS);
            assertThat(java.nio.file.attribute.PosixFilePermissions.toString(
                    Files.getPosixFilePermissions(realOutput, java.nio.file.LinkOption.NOFOLLOW_LINKS)))
                    .isEqualTo("rwx------");
        } finally {
            Files.deleteIfExists(output);
        }
    }

    @Test
    void singleFrameRejectsNonStickySharedWritableParentBeforeCreatingOutput() throws Exception {
        Path input = Files.write(tempDir.resolve("single-shared-parent-input.mp4"), new byte[] {1});
        Path parent = Files.createDirectory(tempDir.resolve("single-unsafe-shared-parent"));
        var posix = Files.getFileAttributeView(parent,
                java.nio.file.attribute.PosixFileAttributeView.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue(posix != null, "POSIX permissions are required for this test");
        posix.setPermissions(java.util.EnumSet.allOf(java.nio.file.attribute.PosixFilePermission.class));
        Path output = parent.resolve("frame.jpg");

        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(input, 0, output))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("shared-writable");
        assertThat(Files.exists(output)).isFalse();
        posix.setPermissions(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
    }

    @Test
    void singleFrameRejectsReadableSharedParentBeforeWritingMedia() throws Exception {
        Path input = Files.write(tempDir.resolve("single-readable-parent-input.mp4"), new byte[] {1});
        Path parent = Files.createDirectory(tempDir.resolve("single-readable-parent"));
        var posix = Files.getFileAttributeView(parent,
                java.nio.file.attribute.PosixFileAttributeView.class, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        Assumptions.assumeTrue(posix != null, "POSIX permissions are required for this test");
        posix.setPermissions(java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"));
        Path output = parent.resolve("frame.jpg");

        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(input, 0, output))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("owner-only");
        assertThat(Files.exists(output)).isFalse();
        posix.setPermissions(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
    }

    @Test
    void rejectsOutputDirectoryBeneathSymlinkedAncestorBeforeCreatingOutput() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("output-target"));
        Path link = tempDir.resolve("output-parent-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            Assumptions.abort("Symlink creation is unavailable on this filesystem");
        }
        Path input = tempDir.resolve("input-for-linked-output.mp4");
        Files.write(input, new byte[] {1});
        Path requestedOutput = link.resolve("frames");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                input, requestedOutput, VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("symlinks");
        assertThat(Files.exists(actual.resolve("frames"))).isFalse();
    }

    @Test
    void extractSingleFrameRejectsSymlinkedParent() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("single-frame-target"));
        Path link = tempDir.resolve("single-frame-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            return;
        }
        Path input = tempDir.resolve("single-input.mp4");
        Files.write(input, new byte[] {1});
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(
                input, 0, link.resolve("frame.jpg")))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
    }

    @Test
    void extractSingleFrameRejectsNestedSymlinkAncestorBeforeCreatingOutput() throws Exception {
        Path actual = Files.createDirectory(tempDir.resolve("single-nested-target"));
        Path link = tempDir.resolve("single-nested-link");
        try {
            Files.createSymbolicLink(link, actual);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException unavailable) {
            Assumptions.abort("Symlink creation is unavailable on this filesystem");
        }
        Path input = Files.write(tempDir.resolve("single-nested-input.mp4"), new byte[] {1});
        Path requested = link.resolve("nested").resolve("frame.jpg");

        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(input, 0, requested))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("unsafe");
        assertThat(Files.exists(actual.resolve("nested"))).isFalse();
    }

    @Test
    void extractFramesLeavesConcurrentDestinationCollisionUntouched() throws Exception {
        Path input = Files.write(tempDir.resolve("frames-input.mp4"), new byte[] {1});
        Path output = Files.createDirectory(tempDir.resolve("frames-collision-output"));
        Path collision = output.resolve("frame_0001.jpg");
        VideoFrameExtractor extractor = fakeExtractorThatCreatesCollision(collision);

        assertThatThrownBy(() -> extractor.extractFrames(input, output,
                VideoFrameExtractor.ExtractionConfig.builder().maxFrames(1).build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("already exists");

        assertThat(Files.readAllBytes(collision)).containsExactly(9, 8, 7);
        try (var entries = Files.list(output)) {
            assertThat(entries.map(path -> path.getFileName().toString())
                    .filter(name -> name.startsWith(".media-ffmpeg-")).toList()).isEmpty();
        }
    }

    @Test
    void extractSingleFrameLeavesConcurrentDestinationCollisionUntouched() throws Exception {
        Path input = Files.write(tempDir.resolve("single-collision-input.mp4"), new byte[] {1});
        Path output = tempDir.resolve("single-collision-output.jpg");
        Path collision = output;
        VideoFrameExtractor extractor = fakeExtractorThatCreatesCollision(collision);

        assertThatThrownBy(() -> extractor.extractFrameAtTimestamp(input, 0, output))
                .isInstanceOf(java.io.IOException.class);

        assertThat(Files.readAllBytes(collision)).containsExactly(9, 8, 7);
        try (var entries = Files.list(tempDir)) {
            assertThat(entries.map(path -> path.getFileName().toString())
                    .filter(name -> name.startsWith(".media-ffmpeg-")).toList()).isEmpty();
        }
    }

    private static VideoFrameExtractor fakeExtractorThatCreatesCollision(Path collision) {
        return new VideoFrameExtractor() {
            @Override
            public VideoMetadata getVideoMetadata(Path videoPath) {
                return new VideoMetadata(16, 16, 1.0, 1.0, 1, "1/1000");
            }

            @Override
            ProcessResult runFFmpegProcess(List<String> command, Duration timeout, int maxDiagnosticBytes,
                    Path monitoredOutput, long maxOutputBytes) throws java.io.IOException {
                Path requested = Path.of(command.get(command.size() - 2));
                Path generated = requested.toString().contains("%04d")
                        ? requested.getParent().resolve("frame_0001.jpg") : requested;
                Files.write(generated, new byte[] {1, 2, 3});
                Files.write(collision, new byte[] {9, 8, 7});
                return new ProcessResult(0, false, "");
            }
        };
    }

    @Test
    void failedSingleFrameExtractionCleansPartialOutput() throws Exception {
        Path input = tempDir.resolve("bad.mp4");
        Files.write(input, new byte[] {1, 2, 3});
        Path output = tempDir.resolve("failed-frame.jpg");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrameAtTimestamp(input, 0, output))
                .isInstanceOf(java.io.IOException.class);
        assertThat(Files.exists(output)).isFalse();
    }

    @Test
    void singleFrameOutputByteCapRejectsOversizedResult() throws Exception {
        Path output = tempDir.resolve("oversized.jpg");
        Files.write(output, new byte[32 * 1024 * 1024 + 1]);
        assertThatThrownBy(() -> VideoFrameExtractor.validateSingleFrameOutput(output, tempDir))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("byte budget");
    }

    @Test
    void ffmpegCommandUsesProtocolAllowlistAndBoundedDecodeOptions() throws Exception {
        var config = VideoFrameExtractor.ExtractionConfig.builder().maxFrames(3).resolution(640, 480).build();
        List<String> command = new VideoFrameExtractor().buildFFmpegCommand(
                tempDir.resolve("safe.mp4"), tempDir.resolve("frames"), config);
        assertThat(command).containsSubsequence("-protocol_whitelist", "file", "-max_alloc", "268435456",
                "-max_pixels", "16000000", "-f", "mov", "-i", tempDir.resolve("safe.mp4").toString());
        assertThat(command).containsSubsequence("-copyts", "-i", tempDir.resolve("safe.mp4").toString(),
                "-vf", "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1/1)',showinfo,scale=640:480",
                "-fps_mode", "passthrough", "-enc_time_base", "demux");
        assertThat(command).noneMatch(value -> value.startsWith("fps="));
        assertThat(command).noneMatch(value -> value.contains("http:") || value.contains("concat:"));
    }

    @Test
    void mapsVariableRateAndReorderedFramesFromExactPtsInEmissionOrder() {
        String diagnostics = "[Parsed_showinfo_0] config in time_base: 1/90000, frame_rate: 30/1\n"
                + "[Parsed_showinfo_0] n: 0 pts: 90000 pts_time:1.0\n"
                + "[Parsed_showinfo_0] n: 1 pts: 121500 pts_time:1.35\n"
                + "[Parsed_showinfo_0] n: 2 pts: 81000 pts_time:0.9\n";
        var first = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "1/90000");
        var second = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 1, "1/90000");
        var reordered = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 2, "1/90000");
        assertThat(first.timestampMs()).isEqualTo(1000L);
        assertThat(second.timestampMs()).isEqualTo(1350L);
        assertThat(reordered.timestampMs()).isEqualTo(900L);
        assertThat(reordered.pts()).isEqualTo(81000L);
    }

    @Test
    void collectedFramesPreserveEmissionSequenceGapsAndExactSourcePts() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("sequence-gap"));
        Files.write(output.resolve("frame_0001.jpg"), new byte[] {1});
        Files.write(output.resolve("frame_0003.jpg"), new byte[] {3});
        String diagnostics = "[Parsed_showinfo_0] config in time_base: 1/90000, frame_rate: 30/1\n"
                + "[Parsed_showinfo_0] n: 0 pts: 90000 pts_time:1.0\n"
                + "[Parsed_showinfo_0] n: 1 pts: 121500 pts_time:1.35\n"
                + "[Parsed_showinfo_0] n: 2 pts: 81000 pts_time:0.9\n";

        List<VideoFrameExtractor.ExtractedFrame> frames = new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().maxFrames(3).build(),
                "1/90000", diagnostics);

        assertThat(frames).extracting(VideoFrameExtractor.ExtractedFrame::getFrameNumber)
                .containsExactly(0, 2);
        assertThat(frames).extracting(frame -> frame.getSourceTimestamp().pts())
                .containsExactly(90000L, 81000L);
        assertThat(frames).extracting(VideoFrameExtractor.ExtractedFrame::getTimestampMs)
                .containsExactly(1000L, 900L);
    }

    @Test
    void collectedFramesRejectAnInvalidZeroBasedSequence() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("zero-sequence"));
        Files.write(output.resolve("frame_0000.jpg"), new byte[] {1});

        assertThatThrownBy(() -> new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().build(), "1/1000", ""))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("sequence number");
    }

    @Test
    void malformedFrameLikeFilenameFailsClosedAndIsCleanedUp() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("malformed-sequence"));
        Path malformed = output.resolve("frame_bad.jpg");
        Files.write(malformed, new byte[] {1});

        assertThatThrownBy(() -> new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().build(), "1/1000", ""))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("sequence number");
        assertThat(Files.exists(malformed)).isFalse();
    }

    @Test
    void malformedFrameLikeSymlinkIsUnlinkedWithoutTouchingItsTarget() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("malformed-symlink"));
        Path target = Files.write(tempDir.resolve("outside-target.jpg"), new byte[] {7});
        Path malformedLink = output.resolve("frame_bad.jpg");
        Files.createSymbolicLink(malformedLink, target);

        assertThatThrownBy(() -> new VideoFrameExtractor().collectExtractedFrames(
                output, VideoFrameExtractor.ExtractionConfig.builder().build(), "1/1000", ""))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("sequence number");
        assertThat(Files.isSymbolicLink(malformedLink)).isFalse();
        assertThat(Files.readAllBytes(target)).containsExactly((byte) 7);
    }

    @Test
    void preservesDiscontinuousPtsAndReturnsTypedUnknownForMissingOrInvalidTimebase() {
        String diagnostics = "[Parsed_showinfo_0] n: 0 pts: 45000 pts_time:0.5\n"
                + "[Parsed_showinfo_0] n: 1 pts: 0 pts_time:0\n"
                + "[Parsed_showinfo_0] n: 2 pts: NOPTS pts_time:NOPTS\n";
        var beforeDiscontinuity = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "1/90000");
        var afterDiscontinuity = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 1, "1/90000");
        var noPts = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 2, "1/90000");
        var invalidTimeBase = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 0, "0/0");
        var missing = VideoFrameExtractor.timestampForOutputFrame(diagnostics, 4, "1/90000");
        assertThat(beforeDiscontinuity.timestampMs()).isEqualTo(500L);
        assertThat(afterDiscontinuity.timestampMs()).isZero();
        assertThat(noPts.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(noPts.timestampMs()).isNull();
        assertThat(invalidTimeBase.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(missing.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);

        var mismatch = VideoFrameExtractor.timestampForOutputFrame(
                "[Parsed_showinfo_0] config in time_base: 1/1000, frame_rate: 30/1\n"
                        + "[Parsed_showinfo_0] n: 0 pts: 500 pts_time:0.5\n", 0, "1/90000");
        assertThat(mismatch.status()).isEqualTo(SourceMediaTimestamp.Status.UNKNOWN);
        assertThat(mismatch.reason()).isEqualTo("FFPROBE_FFMPEG_TIMEBASE_MISMATCH");
    }

    @Test
    void rationalTimebaseConversionRoundsToNearestMillisecondWithoutFpsSynthesis() {
        var timestamp = SourceMediaTimestamp.fromPts("1001", "1/30000");
        assertThat(timestamp.status()).isEqualTo(SourceMediaTimestamp.Status.KNOWN);
        assertThat(timestamp.timestampMs()).isEqualTo(33L);
        assertThatThrownBy(() -> SourceMediaTimestamp.parseTimeBase("1/0"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void ffprobeStreamTimebaseIsReadAsExactRationalMetadata() {
        var metadata = VideoFrameExtractor.parseVideoMetadata(
                "width=1280\nheight=720\nduration=4.0\nnb_frames=120\nr_frame_rate=30/1\ntime_base=1/90000\n");
        assertThat(metadata.getTimeBase()).isEqualTo("1/90000");
        assertThat(SourceMediaTimestamp.parseTimeBase(metadata.getTimeBase()))
                .isEqualTo(new SourceMediaTimestamp.RationalTimeBase(1, 90000));
        assertThat(VideoFrameExtractor.frameSequenceNumber("frame_10000.jpg"))
                .isGreaterThan(VideoFrameExtractor.frameSequenceNumber("frame_9999.jpg"));
    }

    @Test
    void timeoutKillsChildProcessTree() throws Exception {
        Path pidFile = tempDir.resolve("child.pid");
        var result = VideoFrameExtractor.runProcess(childCommand("tree", pidFile.toString()), Duration.ofSeconds(2), 128);
        assertThat(result.timedOut()).isTrue();
        long childPid = Long.parseLong(Files.readString(pidFile));
        Thread.sleep(100);
        assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void interruptionCancelsChildProcessTree() throws Exception {
        Path pidFile = tempDir.resolve("cancelled-child.pid");
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                VideoFrameExtractor.runProcess(
                        childCommand("tree", pidFile.toString()), Duration.ofSeconds(30), 128);
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        }, "video-process-cancellation-test");
        worker.start();

        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while ((!Files.exists(pidFile) || Files.size(pidFile) == 0) && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(Files.exists(pidFile)).isTrue();
        assertThat(Files.size(pidFile)).isPositive();
        long childPid = Long.parseLong(Files.readString(pidFile));

        worker.interrupt();
        worker.join(3_000);

        assertThat(worker.isAlive()).isFalse();
        assertThat(failure.get()).isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("interrupted");
        long childExitDeadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)
                && System.nanoTime() < childExitDeadline) Thread.sleep(20);
        assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void outputByteBudgetStopsChildAndReportsOverflow() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("bounded-output"));
        var result = VideoFrameExtractor.runProcess(childCommand("write", output.toString()),
                Duration.ofSeconds(5), 128, output, 1024);
        assertThat(result.outputExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
    }

    @Test
    void publishesValidatedStagedFramesAndRemovesPrivateStagingDirectory() throws Exception {
        Path staging = Files.createDirectory(tempDir.resolve("private-ffmpeg-stage"));
        Path stagedFrame = Files.write(staging.resolve("frame_0001.jpg"), new byte[] {1, 2, 3});
        Path output = Files.createDirectory(tempDir.resolve("published-frames"));
        var frame = new VideoFrameExtractor.ExtractedFrame(
                stagedFrame, SourceMediaTimestamp.fromPts("0", "1/1000"), 0);

        VideoFrameExtractor.publishStagedFrames(List.of(frame), output);
        VideoFrameExtractor.cleanupStagingDirectory(staging);

        assertThat(Files.readAllBytes(output.resolve("frame_0001.jpg"))).containsExactly(1, 2, 3);
        assertThat(Files.exists(staging)).isFalse();
    }

    @Test
    void stagedPublishFailureRollsBackOnlyFramesPublishedByThisCall() throws Exception {
        Path staging = Files.createDirectory(tempDir.resolve("failed-ffmpeg-stage"));
        Path first = Files.write(staging.resolve("frame_0001.jpg"), new byte[] {1});
        Path colliding = Files.write(staging.resolve("frame_0002.jpg"), new byte[] {2});
        Path output = Files.createDirectory(tempDir.resolve("failed-publish"));
        Files.write(output.resolve("frame_0002.jpg"), new byte[] {9});
        var frames = List.of(
                new VideoFrameExtractor.ExtractedFrame(first, SourceMediaTimestamp.fromPts("0", "1/1000"), 0),
                new VideoFrameExtractor.ExtractedFrame(colliding, SourceMediaTimestamp.fromPts("1", "1/1000"), 1));

        assertThatThrownBy(() -> VideoFrameExtractor.publishStagedFrames(frames, output))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("already exists");

        assertThat(Files.exists(output.resolve("frame_0001.jpg"))).isFalse();
        assertThat(Files.readAllBytes(output.resolve("frame_0002.jpg"))).containsExactly(9);
        VideoFrameExtractor.cleanupStagingDirectory(staging);
        assertThat(Files.exists(staging)).isFalse();
    }

    @Test
    void rollbackPreservesConcurrentReplacementAtPreviouslyPublishedPath() throws Exception {
        Path staging = Files.createDirectory(tempDir.resolve("replacement-ffmpeg-stage"));
        Path first = Files.write(staging.resolve("frame_0001.jpg"), new byte[] {1});
        Path second = Files.write(staging.resolve("frame_0002.jpg"), new byte[] {2});
        Path output = Files.createDirectory(tempDir.resolve("replacement-publish"));
        Files.write(output.resolve("frame_0002.jpg"), new byte[] {9});
        var frames = List.of(
                new VideoFrameExtractor.ExtractedFrame(first, SourceMediaTimestamp.fromPts("0", "1/1000"), 0),
                new VideoFrameExtractor.ExtractedFrame(second, SourceMediaTimestamp.fromPts("1", "1/1000"), 1));
        Path replacement = tempDir.resolve("concurrent-frame-replacement.jpg");
        Files.write(replacement, new byte[] {7, 7});

        assertThatThrownBy(() -> VideoFrameExtractor.publishStagedFrames(frames, output, published -> {
            try {
                Files.move(replacement, published, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            } catch (java.io.IOException failure) {
                throw new java.io.UncheckedIOException(failure);
            }
        })).isInstanceOf(java.io.IOException.class).hasMessageContaining("already exists");

        assertThat(Files.readAllBytes(output.resolve("frame_0001.jpg"))).containsExactly(7, 7);
        assertThat(Files.readAllBytes(output.resolve("frame_0002.jpg"))).containsExactly(9);
        VideoFrameExtractor.cleanupStagingDirectory(staging);
    }

    @Test
    void stagingCleanupRecursesAndSurfacesUnsafeCleanupTarget() throws Exception {
        Path staging = Files.createDirectories(tempDir.resolve("nested-ffmpeg-stage").resolve("nested"));
        Files.write(staging.resolve("frame.bin"), new byte[] {1});
        Path stagingRoot = staging.getParent();

        VideoFrameExtractor.cleanupStagingDirectory(stagingRoot);

        assertThat(Files.exists(stagingRoot)).isFalse();
        Path notDirectory = Files.write(tempDir.resolve("not-a-stage-directory"), new byte[] {1});
        assertThatThrownBy(() -> VideoFrameExtractor.cleanupStagingDirectory(notDirectory))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("private directory");
    }

    @Test
    void extractionFailureRetainsPrimaryErrorAndReportsStagingCleanupFailure() throws Exception {
        Path input = Files.write(tempDir.resolve("cleanup-failure-input.mp4"), new byte[] {1});
        Path output = Files.createDirectory(tempDir.resolve("cleanup-failure-output"));
        VideoFrameExtractor extractor = new VideoFrameExtractor() {
            @Override
            public VideoMetadata getVideoMetadata(Path videoPath) {
                return new VideoMetadata(16, 16, 1.0, 1.0, 1, "1/1000");
            }

            @Override
            ProcessResult runFFmpegProcess(List<String> command, Duration timeout, int maxDiagnosticBytes,
                    Path monitoredOutput, long maxOutputBytes) throws java.io.IOException {
                Files.delete(monitoredOutput);
                Files.write(monitoredOutput, new byte[] {4});
                return new ProcessResult(1, false, "");
            }
        };

        Throwable failure = catchThrowable(() -> extractor.extractFrames(input, output,
                VideoFrameExtractor.ExtractionConfig.builder().maxFrames(1).build()));

        assertThat(failure).isInstanceOf(java.io.IOException.class).hasMessageContaining("exit code: 1");
        assertThat(failure.getSuppressed()).anySatisfy(suppressed ->
                assertThat(suppressed).hasMessageContaining("staging cleanup failed"));
    }

    @Test
    void detectsOutputBudgetOverflowWhenChildExitsBetweenPollingIntervals() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("fast-bounded-output"));
        var result = VideoFrameExtractor.runProcess(childCommand("write-once", output.toString()),
                Duration.ofSeconds(5), 128, output, 1024);

        assertThat(result.outputExceeded()).isTrue();
        assertThat(result.timedOut()).isFalse();
    }

    @Test
    void rejectsTraversalPathComponents() throws Exception {
        Path file = tempDir.resolve("source.mp4");
        Files.write(file, new byte[] {1});
        Path traversal = tempDir.resolve("sub").resolve("..").resolve("source.mp4");
        assertThatThrownBy(() -> new VideoFrameExtractor().extractFrames(
                traversal, tempDir.resolve("out"), VideoFrameExtractor.ExtractionConfig.builder().build()))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("traversal");
    }

    private static List<String> childCommand(String mode) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return List.of(java, "-cp", System.getProperty("java.class.path"),
            VideoFrameExtractorProcessTest.class.getName(), mode);
    }

    private static List<String> childCommand(String mode, String argument) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return List.of(java, "-cp", System.getProperty("java.class.path"),
                VideoFrameExtractorProcessTest.class.getName(), mode, argument);
    }

    public static void main(String[] args) throws Exception {
        if ("noise".equals(args[0])) {
            byte[] bytes = new byte[64 * 1024];
            java.util.Arrays.fill(bytes, (byte) 'x');
            while (true) {
                System.err.write(bytes);
                System.err.flush();
            }
        } else if ("sleep".equals(args[0])) {
            System.out.write("waiting".getBytes(StandardCharsets.UTF_8));
            System.out.flush();
            Thread.sleep(30_000);
        } else if ("sleep-mark".equals(args[0])) {
            Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()));
            Thread.sleep(30_000);
        } else if ("tree".equals(args[0])) {
            String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
            Process child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                    VideoFrameExtractorProcessTest.class.getName(), "sleep").start();
            Files.writeString(Path.of(args[1]), Long.toString(child.pid()));
            Thread.sleep(30_000);
        } else if ("write".equals(args[0])) {
            Path output = Path.of(args[1]);
            Path file = output.resolve("frame_0000.jpg");
            try (var stream = Files.newOutputStream(file)) {
                byte[] block = new byte[4096];
                while (true) stream.write(block);
            }
        } else if ("write-once".equals(args[0])) {
            Files.write(Path.of(args[1]).resolve("frame_0000.jpg"), new byte[2048]);
        } else {
            throw new IllegalArgumentException("unknown child mode");
        }
    }
}
