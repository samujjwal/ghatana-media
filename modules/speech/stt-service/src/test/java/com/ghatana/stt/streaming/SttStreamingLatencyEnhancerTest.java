package com.ghatana.stt.streaming;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link SttStreamingLatencyEnhancer} (AV-007.4). 
 */
@DisplayName("SttStreamingLatencyEnhancer — AV-007.4")
class SttStreamingLatencyEnhancerTest {

    private List<SttStreamingLatencyEnhancer.AudioChunkBatch> emitted;
    private SttStreamingLatencyEnhancer enhancer;

    @BeforeEach
    void setUp() { 
        emitted  = new ArrayList<>(); 
        enhancer = SttStreamingLatencyEnhancer.builder() 
                .maxBufferChunks(20) 
                .maxChunkAgeMs(200) 
                .emitter(emitted::add) 
                .build(); 
    }

    @Test
    @DisplayName("Ingesting a chunk returns true and increments counters")
    void ingestAcceptsChunk() { 
        boolean accepted = enhancer.ingest(new byte[]{1, 2, 3}, 1, 1000L); 
        assertThat(accepted).isTrue(); 
        assertThat(enhancer.stats().chunksReceived()).isEqualTo(1); 
    }

    @Test
    @DisplayName("Empty audioBytes are rejected (returns false)")
    void ingestRejectsEmptyBytes() { 
        boolean accepted = enhancer.ingest(new byte[0], 1, 1000L); 
        assertThat(accepted).isFalse(); 
    }

    @Test
    @DisplayName("Null audioBytes throws NullPointerException")
    void ingestRejectsNullBytes() { 
        assertThatThrownBy(() -> enhancer.ingest(null, 1, 1000L)) 
                .isInstanceOf(NullPointerException.class); 
    }

    @Test
    @DisplayName("flush emits remaining buffered chunks")
    void flushEmitsRemainingChunks() { 
        enhancer.ingest(new byte[]{1, 2}, 1, 1000L); 
        enhancer.flush(); 

        // After flush, all chunks should be emitted
        long totalChunks = emitted.stream().mapToInt(SttStreamingLatencyEnhancer.AudioChunkBatch::chunkCount).sum(); 
        assertThat(totalChunks).isEqualTo(1); 
    }

    @Test
    @DisplayName("Buffer is empty after flush")
    void bufferEmptyAfterFlush() { 
        enhancer.ingest(new byte[]{1}, 1, 1000L); 
        enhancer.flush(); 
        assertThat(enhancer.bufferSize()).isEqualTo(0); 
    }

    @Test
    @DisplayName("Back-pressure rejects over-capacity input and recovers after flush")
    void backPressureAtHighWaterMark() {
        List<SttStreamingLatencyEnhancer.AudioChunkBatch> boundedEmitted = new ArrayList<>();
        SttStreamingLatencyEnhancer bounded = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(20)
                .maxChunkBytes(4)
                .maxBufferBytes(4)
                .emitter(boundedEmitted::add)
                .build();

        for (int i = 0; i < 4; i++) {
            assertThat(bounded.ingest(new byte[] {(byte) i}, i, i * 10L)).isTrue();
        }
        assertThat(bounded.bufferSize()).isEqualTo(4);
        assertThat(bounded.bufferedBytes()).isEqualTo(4);
        assertThat(bounded.isBackPressureActive()).isTrue();
        assertThat(bounded.stats().chunksReceived()).isEqualTo(4);

        assertThat(bounded.ingest(new byte[] {5}, 4, 40L)).isFalse();
        assertThat(bounded.bufferSize()).isEqualTo(4);
        assertThat(bounded.bufferedBytes()).isEqualTo(4);
        assertThat(bounded.stats().chunksReceived()).isEqualTo(4);

        bounded.flush();
        assertThat(bounded.bufferSize()).isZero();
        assertThat(bounded.bufferedBytes()).isZero();
        assertThat(bounded.isBackPressureActive()).isFalse();
        assertThat(boundedEmitted).hasSize(1);
        assertThat(boundedEmitted.get(0).chunkCount()).isEqualTo(4);

        assertThat(bounded.ingest(new byte[] {6}, 5, 50L)).isTrue();
        assertThat(bounded.bufferedBytes()).isEqualTo(1);
        assertThat(bounded.stats().chunksReceived()).isEqualTo(5);
    }

