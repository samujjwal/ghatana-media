package com.ghatana.media.launcher;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.CanonicalStreamFramePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
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
        if (expected == null || frame == null) {
            return Result.notAdmitted("canonical stream binding and frame are required");
        }
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
        if (!current.equals(expected)) {
            return Result.notAdmitted("canonical stream identity, generation, cursor or lease changed");
        }
        byte[] payload = frame.payload();
        if (payload == null || payload.length == 0
                || payload.length > runtime.config().maximumChunkBytes()) {
            return Result.notAdmitted("audio frame payload is outside the admitted non-empty bound");
        }
        if (frame.sequenceNumber() < 0 || frame.sequenceNumber() == Integer.MAX_VALUE
                || expected.lastAcknowledgedSequence() == Long.MAX_VALUE
                || frame.sequenceNumber() != expected.lastAcknowledgedSequence() + 1) {
            return Result.notAdmitted("audio frame sequence is not the exact canonical next sequence");
        }
        if (expected.sessionRevision() > Integer.MAX_VALUE) {
            return Result.notAdmitted("canonical stream reconnect generation exceeds the supported range");
        }

        try {
            var acknowledgement = runtime.acceptFrameForBinding(
                    new StreamFrame(expected.tenantId(), expected.streamId(), connectionToken,
                            frame.sequenceNumber(), payload, false, Instant.now()),
                    Math.toIntExact(expected.sessionRevision()), expected.storeVersion(),
                    expected.lastAcknowledgedSequence(), expected.leaseExpiresAt());
            return Result.acknowledged(acknowledgement.acceptedSequence());
        } catch (MediaRuntime.StreamBindingConflictException staleGeneration) {
            return Result.notAdmitted(staleGeneration.getMessage());
        } catch (SecurityException | IllegalArgumentException rejected) {
            return Result.notAdmitted(rejected.getMessage());
        } catch (RuntimeException uncertain) {
            // A provider call or durable commit may already have happened. The caller must not replay.
            return new Result(Disposition.OUTCOME_UNKNOWN, -1, "canonical stream frame outcome is unknown");
        }
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
