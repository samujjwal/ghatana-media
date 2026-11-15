package com.ghatana.media.launcher;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/**
 * Strict, bounded RIFF/WAVE reader for the DEV_ONLY audio restoration lane. Only signed 16-bit PCM with one or two
 * channels in a bounded sample-rate range is accepted; anything else is refused with a typed code, never repaired or
 * guessed. Samples are returned interleaved.
 */
final class MediaDevAudioWav {
    static final int MIN_RATE = 8_000;
    static final int MAX_RATE = 96_000;
    static final int MAX_CHANNELS = 2;

    /** Decoded PCM16 audio; {@code samples} is interleaved and owned by this value (never exposed mutably). */
    record Pcm(int sampleRate, int channels, short[] samples) {
        Pcm {
            samples = samples.clone();
        }
        @Override public short[] samples() { return samples.clone(); }
        int frames() { return samples.length / channels; }
        /** Package-private zero-copy view for read-only analysis. */
        short[] raw() { return samples; }
        @Override public boolean equals(Object other) {
            return other instanceof Pcm pcm && pcm.sampleRate == sampleRate && pcm.channels == channels
                    && Arrays.equals(pcm.samples, samples);
        }
        @Override public int hashCode() { return 31 * (31 * sampleRate + channels) + Arrays.hashCode(samples); }
        @Override public String toString() { return "Pcm[" + sampleRate + " Hz, " + channels + " ch, " + frames() + " frames]"; }
    }

    static final class WavException extends RuntimeException {
        private final String code;
        WavException(String code, String message) {
            super(message, null, false, false);
            this.code = code;
        }
        String code() { return code; }
    }

    private MediaDevAudioWav() { }

    static Pcm parse(byte[] bytes) {
        if (bytes.length < 44) throw new WavException("AUDIO_NOT_WAV", "the artifact is too small to be a WAV file");
        ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        if (buffer.getInt(0) != 0x46464952 || buffer.getInt(8) != 0x45564157) { // "RIFF" ... "WAVE"
            throw new WavException("AUDIO_NOT_WAV", "the artifact is not a RIFF/WAVE file");
        }
        int position = 12;
        int channels = -1;
        int rate = -1;
        boolean fmtSeen = false;
        while (position + 8 <= bytes.length) {
            int id = buffer.getInt(position);
            long size = Integer.toUnsignedLong(buffer.getInt(position + 4));
            int body = position + 8;
            if (id == 0x20746d66) { // "fmt "
                if (size < 16 || body + 16 > bytes.length) throw new WavException("AUDIO_FORMAT_NOT_SUPPORTED", "malformed fmt chunk");
                int tag = Short.toUnsignedInt(buffer.getShort(body));
                channels = Short.toUnsignedInt(buffer.getShort(body + 2));
                rate = buffer.getInt(body + 4);
                int bits = Short.toUnsignedInt(buffer.getShort(body + 14));
                if (tag != 1 || bits != 16) {
                    throw new WavException("AUDIO_FORMAT_NOT_SUPPORTED", "only signed 16-bit PCM WAV is supported");
                }
                if (channels < 1 || channels > MAX_CHANNELS) {
                    throw new WavException("AUDIO_FORMAT_NOT_SUPPORTED", "only mono or stereo audio is supported");
                }
                if (rate < MIN_RATE || rate > MAX_RATE) {
                    throw new WavException("AUDIO_FORMAT_NOT_SUPPORTED",
                            "sample rate must be within [" + MIN_RATE + ", " + MAX_RATE + "] Hz");
                }
                fmtSeen = true;
            } else if (id == 0x61746164) { // "data"
                if (!fmtSeen) throw new WavException("AUDIO_NOT_WAV", "data chunk precedes the fmt chunk");
                long available = bytes.length - (long) body;
                long length = Math.min(size, available);
                int frameBytes = 2 * channels;
                long frames = length / frameBytes;
                if (frames <= 0) throw new WavException("AUDIO_EMPTY", "the audio has no samples");
                short[] samples = new short[(int) (frames * channels)];
                ByteBuffer data = ByteBuffer.wrap(bytes, body, (int) (frames * frameBytes)).order(ByteOrder.LITTLE_ENDIAN);
                data.asShortBuffer().get(samples);
                return new Pcm(rate, channels, samples);
            }
            long next = body + size + (size & 1);
            if (next > bytes.length) break;
            position = (int) next;
        }
        throw new WavException("AUDIO_NOT_WAV", "no data chunk was found");
    }

    /** Canonical 44-byte-header PCM16 WAV; used by tests and the metric fixtures. */
    static byte[] write(Pcm pcm) {
        int dataBytes = pcm.raw().length * 2;
        ByteBuffer out = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        out.putInt(0x46464952).putInt(36 + dataBytes).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) pcm.channels()).putInt(pcm.sampleRate())
                .putInt(pcm.sampleRate() * pcm.channels() * 2).putShort((short) (pcm.channels() * 2)).putShort((short) 16);
        out.putInt(0x61746164).putInt(dataBytes);
        out.asShortBuffer().put(pcm.raw());
        return out.array();
    }
}
