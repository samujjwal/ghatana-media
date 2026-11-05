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

    enum Disposition { ACKNOWLEDGED, DUPLICATE, NOT_ADMITTED, LEASE_EXPIRED, OUTCOME_UNKNOWN }

    /** Reads the trusted current binding; absent purpose binding remains absent. */
    Optional<Binding> currentBinding(String tenantId, String streamId, String principalId);

    /** Atomically offers one frame against the supplied canonical revision, version and lease. */
    Result offer(Binding expected, VideoStreamSession.DecodedFrame frame);

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
