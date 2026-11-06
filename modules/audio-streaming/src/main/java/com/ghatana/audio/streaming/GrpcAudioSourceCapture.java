package com.ghatana.audio.streaming;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Bounded adapter for an authenticated gRPC audio source. The adapter owns no Media session
 * state: every accepted frame and EOS marker is sent to {@link CanonicalStreamFramePort}.
 *
 * <p>The source readback is a trusted transport/rights boundary and is re-read immediately before
 * each canonical offer. Missing, unknown, denied, or stale readback produces no frame offer. A
 * source frame's cursor/version are retained in the result as observed provenance; the current
 * canonical port does not durably persist those values alongside its Media sequence ACK.</p>
 */
public final class GrpcAudioSourceCapture {

    public static final int MAX_BATCH_FRAMES = 128;
    public static final long MAX_BATCH_BYTES = AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES;

    public enum Authorization { AUTHORIZED, DENIED, REVOKED, UNKNOWN }
    public enum Disposition {
        ACCEPTED, GAP, DENIED, REVOKED, LEASE_EXPIRED, UNKNOWN, NOT_ADMITTED,
        BACKPRESSURED, OUTCOME_UNKNOWN, EOS
    }

    public record Request(
            String tenantId, String streamId, String principalId, String purposeRef, String sourceVersion) {
        public Request {
            tenantId = required(tenantId, "tenantId");
            streamId = required(streamId, "streamId");
            principalId = required(principalId, "principalId");
            purposeRef = required(purposeRef, "purposeRef");
            sourceVersion = required(sourceVersion, "sourceVersion");
        }
    }

    /** Exact authorized source version and source cursor returned by the trusted readback. */
    public record Readback(
            Authorization authorization, String sourceVersion, long sourceCursor, long mediaSequence) {
        public Readback {
            Objects.requireNonNull(authorization, "authorization");
            if (sourceCursor < 0 || mediaSequence < 0) {
                throw new IllegalArgumentException("source and Media cursors must be nonnegative");
            }
            if (authorization == Authorization.AUTHORIZED) {
                sourceVersion = required(sourceVersion, "sourceVersion");
            } else if (sourceVersion != null) {
                throw new IllegalArgumentException("non-authorized readback cannot disclose a source version");
            }
        }
    }

    /** A source frame keeps transport cursor, source version, and Media sequence distinct. */
    public record SourceFrame(
            String sourceVersion, long sourceCursor, int mediaSequence, long transportTimestampMillis, byte[] payload) {
        public SourceFrame {
            sourceVersion = required(sourceVersion, "sourceVersion");
            if (sourceCursor < 0 || mediaSequence < 0
                    || mediaSequence > AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER) {
                throw new IllegalArgumentException("source frame cursor is outside the supported range");
            }
            if (payload == null || payload.length == 0 || payload.length > AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES) {
                throw new IllegalArgumentException("audio source frame payload is outside the supported size");
            }
            payload = payload.clone();
        }

        @Override public byte[] payload() { return payload.clone(); }
    }

    public record Batch(List<SourceFrame> frames, boolean endOfStream) {
        public Batch {
            frames = List.copyOf(Objects.requireNonNull(frames, "frames"));
            if (frames.size() > MAX_BATCH_FRAMES) {
                throw new IllegalArgumentException("audio source batch exceeds the frame bound");
            }
            long bytes = 0;
            for (SourceFrame frame : frames) {
                bytes += Objects.requireNonNull(frame, "frame").payload().length;
                if (bytes > MAX_BATCH_BYTES) {
                    throw new IllegalArgumentException("audio source batch exceeds the byte bound");
                }
            }
            if (frames.isEmpty() && !endOfStream) {
                throw new IllegalArgumentException("empty non-terminal audio source batch is invalid");
            }
        }
    }

    /** Implemented by the authenticated source client; methods must not return unverified claims. */
    public interface AuthenticatedGrpcSource {
        Readback readback(Request request, long requestedSourceCursor, long requestedMediaSequence);
        Batch readBatch(Request request, Readback admittedReadback, int maxFrames, long maxBytes);
    }

    private final CanonicalStreamFramePort canonical;
    private final AuthenticatedGrpcSource source;

    public GrpcAudioSourceCapture(CanonicalStreamFramePort canonical, AuthenticatedGrpcSource source) {
        this.canonical = Objects.requireNonNull(canonical, "canonical");
        this.source = Objects.requireNonNull(source, "source");
    }

