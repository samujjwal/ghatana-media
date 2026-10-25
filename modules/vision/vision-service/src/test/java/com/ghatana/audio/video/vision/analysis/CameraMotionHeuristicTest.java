package com.ghatana.audio.video.vision.analysis;

import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.data.Offset.offset;

class CameraMotionHeuristicTest {
    @BeforeAll
    static void loadNativeOpenCv() { nu.pattern.OpenCV.loadLocally(); }

    @Test
    void distributedTextureTranslationProducesOnlyUncalibratedPixelCandidate() throws Exception {
        BufferedImage before = textured(240, 180);
        BufferedImage after = translated(before, 6, -4);

        var assessment = compare(png(before), png(after), known("0"), known("1"), 0, 1);

        assertThat(assessment.disposition()).isEqualTo(CameraMotionHeuristic.Disposition.CAMERA_MOTION_CANDIDATE);
        assertThat(assessment.xTranslationPixels()).isCloseTo(6.0, offset(1.5));
        assertThat(assessment.yTranslationPixels()).isCloseTo(-4.0, offset(1.5));
        assertThat(assessment.supportFraction()).isGreaterThanOrEqualTo(0.70);
        assertThat(assessment.consensusCellCount()).isGreaterThanOrEqualTo(8);
        assertThat(assessment.methodStatus()).isEqualTo("HEURISTIC_UNCALIBRATED");
        assertThat(assessment.uncertaintyDisposition()).isEqualTo("QUALITATIVE");
    }

    @Test
    void localizedObjectMotionDoesNotBecomeGlobalCameraCandidate() throws Exception {
        BufferedImage before = textured(240, 180);
        BufferedImage after = copy(before);
        Graphics2D graphics = after.createGraphics();
        try {
            graphics.setColor(Color.WHITE);
            graphics.fillRect(80, 60, 60, 50);
            graphics.setColor(Color.BLACK);
            graphics.fillRect(95, 70, 24, 24);
        } finally { graphics.dispose(); }

        var assessment = compare(png(before), png(after), known("0"), known("1"), 0, 1);

        assertThat(assessment.disposition()).isNotEqualTo(CameraMotionHeuristic.Disposition.CAMERA_MOTION_CANDIDATE);
    }

    @Test
    void unknownClockGapAndReorderedPtsReturnUnknownWithoutEstimating() {
        byte[] arbitrary = new byte[] {1, 2, 3};
        var unknown = CameraMotionHeuristic.compare(0, SourceMediaTimestamp.unknown("PTS_MISSING"), arbitrary,
                1, known("1"), arbitrary, 25);
        var gap = CameraMotionHeuristic.compare(0, known("0"), arbitrary,
                2, known("1"), arbitrary, 25);
        var reordered = CameraMotionHeuristic.compare(0, known("2"), arbitrary,
                1, known("1"), arbitrary, 25);

        assertThat(unknown.unknownReason()).isEqualTo(CameraMotionHeuristic.UnknownReason.SOURCE_TIMESTAMP_UNKNOWN);
        assertThat(gap.unknownReason()).isEqualTo(CameraMotionHeuristic.UnknownReason.FRAME_GAP);
        assertThat(reordered.unknownReason()).isEqualTo(CameraMotionHeuristic.UnknownReason.SOURCE_TIMESTAMP_NOT_MONOTONIC);
        assertThat(unknown.xTranslationPixels()).isNull();
    }

    @Test
    void frameDimensionMismatchReturnsUnknown() throws Exception {
        var assessment = compare(png(textured(240, 180)), png(textured(200, 180)),
                known("0"), known("1"), 0, 1);

        assertThat(assessment.disposition()).isEqualTo(CameraMotionHeuristic.Disposition.UNKNOWN);
        assertThat(assessment.unknownReason()).isEqualTo(CameraMotionHeuristic.UnknownReason.FRAME_DIMENSIONS_MISMATCH);
        assertThat(assessment.xTranslationPixels()).isNull();
    }

    private static CameraMotionHeuristic.Assessment compare(byte[] a, byte[] b,
            SourceMediaTimestamp ptsA, SourceMediaTimestamp ptsB, int ordinalA, int ordinalB) {
        return CameraMotionHeuristic.compare(ordinalA, ptsA, a, ordinalB, ptsB, b, 25);
    }

    private static SourceMediaTimestamp known(String pts) {
        return SourceMediaTimestamp.fromPts(pts, "1/25");
    }

    private static BufferedImage textured(int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        int value = 0x13579bdf;
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            value = value * 1664525 + 1013904223;
            int gray = (value >>> 24) & 0xff;
            image.setRGB(x, y, (gray << 16) | (gray << 8) | gray);
        }
        return image;
    }

    private static BufferedImage translated(BufferedImage source, int dx, int dy) {
        BufferedImage target = new BufferedImage(source.getWidth(), source.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = target.createGraphics();
        try {
            graphics.setColor(Color.BLACK);
            graphics.fillRect(0, 0, target.getWidth(), target.getHeight());
            graphics.drawImage(source, dx, dy, null);
        } finally { graphics.dispose(); }
        return target;
    }

    private static BufferedImage copy(BufferedImage source) {
        BufferedImage target = new BufferedImage(source.getWidth(), source.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = target.createGraphics();
        try { graphics.drawImage(source, 0, 0, null); } finally { graphics.dispose(); }
        return target;
    }

    private static byte[] png(BufferedImage image) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return bytes.toByteArray();
    }
}
