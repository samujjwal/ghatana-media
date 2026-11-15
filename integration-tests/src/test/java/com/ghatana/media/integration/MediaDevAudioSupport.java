package com.ghatana.media.integration;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Random;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevVoiceJourneySupport.ffmpeg;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Helpers for the J-07 audio restoration journeys. The degradations, the FFmpeg decode and the SNR/clipping
 * measurements here are written independently of the production lane so the lane's reported numbers can be checked.
 */
final class MediaDevAudioSupport {
    private MediaDevAudioSupport() { }

    record Wav(int sampleRate, short[] samples) { }

    /** Mono PCM16 WAV bytes. */
    static byte[] wav(int sampleRate, short[] samples) {
        ByteBuffer out = ByteBuffer.allocate(44 + samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples.length * 2)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples.length * 2);
        for (short sample : samples) out.putShort(sample);
        return out.array();
    }

    /** Decoded mono s16le through FFmpeg at the clip's own rate (an independent decode, not the lane's parser). */
    static Wav decodeWithFfmpeg(byte[] wavBytes) throws Exception {
        Path file = Files.createTempFile("media-audio-it-", ".wav");
        try {
            Files.write(file, wavBytes);
            int rate = ByteBuffer.wrap(wavBytes).order(ByteOrder.LITTLE_ENDIAN).getInt(24);
            Process process = new ProcessBuilder(ffmpeg(), "-nostdin", "-v", "error", "-i", file.toString(), "-vn",
                    "-ac", "1", "-ar", Integer.toString(rate), "-f", "s16le", "-").start();
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            process.getInputStream().transferTo(pcm);
            byte[] err = process.getErrorStream().readAllBytes();
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("ffmpeg decode: " + new String(err, StandardCharsets.UTF_8)).isZero();
            byte[] raw = pcm.toByteArray();
            short[] samples = new short[raw.length / 2];
            ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples);
            return new Wav(rate, samples);
        } finally {
            Files.deleteIfExists(file);
        }
    }

    /** clean + white noise at {@code snrDb} + 50 Hz hum (with a 100 Hz harmonic), then hard clipped. */
    static short[] degrade(short[] clean, int rate, double snrDb, double humAmplitude, double clipFraction, long seed) {
        double power = 0;
        for (short s : clean) power += (double) s * s;
        power /= clean.length;
        double sigma = Math.sqrt(power / Math.pow(10, snrDb / 10));
        Random random = new Random(seed);
        double[] noisy = new double[clean.length];
        double peak = 0;
        for (int i = 0; i < clean.length; i++) {
            double t = i / (double) rate;
            noisy[i] = clean[i] + random.nextGaussian() * sigma + humAmplitude * Math.sin(2 * Math.PI * 50 * t)
                    + 0.4 * humAmplitude * Math.sin(2 * Math.PI * 100 * t);
            peak = Math.max(peak, Math.abs(noisy[i]));
        }
        double ceiling = clipFraction * peak;
        short[] out = new short[clean.length];
        for (int i = 0; i < out.length; i++) out[i] = (short) Math.round(Math.max(-ceiling, Math.min(ceiling, noisy[i])));
        return out;
    }

    static double snrDb(short[] signal, short[] reference) {
        double ref = 0;
        double err = 0;
        for (int i = 0; i < reference.length; i++) {
            ref += (double) reference[i] * reference[i];
            double e = signal[i] - reference[i];
            err += e * e;
        }
        return 10 * Math.log10(ref / err);
    }

    /** Samples inside plateaus of at least 3 identical values with magnitude >= max(1024, 25% of peak). */
    static int clippedSamples(short[] samples) {
        int peak = 0;
        for (short s : samples) peak = Math.max(peak, Math.abs((int) s));
        int floor = Math.max(1024, peak / 4);
        int total = 0;
        for (int i = 0; i < samples.length; ) {
            int j = i;
            while (j + 1 < samples.length && samples[j + 1] == samples[i]) j++;
            if (j - i + 1 >= 3 && Math.abs((int) samples[i]) >= floor) total += j - i + 1;
            i = j + 1;
        }
        return total;
    }

    /** Synthetic (clearly not speech) clip: two tones plus seeded noise, for the fault suite. */
    static short[] syntheticClip(int rate, double seconds, long seed) {
        Random random = new Random(seed);
        short[] samples = new short[(int) (rate * seconds)];
        for (int i = 0; i < samples.length; i++) {
            double t = i / (double) rate;
            double value = 6000 * Math.sin(2 * Math.PI * 220 * t) + 3000 * Math.sin(2 * Math.PI * 660 * t)
                    + 400 * random.nextGaussian();
            samples[i] = (short) Math.round(Math.max(-32768, Math.min(32767, value)));
        }
        return samples;
    }

    /**
     * An executable wrapper used as the configured FFmpeg. It logs every filter-graph invocation (so a test can prove
     * that nothing ran) and, on request through marker files, makes the real FFmpeg run in real time ({@code -re}) so
     * the test can kill the real process mid-run: {@code kill-once} records the pid and is consumed by one run,
     * {@code slow} slows every run. Without markers it just execs the real binary.
     */
    static Path ffmpegWrapper(Path directory) throws Exception {
        Path script = directory.resolve("ffmpeg-wrapper.sh");
        String real = ffmpeg();
        Files.writeString(script, """
                #!/bin/sh
                PATH=/usr/bin:/bin
                D='%s'
                case " $* " in *" -af "*) echo "$$" >> "$D/invocations.log";; esac
                if [ -f "$D/kill-once" ]; then rm -f "$D/kill-once"; echo "$$" > "$D/pid"; exec '%s' -re "$@"; fi
                if [ -f "$D/slow" ]; then exec '%s' -re "$@"; fi
                exec '%s' "$@"
                """.formatted(directory, real, real, real));
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwx------"));
        return script;
    }

    static int invocations(Path directory) throws Exception {
        Path log = directory.resolve("invocations.log");
        return Files.isRegularFile(log) ? (int) Files.readAllLines(log).stream().filter(line -> !line.isBlank()).count() : 0;
    }
}
