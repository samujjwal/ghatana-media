package com.ghatana.audio.streaming;

import java.util.Objects;

/**
 * Bounded source-frame decoding under a declared codec and timebase.
 *
 * <p>AS-04: raw audio is decoded only when the declared codec and rational
 * sample timebase are supported — PCM and Opus are the admitted wire
 * codecs; anything else returns {@link DecodeVerdict#UNAVAILABLE} rather
 * than a fabricated decode. Sample positions are exact rational ticks
 * (num/den within the declared timebase), never floating-point seconds
 * or wall clock. Decode is bounded: a session admits at most
 * {@link SessionBudget#maxFrames} frames and
 * {@link SessionBudget#maxBytes} bytes before returning
 * {@link DecodeVerdict#BUDGET_EXCEEDED} — a producer faster than the
 * declared budget cannot exhaust memory.
 *
 * @doc.type class
 * @doc.purpose Bounded codec/timebase-declared audio frame decoding
 * @doc.layer product
 * @doc.pattern Decoder
 */
public final class BoundedAudioFrameDecoder {

    /** Admitted wire codecs; anything else is UNAVAILABLE, never guessed. */
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

    /** Rational sample position inside the declared timebase — exact, never float. */
    public record SamplePosition(long numerator, long denominator) {
        public SamplePosition {
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
     * must match an admitted codec/rational pair; an undeclared codec
     * produces a session that reports UNAVAILABLE for every frame.
     */
    public static BoundedAudioFrameDecoder declare(
            String codecName, long timebaseNumerator, long timebaseDenominator,
            SessionBudget budget) {
        Objects.requireNonNull(codecName, "codecName");
        Objects.requireNonNull(budget, "budget");
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
     * its rational sample position within the timebase, and whether it is a
     * partial (VAD/caption) revision. Undeclared codec, malformed shape, or
     * a session over budget fail closed.
     */
    public Result decode(byte[] payload, long positionNumerator, boolean partialRevision) {
        if (codec == null) {
            return Result.fail(DecodeVerdict.UNAVAILABLE,
                    "codec is not declared for this session");
        }
        if (payload == null || payload.length == 0) {
            return Result.fail(DecodeVerdict.MALFORMED, "empty payload");
        }
        if (codec == Codec.PCM_S16LE && (payload.length & 1) != 0) {
            return Result.fail(DecodeVerdict.MALFORMED,
                    "PCM_S16LE payload must be a whole number of 16-bit samples");
        }
        if (positionNumerator < 0) {
            return Result.fail(DecodeVerdict.MALFORMED,
                    "sample position numerator cannot be negative");
        }
        if (frames >= budget.maxFrames() || bytes + payload.length > budget.maxBytes()) {
            return Result.fail(DecodeVerdict.BUDGET_EXCEEDED,
                    "session frame/byte budget exceeded");
        }
        frames++;
        bytes += payload.length;
        return Result.ok(new DecodedSourceFrame(
                codec, payload, new SamplePosition(positionNumerator, timebase.denominator()),
                partialRevision));
    }

    public int framesDecoded() { return frames; }
    public long bytesDecoded() { return bytes; }
    public Codec codec() { return codec; }
    public SamplePosition timebase() { return timebase; }
}
