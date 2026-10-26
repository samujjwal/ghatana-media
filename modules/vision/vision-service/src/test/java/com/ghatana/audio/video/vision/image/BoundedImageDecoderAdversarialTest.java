package com.ghatana.audio.video.vision.image;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

class BoundedImageDecoderAdversarialTest {
    @Test
    void rejectsTruncatedJpegAndInvalidSegmentLength() {
        byte[] truncatedJpeg = {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xda, 0, 8, 1};
        byte[] oversizedExifSegment = {
                (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe1,
                0x7f, (byte) 0xff, 'E', 'x', 'i', 'f', 0, 0
        };

        assertThatThrownBy(() -> BoundedImageDecoder.decode(truncatedJpeg))
                .isInstanceOfSatisfying(BoundedImageDecoder.ImageInputException.class,
                        failure -> assertThat(failure.reason())
                                .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.MALFORMED_ENCODING));
        assertThatThrownBy(() -> BoundedImageDecoder.decode(oversizedExifSegment))
                .isInstanceOfSatisfying(BoundedImageDecoder.UnsupportedImageMetadataException.class,
                        failure -> assertThat(failure.reason())
                                .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.UNSUPPORTED_METADATA));
    }

    @Test
    @Timeout(value = 2, unit = TimeUnit.SECONDS)
    void rejectsTinyPngWithOversizedPixelExpansionBeforeRasterDecode() {
        byte[] oversizedDimensions = pngHeader(
                BoundedImageDecoder.MAX_DIMENSION,
                BoundedImageDecoder.MAX_DIMENSION);

        assertThat(oversizedDimensions.length).isLessThan(64);
        assertThatThrownBy(() -> BoundedImageDecoder.decode(oversizedDimensions))
                .isInstanceOfSatisfying(BoundedImageDecoder.ImageInputException.class, failure -> {
                    assertThat(failure.reason())
                            .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.DECODED_SIZE_LIMIT);
                    assertThat(failure).hasMessageContaining("dimensions");
                });
    }

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS)
    void repeatedMalformedInputsFailWithinTimeBudget() {
        Random random = new Random(0x56495303L);
        for (int sample = 0; sample < 200; sample++) {
            byte[] malformed = new byte[8 + random.nextInt(256)];
            random.nextBytes(malformed);
            assertThatThrownBy(() -> BoundedImageDecoder.decode(malformed))
                    .as("malformed sample %s", sample)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void rejectsEncodedInputOverLimitBeforeFormatParsing() {
        byte[] oversized = new byte[BoundedImageDecoder.MAX_ENCODED_BYTES + 1];
        assertThatThrownBy(() -> BoundedImageDecoder.decode(oversized))
                .isInstanceOfSatisfying(BoundedImageDecoder.ImageInputException.class, failure -> {
                    assertThat(failure.reason())
                            .isEqualTo(BoundedImageDecoder.ImageInputException.Reason.ENCODED_SIZE_LIMIT);
                    assertThat(failure).hasMessageContaining("50 MiB");
                });
    }

    private static byte[] pngHeader(int width, int height) {
        ByteBuffer png = ByteBuffer.allocate(33).order(ByteOrder.BIG_ENDIAN);
        png.put(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        png.putInt(13).put(new byte[] {'I', 'H', 'D', 'R'}).putInt(width).putInt(height);
        png.put(new byte[] {8, 2, 0, 0, 0});
        CRC32 crc = new CRC32();
        crc.update(png.array(), 12, 17);
        png.putInt((int) crc.getValue());
        return png.array();
    }
}
