package com.ghatana.audio.video.vision.image;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

class BoundedImageDecoderTest {
    @Test void decodesAllowedImageWithinBounds() throws Exception {
        BufferedImage source = new BufferedImage(16, 12, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        ImageIO.write(source, "png", encoded);
        var decoded = BoundedImageDecoder.decode(encoded.toByteArray());
        assertThat(decoded.getWidth()).isEqualTo(16);
        assertThat(decoded.getHeight()).isEqualTo(12);
    }

    @Test void rejectsOversizedEncodedImageBeforeDecode() {
        assertThatThrownBy(() -> BoundedImageDecoder.decode(new byte[BoundedImageDecoder.MAX_ENCODED_BYTES + 1]))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("50 MiB");
    }

    @Test void rejectsMalformedEncoding() {
        assertThatThrownBy(() -> BoundedImageDecoder.decode(new byte[] {1, 2, 3}))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test void rejectsUnsafeDimensionsBeforeAllocatingDecodedPixels() throws Exception {
        BufferedImage source = new BufferedImage(BoundedImageDecoder.MAX_DIMENSION + 1, 1, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        ImageIO.write(source, "png", encoded);
        assertThatThrownBy(() -> BoundedImageDecoder.decode(encoded.toByteArray()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
    }

    @Test
    @Timeout(value = 1, unit = java.util.concurrent.TimeUnit.SECONDS)
    void rejectsTinyPngHeaderWithDecodedPixelExpansionBeforeRasterAllocation() {
        byte[] header = pngHeader(BoundedImageDecoder.MAX_DIMENSION, BoundedImageDecoder.MAX_DIMENSION);
        assertThat(header).hasSizeLessThan(64);
        assertThatThrownBy(() -> BoundedImageDecoder.decode(header))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions");
    }

    @Test void appliesAllExifOrientationsToDecodedRaster() throws Exception {
        BufferedImage source = new BufferedImage(8, 6, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        ImageIO.write(source, "jpeg", jpeg);
        byte[] encoded = jpeg.toByteArray();
        for (int orientation = 1; orientation <= 8; orientation++) {
            var decoded = BoundedImageDecoder.decodeWithMetadata(withExifOrientation(encoded, orientation));
            assertThat(decoded.orientation()).isEqualTo(orientation);
            assertThat(decoded.encodedWidth()).isEqualTo(8);
            assertThat(decoded.encodedHeight()).isEqualTo(6);
            assertThat(decoded.image().getWidth()).isEqualTo(orientation >= 5 ? 6 : 8);
            assertThat(decoded.image().getHeight()).isEqualTo(orientation >= 5 ? 8 : 6);
        }
    }

    @Test void orientationTransformsMapMirroredAndRotatedBoxesIntoOrientedCoordinates() {
        var source = new ExifOrientationTransform.Box(1, 1, 2, 1);
        assertThat(new ExifOrientationTransform(2, 8, 6).toOrientedBox(source))
                .isEqualTo(new ExifOrientationTransform.Box(5, 1, 2, 1));
        assertThat(new ExifOrientationTransform(6, 8, 6).toOrientedBox(source))
                .isEqualTo(new ExifOrientationTransform.Box(4, 1, 1, 2));
        assertThat(new ExifOrientationTransform(8, 8, 6).toOrientedBox(source))
                .isEqualTo(new ExifOrientationTransform.Box(1, 5, 1, 2));
    }

    @Test void exifBoxRejectsNonFiniteOrOverflowingGeometryBeforeTransform() {
        assertThatThrownBy(() -> new ExifOrientationTransform.Box(Double.NaN, 0, 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExifOrientationTransform.Box(0, 0, Double.POSITIVE_INFINITY, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExifOrientationTransform.Box(Double.MAX_VALUE, 0, Double.MAX_VALUE, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExifOrientationTransform.Box(0, 0, -1, 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test void pixelTransformRoundTripsAllEightOrientations() {
        for (int orientation = 1; orientation <= 8; orientation++) {
            var transform = new ExifOrientationTransform(orientation, 8, 6);
            for (int y = 0; y < 6; y++) {
                for (int x = 0; x < 8; x++) {
                    var target = transform.toOrientedPixel(x, y);
                    assertThat(target.x()).isBetween(0, transform.orientedWidth() - 1);
                    assertThat(target.y()).isBetween(0, transform.orientedHeight() - 1);
                    assertThat(transform.toSourcePixel(target.x(), target.y()))
                            .isEqualTo(new ExifOrientationTransform.Pixel(x, y));
                }
            }
            var sourceBox = new ExifOrientationTransform.Box(1, 1, 2, 1);
            assertThat(transform.toSourceBox(transform.toOrientedBox(sourceBox))).isEqualTo(sourceBox);
        }
    }

    @Test void rejectsMalformedExifOrientationAsUnsupportedMetadata() throws Exception {
        BufferedImage source = new BufferedImage(8, 6, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        ImageIO.write(source, "jpeg", jpeg);
        byte[] original = jpeg.toByteArray();
        byte[] malformed = new byte[] {0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3};
        assertThatThrownBy(() -> BoundedImageDecoder.decode(withExifPayload(original, malformed)))
                .isInstanceOf(BoundedImageDecoder.UnsupportedImageMetadataException.class);
    }

    private static byte[] withExifOrientation(byte[] jpeg, int orientation) {
        byte[] tiff = new byte[] {
                'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0,
                0x12, 0x01, 3, 0, 1, 0, 0, 0, (byte) orientation, 0, 0, 0,
                0, 0, 0, 0
        };
        byte[] exif = new byte[6 + tiff.length];
        System.arraycopy(new byte[] {'E', 'x', 'i', 'f', 0, 0}, 0, exif, 0, 6);
        System.arraycopy(tiff, 0, exif, 6, tiff.length);
        return withExifPayload(jpeg, exif);
    }

    private static byte[] pngHeader(int width, int height) {
        ByteBuffer png = ByteBuffer.allocate(33).order(ByteOrder.BIG_ENDIAN);
        png.put(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        png.putInt(13).put(new byte[] {'I', 'H', 'D', 'R'}).putInt(width).putInt(height);
        png.put(new byte[] {8, 2, 0, 0, 0});
        java.util.zip.CRC32 crc = new java.util.zip.CRC32();
        crc.update(png.array(), 12, 17);
        png.putInt((int) crc.getValue());
        return png.array();
    }

    private static byte[] withExifPayload(byte[] jpeg, byte[] exifPayload) {
        int segmentLength = exifPayload.length + 2;
        byte[] result = new byte[jpeg.length + exifPayload.length + 4];
        result[0] = (byte) 0xFF;
        result[1] = (byte) 0xD8;
        result[2] = (byte) 0xFF;
        result[3] = (byte) 0xE1;
        result[4] = (byte) (segmentLength >>> 8);
        result[5] = (byte) segmentLength;
        System.arraycopy(exifPayload, 0, result, 6, exifPayload.length);
        System.arraycopy(jpeg, 2, result, 6 + exifPayload.length, jpeg.length - 2);
        return result;
    }
}
