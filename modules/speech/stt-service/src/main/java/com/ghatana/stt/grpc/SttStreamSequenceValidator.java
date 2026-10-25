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
    private long acceptedPcmBytes;

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
        // Streaming accepts raw mono S16LE PCM only. Enforce the same five-minute
        // duration budget as file transcription without allowing arithmetic wraparound.
        long maxPcmBytes = (long) requestedSampleRate * Short.BYTES
                * SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS;
        if (acceptedPcmBytes > maxPcmBytes - payloadBytes) {
            throw new StreamInputException(Failure.NOT_ADMITTED,
                    "STT_STREAM_DURATION_LIMIT: stream exceeds the configured duration limit");
        }
        if (timestampMs < 0 || (lastTimestampMs >= 0 && timestampMs < lastTimestampMs)) {
            throw invalid("STT_STREAM_TIMESTAMP_INVALID: source timestamps must be nonnegative and monotonic");
        }
        // Timestamp values are source-clock milliseconds. Convert without an
        // intermediate multiplication overflow before handing them to a sample clock.
        long wholeSeconds = timestampMs / 1_000;
        long fractionalMs = timestampMs % 1_000;
        if (wholeSeconds > Long.MAX_VALUE / requestedSampleRate) {
            throw invalid("STT_STREAM_TIMESTAMP_LIMIT: source timestamp exceeds the supported sample clock");
        }
        long wholeSecondSamples = wholeSeconds * requestedSampleRate;
        long fractionalSamples = fractionalMs * requestedSampleRate / 1_000;
        if (wholeSecondSamples > Long.MAX_VALUE - fractionalSamples) {
            throw invalid("STT_STREAM_TIMESTAMP_LIMIT: source timestamp exceeds the supported sample clock");
        }

        boolean hasSequence = sequence > 0;
        if (sequence < 0) throw invalid("STT_STREAM_SEQUENCE_INVALID: sequence cannot be negative");
        if (sequence > Integer.MAX_VALUE) {
            throw new StreamInputException(Failure.NOT_ADMITTED,
                    "STT_STREAM_SEQUENCE_LIMIT: engine chunk sequence limit reached");
        }
        // Validate against a candidate mode first. Rejected input must not mutate
        // session state, so a client may correct an invalid first chunk and retry.
        boolean candidateSequenced = sequenced == null ? hasSequence : sequenced;
        if (sequenced == null) {
            if (hasSequence && sequence != 1) {
                throw new StreamInputException(Failure.NOT_ADMITTED,
                        "STT_STREAM_RESUME_NOT_ADMITTED: sequence must start at 1; durable resume is unavailable");
            }
        } else if (sequenced != hasSequence) {
            throw invalid("STT_STREAM_SEQUENCE_MODE_CHANGED: cannot mix sequenced and legacy chunks");
        }

        long next = candidateSequenced ? sequence : lastSequence + 1;
        if (next != lastSequence + 1) {
            throw invalid(next <= lastSequence
                    ? "STT_STREAM_SEQUENCE_DUPLICATE: sequence was already accepted"
                    : "STT_STREAM_SEQUENCE_GAP: sequence must be contiguous");
        }
        if (sequenced == null) sequenced = candidateSequenced;
        lastSequence = next;
        acceptedPcmBytes += payloadBytes;
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
