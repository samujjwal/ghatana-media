package com.ghatana.stt.grpc;

import com.ghatana.media.stt.api.Alternative;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.api.WordTiming;
import com.ghatana.stt.core.grpc.proto.AlternativeHypothesis;
import com.ghatana.stt.core.grpc.proto.ConfidenceCalibration;
import com.ghatana.stt.core.grpc.proto.TimestampTimebase;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;

import java.time.Duration;
import java.util.List;

/** Validates provider metadata and maps only supplied transcript values to the stable wire contract. */
final class SttTranscriptionResponseMapper {
    static final int MAX_ALTERNATIVES = 16;
    static final int MAX_WORD_TIMINGS = 2_000;

    static final class InvalidResultException extends IllegalArgumentException {
        InvalidResultException(String detail) {
            super("STT_RESULT_INVALID: " + detail);
        }
    }

    private SttTranscriptionResponseMapper() { }

    static TranscribeResponse.Builder toProto(TranscriptionResult result, Duration audioDuration) {
        if (result == null) throw invalid("provider returned no transcription result");
        if (result.text() == null) throw invalid("provider returned null transcript text");
        if (!confidence(result.confidence())) throw invalid("transcript confidence must be finite and in [0, 1]");
        if (audioDuration == null || audioDuration.isNegative()) throw invalid("decoded audio duration is unavailable");

        // These collections are optional provider metadata; absent values remain absent on the wire.
        List<Alternative> alternatives = result.alternatives() == null ? List.of() : result.alternatives();
        List<WordTiming> words = result.words() == null ? List.of() : result.words();
        if (alternatives.size() > MAX_ALTERNATIVES) {
            throw invalid("alternative count exceeds the " + MAX_ALTERNATIVES + " item limit");
        }
        if (words.size() > MAX_WORD_TIMINGS) {
            throw invalid("word timing count exceeds the " + MAX_WORD_TIMINGS + " item limit");
        }

        TranscribeResponse.Builder response = TranscribeResponse.newBuilder()
                .setText(result.text())
                .setConfidence((float) result.confidence())
                .setModelUsed(result.modelId() == null ? "" : result.modelId())
                .setLanguage(result.language() == null ? "" : result.language())
                .setWordTimingTimebase(words.isEmpty()
                        ? TimestampTimebase.TIMESTAMP_TIMEBASE_UNKNOWN
                        : TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO)
                .setConfidenceCalibration(ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNCALIBRATED);
        if (result.processingTime() != null) {
            if (result.processingTime().isNegative()) throw invalid("processing time cannot be negative");
            response.setProcessingTimeMs(result.processingTime().toMillis());
        }

        for (Alternative alternative : alternatives) {
            if (alternative == null || alternative.text() == null || alternative.text().isBlank()) {
                throw invalid("alternative text is required");
            }
            if (!confidence(alternative.confidence())) {
                throw invalid("alternative confidence must be finite and in [0, 1]");
            }
            response.addAlternatives(AlternativeHypothesis.newBuilder()
                    .setText(alternative.text())
                    .setConfidence((float) alternative.confidence())
                    .build());
        }

        double durationSeconds = audioDuration.toNanos() / 1_000_000_000.0d;
        double previousStart = -1.0d;
        double previousEnd = 0.0d;
        long previousEndMs = -1;
        for (WordTiming timing : words) {
            if (timing == null || timing.word() == null || timing.word().isBlank()) {
                throw invalid("word timing text is required");
            }
            double start = timing.startSec();
            double end = timing.endSec();
            if (!Double.isFinite(start) || !Double.isFinite(end) || start < 0.0d || end <= start) {
                throw invalid("word timing interval must be finite, nonnegative, and nonempty");
            }
            if (start <= previousStart || start < previousEnd) {
                throw invalid("word timing intervals must be strictly ordered and non-overlapping");
            }
            if (end > durationSeconds) {
                throw invalid("word timing interval exceeds decoded audio duration");
            }
            if (!confidence(timing.confidence())) {
                throw invalid("word timing confidence must be finite and in [0, 1]");
            }
            long startMs = Math.round(start * 1_000.0d);
            long endMs = Math.round(end * 1_000.0d);
            if (endMs <= startMs || startMs < previousEndMs) {
                throw invalid("word timing interval cannot be represented as ordered millisecond bounds");
            }
            response.addWordTimings(com.ghatana.stt.core.grpc.proto.WordTiming.newBuilder()
                    .setWord(timing.word())
                    .setStartMs(startMs)
                    .setEndMs(endMs)
                    .setConfidence((float) timing.confidence())
                    .build());
            previousStart = start;
            previousEnd = end;
            previousEndMs = endMs;
        }
        return response;
    }

    private static boolean confidence(double value) {
        return Double.isFinite(value) && value >= 0.0d && value <= 1.0d;
    }

    private static InvalidResultException invalid(String detail) {
        return new InvalidResultException(detail);
    }
}
