package com.ghatana.media.launcher;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.CanonicalStreamFramePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import java.time.Instant;
import java.util.Optional;

/** Bridges audio frame helpers to MediaRuntime's canonical leased stream session. */
final class MediaRuntimeCanonicalStreamFramePort implements CanonicalStreamFramePort {

    private static final String GOVERNANCE_PURPOSE = "governance.purpose";

    private final MediaRuntime runtime;
    private final String tenantId;
    private final String principalId;
    private final String streamId;
    private final String connectionToken;

    MediaRuntimeCanonicalStreamFramePort(
            MediaRuntime runtime,
            String tenantId,
            String principalId,
            String streamId,
            String connectionToken) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.tenantId = required(tenantId, "tenantId");
        this.principalId = required(principalId, "principalId");
        this.streamId = required(streamId, "streamId");
        this.connectionToken = required(connectionToken, "connectionToken");
    }

    @Override
    public Optional<Binding> currentBinding(String tenantId, String streamId, String principalId) {
        if (!this.tenantId.equals(tenantId)
                || !this.streamId.equals(streamId)
                || !this.principalId.equals(principalId)
                || !runtime.streamConnectionTokenMatches(tenantId, streamId, connectionToken)) {
            return Optional.empty();
        }
        StreamSession session = runtime.stream(tenantId, principalId, streamId).orElse(null);
        if (session == null
                || session.streamKind() != StreamKind.AUDIO
                || !connected(session.state())
                || session.leaseExpiresAt() == null
                || !session.leaseExpiresAt().isAfter(Instant.now())
                || session.reconnectCount() < 1) {
            return Optional.empty();
        }
        Object purpose = session.metadata().get(GOVERNANCE_PURPOSE);
        if (!(purpose instanceof String purposeRef)
                || purposeRef.isBlank()
                || "unspecified".equalsIgnoreCase(purposeRef.trim())) {
            return Optional.empty();
        }
        return Optional.of(new Binding(
                session.sessionId(), session.tenantId(), session.principalId(), purposeRef,
                session.reconnectCount(), session.version(), session.lastSequence(), session.leaseExpiresAt()));
    }

    @Override
    public Result offer(Binding expected, AudioStreamSession.DecodedFrame frame) {
        return offerWithFeedback(expected, frame).result();
    }

    @Override
    public OfferFeedback offerWithFeedback(Binding expected, AudioStreamSession.DecodedFrame frame) {
        if (expected == null || frame == null) {
            return OfferFeedback.unavailable(
                    Result.notAdmitted("canonical stream binding and frame are required"));
        }
        Result rejection = bindingRejection(expected);
        if (rejection != null) return OfferFeedback.unavailable(rejection);
        byte[] payload = frame.payload();
        if (payload == null || payload.length == 0
                || payload.length > runtime.config().maximumChunkBytes()) {
            return OfferFeedback.unavailable(
                    Result.notAdmitted("audio frame payload is outside the admitted non-empty bound"));
        }
        if (frame.sequenceNumber() < 0
                || frame.sequenceNumber() > AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER
                || frame.sequenceNumber() != expected.lastAcknowledgedSequence() + 1) {
            return OfferFeedback.unavailable(
                    Result.notAdmitted("audio frame sequence is not the exact canonical next sequence"));
        }
        if (expected.sessionRevision() > Integer.MAX_VALUE) {
            return OfferFeedback.unavailable(Result.notAdmitted(
                    "canonical stream reconnect generation exceeds the supported range"));
        }
        return dispatch(expected, frame.sequenceNumber(), payload, false);
    }

    @Override
    public OfferFeedback endOfStreamWithFeedback(Binding expected) {
        if (expected == null) {
            return OfferFeedback.unavailable(Result.notAdmitted("canonical stream binding is required"));
        }
        Result rejection = bindingRejection(expected);
        if (rejection != null) return OfferFeedback.unavailable(rejection);
        if (expected.lastAcknowledgedSequence() >= AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER) {
            return OfferFeedback.unavailable(
                    Result.notAdmitted("audio stream sequence is exhausted before end of stream"));
        }
        if (expected.sessionRevision() > Integer.MAX_VALUE) {
            return OfferFeedback.unavailable(Result.notAdmitted(
                    "canonical stream reconnect generation exceeds the supported range"));
        }
        return dispatch(expected, expected.lastAcknowledgedSequence() + 1, new byte[0], true);
    }

    private OfferFeedback dispatch(Binding expected, long sequence, byte[] payload, boolean endOfStream) {
        try {
            var acknowledgement = runtime.acceptFrameForBinding(
                    new StreamFrame(expected.tenantId(), expected.streamId(), connectionToken,
                            sequence, payload, endOfStream, Instant.now()),
                    Math.toIntExact(expected.sessionRevision()), expected.storeVersion(),
                    expected.lastAcknowledgedSequence(), expected.leaseExpiresAt());
            if (acknowledgement.acceptedSequence() != sequence) {
                return OfferFeedback.unavailable(new Result(Disposition.OUTCOME_UNKNOWN, -1,
                        "canonical stream provider acknowledgement did not match the offered sequence"));
            }
            StreamSession persisted = runtime.stream(expected.tenantId(), expected.principalId(), expected.streamId())
                    .orElse(null);
            if (!confirmsAcknowledgement(persisted, expected, sequence, acknowledgement.bufferedBytes(), endOfStream)) {
                return OfferFeedback.unavailable(new Result(Disposition.OUTCOME_UNKNOWN, -1,
                        "canonical stream acknowledgement was not confirmed by session-store readback"));
            }
            return new OfferFeedback(Result.acknowledged(acknowledgement.acceptedSequence()),
                    acknowledgement.bufferedBytes(), acknowledgement.backpressured(), true);
        } catch (MediaRuntime.StreamBindingConflictException staleGeneration) {
            return OfferFeedback.unavailable(Result.notAdmitted(staleGeneration.getMessage()));
        } catch (SecurityException | IllegalArgumentException rejected) {
            return OfferFeedback.unavailable(Result.notAdmitted(rejected.getMessage()));
        } catch (RuntimeException uncertain) {
            // A provider call or durable commit may already have happened. The caller must not replay.
            return OfferFeedback.unavailable(
                    new Result(Disposition.OUTCOME_UNKNOWN, -1, "canonical stream frame outcome is unknown"));
        }
    }

    private static boolean confirmsAcknowledgement(
            StreamSession persisted,
            Binding expected,
            long sequence,
            long bufferedBytes,
            boolean endOfStream) {
        if (persisted == null) return false;
        return persisted.tenantId().equals(expected.tenantId())
                && persisted.sessionId().equals(expected.streamId())
                && persisted.principalId().equals(expected.principalId())
                && persisted.streamKind() == StreamKind.AUDIO
                && persisted.reconnectCount() == expected.sessionRevision()
                && persisted.version() == expected.storeVersion() + 2
                && persisted.lastSequence() == sequence
                && persisted.bufferedBytes() == bufferedBytes
                && persisted.inFlightSequence() == null
                && persisted.inFlightAttemptId().isBlank()
                && persisted.finality() == StreamFinality.NONE
                && (endOfStream
                        ? persisted.state() == StreamState.DRAINING
                        : connected(persisted.state()));
    }

    private Result bindingRejection(Binding expected) {
        Binding current = currentBinding(expected.tenantId(), expected.streamId(), expected.principalId())
                .orElse(null);
        if (current == null) {
            StreamSession session = runtime.stream(expected.tenantId(), expected.principalId(), expected.streamId())
                    .orElse(null);
            if (session != null
                    && (session.finality() == StreamFinality.UNKNOWN || session.inFlightSequence() != null)) {
                return new Result(Disposition.OUTCOME_UNKNOWN, -1,
                        "canonical stream has an unresolved provider outcome");
            }
            if (session != null && (session.leaseExpiresAt() == null
                    || !session.leaseExpiresAt().isAfter(Instant.now()))) {
                return new Result(Disposition.LEASE_EXPIRED, -1, "canonical stream lease expired");
            }
            return Result.notAdmitted("canonical stream is not connected or its binding is unavailable");
        }
        return current.equals(expected) ? null
                : Result.notAdmitted("canonical stream identity, generation, cursor or lease changed");
    }

    private static boolean connected(StreamState state) {
        return state == StreamState.CONNECTED || state == StreamState.DEGRADED;
    }

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value;
    }
}
