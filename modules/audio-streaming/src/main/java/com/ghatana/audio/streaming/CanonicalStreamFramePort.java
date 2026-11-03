package com.ghatana.audio.streaming;

import java.time.Instant;
import java.util.Objects;
import java.util.Optional;

/**
 * Narrow integration seam for ordered audio frames backed by Media's canonical stream session.
 *
 * <p>This module intentionally has no dependency on Media runtime contracts. The runtime-owned
 * implementation must obtain bindings from its canonical session store and perform each frame
 * offer through that store's lease/version fence. This interface keeps no session state and does
 * not imply provider finality. If the runtime cannot supply the purpose-bound identity required
 * by the caller, integration must return {@link Result#notAdmitted(String)}.
 *
 * <p>The runtime's durable {@code reconnectCount} is the connection generation; its CAS
 * {@code version} changes on other session updates and is not a substitute for that generation.
 * This SPI keeps both fields separate. A runtime adapter must check both while holding its
 * canonical session fence. Duplicate ACK replay remains unavailable because the store has no
 * per-frame payload fingerprint; duplicates must not trigger a provider call or a positive ACK.
 *
 * @doc.type interface
 * @doc.purpose Bind audio frame ordering to the canonical Media stream session owner
 * @doc.layer product
 * @doc.pattern Port
 */
public interface CanonicalStreamFramePort {

    /** Trusted identity and durable cursor read from the canonical session owner. */
    record Binding(
            String streamId,
            String tenantId,
            String principalId,
            String purposeRef,
            /** Durable reconnect generation; distinct from the session CAS version below. */
            long sessionRevision,
            /** Exact current store CAS version captured with the binding. */
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
                    || lastAcknowledgedSequence > AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER) {
                throw new IllegalArgumentException("canonical stream revision or ACK cursor is invalid");
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

    /** Result of one frame offer; ACK means store acceptance only, never provider finality. */
    record Result(Disposition disposition, long acknowledgedSequence, String reason) {
        public Result {
            disposition = Objects.requireNonNull(disposition, "disposition");
            reason = reason == null ? "" : reason;
            if (disposition == Disposition.ACKNOWLEDGED
                    && (acknowledgedSequence < 0
                    || acknowledgedSequence > AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER)) {
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

    /** Reads the current trusted binding; an absent purpose/source binding must remain absent. */
    Optional<Binding> currentBinding(String tenantId, String streamId, String principalId);

    /**
     * Offers one contiguous frame using the supplied expected binding as a compare-and-set fence.
     * Implementations must revalidate identity and lease in the canonical store when accepting.
     */
    Result offer(Binding expected, AudioStreamSession.DecodedFrame frame);

    /** Fail-closed implementation for deployments without the canonical runtime adapter. */
    static CanonicalStreamFramePort notAdmitted(String reason) {
        String detail = reason == null || reason.isBlank()
                ? "canonical Media stream session adapter is unavailable"
                : reason;
        return new CanonicalStreamFramePort() {
            @Override
            public Optional<Binding> currentBinding(String tenantId, String streamId, String principalId) {
                return Optional.empty();
            }

            @Override
            public Result offer(Binding expected, AudioStreamSession.DecodedFrame frame) {
                return Result.notAdmitted(detail);
            }
        };
    }
}
