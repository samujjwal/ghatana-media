package com.ghatana.media.production.rendering;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.AbstractList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

class PngFrameCodecTest {
    private static final TimeBase TIME_BASE = new TimeBase(1_001, 30_000);

    @Test
    void sequenceDecodePreservesCallerClockAndFrameMetadataWithoutClaimingArtifactBinding() {
        Roi roi = new Roi(1, 0, 1, 1);
        byte[][] rgb = {{10, 20, 30, 40, 50, 60}, {11, 21, 31, 41, 51, 61}, {12, 22, 32, 42, 52, 62}};
        List<PngFrameCodec.PngFrame> pngs = List.of(
                inputFrame(0, 0, roi, rgb[0]),
                inputFrame(1, 1_001, roi, rgb[1]),
                inputFrame(2, 3_003, roi, rgb[2]));

        PngFrameCodec.DecodedPngFrameSequence sequence = PngFrameCodec.decodeSequence(TIME_BASE, pngs);

        assertThat(sequence.timeBase()).isEqualTo(TIME_BASE);
        assertThat(sequence.frames()).extracting(Frame::frameIndex).containsExactly(0, 1, 2);
        assertThat(sequence.frames()).extracting(Frame::presentationTicks).containsExactly(0L, 1_001L, 3_003L);
        assertThat(sequence.frames()).allSatisfy(frame -> assertThat(frame.roi()).isEqualTo(roi));
        assertThat(sequence.frames().get(1).rgb()).containsExactly(rgb[1]);
    }

    @Test
    void candidatePngRoundTripEncodesActualRgbPayloadAndCallerMetadataRemainsAvailable() {
        byte[] pixels = {(byte) 250, 2, 3, 4, 5, 6};
        Roi roi = new Roi(0, 0, 2, 1);
        Frame source = new Frame(7, 9_001, 2, 1, roi, pixels);
        CandidateFrame candidate = new CandidateFrame(source.frameIndex(), source.presentationTicks(), source.width(),
                source.height(), source.roi(), source.rgb(), source.frameSha256());

        byte[] png = PngFrameCodec.encode(candidate);
        Frame decoded = PngFrameCodec.decode(png,
                new PngFrameCodec.FrameMetadata(7, 9_001, 2, 1, roi));

        assertThat(decoded.rgb()).containsExactly(pixels);
        assertThat(decoded.frameIndex()).isEqualTo(candidate.frameIndex());
        assertThat(decoded.presentationTicks()).isEqualTo(candidate.presentationTicks());
        assertThat(decoded.roi()).isEqualTo(candidate.roi());
        assertThat(ImageIO.getImageReadersByFormatName("png").hasNext()).isTrue();
    }

