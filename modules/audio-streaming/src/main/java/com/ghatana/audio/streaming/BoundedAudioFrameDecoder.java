package com.ghatana.audio.streaming;

import java.util.Objects;

/**
 * Bounded source-frame decoding under a declared codec and timebase.
 *
 * <p>AS-04: raw audio is decoded only when the declared codec and rational
 * sample timebase are supported. PCM_S16LE is structurally decoded here;
 * OPUS is recognized but returns {@link DecodeVerdict#UNAVAILABLE} until an
 * actual Opus decoder is wired into this runtime. Sample positions are exact
 * rational seconds calculated from source ticks and seconds-per-tick, never
 * floating-point seconds or wall clock. Decode is bounded: a session admits at most
 * {@link SessionBudget#maxFrames} frames and
 * {@link SessionBudget#maxBytes} bytes before returning
 * {@link DecodeVerdict#BUDGET_EXCEEDED} — a producer faster than the
 * declared budget cannot exhaust memory. Concurrent calls on one decoder are
 * serialized so they cannot oversubscribe its shared session budget.
 *
 * @doc.type class
 * @doc.purpose Bounded codec/timebase-declared audio frame decoding
 * @doc.layer product
 * @doc.pattern Decoder
 */
public final class BoundedAudioFrameDecoder {

    /** Recognized codec declarations; recognition alone does not mean a decoder is available. */
    public enum Codec { PCM_S16LE, OPUS }

    /** Result of one bounded decode attempt. */
    public enum DecodeVerdict {
        DECODED,
        /** Codec, timebase or frame subtype is unsupported — not an error, an honest abstain. */
        UNAVAILABLE,
        /** The session frame/byte budget was exceeded. */
        BUDGET_EXCEEDED,
        /** The declared frame shape was malformed. */
        MALFORMED
    }

    /** Rational source-media time in seconds — exact, never float. */
    public record SamplePosition(long numerator, long denominator) {
        public SamplePosition {
            if (numerator < 0) {
                throw new IllegalArgumentException("time numerator cannot be negative");
            }
            if (denominator <= 0) {
                throw new IllegalArgumentException("timebase denominator must be positive");
            }
        }
    }

    /** Per-session decode budget. */
    public record SessionBudget(int maxFrames, long maxBytes) {
        public SessionBudget {
            if (maxFrames < 1 || maxBytes < 1) {
                throw new IllegalArgumentException("budget must be positive");
            }
        }
    }

    /** A decoded source frame with its exact sample position and provenance. */
    public record DecodedSourceFrame(
            Codec codec, byte[] payload, SamplePosition position,
            /** true when the frame carries a VAD/caption partial revision (not a final commit). */
            boolean partialRevision) {
        public DecodedSourceFrame {
            Objects.requireNonNull(codec, "codec");
            Objects.requireNonNull(payload, "payload");
            Objects.requireNonNull(position, "position");
            payload = payload.clone();
        }

        /** Returns a copy so decoded source bytes cannot be changed after admission. */
        @Override
        public byte[] payload() {
            return payload.clone();
        }
    }

    /** The outcome of a bounded decode. */
    public record Result(DecodeVerdict verdict, DecodedSourceFrame frame, String reason) {
        static Result ok(DecodedSourceFrame f) { return new Result(DecodeVerdict.DECODED, f, null); }
        static Result fail(DecodeVerdict v, String r) { return new Result(v, null, r); }
    }

    private final Codec codec;
    private final SamplePosition timebase;
    private final SessionBudget budget;
    private int frames;
    private long bytes;

    private BoundedAudioFrameDecoder(Codec codec, SamplePosition timebase, SessionBudget budget) {
        this.codec = codec;
        this.timebase = timebase;
        this.budget = budget;
    }

    /**
     * Declares a bounded decode session. {@code codecName} and the timebase
     * must match a recognized codec/rational pair. Only PCM_S16LE decoding
     * is currently implemented; a declared OPUS session reports UNAVAILABLE
     * for every frame until a real decoder is wired in.
     */
    public static BoundedAudioFrameDecoder declare(
            String codecName, long timebaseNumerator, long timebaseDenominator,
            SessionBudget budget) {
        Objects.requireNonNull(codecName, "codecName");
        Objects.requireNonNull(budget, "budget");
        if (timebaseNumerator <= 0) {
            throw new IllegalArgumentException("timebase numerator must be positive");
        }
        Codec codec;
        try {
            codec = Codec.valueOf(codecName.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException unknown) {
            codec = null;
        }
        return new BoundedAudioFrameDecoder(codec,
                new SamplePosition(timebaseNumerator, timebaseDenominator), budget);
    }

    /**
     * Decodes one source frame. A frame carries its declared byte payload,
     * its source tick position, and whether it is a partial (VAD/caption)
     * revision. The output position is ticks * secondsPerTick as an exact
     * rational number. Undeclared/unsupported codec, malformed shape, or a
     * session over budget fail closed.
     */
    public synchronized Result decode(byte[] payload, long positionNumerator, boolean partialRevision) {
        if (codec == null) {
            return Result.fail(DecodeVerdict.UNAVAILABLE,
                    "codec is not declared for this session");
        }
        if (codec == Codec.OPUS) {
            return Result.fail(DecodeVerdict.UNAVAILABLE,
                    "OPUS decoder is not available in this runtime");
        }
        if (payload == null || payload.length == 0) {
            return Result.fail(DecodeVerdict.MALFORMED, "empty payload");
        }
        if (codec == Codec.PCM_S16LE && (payload.length & 1) != 0) {
            return Result.fail(DecodeVerdict.MALFORMED,
                    "PCM_S16LE payload must be a whole number of 16-bit samples");
        }
        if (payload.length > AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
            return Result.fail(DecodeVerdict.BUDGET_EXCEEDED,
                    "frame payload exceeds the bounded audio frame size");
        }
        if (positionNumerator < 0) {
            return Result.fail(DecodeVerdict.MALFORMED,
                    "sample position numerator cannot be negative");
        }
        long exactTimeNumerator;
        try {
            exactTimeNumerator = Math.multiplyExact(positionNumerator, timebase.numerator());
        } catch (ArithmeticException overflow) {
            return Result.fail(DecodeVerdict.MALFORMED,
                    "sample position exceeds the exact rational time range");
        }
        if (frames >= budget.maxFrames() || payload.length > budget.maxBytes() - bytes) {
            return Result.fail(DecodeVerdict.BUDGET_EXCEEDED,
                    "session frame/byte budget exceeded");
        }
        Result result = Result.ok(new DecodedSourceFrame(
                codec, payload, new SamplePosition(exactTimeNumerator, timebase.denominator()),
                partialRevision));
        frames++;
        bytes += payload.length;
        return result;
    }

    public synchronized int framesDecoded() { return frames; }
    public synchronized long bytesDecoded() { return bytes; }
    public Codec codec() { return codec; }
    public SamplePosition timebase() { return timebase; }
}
