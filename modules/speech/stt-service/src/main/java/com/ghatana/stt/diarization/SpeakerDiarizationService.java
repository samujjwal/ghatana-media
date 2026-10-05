package com.ghatana.stt.diarization;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Speaker diarization service for the STT pipeline (AV-007.1).
 *
 * <p>Partitions a transcript or a sequence of audio segments into speaker-labeled
 * turns. This implementation provides deterministic label assignment based on
 * embedding similarity clustering. It is pluggable: supply a
 * {@link SpeakerEmbeddingExtractor} to switch between ECAPA-TDNN, x-vector,
 * or any other representation.
 *
 * <h3>Acceptance criteria (AV-007.1)</h3>
 * <ul>
 *   <li>Multiple speaker identification and separation.</li>
 *   <li>Speaker accuracy &gt;90% for 2–3 speakers (validated in quality tests).</li>
 * </ul>
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * SpeakerDiarizationService diarizer = SpeakerDiarizationService.builder()
 *     .embeddingExtractor(myExtractor)
 *     .maxSpeakers(4)
 *     .similarityThreshold(0.75)
 *     .build();
 *
 * List<SpeakerTurn> turns = diarizer.diarize(audioSegments);
 * turns.forEach(t -> System.out.printf("[%s] %s%n", t.speakerId(), t.text()));
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose Speaker diarization — identifies who spoke when in an audio stream
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SpeakerDiarizationService {

    private static final Logger LOG = LoggerFactory.getLogger(SpeakerDiarizationService.class);

    private final SpeakerEmbeddingExtractor extractor;
    private final int maxSpeakers;
    private final double similarityThreshold;

    private SpeakerDiarizationService(Builder builder) {
        this.extractor = builder.extractor;
        this.maxSpeakers = builder.maxSpeakers;
        this.similarityThreshold = builder.similarityThreshold;
    }

    /** @return a new builder */
    public static Builder builder() {
        return new Builder();
    }

    // ─── diarize ──────────────────────────────────────────────────────────────

    /**
     * Assigns speaker labels to the given list of audio segments.
     *
     * <p>Each segment is embedded; new speakers are added when the cosine similarity
     * to every existing cluster centroid is below {@code similarityThreshold}.
     * The maximum number of speakers is capped at {@code maxSpeakers}.
     *
     * @param segments ordered list of audio segments to label
     * @return an ordered list of speaker turns (same length as {@code segments})
     * @throws NullPointerException if segments is null
     */
    public List<SpeakerTurn> diarize(List<AudioSegment> segments) {
        Objects.requireNonNull(segments, "segments must not be null");
        if (segments.isEmpty()) {
            return Collections.emptyList();
        }

        List<SpeakerTurn> result = new ArrayList<>(segments.size());
        List<float[]> centroids = new ArrayList<>(); // per-speaker centroid embeddings

        for (AudioSegment segment : segments) {
            float[] embedding = extractor.extract(segment.audioBytes());
            String speakerId = assignSpeaker(embedding, centroids);

            result.add(new SpeakerTurn(speakerId, segment.startMs(), segment.endMs(), segment.text()));
            LOG.debug("Segment [{}-{}ms] assigned to {}", segment.startMs(), segment.endMs(), speakerId);
        }

        LOG.info("Diarization complete: {} segments → {} speaker(s)",
                segments.size(), centroids.size());
        return Collections.unmodifiableList(result);
    }

    // ─── internal ─────────────────────────────────────────────────────────────

    private String assignSpeaker(float[] embedding, List<float[]> centroids) {
        double bestSim = -1.0;
        int bestIdx = -1;

        for (int i = 0; i < centroids.size(); i++) {
            double sim = cosineSimilarity(embedding, centroids.get(i));
            if (sim > bestSim) {
                bestSim = sim;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0 && bestSim >= similarityThreshold) {
            // Update centroid with exponential moving average
            float[] centroid = centroids.get(bestIdx);
            for (int d = 0; d < centroid.length; d++) {
                centroid[d] = 0.9f * centroid[d] + 0.1f * embedding[d];
            }
            return "SPEAKER_" + bestIdx;
        }

        // New speaker (if under cap)
        if (centroids.size() < maxSpeakers) {
            centroids.add(embedding.clone());
            return "SPEAKER_" + (centroids.size() - 1);
        }

        // Exceeded cap — assign to best match
        return "SPEAKER_" + (bestIdx >= 0 ? bestIdx : 0);
    }

    private static double cosineSimilarity(float[] a, float[] b) {
        double dot = 0, normA = 0, normB = 0;
        for (int i = 0; i < Math.min(a.length, b.length); i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) return 0.0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // ─── Builder ─────────────────────────────────────────────────────────────

    /** Builder for {@link SpeakerDiarizationService}. */
    public static final class Builder {
        private SpeakerEmbeddingExtractor extractor = SpeakerDiarizationService::byteDistributionEmbedding;
        private int maxSpeakers = 10;
        private double similarityThreshold = 0.80;

        private Builder() {}

        public Builder embeddingExtractor(SpeakerEmbeddingExtractor extractor) {
            this.extractor = Objects.requireNonNull(extractor, "extractor must not be null");
            return this;
        }

        public Builder maxSpeakers(int maxSpeakers) {
            if (maxSpeakers < 1) throw new IllegalArgumentException("maxSpeakers must be >= 1");
            this.maxSpeakers = maxSpeakers;
            return this;
        }

        public Builder similarityThreshold(double threshold) {
            if (threshold < 0 || threshold > 1) {
                throw new IllegalArgumentException("similarityThreshold must be in [0, 1]");
            }
            this.similarityThreshold = threshold;
            return this;
        }

        public SpeakerDiarizationService build() {
            return new SpeakerDiarizationService(this);
        }
    }

    // ─── Domain types ─────────────────────────────────────────────────────────

    /** Functional interface for extracting speaker embeddings from raw audio bytes. */
    @FunctionalInterface
    public interface SpeakerEmbeddingExtractor {
        /**
         * Extracts a speaker embedding from the given raw audio bytes.
         *
         * @param audioBytes raw PCM audio bytes
         * @return a fixed-dimension float embedding vector
         */
        float[] extract(byte[] audioBytes);
    }

    private static float[] byteDistributionEmbedding(byte[] audioBytes) {
        Objects.requireNonNull(audioBytes, "audioBytes must not be null");
        float[] embedding = new float[16];
        if (audioBytes.length == 0) {
            return embedding;
        }
        for (byte audioByte : audioBytes) {
            embedding[Byte.toUnsignedInt(audioByte) % embedding.length] += 1.0f;
        }
        float norm = 0.0f;
        for (float value : embedding) {
            norm += value * value;
        }
        if (norm == 0.0f) {
            return embedding;
        }
        float scale = (float) Math.sqrt(norm);
        for (int i = 0; i < embedding.length; i++) {
            embedding[i] = embedding[i] / scale;
        }
        return embedding;
    }

    /**
     * An audio segment ready for diarization.
     *
     * @param audioBytes raw PCM bytes for this segment
     * @param startMs    start time of this segment in the stream (milliseconds)
     * @param endMs      end time of this segment in the stream (milliseconds)
     * @param text       the transcribed text for this segment (may be empty)
     */
    public record AudioSegment(byte[] audioBytes, long startMs, long endMs, String text) {
        public AudioSegment {
            Objects.requireNonNull(audioBytes, "audioBytes must not be null");
            Objects.requireNonNull(text, "text must not be null");
            if (startMs < 0) throw new IllegalArgumentException("startMs must be >= 0");
            if (endMs < startMs) throw new IllegalArgumentException("endMs must be >= startMs");
        }
    }

    /**
     * A labeled speaker turn produced by the diarizer.
     *
     * @param speakerId the assigned speaker identifier (e.g. {@code "SPEAKER_0"})
     * @param startMs   start time in the original stream (milliseconds)
     * @param endMs     end time in the original stream (milliseconds)
     * @param text      the transcribed text for this turn
     */
    public record SpeakerTurn(String speakerId, long startMs, long endMs, String text) {}
}
