package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevRegionMask.Rect;
import com.ghatana.media.launcher.MediaDevRegionPixels.Effect;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** J-11 pixel effects on raw yuv420p frames never touch a sample outside the rectangle. */
class MediaDevRegionPixelsTest {
    private static final int W = 64;
    private static final int H = 48;
    private static final Rect RECT = new Rect(16, 10, 24, 20);

    private static byte[] noise() {
        byte[] frame = new byte[MediaDevRegionPixels.frameBytes(W, H)];
        new Random(7).nextBytes(frame);
        return frame;
    }

    @Test
    void everyEffectLeavesEverySampleOutsideTheRectangleBitIdentical() {
        for (Effect effect : new Effect[] {Effect.fill("#336699"), Effect.pixelate(8), Effect.blur(3)}) {
            byte[] original = noise();
            byte[] edited = original.clone();
            MediaDevRegionPixels.apply(edited, W, H, RECT, effect);
            MediaDevRegionPixels.Comparison comparison = new MediaDevRegionPixels.Comparison();
            comparison.compareFrame(original, edited, W, H, RECT);
            assertThat(comparison.outsideMaxAbsDiff).as(effect.type().name()).isZero();
            assertThat(comparison.outsidePsnrDb()).isNull();
            assertThat(comparison.insideChangedSamples).as(effect.type().name()).isPositive();
            assertThat(comparison.insideSamples).isEqualTo(24L * 20 + 2L * 12 * 10);
        }
    }

    @Test
    void fillWritesOneSolidColourInEveryPlane() {
        byte[] frame = noise();
        Effect fill = Effect.fill("#FFFFFF");
        MediaDevRegionPixels.apply(frame, W, H, RECT, fill);
        assertThat(frame[RECT.y() * W + RECT.x()] & 0xFF).isEqualTo(235); // BT.709 limited-range white
        int chromaOffset = W * H + (RECT.y() / 2) * (W / 2) + RECT.x() / 2;
        assertThat(frame[chromaOffset] & 0xFF).isEqualTo(128);
        assertThat(Effect.fill("#000000").fillY()).isEqualTo(16);
    }

    @Test
    void pixelateReplacesEachBlockWithItsRoundedMeanAndIsIdempotent() {
        byte[] frame = new byte[MediaDevRegionPixels.frameBytes(W, H)];
        // A 4x4 block with values 0..15 pixelated with block 4 becomes round-half-up(7.5) = 8 everywhere.
        for (int row = 0; row < 4; row++) for (int col = 0; col < 4; col++) frame[(10 + row) * W + 16 + col] = (byte) (row * 4 + col);
        MediaDevRegionPixels.apply(frame, W, H, new Rect(16, 10, 4, 4), Effect.pixelate(4));
        for (int row = 0; row < 4; row++) for (int col = 0; col < 4; col++) assertThat(frame[(10 + row) * W + 16 + col]).isEqualTo((byte) 8);
        byte[] again = frame.clone();
        MediaDevRegionPixels.apply(again, W, H, new Rect(16, 10, 4, 4), Effect.pixelate(4));
        assertThat(again).isEqualTo(frame);
    }

    @Test
    void blurSmoothsAStepEdgeAndKeepsAFlatRegionFlat() {
        byte[] flat = new byte[MediaDevRegionPixels.frameBytes(W, H)];
        Arrays.fill(flat, (byte) 100);
        byte[] copy = flat.clone();
        MediaDevRegionPixels.apply(copy, W, H, RECT, Effect.blur(4));
        assertThat(copy).isEqualTo(flat);
        byte[] step = new byte[MediaDevRegionPixels.frameBytes(W, H)];
        for (int row = 10; row < 30; row++) for (int col = 28; col < 40; col++) step[row * W + col] = (byte) 200;
        MediaDevRegionPixels.apply(step, W, H, RECT, Effect.blur(4));
        int across = step[20 * W + 27] & 0xFF;
        assertThat(across).isBetween(1, 199);
    }

    @Test
    void invalidEffectParametersAreRefused() {
        assertThatThrownBy(() -> Effect.fill("red")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Effect.pixelate(7)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Effect.pixelate(66)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Effect.blur(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Effect.blur(33)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void psnrOutsideReflectsAnyLossyChangeAndIsNullWhenExact() {
        byte[] original = noise();
        byte[] edited = original.clone();
        edited[0] = (byte) ((edited[0] & 0xFF) ^ 1);
        MediaDevRegionPixels.Comparison comparison = new MediaDevRegionPixels.Comparison();
        comparison.compareFrame(original, edited, W, H, RECT);
        assertThat(comparison.outsideMaxAbsDiff).isEqualTo(1);
        assertThat(comparison.outsidePsnrDb()).isNotNull().isGreaterThan(60.0);
    }
}