    @Test
    @DisplayName("AudioChunkBatch.meetsLatencySla returns true when avg <= 500ms")
    void audioChunkBatchLatencySla() { 
        SttStreamingLatencyEnhancer.AudioChunkBatch batch =
                new SttStreamingLatencyEnhancer.AudioChunkBatch(List.of(), 0, 0L, 1, 300L); 
        assertThat(batch.meetsLatencySla()).isTrue(); 

        SttStreamingLatencyEnhancer.AudioChunkBatch late =
                new SttStreamingLatencyEnhancer.AudioChunkBatch(List.of(), 0, 0L, 1, 600L); 
        assertThat(late.meetsLatencySla()).isFalse(); 
    }

    @Test
    @DisplayName("Builder rejects missing emitter")
    void builderRejectsMissingEmitter() { 
        assertThatThrownBy(() -> SttStreamingLatencyEnhancer.builder() 
                .maxBufferChunks(10) 
                .build()) 
                .isInstanceOf(NullPointerException.class); 
    }

    @Test
    @DisplayName("Retains a bounded copy instead of the caller-owned chunk array")
    void ingestCopiesCallerOwnedBytes() {
        byte[] callerBuffer = new byte[] {1, 2, 3};
        assertThat(enhancer.ingest(callerBuffer, 1, 1000L)).isTrue();
        callerBuffer[0] = 99;

        enhancer.flush();

        assertThat(emitted).hasSize(1);
        assertThat(emitted.get(0).audioChunks().get(0)).containsExactly(1, 2, 3);
        assertThat(enhancer.bufferedBytes()).isZero();
    }

