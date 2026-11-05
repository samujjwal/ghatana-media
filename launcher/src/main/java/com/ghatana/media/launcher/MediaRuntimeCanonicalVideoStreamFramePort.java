package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.video.streaming.CanonicalVideoStreamFramePort;
import com.ghatana.video.streaming.VideoStreamSession;
import java.time.Instant;
import java.util.Optional;

/** Bridges video frame helpers to MediaRuntime's canonical leased video session. */
final class MediaRuntimeCanonicalVideoStreamFramePort implements CanonicalVideoStreamFramePort {

    private static final String GOVERNANCE_PURPOSE = "governance.purpose";
    private static final int VIDEO_FRAME_HEADER_BYTES = Integer.BYTES + 1 + Long.BYTES + Integer.BYTES;

    private final MediaRuntime runtime;
    private final String tenantId;
    private final String principalId;
    private final String streamId;
    private final String connectionToken;
    private final VideoStreamSession videoCodec = new VideoStreamSession();

    MediaRuntimeCanonicalVideoStreamFramePort(
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
                || session.streamKind() != StreamKind.VIDEO
                || !connected(session.state())
                || session.leaseExpiresAt() == null
                || !session.leaseExpiresAt().isAfter(Instant.now())
                || session.reconnectCount() < 1
                || session.finality() == StreamFinality.UNKNOWN
                || session.inFlightSequence() != null
                || session.lastSequence() > VideoStreamSession.MAX_FRAME_SEQUENCE) {
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
    public Result offer(Binding expected, VideoStreamSession.DecodedFrame frame) {
        if (expected == null || frame == null) {
            return Result.notAdmitted("canonical video stream binding and frame are required");
        }
        Binding current = currentBinding(expected.tenantId(), expected.streamId(), expected.principalId())
                .orElse(null);
        if (current == null) {
            StreamSession session = runtime.stream(expected.tenantId(), expected.principalId(), expected.streamId())
                    .orElse(null);
            if (session != null
                    && (session.finality() == StreamFinality.UNKNOWN || session.inFlightSequence() != null)) {
                return new Result(Disposition.OUTCOME_UNKNOWN, -1,
                        "canonical video stream has an unresolved frame outcome");
            }
            if (session != null && (session.leaseExpiresAt() == null
                    || !session.leaseExpiresAt().isAfter(Instant.now()))) {
                return new Result(Disposition.LEASE_EXPIRED, -1, "canonical video stream lease expired");
            }
            return Result.notAdmitted("canonical video stream is not connected or its binding is unavailable");
        }
        if (!current.equals(expected)) {
            return Result.notAdmitted("canonical video stream identity, generation, cursor or lease changed");
        }

        byte[] payload = frame.payload();
        if (payload == null || payload.length == 0
                || (long) payload.length + VIDEO_FRAME_HEADER_BYTES > runtime.config().maximumChunkBytes()) {
            return Result.notAdmitted("video frame wire payload is outside the admitted non-empty bound");
        }
        if (frame.sequenceNumber() < 0
                || frame.sequenceNumber() > VideoStreamSession.MAX_FRAME_SEQUENCE
                || expected.lastAcknowledgedSequence() == Long.MAX_VALUE
                || frame.sequenceNumber() != expected.lastAcknowledgedSequence() + 1) {
            return Result.notAdmitted("video frame sequence is not the exact canonical next sequence");
        }
        if (expected.sessionRevision() > Integer.MAX_VALUE) {
            return Result.notAdmitted("canonical video reconnect generation exceeds the supported range");
        }

        final byte[] wireFrame;
        try {
            // The current runtime frame contract carries opaque bytes. Preserve the
            // video helper's legacy timestamp and keyframe flag in those bytes; the
            // timestamp is not promoted to source PTS or a qualified timebase.
            wireFrame = videoCodec.encodeFrame(
                    frame.sequenceNumber(), frame.keyFrame(), frame.timestampMillis(), payload);
        } catch (IllegalArgumentException invalidFrame) {
            return Result.notAdmitted("video frame does not satisfy the bounded wire contract");
        }

        try {
            var acknowledgement = runtime.acceptFrameForBinding(
                    new StreamFrame(expected.tenantId(), expected.streamId(), connectionToken,
                            frame.sequenceNumber(), wireFrame, false, Instant.now()),
                    Math.toIntExact(expected.sessionRevision()), expected.storeVersion(),
                    expected.lastAcknowledgedSequence(), expected.leaseExpiresAt());
            return Result.acknowledged(acknowledgement.acceptedSequence());
        } catch (MediaRuntime.StreamBindingConflictException staleGeneration) {
            return Result.notAdmitted(staleGeneration.getMessage());
        } catch (SecurityException | IllegalArgumentException rejected) {
            return Result.notAdmitted(rejected.getMessage());
        } catch (RuntimeException uncertain) {
            // A provider effect or durable cursor commit may already have happened.
            // Never convert an uncertain provider outcome into a retryable ACK.
            return new Result(Disposition.OUTCOME_UNKNOWN, -1,
                    "canonical video stream frame outcome is unknown");
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
