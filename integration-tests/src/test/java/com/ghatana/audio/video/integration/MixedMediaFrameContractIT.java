package com.ghatana.audio.video.integration;

import com.ghatana.audio.streaming.AudioStreamSession;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder;
import com.ghatana.video.streaming.VideoFrameTimebase;
import com.ghatana.video.streaming.VideoStreamSession;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Local mixed-media frame/timebase composition using generated PCM and PNG fixtures.
 * This does not qualify transport, video codecs, provider behavior, or host capacity.
 */
@Tag("integration")
class MixedMediaFrameContractIT {
    private static final int[] SESSION_COUNTS = {1, 16, 64};
    private static final int SAMPLE_RATE = 48_000;
    private static final int SAMPLES_PER_AUDIO_FRAME = 960; // 20 ms at 48 kHz
    private static final int AUDIO_FRAME_BYTES = SAMPLES_PER_AUDIO_FRAME * Short.BYTES;
    private static final int AUDIO_FRAME_COUNT = 4;
    private static final long VIDEO_TICKS_PER_SECOND = 90_000;
    private static final long[] VIDEO_PRESENTATION_TICKS = {0, 1_800, 5_400};
    private static final int[] VIDEO_AUDIO_POSITION_INDEX = {0, 1, 3};
    private static final Duration START_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration COMPLETION_TIMEOUT = Duration.ofSeconds(30);

    @Test
    void composesPcmSamplePositionsWithVariableRateVideoPresentationTimestamps() throws Exception {
        byte[] png = generatedPng();
        assertThat(png).startsWith(new byte[]{(byte) 0x89, 'P', 'N', 'G'});
        assertThat(VIDEO_PRESENTATION_TICKS[1] - VIDEO_PRESENTATION_TICKS[0]).isEqualTo(1_800L);
        assertThat(VIDEO_PRESENTATION_TICKS[2] - VIDEO_PRESENTATION_TICKS[1]).isEqualTo(3_600L);

        for (int sessionCount : SESSION_COUNTS) {
            runConcurrentTier(sessionCount, png);
        }
    }

    private static void runConcurrentTier(int sessionCount, byte[] png) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(sessionCount);
        CountDownLatch ready = new CountDownLatch(sessionCount);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> sessions = new ArrayList<>(sessionCount);
        try {
            for (int sessionId = 0; sessionId < sessionCount; sessionId++) {
                int id = sessionId;
                sessions.add(workers.submit(() -> {
                    ready.countDown();
                    if (!start.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                        throw new IllegalStateException("mixed-media session missed the bounded start");
                    }
                    verifyOneSession(id, png);
                    return null;
                }));
            }
            assertThat(ready.await(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)).isTrue();
            start.countDown();
            for (Future<?> session : sessions) {
                session.get(COMPLETION_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
            }
        } finally {
            start.countDown();
            workers.shutdownNow();
            assertThat(workers.awaitTermination(START_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)).isTrue();
        }
    }