    /** Reads one bounded source batch and offers only a contiguous authorized prefix. */
    public Result capture(Request request) {
        Objects.requireNonNull(request, "request");
        Optional<CanonicalStreamFramePort.Binding> initial = binding(request);
        if (initial.isEmpty()) return new Result(Disposition.NOT_ADMITTED, 0, -1, "canonical binding unavailable");
        CanonicalStreamFramePort.Binding binding = initial.get();
        long nextMedia = binding.lastAcknowledgedSequence() + 1;
        if (nextMedia > AudioStreamSession.MAX_FRAME_SEQUENCE_NUMBER) {
            return new Result(Disposition.UNKNOWN, 0, -1, "canonical stream sequence is exhausted");
        }
        Readback admitted = readback(request, -1, nextMedia);
        if (!admitted(admitted, request, -1, nextMedia)) return blocked(admitted);

        Batch batch;
        try {
            batch = source.readBatch(request, admitted, MAX_BATCH_FRAMES, MAX_BATCH_BYTES);
            if (batch == null) return new Result(Disposition.UNKNOWN, 0, -1, "source batch unavailable");
        } catch (RuntimeException unavailable) {
            return new Result(Disposition.UNKNOWN, 0, -1, "source batch readback unavailable");
        }
        Set<Integer> sequences = new HashSet<>();
        Set<Long> cursors = new HashSet<>();
        if (batch.frames().stream().anyMatch(frame -> !request.sourceVersion().equals(frame.sourceVersion())
                || !sequences.add(frame.mediaSequence()) || !cursors.add(frame.sourceCursor()))) {
            return new Result(Disposition.UNKNOWN, 0, -1, "source batch version or cursor identity is inconsistent");
        }

        List<SourceFrame> ordered = new ArrayList<>(batch.frames());
        ordered.sort(Comparator.comparingInt(SourceFrame::mediaSequence));
        int accepted = 0;
        long lastCursor = -1;
        long expectedSourceCursor = admitted.sourceCursor();
        for (SourceFrame frame : ordered) {
            long expectedMediaSequence = nextMedia + accepted;
            if (frame.mediaSequence() < expectedMediaSequence) continue;
            if (frame.mediaSequence() != expectedMediaSequence || frame.sourceCursor() != expectedSourceCursor) {
                return new Result(Disposition.GAP, accepted, lastCursor, "source cursor or Media sequence gap");
            }
            Readback current = readback(request, expectedSourceCursor, expectedMediaSequence);
            if (!admitted(current, request, expectedSourceCursor, expectedMediaSequence)) {
                return blocked(current, accepted, lastCursor);
            }
            if (expectedSourceCursor == Long.MAX_VALUE) {
                return new Result(Disposition.UNKNOWN, accepted, lastCursor, "source cursor is exhausted");
            }
            Optional<CanonicalStreamFramePort.Binding> refreshed = binding(request);
            if (refreshed.isEmpty() || !sameGeneration(binding, refreshed.get())
                    || refreshed.get().lastAcknowledgedSequence() != expectedMediaSequence - 1) {
                return new Result(Disposition.UNKNOWN, accepted, lastCursor, "canonical cursor changed");
            }
            AudioStreamSession.DecodedFrame decoded = new AudioStreamSession.DecodedFrame(
                    frame.mediaSequence(), frame.transportTimestampMillis(), frame.payload());
            CanonicalStreamFramePort.OfferFeedback offered;
            try {
                offered = canonical.offerWithFeedback(refreshed.get(), decoded);
            } catch (RuntimeException unknown) {
                return new Result(Disposition.OUTCOME_UNKNOWN, accepted, lastCursor, "canonical offer outcome unknown");
            }
            if (offered == null || offered.result() == null) {
                return new Result(Disposition.OUTCOME_UNKNOWN, accepted, lastCursor, "canonical offer outcome unknown");
            }
            if (offered.result().disposition() == CanonicalStreamFramePort.Disposition.OUTCOME_UNKNOWN) {
                return new Result(Disposition.OUTCOME_UNKNOWN, accepted, lastCursor, "canonical offer outcome unknown");
            }
            if (offered.result().disposition() == CanonicalStreamFramePort.Disposition.LEASE_EXPIRED) {
                return new Result(Disposition.LEASE_EXPIRED, accepted, lastCursor,
                        "canonical stream lease expired before frame acceptance");
            }
            if (offered.result().disposition() != CanonicalStreamFramePort.Disposition.ACKNOWLEDGED
                    || offered.result().acknowledgedSequence() != expectedMediaSequence) {
                return new Result(Disposition.UNKNOWN, accepted, lastCursor, "canonical frame was not acknowledged");
            }
            accepted++;
            lastCursor = frame.sourceCursor();
            expectedSourceCursor++;
            if (!offered.feedbackAvailable()) {
                return new Result(Disposition.UNKNOWN, accepted, lastCursor,
                        "canonical backpressure feedback is unavailable");
            }
            if (offered.backpressured()) {
                return new Result(Disposition.BACKPRESSURED, accepted, lastCursor, "canonical stream is backpressured");
            }
        }

        if (!batch.endOfStream()) {
            return new Result(accepted == 0 ? Disposition.GAP : Disposition.ACCEPTED, accepted, lastCursor,
                    accepted == 0 ? "source batch made no contiguous progress" : "");
        }
        long eosMediaSequence = nextMedia + accepted;
        Readback eosReadback = readback(request, expectedSourceCursor, eosMediaSequence);
        if (!admitted(eosReadback, request, expectedSourceCursor, eosMediaSequence)) {
            return blocked(eosReadback, accepted, lastCursor);
        }
        Optional<CanonicalStreamFramePort.Binding> eosBinding = binding(request);
        if (eosBinding.isEmpty() || !sameGeneration(binding, eosBinding.get())
                || eosBinding.get().lastAcknowledgedSequence() != eosMediaSequence - 1) {
            return new Result(Disposition.UNKNOWN, accepted, lastCursor, "canonical cursor changed before EOS");
        }
        try {
            CanonicalStreamFramePort.OfferFeedback eos = canonical.endOfStreamWithFeedback(eosBinding.get());
            if (eos == null || eos.result() == null) {
                return new Result(Disposition.OUTCOME_UNKNOWN, accepted, lastCursor, "canonical EOS outcome unknown");
            }
            if (eos.result().disposition() == CanonicalStreamFramePort.Disposition.ACKNOWLEDGED) {
                return new Result(Disposition.EOS, accepted, lastCursor, "");
            }
            Disposition disposition = switch (eos.result().disposition()) {
                case OUTCOME_UNKNOWN -> Disposition.OUTCOME_UNKNOWN;
                case LEASE_EXPIRED -> Disposition.LEASE_EXPIRED;
                default -> Disposition.UNKNOWN;
            };
            return new Result(disposition, accepted, lastCursor, "canonical EOS was not acknowledged");
        } catch (RuntimeException unknown) {
            return new Result(Disposition.OUTCOME_UNKNOWN, accepted, lastCursor, "canonical EOS outcome unknown");
        }
    }

