package com.ghatana.media.launcher;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure timing logic of the DEV_ONLY dubbing lane: fit one synthesized segment to its source time window, then place
 * the fitted segments on one mono 24 kHz timeline whose offsets are the source-clock window starts.
 *
 * <p>Fit rule per segment (window = source end - source start, natural = measured synthesized duration):</p>
 * <ul>
 *   <li>natural &lt;= window: {@link Fit#FITS}, tempo 1.0, silence pads the rest of the window;</li>
 *   <li>natural &gt; window and the needed speed-up is at most {@link #MAX_TEMPO}: {@link Fit#TEMPO_ADJUSTED} with
 *       the bounded {@code atempo} factor that makes the measured result fit;</li>
 *   <li>otherwise {@link Fit#OVERFLOW}: the maximum tempo is applied and the remainder is reported as overflow.
 *       Audio is never truncated; the caller either refuses the dub (typed) or, under the explicit spill policy,
 *       keeps the full audio only when it does not run into the next segment's window.</li>
 * </ul>
 */
final class MediaDevDubTiming {
    static final int SAMPLE_RATE = 24_000;
    /** Documented atempo bounds of the lane. Only speed-ups are used; the slow bound is recorded for completeness. */
    static final double MIN_TEMPO = 0.8;
    static final double MAX_TEMPO = 1.25;
    static final int MAX_TRACK_MILLIS = 20 * 60 * 1000;

    enum Fit { FITS, TEMPO_ADJUSTED, OVERFLOW }

    private MediaDevDubTiming() { }

    /** Applies a pitch-preserving tempo factor to mono 24 kHz samples (ffmpeg atempo in production). */
    interface TempoAdjuster {
        short[] adjust(short[] samples, double tempo) throws java.io.IOException;
    }

    /** One synthesized segment ready for placement. */
    record Segment(String segmentId, long startMillis, long endMillis, short[] natural) { }

    record Placed(String segmentId, long sourceStartMillis, long sourceEndMillis, long windowMillis, long naturalMillis,
                  double tempoFactor, long dubMillis, long placedStartMillis, long placedEndMillis, Fit fit,
                  long overflowMillis, short[] samples) {
        boolean overflow() { return fit == Fit.OVERFLOW; }

        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("segmentId", segmentId);
            view.put("sourceStartMillis", sourceStartMillis);
            view.put("sourceEndMillis", sourceEndMillis);
            view.put("windowMillis", windowMillis);
            view.put("naturalDurationMillis", naturalMillis);
            view.put("tempoFactor", tempoFactor);
            view.put("dubDurationMillis", dubMillis);
            view.put("placedStartMillis", placedStartMillis);
            view.put("placedEndMillis", placedEndMillis);
            view.put("fit", fit.name());
            view.put("overflow", overflow());
            view.put("overflowMillis", overflowMillis);
            return view;
        }
    }

    static long millis(int samples) {
        return Math.round(samples * 1000.0 / SAMPLE_RATE);
    }

    static int samplesFor(long millis) {
        return (int) (millis * SAMPLE_RATE / 1000);
    }

    /** Fits one segment; {@code adjuster} may be null, which means tempo adjustment is unavailable (overflow instead). */
    static Placed fit(Segment segment, TempoAdjuster adjuster) throws java.io.IOException {
        long window = segment.endMillis() - segment.startMillis();
        if (window <= 0) throw new IllegalArgumentException("source window must be positive");
        long natural = millis(segment.natural().length);
        if (natural <= window) {
            return new Placed(segment.segmentId(), segment.startMillis(), segment.endMillis(), window, natural, 1.0,
                    natural, segment.startMillis(), segment.startMillis() + natural, Fit.FITS, 0, segment.natural());
        }
        double maxTempo = adjuster == null ? 1.0 : MAX_TEMPO;
        double tempo = Math.min(maxTempo, roundUp4(natural * 1.003 / window));
        short[] samples = segment.natural();
        long dub = natural;
        if (adjuster != null && tempo > 1.0) {
            samples = adjuster.adjust(segment.natural(), tempo);
            dub = millis(samples.length);
            if (dub > window && tempo < maxTempo) {
                // One refinement from the measured result (the encoder's rounding), still within the bound.
                tempo = Math.min(maxTempo, roundUp4(tempo * dub * 1.003 / window));
                samples = adjuster.adjust(segment.natural(), tempo);
                dub = millis(samples.length);
            }
        } else {
            tempo = 1.0;
        }
        long overflow = Math.max(0, dub - window);
        Fit fit = overflow == 0 ? Fit.TEMPO_ADJUSTED : Fit.OVERFLOW;
        return new Placed(segment.segmentId(), segment.startMillis(), segment.endMillis(), window, natural, tempo, dub,
                segment.startMillis(), segment.startMillis() + dub, fit, overflow, samples);
    }

    private static double roundUp4(double value) {
        return Math.ceil(value * 10_000.0) / 10_000.0;
    }

    /** A segment whose audio does not fit and that the chosen policy cannot accommodate. */
    record Overflow(String segmentId, long windowMillis, long naturalMillis, long dubMillis, long overflowMillis,
                    double requiredTempo, String reason) {
        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("segmentId", segmentId);
            view.put("windowMillis", windowMillis);
            view.put("naturalDurationMillis", naturalMillis);
            view.put("dubDurationMillis", dubMillis);
            view.put("overflowMillis", overflowMillis);
            view.put("requiredTempoFactor", requiredTempo);
            view.put("maxTempoFactor", MAX_TEMPO);
            view.put("reason", reason);
            return view;
        }
    }

    /**
     * The overflowing segments the policy cannot accommodate. REFUSE: every OVERFLOW segment. ALLOW_SPILL: only an
     * OVERFLOW segment whose full audio would run into the next segment's source window (or the track ceiling).
     */
    static List<Overflow> unaccommodated(List<Placed> placed, boolean allowSpill) {
        List<Overflow> refused = new ArrayList<>();
        for (int i = 0; i < placed.size(); i++) {
            Placed current = placed.get(i);
            if (!current.overflow()) continue;
            double required = current.naturalMillis() / (double) current.windowMillis();
            if (!allowSpill) {
                refused.add(new Overflow(current.segmentId(), current.windowMillis(), current.naturalMillis(),
                        current.dubMillis(), current.overflowMillis(), required, "EXCEEDS_WINDOW_AT_MAX_TEMPO"));
                continue;
            }
            long nextStart = i + 1 < placed.size() ? placed.get(i + 1).placedStartMillis() : Long.MAX_VALUE;
            if (current.placedEndMillis() > nextStart || current.placedEndMillis() > MAX_TRACK_MILLIS) {
                refused.add(new Overflow(current.segmentId(), current.windowMillis(), current.naturalMillis(),
                        current.dubMillis(), current.overflowMillis(), required, "SPILL_COLLIDES_WITH_NEXT_SEGMENT"));
            }
        }
        return refused;
    }

    /** Mono 24 kHz timeline: silence, with each fitted segment at its source window start (sum with clipping). */
    static short[] assemble(List<Placed> placed, long minimumTrackMillis) {
        long end = minimumTrackMillis;
        for (Placed segment : placed) end = Math.max(end, segment.placedEndMillis());
        if (end <= 0 || end > MAX_TRACK_MILLIS) throw new IllegalArgumentException("track length is out of range");
        int[] mix = new int[samplesFor(end) + 1];
        for (Placed segment : placed) {
            int offset = samplesFor(segment.placedStartMillis());
            for (int i = 0; i < segment.samples().length && offset + i < mix.length; i++) {
                mix[offset + i] += segment.samples()[i];
            }
        }
        short[] track = new short[mix.length];
        for (int i = 0; i < mix.length; i++) track[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, mix[i]));
        return track;
    }

    // ---- WAV ----

    /** Mono 24 kHz signed 16-bit PCM WAV bytes. */
    static byte[] encodeWav(short[] samples) {
        return encodeWav(samples, null);
    }

    /**
     * Mono 24 kHz signed 16-bit PCM WAV bytes. A non-null {@code comment} is written after the data chunk as a RIFF
     * {@code LIST/INFO ICMT} chunk (the same kind of provenance comment the audio-restoration lane writes), so the
     * bytes differ per request while the PCM samples stay exactly what was synthesized and assembled.
     */
    static byte[] encodeWav(short[] samples, String comment) {
        int data = samples.length * 2;
        byte[] text = comment == null ? new byte[0] : (comment + "\0").getBytes(StandardCharsets.US_ASCII);
        int icmt = text.length == 0 ? 0 : 8 + text.length + (text.length & 1);
        int list = icmt == 0 ? 0 : 8 + 4 + icmt;
        ByteBuffer out = ByteBuffer.allocate(44 + data + list).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + data + list)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(data);
        for (short sample : samples) out.putShort(sample);
        if (list > 0) {
            out.put("LIST".getBytes(StandardCharsets.US_ASCII)).putInt(4 + icmt)
                    .put("INFOICMT".getBytes(StandardCharsets.US_ASCII)).putInt(text.length).put(text);
            if ((text.length & 1) == 1) out.put((byte) 0);
        }
        return out.array();
    }

    /** Decodes mono 24 kHz PCM16 WAV; any other shape is refused. */
    static short[] decodeWav(byte[] wav) {
        if (wav.length < 44 || !"RIFF".equals(ascii(wav, 0)) || !"WAVE".equals(ascii(wav, 8))) {
            throw new IllegalArgumentException("not a RIFF/WAVE file");
        }
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        boolean formatSeen = false;
        for (int at = 12; at + 8 <= wav.length; ) {
            String id = ascii(wav, at);
            long size = buffer.getInt(at + 4) & 0xffffffffL;
            int body = at + 8;
            if ("fmt ".equals(id)) {
                if (size < 16 || buffer.getShort(body) != 1 || buffer.getShort(body + 2) != 1
                        || buffer.getInt(body + 4) != SAMPLE_RATE || buffer.getShort(body + 14) != 16) {
                    throw new IllegalArgumentException("WAV is not mono 24 kHz PCM16");
                }
                formatSeen = true;
            } else if ("data".equals(id)) {
                if (!formatSeen) throw new IllegalArgumentException("WAV data precedes its format");
                int length = (int) Math.min(size, wav.length - body);
                short[] samples = new short[length / 2];
                for (int i = 0; i < samples.length; i++) samples[i] = buffer.getShort(body + i * 2);
                return samples;
            }
            at = (int) Math.min(Integer.MAX_VALUE, body + size + (size & 1));
        }
        throw new IllegalArgumentException("WAV has no data chunk");
    }

    private static String ascii(byte[] bytes, int at) {
        return new String(bytes, at, 4, StandardCharsets.US_ASCII);
    }
}