    private static void verifyOneSession(int sessionId, byte[] png) {
        AudioStreamSession audioWire = new AudioStreamSession();
        BoundedAudioFrameDecoder audioDecoder = BoundedAudioFrameDecoder.declare(
                "PCM_S16LE", 1, SAMPLE_RATE,
                new BoundedAudioFrameDecoder.SessionBudget(
                        AUDIO_FRAME_COUNT, (long) AUDIO_FRAME_COUNT * AUDIO_FRAME_BYTES));
        List<BoundedAudioFrameDecoder.SamplePosition> audioPositions = new ArrayList<>(AUDIO_FRAME_COUNT);

        for (int frame = 0; frame < AUDIO_FRAME_COUNT; frame++) {
            long firstSample = (long) frame * SAMPLES_PER_AUDIO_FRAME;
            byte[] pcm = generatedPcm(sessionId, firstSample);
            var decodedSource = audioDecoder.decode(pcm, firstSample, false);
            assertThat(decodedSource.verdict()).isEqualTo(BoundedAudioFrameDecoder.DecodeVerdict.DECODED);
            assertThat(decodedSource.frame().position().numerator()).isEqualTo(firstSample);
            assertThat(decodedSource.frame().position().denominator()).isEqualTo(SAMPLE_RATE);
            audioPositions.add(decodedSource.frame().position());

            long legacyTimestampMillis = firstSample * 1_000 / SAMPLE_RATE;
            var wireFrame = audioWire.decodeFrame(audioWire.encodeFrame(
                    frame, legacyTimestampMillis, decodedSource.frame().payload()));
            assertThat(wireFrame.sequenceNumber()).isEqualTo(frame);
            assertThat(wireFrame.timestampMillis()).isEqualTo(legacyTimestampMillis);
            assertThat(wireFrame.payload()).containsExactly(pcm);
        }
        assertThat(audioDecoder.framesDecoded()).isEqualTo(AUDIO_FRAME_COUNT);
        assertThat(audioDecoder.bytesDecoded()).isEqualTo((long) AUDIO_FRAME_COUNT * AUDIO_FRAME_BYTES);

        VideoStreamSession videoWire = new VideoStreamSession();
        for (int frame = 0; frame < VIDEO_PRESENTATION_TICKS.length; frame++) {
            long presentationTicks = VIDEO_PRESENTATION_TICKS[frame];
            long legacyTimestampMillis = presentationTicks * 1_000 / VIDEO_TICKS_PER_SECOND;
            var wireFrame = videoWire.decodeFrame(videoWire.encodeFrame(
                    frame, frame == 0, legacyTimestampMillis, png));
            assertThat(wireFrame.sequenceNumber()).isEqualTo(frame);
            assertThat(wireFrame.keyFrame()).isEqualTo(frame == 0);
            assertThat(wireFrame.timestampMillis()).isEqualTo(legacyTimestampMillis);
            assertThat(wireFrame.payload()).containsExactly(png);

            var timing = VideoFrameTimebase.bind(
                    "generated-media-session-" + sessionId,
                    wireFrame,
                    frame == 0 ? frame : 0,
                    VideoFrameTimebase.SourceTimestamp.known(
                            presentationTicks, 1, VIDEO_TICKS_PER_SECOND, "generated-media-clock"),
                    VideoFrameTimebase.SourceTimestamp.known(
                            presentationTicks, 1, VIDEO_TICKS_PER_SECOND, "generated-media-clock"),
                    "generated-segment-0",
                    "png-test-fixture",
                    "png-test-fixture-v1",
                    VideoFrameTimebase.PresentationMapping.unknown("NO_EXTERNAL_PRESENTATION_MAPPING"));
            assertThat(timing.sequence()).isEqualTo(frame);
            assertThat(timing.presentationPts().ticks()).isEqualTo(presentationTicks);
            assertThat(timing.presentationPts().timebaseDenominator()).isEqualTo(VIDEO_TICKS_PER_SECOND);
            assertThat(timing.presentationPts().clockId()).isEqualTo("generated-media-clock");
            assertThat(timing.presentationMapping().status()).isEqualTo(VideoFrameTimebase.Status.UNKNOWN);

            // The generated fixture declares both clocks against the same exact synthetic timeline.
            // This verifies rational preservation at matching boundaries; it is not a real capture map.
            var audioPosition = audioPositions.get(VIDEO_AUDIO_POSITION_INDEX[frame]);
            assertRationalTimeEquals(
                    audioPosition.numerator(), audioPosition.denominator(),
                    presentationTicks, VIDEO_TICKS_PER_SECOND);
        }
    }

    private static void assertRationalTimeEquals(
            long firstNumerator, long firstDenominator, long secondNumerator, long secondDenominator) {
        BigInteger left = BigInteger.valueOf(firstNumerator).multiply(BigInteger.valueOf(secondDenominator));
        BigInteger right = BigInteger.valueOf(secondNumerator).multiply(BigInteger.valueOf(firstDenominator));
        assertThat(left).isEqualTo(right);
    }

    private static byte[] generatedPcm(int sessionId, long firstSample) {
        ByteBuffer pcm = ByteBuffer.allocate(AUDIO_FRAME_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (int sample = 0; sample < SAMPLES_PER_AUDIO_FRAME; sample++) {
            pcm.putShort((short) ((firstSample + sample + sessionId * 97) & 0xffff));
        }
        return pcm.array();
    }

    private static byte[] generatedPng() throws Exception {
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, 0xff336699);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        if (!ImageIO.write(image, "png", bytes)) {
            throw new IllegalStateException("PNG writer unavailable");
        }
        return bytes.toByteArray();
    }
}