    private Optional<CanonicalStreamFramePort.Binding> binding(Request request) {
        try {
            Optional<CanonicalStreamFramePort.Binding> found = canonical.currentBinding(
                    request.tenantId(), request.streamId(), request.principalId());
            if (found.isEmpty()) return Optional.empty();
            CanonicalStreamFramePort.Binding value = found.get();
            return value.tenantId().equals(request.tenantId()) && value.streamId().equals(request.streamId())
                    && value.principalId().equals(request.principalId()) && value.purposeRef().equals(request.purposeRef())
                    ? found : Optional.empty();
        } catch (RuntimeException unavailable) {
            return Optional.empty();
        }
    }

    private Readback readback(Request request, long sourceCursor, long mediaSequence) {
        try {
            Readback result = source.readback(request, sourceCursor, mediaSequence);
            return result == null ? new Readback(Authorization.UNKNOWN, null,
                    Math.max(0, sourceCursor), mediaSequence) : result;
        } catch (RuntimeException unavailable) {
            return new Readback(Authorization.UNKNOWN, null, Math.max(0, sourceCursor), mediaSequence);
        }
    }

    private static boolean admitted(Readback readback, Request request, long sourceCursor, long mediaSequence) {
        return readback.authorization() == Authorization.AUTHORIZED
                && request.sourceVersion().equals(readback.sourceVersion())
                && (sourceCursor < 0 || readback.sourceCursor() == sourceCursor)
                && readback.mediaSequence() == mediaSequence;
    }

    private static Result blocked(Readback readback) { return blocked(readback, 0, -1); }
    private static Result blocked(Readback readback, int accepted, long cursor) {
        Disposition disposition = switch (readback.authorization()) {
            case DENIED -> Disposition.DENIED;
            case REVOKED -> Disposition.REVOKED;
            case AUTHORIZED, UNKNOWN -> Disposition.UNKNOWN;
        };
        return new Result(disposition,
                accepted, cursor, "source authorization readback did not admit the exact version and cursor");
    }

    private static boolean sameGeneration(CanonicalStreamFramePort.Binding left,
            CanonicalStreamFramePort.Binding right) {
        return left.streamId().equals(right.streamId()) && left.tenantId().equals(right.tenantId())
                && left.principalId().equals(right.principalId()) && left.purposeRef().equals(right.purposeRef())
                && left.sessionRevision() == right.sessionRevision();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank() || !value.equals(value.trim())) {
            throw new IllegalArgumentException(name + " must be present and canonical");
        }
        return value;
    }

    /** Result does not claim source provenance was durably recorded by the current session port. */
    public record Result(Disposition disposition, int acknowledgedFrames, long lastSourceCursor, String reason) {
        public Result {
            Objects.requireNonNull(disposition, "disposition");
            if (acknowledgedFrames < 0 || lastSourceCursor < -1) throw new IllegalArgumentException("invalid capture result");
            reason = reason == null ? "" : reason;
        }
    }
}
