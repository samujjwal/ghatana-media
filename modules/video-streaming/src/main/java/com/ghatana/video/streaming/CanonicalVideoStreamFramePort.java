package com.ghatana.video.streaming;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Runtime integration seam for video frames accepted by Media's canonical stream session.
 *
 * <p>This module-local API deliberately owns no session state. Implementations must resolve
 * identity, consent, lease and durable ACK cursor from the canonical session owner and atomically
 * fence every offer by both {@code sessionRevision} and {@code storeVersion}. The timestamp in
 * {@link VideoStreamSession.DecodedFrame} is a legacy wire millisecond value; it is not source
 * PTS. Source timing remains unknown unless the caller separately supplies qualified timing
 * evidence to the owning runtime contract.</p>
 *
 * <p>A local reconciler or successful decode is not a canonical ACK. Missing adapters therefore
 * fail closed and cannot produce positive acceptance.</p>
 */
public interface CanonicalVideoStreamFramePort {

    /** Trusted session identity and durable cursor read from the canonical owner. */
    record Binding(
            String streamId,
            String tenantId,
            String principalId,
            String purposeRef,
            long sessionRevision,
            long storeVersion,
            long lastAcknowledgedSequence,
            Instant leaseExpiresAt) {
        public Binding {
            streamId = required(streamId, "streamId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            purposeRef = required(purposeRef, "purposeRef");
            if (sessionRevision < 1 || storeVersion < 1
                    || lastAcknowledgedSequence < -1
                    || lastAcknowledgedSequence > VideoStreamSession.MAX_FRAME_SEQUENCE) {
                throw new IllegalArgumentException("canonical video stream revision or ACK cursor is invalid");
            }
            leaseExpiresAt = Objects.requireNonNull(leaseExpiresAt, "leaseExpiresAt");
        }

        private static String required(String value, String field) {
            if (value == null || value.isBlank()) {
                throw new IllegalArgumentException(field + " must not be blank");
            }
            int first = value.codePointAt(0);
            int last = value.codePointBefore(value.length());
            if (Character.isWhitespace(first) || Character.isSpaceChar(first)
                    || Character.isWhitespace(last) || Character.isSpaceChar(last)) {
                throw new IllegalArgumentException(field + " must not have surrounding whitespace");
            }
            return value;
        }
    }

    /** Store outcome; ACK means durable session acceptance, never provider finality. */
    record Result(Disposition disposition, long acknowledgedSequence, String reason) {
        public Result {
            disposition = Objects.requireNonNull(disposition, "disposition");
            reason = reason == null ? "" : reason;
            if (disposition == Disposition.ACKNOWLEDGED
                    && (acknowledgedSequence < 0
                    || acknowledgedSequence > VideoStreamSession.MAX_FRAME_SEQUENCE)) {
                throw new IllegalArgumentException("acknowledgedSequence is outside the supported range");
            }
            if (disposition != Disposition.ACKNOWLEDGED && acknowledgedSequence != -1) {
                throw new IllegalArgumentException("non-ACK result cannot carry an acknowledged sequence");
            }
        }

        public static Result acknowledged(long sequence) {
            return new Result(Disposition.ACKNOWLEDGED, sequence, "");
        }

        public static Result notAdmitted(String reason) {
            return new Result(Disposition.NOT_ADMITTED, -1, reason);
        }
    }

    /**
     * Additive runtime feedback for callers that must honor canonical buffer pressure.
     * {@code feedbackAvailable=false} means an older/custom port supplied only the stable
     * {@link Result} contract; callers must treat backpressure as unknown in that case.
     */
    record OfferFeedback(Result result, long bufferedBytes, boolean backpressured, boolean feedbackAvailable) {
        public OfferFeedback {
            result = Objects.requireNonNull(result, "result");
            if (bufferedBytes < 0) throw new IllegalArgumentException("bufferedBytes must not be negative");
            if (!feedbackAvailable && (bufferedBytes != 0 || backpressured)) {
                throw new IllegalArgumentException("unavailable stream feedback cannot carry provider metrics");
            }
            if (result.disposition() != Disposition.ACKNOWLEDGED
                    && (bufferedBytes != 0 || backpressured)) {
                throw new IllegalArgumentException("a non-ACK stream result cannot carry provider feedback");
            }
        }

        public static OfferFeedback unavailable(Result result) {
            return new OfferFeedback(result, 0, false, false);
        }
    }

    enum Disposition { ACKNOWLEDGED, DUPLICATE, NOT_ADMITTED, LEASE_EXPIRED, OUTCOME_UNKNOWN }

    /** Reads the trusted current binding; absent purpose binding remains absent. */
    Optional<Binding> currentBinding(String tenantId, String streamId, String principalId);

    /** Atomically offers one frame against the supplied canonical revision, version and lease. */
    Result offer(Binding expected, VideoStreamSession.DecodedFrame frame);

    /** Offers one frame and preserves provider backpressure feedback when the runtime exposes it. */
    default OfferFeedback offerWithFeedback(Binding expected, VideoStreamSession.DecodedFrame frame) {
        return OfferFeedback.unavailable(offer(expected, frame));
    }

    /**
     * Sends a canonical EOS marker at the exact next sequence. Older ports fail closed by default;
     * an ACK still means the session accepted EOS, not that a provider finalized output.
     */
    default OfferFeedback endOfStreamWithFeedback(Binding expected) {
        return OfferFeedback.unavailable(Result.notAdmitted("canonical video stream EOS is unavailable"));
    }

    /** Fail-closed adapter for runtimes without canonical video-session integration. */
    static CanonicalVideoStreamFramePort notAdmitted(String reason) {
        String detail = reason == null || reason.isBlank()
                ? "canonical Media video stream session adapter is unavailable"
                : reason;
        return new CanonicalVideoStreamFramePort() {
            @Override
            public Optional<Binding> currentBinding(String tenantId, String streamId, String principalId) {
                return Optional.empty();
            }

            @Override
            public Result offer(Binding expected, VideoStreamSession.DecodedFrame frame) {
                return Result.notAdmitted(detail);
            }
        };
    }
}
