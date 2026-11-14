package com.ghatana.stt.local;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * Bounded PCM16 WAV helper: decode, mono downmix, band-limited (windowed-sinc) resampling and re-encode. It
 * exists so a synthesized 24 kHz clip can be fed to the 16 kHz mono STT contract deterministically, without
 * an external converter.
 */
public final class PcmWav {
    static final int MAX_PCM_BYTES = 16 * 1024 * 1024;

    private PcmWav() { }

    public record Pcm(short[] samples, int sampleRate) {
        public double seconds() { return samples.length / (double) sampleRate; }
    }

    /** Decodes little-endian signed 16-bit PCM WAV (mono or stereo); stereo is averaged to mono. */
    public static Pcm decode(byte[] wav) throws LocalSpeechException {
        try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            AudioFormat format = stream.getFormat();
            int channels = format.getChannels();
            if (!AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding()) || format.isBigEndian()
                    || format.getSampleSizeInBits() != 16 || (channels != 1 && channels != 2)
                    || format.getSampleRate() < 8_000 || format.getSampleRate() > 48_000) {
                throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT,
                        "WAV must be 16-bit little-endian PCM, mono or stereo, 8-48 kHz");
            }
            byte[] pcm = stream.readNBytes(MAX_PCM_BYTES + 1);
            if (pcm.length == 0 || pcm.length > MAX_PCM_BYTES || pcm.length % (2 * channels) != 0) {
                throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT, "WAV payload size is invalid");
            }
            short[] mono = new short[pcm.length / (2 * channels)];
            for (int i = 0; i < mono.length; i++) {
                int sum = 0;
                for (int c = 0; c < channels; c++) {
                    int offset = (i * channels + c) * 2;
                    sum += (short) ((pcm[offset] & 0xff) | (pcm[offset + 1] << 8));
                }
                mono[i] = (short) (sum / channels);
            }
            return new Pcm(mono, Math.round(format.getSampleRate()));
        } catch (UnsupportedAudioFileException | IOException invalid) {
            throw new LocalSpeechException(LocalSpeechException.Code.INVALID_INPUT, "not a decodable WAV file");
        }
    }

    public static Pcm resample(Pcm input, int targetRate) {
        if (input.sampleRate() == targetRate) return input;
        double ratio = (double) targetRate / input.sampleRate();
        int outLength = (int) Math.floor(input.samples().length * ratio);
        double cutoff = Math.min(1.0, ratio) * 0.97; // normalized to the input Nyquist, guard for the transition band
        int halfWidth = 32;
        short[] out = new short[outLength];
        short[] in = input.samples();
        for (int n = 0; n < outLength; n++) {
            double center = n / ratio;
            int first = (int) Math.floor(center) - halfWidth + 1;
            double acc = 0;
            for (int k = first; k < first + 2 * halfWidth; k++) {
                if (k < 0 || k >= in.length) continue;
                double x = k - center;
                double window = 0.5 + 0.5 * Math.cos(Math.PI * x / halfWidth);
                double sinc = x == 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
                acc += in[k] * sinc * window;
            }
            out[n] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(acc)));
        }
        return new Pcm(out, targetRate);
    }

    public static byte[] encode(Pcm pcm) {
        byte[] bytes = new byte[pcm.samples().length * 2];
        for (int i = 0; i < pcm.samples().length; i++) {
            bytes[2 * i] = (byte) pcm.samples()[i];
            bytes[2 * i + 1] = (byte) (pcm.samples()[i] >> 8);
        }
        AudioFormat format = new AudioFormat(AudioFormat.Encoding.PCM_SIGNED, pcm.sampleRate(), 16, 1, 2,
                pcm.sampleRate(), false);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (AudioInputStream stream = new AudioInputStream(new ByteArrayInputStream(bytes), format,
                pcm.samples().length)) {
            AudioSystem.write(stream, AudioFileFormat.Type.WAVE, out);
        } catch (IOException failure) {
            throw new IllegalStateException("WAV encoding failed", failure);
        }
        return out.toByteArray();
    }

    /** Convenience: any supported PCM16 WAV to 16 kHz mono PCM16 WAV. */
    public static byte[] toMono16k(byte[] wav) throws LocalSpeechException {
        return encode(resample(decode(wav), 16_000));
    }
}