    @Test
    void rejectsTrailingBytesMalformedPngDimensionMismatchAndEncodedInputOverflow() throws Exception {
        byte[] valid = png(2, 1, new byte[] {1, 2, 3, 4, 5, 6});
        PngFrameCodec.FrameMetadata metadata = new PngFrameCodec.FrameMetadata(0, 0, 2, 1, new Roi(0, 0, 2, 1));
        byte[] trailing = java.util.Arrays.copyOf(valid, valid.length + 1);
        trailing[trailing.length - 1] = 42;

        assertThatThrownBy(() -> PngFrameCodec.decode(trailing, metadata))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("trailing bytes");
        assertThatThrownBy(() -> PngFrameCodec.decode(new byte[] {1, 2, 3}, metadata))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not a PNG");
        assertThatThrownBy(() -> PngFrameCodec.decode(valid,
                new PngFrameCodec.FrameMetadata(0, 0, 1, 1, new Roi(0, 0, 1, 1))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions do not match");
        assertThatThrownBy(() -> PngFrameCodec.decode(valid, metadata,
                new PngFrameCodec.Limits(valid.length - 1, 1_000, 10, 10, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("encoded byte bound");
    }

    @Test
    void rejectsPixelLimitBeforeImageAllocationAndCapsEncodedOutput() {
        byte[] valid = png(2, 1, new byte[] {1, 2, 3, 4, 5, 6});
        PngFrameCodec.FrameMetadata metadata = new PngFrameCodec.FrameMetadata(0, 0, 2, 1, new Roi(0, 0, 2, 1));
        assertThatThrownBy(() -> PngFrameCodec.decode(valid, metadata,
                new PngFrameCodec.Limits(1_000, 1_000, 10, 1, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("pixel or frame bounds");

        CandidateFrame candidate = new CandidateFrame(0, 0, 2, 1, metadata.roi(),
                new byte[] {1, 2, 3, 4, 5, 6}, sha256(new byte[] {1, 2, 3, 4, 5, 6}));
        assertThatThrownBy(() -> PngFrameCodec.encode(candidate,
                new PngFrameCodec.Limits(1_000, 8, 10, 10, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("output bound");
    }

    @Test
    void defensivelyCopiesPngBuffers() {
        byte[] encoded = png(1, 1, new byte[] {8, 9, 10});
        byte[] expected = encoded.clone();
        PngFrameCodec.PngFrame input = new PngFrameCodec.PngFrame(encoded,
                new PngFrameCodec.FrameMetadata(0, 0, 1, 1, new Roi(0, 0, 1, 1)));
        encoded[0] = 0;
        byte[] returned = input.png();
        returned[0] = 0;
        assertThat(input.png()).containsExactly(expected);
    }

    @Test
    void rejectsAggregatePixelOverflowBeforeAttemptingToDecodeAnyFrame() {
        Roi fullFrame = new Roi(0, 0, 2_048, 2_048);
        List<PngFrameCodec.PngFrame> frames = List.of(
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(0, 1, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(1, 2, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(2, 3, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(3, 4, 2_048, 2_048, fullFrame)));

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, frames))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate pixel");
    }

    @Test
    void rejectsAggregateEncodedOverflowBeforeDecodingAnyFrame() {
        Roi roi = new Roi(0, 0, 2, 1);
        List<PngFrameCodec.PngFrame> frames = List.of(
                inputFrame(0, 1, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                inputFrame(1, 2, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                inputFrame(2, 3, roi, new byte[] {1, 2, 3, 4, 5, 6}));
        long encodedBytes = frames.stream().mapToLong(frame -> frame.png().length).sum();
        PngFrameCodec.Limits limits = new PngFrameCodec.Limits(1_000, 1_000, 10, 10, encodedBytes - 1);

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, frames, limits))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate encoded byte bound");
    }

    @Test
    void rejectsUnderreportedFrameListAfterReadingAtMostTheBoundedFrameCount() {
        int[] yielded = {0};
        PngFrameCodec.FrameMetadata metadata =
                new PngFrameCodec.FrameMetadata(0, 1, 1, 1, new Roi(0, 0, 1, 1));
        PngFrameCodec.PngFrame frame = new PngFrameCodec.PngFrame(new byte[] {1}, metadata);
        List<PngFrameCodec.PngFrame> underreported = new AbstractList<>() {
            @Override public PngFrameCodec.PngFrame get(int index) { throw new UnsupportedOperationException(); }
            @Override public int size() { return 3; }
            @Override public Iterator<PngFrameCodec.PngFrame> iterator() {
                return new Iterator<>() {
                    @Override public boolean hasNext() { return yielded[0] < 100; }
                    @Override public PngFrameCodec.PngFrame next() {
                        yielded[0]++;
                        return frame;
                    }
                };
            }
        };

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, underreported))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("between 3 and 64 frames");
        assertThat(yielded[0]).isEqualTo(TemporalVideoRestoration.MAX_FRAMES);
    }

    private static PngFrameCodec.PngFrame inputFrame(int index, long pts, Roi roi, byte[] rgb) {
        return new PngFrameCodec.PngFrame(png(2, 1, rgb),
                new PngFrameCodec.FrameMetadata(index, pts, 2, 1, roi));
    }

    private static byte[] png(int width, int height, byte[] rgb) {
        try {
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            int[] row = new int[width];
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int offset = (y * width + x) * 3;
                    row[x] = (Byte.toUnsignedInt(rgb[offset]) << 16)
                            | (Byte.toUnsignedInt(rgb[offset + 1]) << 8) | Byte.toUnsignedInt(rgb[offset + 2]);
                }
                image.setRGB(0, y, width, 1, row, 0, width);
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            ImageIO.write(image, "PNG", output);
            return output.toByteArray();
        } catch (Exception ex) {
            throw new AssertionError(ex);
        }
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception ex) { throw new AssertionError(ex); }
    }
}