    @Test
    @DisplayName("Rejects chunks above the configured cap before retaining them")
    void ingestRejectsOversizedChunk() {
        SttStreamingLatencyEnhancer bounded = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(20)
                .maxChunkBytes(4)
                .maxBufferBytes(8)
                .emitter(ignored -> { })
                .build();

        assertThatThrownBy(() -> bounded.ingest(new byte[5], 1, 1000L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_CHUNK_TOO_LARGE");
        assertThat(bounded.bufferedBytes()).isZero();
        assertThat(bounded.stats().chunksReceived()).isZero();
    }

    @Test
    @DisplayName("Rejects repeated sequence and backward timestamps without consuming the next accepted chunk")
    void ingestRequiresIncreasingSequenceAndNondecreasingTimestamp() {
        List<SttStreamingLatencyEnhancer.AudioChunkBatch> orderedBatches = new ArrayList<>();
        SttStreamingLatencyEnhancer ordered = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(20)
                .emitter(orderedBatches::add)
                .build();

        assertThat(ordered.ingest(new byte[] {1, 2}, 10, 1_000)).isTrue();
        assertThatThrownBy(() -> ordered.ingest(new byte[] {3, 4}, -1, 1_010))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_SEQUENCE_INVALID");
        assertThatThrownBy(() -> ordered.ingest(new byte[] {3, 4}, 10, 1_010))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_SEQUENCE_INVALID");
        assertThatThrownBy(() -> ordered.ingest(new byte[] {3, 4}, 9, 1_010))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_SEQUENCE_INVALID");
        assertThatThrownBy(() -> ordered.ingest(new byte[] {3, 4}, 11, 999))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_TIMESTAMP_INVALID");
        assertThatThrownBy(() -> ordered.ingest(new byte[] {3, 4}, 11, -1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_STREAM_TIMESTAMP_INVALID");

        assertThat(ordered.ingest(new byte[] {3, 4}, 11, 1_000)).isTrue();
        ordered.flush();

        assertThat(orderedBatches).hasSize(1);
        assertThat(orderedBatches.getFirst().firstSequenceNumber()).isEqualTo(10);
        assertThat(orderedBatches.getFirst().firstTimestampMs()).isEqualTo(1_000);
        assertThat(orderedBatches.getFirst().chunkCount()).isEqualTo(2);
        assertThat(ordered.stats().chunksReceived()).isEqualTo(2);
    }

    @Test
    @DisplayName("Bounds aggregate pending bytes and releases the reservation after flush")
    void aggregateBufferByteLimitAndFlushRelease() {
        SttStreamingLatencyEnhancer bounded = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(20)
                .maxChunkBytes(48)
                .maxBufferBytes(64)
                .emitter(ignored -> { })
                .build();

        assertThat(bounded.ingest(new byte[48], 1, 1000L)).isTrue();
        assertThat(bounded.ingest(new byte[16], 2, 1010L)).isTrue();
        assertThat(bounded.bufferedBytes()).isEqualTo(64);
        assertThat(bounded.isBackPressureActive()).isTrue();
        assertThat(bounded.ingest(new byte[1], 3, 1020L)).isFalse();
        assertThat(bounded.bufferedBytes()).isEqualTo(64);

        bounded.flush();

        assertThat(bounded.bufferedBytes()).isZero();
        assertThat(bounded.isBackPressureActive()).isFalse();
        assertThat(bounded.ingest(new byte[16], 3, 1020L)).isTrue();
    }

    @Test
    @DisplayName("Emitter failures do not retain byte reservations or poison later input")
    void emitterFailureReleasesReservation() {
        SttStreamingLatencyEnhancer bounded = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(4)
                .maxChunkBytes(8)
                .maxBufferBytes(8)
                .emitter(ignored -> { throw new IllegalStateException("fixture failure"); })
                .build();

        assertThat(bounded.ingest(new byte[] {1, 2}, 1, 1000L)).isTrue();
        assertThat(bounded.bufferedBytes()).isZero();
        assertThat(bounded.ingest(new byte[] {3, 4}, 2, 1010L)).isTrue();
        assertThat(bounded.bufferedBytes()).isZero();
        assertThat(bounded.stats().chunksReceived()).isEqualTo(2);
    }

    @Test
    @DisplayName("Keeps in-flight emitter payloads inside the aggregate byte budget")
    void inFlightEmitterBytesRemainReserved() throws Exception {
        CountDownLatch emitterEntered = new CountDownLatch(1);
        CountDownLatch allowEmitterReturn = new CountDownLatch(1);
        SttStreamingLatencyEnhancer bounded = SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(4)
                .maxChunkBytes(8)
                .maxBufferBytes(8)
                .emitter(ignored -> {
                    emitterEntered.countDown();
                    try {
                        if (!allowEmitterReturn.await(5, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("fixture emitter wait timed out");
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("fixture emitter interrupted");
                    }
                })
                .build();
        ExecutorService executor = Executors.newSingleThreadExecutor();

        try {
            var firstIngest = executor.submit(() -> bounded.ingest(new byte[8], 1, 1000L));
            assertThat(emitterEntered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(bounded.bufferedBytes()).isEqualTo(8);
            assertThat(bounded.ingest(new byte[1], 2, 1010L)).isFalse();

            allowEmitterReturn.countDown();
            assertThat(firstIngest.get(5, TimeUnit.SECONDS)).isTrue();
            assertThat(bounded.bufferedBytes()).isZero();
        } finally {
            allowEmitterReturn.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("Builder hard ceilings cannot be bypassed by configuration")
    void builderRejectsUnsafeResourceCaps() {
        assertThatThrownBy(() -> SttStreamingLatencyEnhancer.builder()
                .maxChunkBytes(SttStreamingLatencyEnhancer.MAX_ALLOWED_CHUNK_BYTES + 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SttStreamingLatencyEnhancer.builder()
                .maxBufferBytes(SttStreamingLatencyEnhancer.MAX_ALLOWED_BUFFER_BYTES + 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SttStreamingLatencyEnhancer.builder()
                .maxBufferChunks(SttStreamingLatencyEnhancer.MAX_ALLOWED_BUFFER_CHUNKS + 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> SttStreamingLatencyEnhancer.builder()
                .maxChunkBytes(8)
                .maxBufferBytes(4)
                .emitter(ignored -> { })
                .build())
                .isInstanceOf(IllegalArgumentException.class);
    }
}
