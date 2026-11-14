package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider;
import com.ghatana.media.production.rendering.BoundedProcessRunner;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Resolves one still frame from exact video bytes with the operator-configured absolute FFmpeg path, run
 * through {@link BoundedProcessRunner} (argument array, cleared environment, no stdin, wall-clock and output
 * ceilings). The video is staged in a private temporary directory that is always removed. The time position is
 * formatted from integer milliseconds, so no caller text reaches the command line.
 */
final class MediaDevFfmpegFrameExtractor implements LocalOpenModelVisionProvider.FrameExtractor {
    private static final long MAX_FRAME_BYTES = 64L * 1024 * 1024;
    private final Path ffmpeg;
    private final Duration timeout;

    MediaDevFfmpegFrameExtractor(Path ffmpeg, Duration timeout) {
        if (!ffmpeg.isAbsolute()) throw new IllegalArgumentException("ffmpeg path must be absolute");
        this.ffmpeg = ffmpeg;
        this.timeout = timeout;
    }

    /** Null when no absolute FFmpeg path is configured; the tool is never resolved through PATH. */
    static MediaDevFfmpegFrameExtractor from(Map<String, String> environment) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        if (ffmpeg == null || ffmpeg.isBlank()) return null;
        return new MediaDevFfmpegFrameExtractor(Path.of(ffmpeg), Duration.ofSeconds(60));
    }

    @Override
    public byte[] extractPng(byte[] video, long timeMillis) throws IOException {
        if (timeMillis < 0) throw new IllegalArgumentException("timeMillis must not be negative");
        Path dir = Files.createTempDirectory("media-dev-frame-",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        try {
            Path in = dir.resolve("in.bin");
            Path out = dir.resolve("frame.png");
            Files.write(in, video);
            String position = (timeMillis / 1000) + "." + String.format("%03d", timeMillis % 1000);
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                    List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-ss", position, "-i", in.toString(),
                            "-frames:v", "1", "-f", "image2", "-c:v", "png", "-y", out.toString()),
                    dir, Map.of(), timeout, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER,
                    out, MAX_FRAME_BYTES);
            if (!result.succeeded() || !Files.isRegularFile(out) || Files.size(out) == 0) {
                throw new IOException("frame extraction did not produce a frame");
            }
            return Files.readAllBytes(out);
        } finally {
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
            }
        }
    }
}
