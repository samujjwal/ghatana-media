package com.ghatana.tts.local;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.ghatana.tts.local.LocalAudioEncoder.Encoding;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * MP3 / OGG_OPUS encoding through a bounded FFmpeg process. The real-FFmpeg cases run when an FFmpeg binary with the
 * codec is configured ({@code MEDIA_FFMPEG}, or {@code /usr/bin/ffmpeg}) and are skipped with that reason otherwise;
 * the failure-mode cases use a synthetic executable and always run.
 */
class LocalAudioEncoderTest {
    @TempDir Path dir;

    private static byte[] tone24k(double seconds) throws Exception {
        int samples = (int) (24_000 * seconds);
        byte[] pcm = new byte[samples * 2];
        for (int i = 0; i < samples; i++) {
            short v = (short) (8000 * Math.sin(2 * Math.PI * 440 * i / 24_000.0));
            pcm[2 * i] = (byte) v;
            pcm[2 * i + 1] = (byte) (v >> 8);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AudioSystem.write(new AudioInputStream(new ByteArrayInputStream(pcm),
                new AudioFormat(24_000, 16, 1, true, false), samples), AudioFileFormat.Type.WAVE, out);
        return out.toByteArray();
    }

    private static LocalAudioEncoder realEncoder() {
        String configured = System.getenv("MEDIA_FFMPEG");
        Path candidate = Path.of(configured != null && !configured.isBlank() ? configured : "/usr/bin/ffmpeg");
        LocalAudioEncoder encoder = LocalAudioEncoder.forExecutable(candidate, Duration.ofMinutes(1));
        assumeTrue(encoder != null && encoder.verifyCodecs().contains(Encoding.MP3),
                "SKIPPED: no working FFmpeg with libmp3lame at " + candidate + " (set MEDIA_FFMPEG)");
        return encoder;
    }

    @Test
    void mp3IsProducedFromTheSynthesizedWavAndDecodesEndToEnd() throws Exception {
        LocalAudioEncoder encoder = realEncoder();
        byte[] wav = tone24k(1.5);
        LocalAudioEncoder.Encoded encoded = encoder.encode(wav, Encoding.MP3, Duration.ofSeconds(60), () -> false);
        assertThat(encoded.encoding()).isEqualTo(Encoding.MP3);
        byte[] mp3 = encoded.bytes();
        assertThat(mp3.length).isBetween(1_000, wav.length);
        assertThat(mp3[0] == 'I' || (mp3[0] & 0xFF) == 0xFF).isTrue();
    }

    @Test
    void oggOpusIsProducedWhenTheBuildHasTheCodec() throws Exception {
        LocalAudioEncoder encoder = realEncoder();
        assumeTrue(encoder.verifyCodecs().contains(Encoding.OGG_OPUS), "SKIPPED: FFmpeg has no libopus");
        byte[] ogg = encoder.encode(tone24k(1.0), Encoding.OGG_OPUS, Duration.ofSeconds(60), () -> false).bytes();
        assertThat(new String(ogg, 0, 4, java.nio.charset.StandardCharsets.US_ASCII)).isEqualTo("OggS");
    }

    @Test
    void wavRequestsPassThroughUnchangedWithoutAnyProcess() throws Exception {
        LocalAudioEncoder encoder = LocalAudioEncoder.forExecutable(fakeFfmpeg("exit 7"), Duration.ofSeconds(5));
        byte[] wav = tone24k(0.2);
        assertThat(encoder.encode(wav, Encoding.LINEAR16, Duration.ofSeconds(5), () -> false).bytes()).isEqualTo(wav);
    }

    @Test
    void anFfmpegWithoutTheCodecRefusesWithATypedEncodingError() throws Exception {
        LocalAudioEncoder encoder = LocalAudioEncoder.forExecutable(fakeFfmpeg("echo ' A....D aac'"),
                Duration.ofSeconds(5));
        assertThat(encoder.verifyCodecs()).isEmpty();
        assertThatThrownBy(() -> encoder.encode(tone24k(0.2), Encoding.MP3, Duration.ofSeconds(5), () -> false))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        failure -> assertThat(failure.code()).isEqualTo(LocalTtsException.Code.ENCODING_NOT_SUPPORTED));
    }

    @Test
    void garbageEncoderOutputIsRejectedInsteadOfReportedAsSuccess() throws Exception {
        // Advertises libmp3lame, then "encodes" to a file that is not an MP3.
        Path fake = fakeFfmpeg("""
                if [ "$1" = "-hide_banner" ]; then echo ' A....D libmp3lame'; exit 0; fi
                for last; do :; done
                echo not-an-mp3-file-at-all > "$last"
                """);
        LocalAudioEncoder encoder = LocalAudioEncoder.forExecutable(fake, Duration.ofSeconds(5));
        assertThatThrownBy(() -> encoder.encode(tone24k(0.2), Encoding.MP3, Duration.ofSeconds(5), () -> false))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        failure -> assertThat(failure.code()).isEqualTo(LocalTtsException.Code.OUTPUT_INVALID));
    }

    @Test
    void aHungEncoderIsKilledAtTheDeadlineInsteadOfHanging() throws Exception {
        Path fake = fakeFfmpeg("""
                if [ "$1" = "-hide_banner" ]; then echo ' A....D libmp3lame'; exit 0; fi
                sleep 60
                """);
        LocalAudioEncoder encoder = LocalAudioEncoder.forExecutable(fake, Duration.ofSeconds(30));
        long started = System.nanoTime();
        assertThatThrownBy(() -> encoder.encode(tone24k(0.2), Encoding.MP3, Duration.ofMillis(800), () -> false))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        failure -> assertThat(failure.code()).isEqualTo(LocalTtsException.Code.TIMEOUT));
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(20));
    }

    @Test
    void relativeOrMissingExecutablesYieldNoEncoder() {
        assertThat(LocalAudioEncoder.forExecutable(Path.of("ffmpeg"), Duration.ofSeconds(1))).isNull();
        assertThat(LocalAudioEncoder.forExecutable(dir.resolve("absent"), Duration.ofSeconds(1))).isNull();
        assertThat(LocalAudioEncoder.forExecutable(null, Duration.ofSeconds(1))).isNull();
    }

    private Path fakeFfmpeg(String body) throws Exception {
        Path script = Files.createTempFile(dir, "fake-ffmpeg", ".sh");
        Files.writeString(script, "#!/bin/bash\n" + body + "\n");
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        return script;
    }
}
