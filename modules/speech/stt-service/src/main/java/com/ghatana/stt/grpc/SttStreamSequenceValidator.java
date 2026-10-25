package com.ghatana.stt.grpc;

import com.ghatana.stt.service.SttAudioInputDecoder;

/** Per-RPC identity and sequence fence for the non-resumable STT streaming contract. */
final class SttStreamSequenceValidator {
    enum Failure { INVALID, NOT_ADMITTED }

    static final class StreamInputException extends IllegalArgumentException {
        private final Failure failure;

        StreamInputException(Failure failure, String message) {
            super(message);
            this.failure = failure;
        }

        Failure failure() { return failure; }
    }

    private final String sessionId;
    private long lastSequence;
    private long lastTimestampMs = -1;
    private int sampleRate;
    private Boolean sequenced;

    SttStreamSequenceValidator(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("sessionId must be present");
        }
        this.sessionId = sessionId;
    }

    long accept(String requestedSessionId, long sequence, int requestedSampleRate, long timestampMs, int payloadBytes) {
        if (requestedSessionId != null && !requestedSessionId.isBlank()
                && !sessionId.equals(requestedSessionId)) {
            throw invalid("STT_STREAM_SESSION_MISMATCH: session identity changed within the RPC");
        }
        if (sequence > 0 && (requestedSessionId == null || requestedSessionId.isBlank())) {
            throw invalid("STT_STREAM_SESSION_REQUIRED: sequenced chunks require a client session ID");
        }
        if (payloadBytes <= 0 || payloadBytes > 1_048_576 || (payloadBytes & 1) != 0) {
            throw invalid("STT_STREAM_CHUNK_INVALID: chunks must contain 1..1048576 even PCM bytes");
        }
        if (requestedSampleRate < SttAudioInputDecoder.MIN_SAMPLE_RATE
                || requestedSampleRate > SttAudioInputDecoder.MAX_SAMPLE_RATE) {
            throw invalid("STT_AUDIO_SAMPLE_RATE_INVALID: stream sample rate is outside supported bounds");
        }
        if (sampleRate != 0 && sampleRate != requestedSampleRate) {
            throw invalid("STT_STREAM_SAMPLE_RATE_CHANGED: sample rate must remain constant within a stream");
        }
        if (timestampMs < 0 || (lastTimestampMs >= 0 && timestampMs < lastTimestampMs)) {
            throw invalid("STT_STREAM_TIMESTAMP_INVALID: source timestamps must be nonnegative and monotonic");
        }

        boolean hasSequence = sequence > 0;
        if (sequence < 0) throw invalid("STT_STREAM_SEQUENCE_INVALID: sequence cannot be negative");
        if (sequence > Integer.MAX_VALUE) {
            throw new StreamInputException(Failure.NOT_ADMITTED,
                    "STT_STREAM_SEQUENCE_LIMIT: engine chunk sequence limit reached");
        }
        if (sequenced == null) {
            sequenced = hasSequence;
            if (hasSequence && sequence != 1) {
                throw new StreamInputException(Failure.NOT_ADMITTED,
                        "STT_STREAM_RESUME_NOT_ADMITTED: sequence must start at 1; durable resume is unavailable");
            }
        } else if (sequenced != hasSequence) {
            throw invalid("STT_STREAM_SEQUENCE_MODE_CHANGED: cannot mix sequenced and legacy chunks");
        }

        long next = sequenced ? sequence : lastSequence + 1;
        if (next != lastSequence + 1) {
            throw invalid(next <= lastSequence
                    ? "STT_STREAM_SEQUENCE_DUPLICATE: sequence was already accepted"
                    : "STT_STREAM_SEQUENCE_GAP: sequence must be contiguous");
        }
        lastSequence = next;
        if (sampleRate == 0) sampleRate = requestedSampleRate;
        lastTimestampMs = timestampMs;
        return next;
    }

    long lastSequence() { return lastSequence; }
    String sessionId() { return sessionId; }

    private static StreamInputException invalid(String message) {
        return new StreamInputException(Failure.INVALID, message);
    }
}
