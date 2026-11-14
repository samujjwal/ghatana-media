package com.ghatana.stt.local;

import com.ghatana.media.production.rendering.BoundedProcessRunner;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Extracts the first audio stream of a media container (for example the audio track of an MP4) as a mono 16 kHz PCM16
 * WAV through FFmpeg, as one bounded process: argument array only (never a shell), cleared environment, no stdin, a
 * wall-clock deadline, cooperative cancellation and an output-size ceiling. It exists so a multimodal operation can
 * transcribe the very source artifact version it also analyses visually; a plain WAV source never goes through it.
 * The produced WAV is re-read by the caller's normal WAV decoder, so a container without audio or with undecodable
 * audio is a typed {@link LocalSpeechException.Code#INVALID_INPUT}, never a success.
 */
public final class LocalMediaAudioExtractor {
    static final long MAX_WAV_BYTES = LocalWhisperCppRunner.MAX_INPUT_BYTES;

    private final Path ffmpeg;
    private final Duration maxTimeout;

    /** Returns null when {@code ffmpeg} is not an absolute, executable regular file. */
    public static LocalMediaAudioExtractor forExecutable(Path ffmpeg, Duration maxTimeout) {
        if (ffmpeg == null || !ffmpeg.isAbsolute() || !Files.isExecutable(ffmpeg) || !Files.isRegularFile(ffmpeg)) {
            return null;
        }
        return new LocalMediaAudioExtractor(ffmpeg.normalize(), maxTimeout);
    }

    private LocalMediaAudioExtractor(Path ffmpeg, Duration maxTimeout) {
        this.ffmpeg = Objects.requireNonNull(ffmpeg, "ffmpeg");
        this.maxTimeout = Objects.requireNonNull(maxTimeout, "maxTimeout");
    }

    public byte[] extractWav16kMono(byte[] container, Duration budget,
                                    BoundedProcessRunner.CancellationToken cancellation) throws LocalSpeechException {
        Objects.requireNonNull(container, "container");
        if (container.length < 16) {
            throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT, "source is too small to be media");
        }
        if (budget.isNegative() || budget.isZero()) {
            throw new LocalSpeechException(LocalSpeechException.Code.TIMEOUT, "no time budget remains");
        }
        Duration timeout = budget.compareTo(maxTimeout) < 0 ? budget : maxTimeout;
        Path work = null;
        try {
            work = Files.createTempDirectory("media-audio-extract-");
            Path in = work.resolve("in.bin");
            Path out = work.resolve("out.wav");
            Files.write(in, container);
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                    List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i",
                            in.toString(), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                            "-f", "wav", out.toString()),
                    work, Map.of("PATH", "/usr/bin:/bin", "HOME", work.toString(), "LC_ALL", "C.UTF-8"), timeout,
                    16 * 1024, 64 * 1024, cancellation, out, MAX_WAV_BYTES);
            switch (result.end()) {
                case TIMED_OUT -> throw new LocalSpeechException(LocalSpeechException.Code.TIMEOUT,
                        "audio extraction exceeded its time budget");
                case CANCELLED -> throw new LocalSpeechException(LocalSpeechException.Code.CANCELLED,
                        "audio extraction was cancelled");
                case STDOUT_OVERFLOW, WATCHED_FILE_TOO_LARGE -> throw new LocalSpeechException(
                        LocalSpeechException.Code.INVALID_INPUT, "extracted audio exceeds the 4 MiB ceiling");
                case EXITED -> { }
            }
            if (result.exitCode() != 0 || !Files.isRegularFile(out, LinkOption.NOFOLLOW_LINKS)
                    || Files.size(out) < 45 || Files.size(out) > MAX_WAV_BYTES) {
                throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT,
                        "source has no decodable audio stream");
            }
            return Files.readAllBytes(out);
        } catch (IOException failure) {
            throw new LocalSpeechException(LocalSpeechException.Code.RUNTIME_UNAVAILABLE,
                    "FFmpeg could not be started or staged");
        } finally {
            if (work != null) deleteTree(work);
        }
    }

    private static void deleteTree(Path root) {
        try (DirectoryStream<Path> children = Files.newDirectoryStream(root)) {
            for (Path child : children) Files.deleteIfExists(child);
            Files.deleteIfExists(root);
        } catch (IOException ignored) {
            // temporary staging only
        }
    }
}
