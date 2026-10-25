package com.ghatana.stt.streaming;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Arrays;
import java.util.Objects;
import java.util.concurrent.BlockingDeque;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Real-time streaming latency enhancer for the STT service (AV-007.4).
 *
 * <p>Provides chunk-level buffering with an adaptive emission strategy that
 * targets end-to-end latency &lt;500ms.  Key techniques:
 * <ul>
 *   <li><strong>Micro-batching</strong>: accumulates audio frames for up to
 *       {@code maxChunkAgeMs} ms before flushing to avoid excessive round-trips.</li>
 *   <li><strong>Back-pressure signalling</strong>: callers can check
 *       {@link #isBackPressureActive()} to throttle ingest when the buffer is near
 *       capacity.</li>
 *   <li><strong>Latency tracking</strong>: records per-chunk ingest-to-emit latency
 *       so operators can validate the &lt;500ms SLA.</li>
 * </ul>
 *
 * @doc.type    class
 * @doc.purpose Low-latency STT streaming enhancer targeting &lt;500ms end-to-end
 * @doc.layer   product
 * @doc.pattern Buffer, Strategy
 */
public final class SttStreamingLatencyEnhancer {

    private static final Logger LOG = LoggerFactory.getLogger(SttStreamingLatencyEnhancer.class);

    /** AV-007.4 latency target. */
    public static final Duration LATENCY_TARGET = Duration.ofMillis(500);
    /** Matches the current STT RPC chunk limit. */
    public static final int MAX_ALLOWED_CHUNK_BYTES = 1_048_576;
    /** Hard ceiling for one enhancer instance, independent of caller configuration. */
    public static final long MAX_ALLOWED_BUFFER_BYTES = 100L * 1024 * 1024;
    /** Prevents an accidentally unbounded queue from being configured. */
    public static final int MAX_ALLOWED_BUFFER_CHUNKS = 10_000;

    private final int maxBufferChunks;
    private final int maxChunkBytes;
    private final long maxBufferBytes;
    private final long maxChunkAgeMs;
    private final Consumer<AudioChunkBatch> emitter;

    private final BlockingDeque<TimestampedChunk> buffer;
    private final Object admissionLock = new Object();
    private final ReentrantLock emissionLock = new ReentrantLock();
    private final AtomicLong chunksReceived = new AtomicLong(0);
    private final AtomicLong bufferedBytes = new AtomicLong(0);
    private final AtomicLong batchesEmitted = new AtomicLong(0);
    private final AtomicLong totalLatencyNs = new AtomicLong(0);
    private final AtomicLong latencyViolations = new AtomicLong(0);

    private volatile boolean backPressureActive = false;
    private int lastAcceptedSequence = -1;
    private long lastAcceptedTimestampMs = -1;

    private SttStreamingLatencyEnhancer(Builder builder) {
        this.maxBufferChunks = builder.maxBufferChunks;
        this.maxChunkBytes = builder.maxChunkBytes;
        this.maxBufferBytes = builder.maxBufferBytes;
        this.maxChunkAgeMs   = builder.maxChunkAgeMs;
        this.emitter         = builder.emitter;
        this.buffer          = new LinkedBlockingDeque<>(maxBufferChunks);
    }

    // ── Ingest ────────────────────────────────────────────────────────────────

    /**
     * Accepts a raw audio chunk for buffering.
     *
     * @param audioBytes raw PCM audio bytes
     * @param sequenceNumber monotonically increasing chunk identifier
     * @param timestampMs stream timestamp in milliseconds
     * @return {@code true} if the chunk was accepted; {@code false} if the buffer is full
     */
    public boolean ingest(byte[] audioBytes, int sequenceNumber, long timestampMs) {
        Objects.requireNonNull(audioBytes, "audioBytes must not be null");
        if (audioBytes.length == 0) return false;
        if (audioBytes.length > maxChunkBytes) {
            throw new IllegalArgumentException("STT_STREAM_CHUNK_TOO_LARGE: audio chunk exceeds the configured limit");
        }
        boolean accepted;
        synchronized (admissionLock) {
            if (sequenceNumber < 0) {
                throw new IllegalArgumentException("STT_STREAM_SEQUENCE_INVALID: sequence cannot be negative");
            }
            if (timestampMs < 0) {
                throw new IllegalArgumentException("STT_STREAM_TIMESTAMP_INVALID: timestamp cannot be negative");
            }
            if (lastAcceptedSequence >= 0 && sequenceNumber <= lastAcceptedSequence) {
                throw new IllegalArgumentException(
                        "STT_STREAM_SEQUENCE_INVALID: sequence must increase within the stream");
            }
            if (lastAcceptedTimestampMs >= 0 && timestampMs < lastAcceptedTimestampMs) {
                throw new IllegalArgumentException("STT_STREAM_TIMESTAMP_INVALID: timestamps must not move backwards");
            }

            if (!reserveBytes(audioBytes.length)) {
                backPressureActive = true;
                return false;
            }

            boolean reserved = true;
            try {
                // The caller owns its input array and may reuse it as soon as ingest returns.
                TimestampedChunk chunk = new TimestampedChunk(
                        Arrays.copyOf(audioBytes, audioBytes.length), sequenceNumber, timestampMs, System.nanoTime());
                accepted = buffer.offer(chunk);
                if (accepted) {
                    lastAcceptedSequence = sequenceNumber;
                    lastAcceptedTimestampMs = timestampMs;
                    reserved = false;
                }
            } finally {
                if (reserved) bufferedBytes.addAndGet(-audioBytes.length);
            }
        }

        if (accepted) {
            chunksReceived.incrementAndGet();
            refreshBackPressure();
            tryFlush();
        } else {
            LOG.warn("Buffer full; dropping the current chunk (backPressure={})", true);
            backPressureActive = true;
        }
        return accepted;
    }

    private boolean reserveBytes(int bytes) {
        long current = bufferedBytes.get();
        while (current <= maxBufferBytes - bytes) {
            if (bufferedBytes.compareAndSet(current, current + bytes)) return true;
            current = bufferedBytes.get();
        }
        return false;
    }

    /** Flushes any remaining buffered chunks as a final batch. */
    public void flush() {
        emissionLock.lock();
        try {
            java.util.List<TimestampedChunk> chunks = new java.util.ArrayList<>();
            buffer.drainTo(chunks);
            if (!chunks.isEmpty()) {
                emit(chunks);
            } else {
                refreshBackPressure();
            }
        } finally {
            emissionLock.unlock();
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private void tryFlush() {
        if (buffer.size() >= Math.max(1, maxBufferChunks / 4) || isOldestChunkExpired()) {
            emissionLock.lock();
            try {
                // Recheck after acquiring the emission lock; another ingester may
                // already have drained this batch while this thread was waiting.
                if (buffer.size() >= Math.max(1, maxBufferChunks / 4) || isOldestChunkExpired()) {
                    java.util.List<TimestampedChunk> chunks = new java.util.ArrayList<>();
                    buffer.drainTo(chunks);
                    if (!chunks.isEmpty()) {
                        emit(chunks);
                    } else {
                        refreshBackPressure();
                    }
                }
            } finally {
                emissionLock.unlock();
            }
        }
    }

    private void releaseBytes(java.util.List<TimestampedChunk> chunks) {
        long released = chunks.stream().mapToLong(c -> c.audioBytes().length).sum();
        if (released != 0) bufferedBytes.addAndGet(-released);
    }

    private void refreshBackPressure() {
        long bytes = bufferedBytes.get();
        backPressureActive = buffer.size() >= highWaterMark(maxBufferChunks)
                || bytes >= highWaterMark(maxBufferBytes);
    }

    private static long highWaterMark(long capacity) {
        return (capacity - 1) * 4 / 5 + 1;
    }

    private boolean isOldestChunkExpired() {
        TimestampedChunk oldest = buffer.peekFirst();
        if (oldest == null) return false;
        return (System.nanoTime() - oldest.ingestNs()) / 1_000_000 >= maxChunkAgeMs;
    }

    private void emit(java.util.List<TimestampedChunk> chunks) {
        try {
            long emitNs = System.nanoTime();
            long avgLatencyNs = chunks.stream()
                    .mapToLong(c -> emitNs - c.ingestNs())
                    .sum() / chunks.size();

            totalLatencyNs.addAndGet(avgLatencyNs);
            long avgLatencyMs = avgLatencyNs / 1_000_000;
            if (avgLatencyMs > LATENCY_TARGET.toMillis()) {
                latencyViolations.incrementAndGet();
                LOG.warn("Latency SLA violation: avgLatency={}ms (target={}ms)",
                        avgLatencyMs, LATENCY_TARGET.toMillis());
            }

            AudioChunkBatch batch = new AudioChunkBatch(
                    chunks.stream().map(TimestampedChunk::audioBytes).toList(),
                    chunks.stream().mapToInt(TimestampedChunk::sequenceNumber).min().orElse(0),
                    chunks.stream().mapToLong(TimestampedChunk::timestampMs).min().orElse(0),
                    chunks.size(),
                    avgLatencyMs
            );

            batchesEmitted.incrementAndGet();
            emitter.accept(batch);
        } catch (Exception e) {
            LOG.error("Batch emitter failed failureType={}", e.getClass().getSimpleName());
        } finally {
            // Count payloads retained by an active emitter as well as queued chunks,
            // so concurrent ingress cannot multiply the configured memory budget.
            releaseBytes(chunks);
            refreshBackPressure();
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    /** Returns {@code true} when back-pressure should be applied to the sender. */
    public boolean isBackPressureActive() { return backPressureActive; }

    /** Returns current buffer occupancy. */
    public int bufferSize() { return buffer.size(); }

    /** Returns payload bytes retained by the queue or an in-flight emitter call. */
    public long bufferedBytes() { return bufferedBytes.get(); }

    /** Returns streaming latency statistics. */
    public LatencyStats stats() {
        long chunks = chunksReceived.get();
        long batches = batchesEmitted.get();
        long totalNs = totalLatencyNs.get();
        double avgMs = batches == 0 ? 0.0 : (double) totalNs / batches / 1_000_000.0;
        return new LatencyStats(chunks, batches, avgMs, latencyViolations.get(), avgMs <= 500);
    }

    // ── Nested types ──────────────────────────────────────────────────────────

    private record TimestampedChunk(byte[] audioBytes, int sequenceNumber,
                                     long timestampMs, long ingestNs) {}

    /**
     * Batch of audio chunks ready for STT processing.
     *
     * @param audioChunks        list of raw PCM chunk bytes
     * @param firstSequenceNumber sequence number of the first chunk in the batch
     * @param firstTimestampMs   stream timestamp of the first chunk in milliseconds
     * @param chunkCount         number of chunks in this batch
     * @param avgLatencyMs       average ingest-to-emit latency in milliseconds
     */
    public record AudioChunkBatch(
            java.util.List<byte[]> audioChunks,
            int firstSequenceNumber,
            long firstTimestampMs,
            int chunkCount,
            long avgLatencyMs
    ) {
        /** Returns {@code true} if average latency is within the 500ms SLA. */
        public boolean meetsLatencySla() { return avgLatencyMs <= 500; }
    }

    /**
     * Streaming latency statistics.
     *
     * @param chunksReceived   total chunks accepted
     * @param batchesEmitted   total batches emitted to the STT engine
     * @param avgLatencyMs     average ingest-to-emit latency in milliseconds
     * @param latencyViolations number of batches that exceeded the 500ms target
     * @param meetsTarget      whether avg latency is within the 500ms SLA
     */
    public record LatencyStats(long chunksReceived, long batchesEmitted,
                                double avgLatencyMs, long latencyViolations, boolean meetsTarget) {}

    // ── Builder ────────────────────────────────────────────────────────────────

    /** Returns a new builder for {@link SttStreamingLatencyEnhancer}. */
    public static Builder builder() { return new Builder(); }

    /**
     * Builder for {@link SttStreamingLatencyEnhancer}.
     */
    public static final class Builder {
        private int maxBufferChunks        = 100;
        private int maxChunkBytes = MAX_ALLOWED_CHUNK_BYTES;
        private long maxBufferBytes = 16L * 1024 * 1024;
        private long maxChunkAgeMs          = 200;
        private Consumer<AudioChunkBatch> emitter;

        private Builder() {}

        public Builder maxBufferChunks(int max) {
            if (max <= 0 || max > MAX_ALLOWED_BUFFER_CHUNKS) {
                throw new IllegalArgumentException("maxBufferChunks must be between 1 and "
                        + MAX_ALLOWED_BUFFER_CHUNKS);
            }
            this.maxBufferChunks = max;
            return this;
        }

        /** Set a per-chunk cap no larger than the current STT streaming contract permits. */
        public Builder maxChunkBytes(int max) {
            if (max <= 0 || max > MAX_ALLOWED_CHUNK_BYTES) {
                throw new IllegalArgumentException("maxChunkBytes must be between 1 and "
                        + MAX_ALLOWED_CHUNK_BYTES);
            }
            this.maxChunkBytes = max;
            return this;
        }

        /** Set a per-instance pending-byte cap with a hard 100 MiB ceiling. */
        public Builder maxBufferBytes(long max) {
            if (max <= 0 || max > MAX_ALLOWED_BUFFER_BYTES) {
                throw new IllegalArgumentException("maxBufferBytes must be between 1 and "
                        + MAX_ALLOWED_BUFFER_BYTES);
            }
            this.maxBufferBytes = max;
            return this;
        }

        public Builder maxChunkAgeMs(long ms) {
            if (ms <= 0) throw new IllegalArgumentException("maxChunkAgeMs must be positive");
            this.maxChunkAgeMs = ms;
            return this;
        }

        public Builder emitter(Consumer<AudioChunkBatch> emitter) {
            this.emitter = Objects.requireNonNull(emitter, "emitter must not be null");
            return this;
        }

        public SttStreamingLatencyEnhancer build() {
            Objects.requireNonNull(emitter, "emitter must be set before building");
            if (maxBufferBytes < maxChunkBytes) {
                throw new IllegalArgumentException("maxBufferBytes must be at least maxChunkBytes");
            }
            return new SttStreamingLatencyEnhancer(this);
        }
    }
}
