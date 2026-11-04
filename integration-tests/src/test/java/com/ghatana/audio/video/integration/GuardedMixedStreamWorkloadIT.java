package com.ghatana.audio.video.integration;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.GuardedAudioStreamSession;
import com.ghatana.audio.streaming.StreamConsentGate;
import com.ghatana.audio.streaming.StreamFrameReconciler;
import com.ghatana.video.streaming.GuardedVideoStreamSession;
import com.ghatana.video.streaming.VideoFrameReconciler;
import com.ghatana.video.streaming.VideoStreamSession;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Synthetic concurrent audio+video workload through the current guarded stream APIs.
 * Consent and sinks are test-owned fixtures; this does not qualify rights, codecs,
 * transport, provider behavior, or host resource capacity.
 */
@Tag("integration")
@Tag("performance")
class GuardedMixedStreamWorkloadIT {
    private static final int[] CLIENT_COUNTS = {1, 16, 64};
    private static final int FRAMES_PER_MODALITY = 4;
    private static final int AUDIO_BYTES = 128;
    private static final int VIDEO_BYTES = 96;
    private static final Duration START_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration RUN_TIMEOUT = Duration.ofSeconds(10);

    @Test
    void concurrentGuardedAudioAndVideoFramesRemainBoundedWithInSessionPayloadIntegrity() throws Exception {
        for (int clients : CLIENT_COUNTS) {
            runTier(clients);
        }
    }

    private static void runTier(int clients) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(clients);
        CountDownLatch ready = new CountDownLatch(clients);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<ClientResult>> tasks = new ArrayList<>(clients);
        long deadline = System.nanoTime() + RUN_TIMEOUT.toNanos();
        try {
            for (int tenant = 0; tenant < clients; tenant++) {
                int tenantId = tenant;
                tasks.add(workers.submit(() -> {
                    ready.countDown();
                    if (!start.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                        throw new IllegalStateException("mixed stream client missed bounded start");
                    }
                    return processTenant(tenantId);
                }));
            }
            assertThat(ready.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)).isTrue();
            start.countDown();

            int observedAudio = 0;
            int observedVideo = 0;
            for (Future<ClientResult> task : tasks) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) {
                    throw new IllegalStateException("guarded mixed stream tier exceeded bounded deadline");
                }
                ClientResult result = task.get(remaining, TimeUnit.NANOSECONDS);
                assertThat(result.audioSequences()).containsExactly(0, 1, 2, 3);
                assertThat(result.videoSequences()).containsExactly(0, 1, 2, 3);
                assertThat(result.payloadIntegrityViolations()).isZero();
                observedAudio += result.audioSequences().size();
                observedVideo += result.videoSequences().size();
            }
            assertThat(observedAudio).isEqualTo(clients * FRAMES_PER_MODALITY);
            assertThat(observedVideo).isEqualTo(clients * FRAMES_PER_MODALITY);
        } finally {
            start.countDown();
            workers.shutdownNow();
            assertThat(workers.awaitTermination(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)).isTrue();
        }
    }

    private static ClientResult processTenant(int tenant) {
        String tenantId = "synthetic-tenant-" + tenant;
        StreamFrameReconciler.SessionIdentity audioIdentity = new StreamFrameReconciler.SessionIdentity(
                "audio-" + tenant, tenantId, "synthetic-principal", "synthetic-purpose", 1);
        VideoFrameReconciler.SessionIdentity videoIdentity = new VideoFrameReconciler.SessionIdentity(
                "video-" + tenant, tenantId, "synthetic-principal", "synthetic-purpose", 1);

        // These ADMITTED decisions are local fixtures for exercising the guarded paths.
        GuardedAudioStreamSession audio = GuardedAudioStreamSession.connect(
                audioIdentity, context -> context.tenantId().equals(tenantId)
                        ? StreamConsentGate.Decision.ADMITTED : StreamConsentGate.Decision.DENIED);
        GuardedVideoStreamSession video = GuardedVideoStreamSession.open(
                videoIdentity, context -> context.tenantId().equals(tenantId)
                        ? GuardedVideoStreamSession.ConsentDecision.ADMITTED
                        : GuardedVideoStreamSession.ConsentDecision.DENIED,
                "synthetic-worker-" + tenant);

        AudioStreamSession audioWire = new AudioStreamSession();
        VideoStreamSession videoWire = new VideoStreamSession();
        List<Integer> audioReadback = new ArrayList<>(FRAMES_PER_MODALITY);
        List<Integer> videoReadback = new ArrayList<>(FRAMES_PER_MODALITY);
        AtomicInteger payloadIntegrityViolations = new AtomicInteger();
        for (int sequence = 0; sequence < FRAMES_PER_MODALITY; sequence++) {
            byte[] pcm = payload(AUDIO_BYTES, tenant, sequence);
            AudioStreamSession.DecodedFrame decodedAudio = audioWire.decodeFrame(audioWire.encodeFrame(
                    sequence, sequence * 20L, pcm));
            assertThat(audio.submitFrame(decodedAudio))
                    .isEqualTo(StreamFrameReconciler.Disposition.DELIVERED);
            // In-order frames are returned directly by the submit disposition; takeDelivered
            // is reserved for a held frame released after a sequence gap closes.
            audio.dispatchToProvider(decodedAudio, accepted -> {
                audioReadback.add(accepted.sequenceNumber());
                if (!matchesTenant(accepted.payload(), AUDIO_BYTES, tenant, accepted.sequenceNumber())) {
                    payloadIntegrityViolations.incrementAndGet();
                }
            });

            byte[] image = payload(VIDEO_BYTES, tenant, sequence);
            VideoStreamSession.DecodedFrame decodedVideo = videoWire.decodeFrame(videoWire.encodeFrame(
                    sequence, sequence == 0, sequence * 33L, image));
            assertThat(video.submitFrame("synthetic-worker-" + tenant, 1L, decodedVideo))
                    .isEqualTo(GuardedVideoStreamSession.FrameVerdict.DELIVERED_DECODABLE);
            video.egress("synthetic-worker-" + tenant, 1L, decodedVideo, accepted -> {
                videoReadback.add(accepted.sequenceNumber());
                if (!matchesTenant(accepted.payload(), VIDEO_BYTES, tenant, accepted.sequenceNumber())) {
                    payloadIntegrityViolations.incrementAndGet();
                }
            });
        }
        assertThat(audio.nextAck()).isEqualTo(FRAMES_PER_MODALITY - 1);
        assertThat(video.nextAck("synthetic-worker-" + tenant, 1L)).isEqualTo(FRAMES_PER_MODALITY - 1);
        return new ClientResult(List.copyOf(audioReadback), List.copyOf(videoReadback),
                payloadIntegrityViolations.get());
    }

    private static byte[] payload(int length, int tenant, int sequence) {
        byte[] payload = new byte[length];
        Arrays.fill(payload, (byte) (tenant ^ sequence));
        return payload;
    }

    private static boolean matchesTenant(byte[] payload, int expectedLength, int tenant, int sequence) {
        if (payload == null || payload.length != expectedLength) {
            return false;
        }
        for (byte value : payload) {
            if (value != (byte) (tenant ^ sequence)) {
                return false;
            }
        }
        return true;
    }

    private record ClientResult(List<Integer> audioSequences, List<Integer> videoSequences,
                                int payloadIntegrityViolations) { }
}
