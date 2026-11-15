package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.tracking.RegionOfInterest;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevVisionStillImageOrientationTest {
    @Test
    void roiBoundsUseExifOrientedDimensions() throws Exception {
        BufferedImage decoded = MediaDevVisionTrackingRuntime.decodeStillImage(jpegWithOrientation(640, 360, 6));

        assertThat(decoded.getWidth()).isEqualTo(360);
        assertThat(decoded.getHeight()).isEqualTo(640);
        new RegionOfInterest(0, 0, 360, 640).requireWithin(decoded.getWidth(), decoded.getHeight());
        assertThatThrownBy(() -> new RegionOfInterest(360, 0, 1, 1)
                .requireWithin(decoded.getWidth(), decoded.getHeight()))
                .isInstanceOfSatisfying(RegionOfInterest.RoiRefusedException.class,
                        failure -> assertThat(failure.code()).isEqualTo("ROI_OUT_OF_FRAME"));
    }

    private static byte[] jpegWithOrientation(int width, int height, int orientation) throws Exception {
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        assertThat(ImageIO.write(new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB), "jpeg", encoded)).isTrue();
        byte[] jpeg = encoded.toByteArray();
        byte[] exif = new byte[] {'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0,
                0x12, 0x01, 3, 0, 1, 0, 0, 0, (byte) orientation, 0, 0, 0, 0, 0, 0, 0};
        int segmentLength = exif.length + 2;
        ByteArrayOutputStream result = new ByteArrayOutputStream(jpeg.length + exif.length + 4);
        result.write(jpeg, 0, 2);
        result.write(0xff);
        result.write(0xe1);
        result.write((segmentLength >>> 8) & 0xff);
        result.write(segmentLength & 0xff);
        result.write(exif);
        result.write(jpeg, 2, jpeg.length - 2);
        return result.toByteArray();
    }
}
