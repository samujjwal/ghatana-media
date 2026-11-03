package com.ghatana.video.streaming;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Local PNG payload check for the existing frame wire helper; not a transport test. */
@DisplayName("Video streaming PNG payload tiers")
class VideoStreamingPngPayloadTest {
    private static final int WIDTH = 96;
    private static final int HEIGHT = 64;
    private static final int FRAMES_PER_SESSION = 12;
    private static final long[] SOURCE_TIMES = {
        1_700_000_000_000L, 1_700_000_000_033L, 1_700_000_000_100L,
        1_700_000_000_117L, 1_700_000_000_200L, 1_700_000_000_267L,
        1_700_000_000_300L, 1_700_000_000_401L, 1_700_000_000_433L,
        1_700_000_000_500L, 1_700_000_000_533L, 1_700_000_000_633L
    };

    @Test
    @DisplayName("round trips deterministic PNG frames at bounded 1, 16 and 64 local sessions")
    void shouldPreservePngPixelsSequenceAndSourceTime() throws Exception {
        List<byte[]> pngFrames = createPngFrames();
        long payloadBytes = pngFrames.stream().mapToLong(bytes -> bytes.length).sum();

        for (int sessionCount : List.of(1, 16, 64)) {
            long heapBefore = usedHeapBytes();
            long started = System.nanoTime();
            runTier(sessionCount, pngFrames);
            long elapsedNanos = System.nanoTime() - started;
            long heapAfter = usedHeapBytes();
            int frames = sessionCount * FRAMES_PER_SESSION;
            System.out.printf("video-png local-tier sessions=%d frames=%d pngBytesPerSequence=%d " +
                            "elapsedMs=%.3f fps=%.1f heapDeltaBytes=%d scope=single-process-in-process%n",
                    sessionCount, frames, payloadBytes, elapsedNanos / 1_000_000.0d,
                    frames / (elapsedNanos / 1_000_000_000.0d), heapAfter - heapBefore);
        }
    }

    private static void runTier(int sessionCount, List<byte[]> pngFrames) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(sessionCount);
        CountDownLatch ready = new CountDownLatch(sessionCount);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> results = new ArrayList<>(sessionCount);
        try {
            for (int i = 0; i < sessionCount; i++) {
                results.add(executor.submit(() -> {
                    VideoStreamSession session = new VideoStreamSession();
                    ready.countDown();
                    if (!start.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("PNG tier start timed out");
                    }
                    for (int sequence = 0; sequence < FRAMES_PER_SESSION; sequence++) {
                        byte[] png = pngFrames.get(sequence);
                        var decodedFrame = session.decodeFrame(session.encodeFrame(
                                sequence, sequence == 0 || sequence == 6, SOURCE_TIMES[sequence], png));
                        assertThat(decodedFrame.sequenceNumber()).isEqualTo(sequence);
                        assertThat(decodedFrame.timestampMillis()).isEqualTo(SOURCE_TIMES[sequence]);
                        assertThat(decodedFrame.keyFrame()).isEqualTo(sequence == 0 || sequence == 6);
                        assertPixelsEqual(png, decodedFrame.payload());
                    }
                    return null;
                }));
            }
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            for (Future<?> result : results) {
                result.get(30, TimeUnit.SECONDS);
            }
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(30, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static List<byte[]> createPngFrames() throws IOException {
        List<byte[]> frames = new ArrayList<>(FRAMES_PER_SESSION);
        for (int frame = 0; frame < FRAMES_PER_SESSION; frame++) {
            BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_ARGB);
            for (int y = 0; y < HEIGHT; y++) {
                for (int x = 0; x < WIDTH; x++) {
                    int red = (x * 3 + frame * 17) & 0xff;
                    int green = (y * 5 + frame * 11) & 0xff;
                    int blue = (x + y + frame * 23) & 0xff;
                    image.setRGB(x, y, 0xff000000 | (red << 16) | (green << 8) | blue);
                }
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (!ImageIO.write(image, "png", output)) {
                throw new IOException("JDK PNG writer unavailable");
            }
            frames.add(output.toByteArray());
        }
        return List.copyOf(frames);
    }

    private static void assertPixelsEqual(byte[] expectedPng, byte[] decodedPng) throws IOException {
        BufferedImage expected = ImageIO.read(new ByteArrayInputStream(expectedPng));
        BufferedImage actual = ImageIO.read(new ByteArrayInputStream(decodedPng));
        assertThat(actual).isNotNull();
        assertThat(actual.getWidth()).isEqualTo(WIDTH);
        assertThat(actual.getHeight()).isEqualTo(HEIGHT);
        int[] expectedPixels = expected.getRGB(0, 0, WIDTH, HEIGHT, null, 0, WIDTH);
        int[] actualPixels = actual.getRGB(0, 0, WIDTH, HEIGHT, null, 0, WIDTH);
        assertThat(Arrays.equals(actualPixels, expectedPixels)).isTrue();
    }

    private static long usedHeapBytes() {
        Runtime runtime = Runtime.getRuntime();
        return runtime.totalMemory() - runtime.freeMemory();
    }
}
