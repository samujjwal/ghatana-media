package com.ghatana.media.common.validation;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class MediaFormatValidatorQualificationTest {
    @Test
    void refusesEncodedImagesAboveTheVisionDecoderInputLimitBeforeParsing() {
        byte[] oversized = new byte[50 * 1024 * 1024 + 1];

        var result = MediaFormatValidator.validateImage(oversized, null);

        assertThat(result.valid).isFalse();
        assertThat(result.errorMessage).isEqualTo("Encoded image exceeds the 50 MiB limit");
    }

    @Test
    void recognizesCompressedAudioHeadersWithoutTreatingThemAsQualifiedDecodeProfiles() {
        byte[] mp3Header = new byte[44];
        byte[] id3 = "ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000".getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(id3, 0, mp3Header, 0, id3.length);
        assertThat(MediaFormatValidator.detectAudioFormat(mp3Header)).isEqualTo("MP3");

        var validation = MediaFormatValidator.validateAudio(mp3Header, null, 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).contains("no complete decode profile is qualified");
    }

    @Test
    void codecSniffingRejectsMalformedId3AndReservedMpegHeaderFields() {
        byte[] truncatedId3 = "ID3".getBytes(StandardCharsets.ISO_8859_1);
        assertThat(MediaFormatValidator.detectAudioFormat(truncatedId3)).isEqualTo("UNKNOWN");

        byte[] invalidTagSize = new byte[10];
        putAscii(invalidTagSize, 0, "ID3");
        invalidTagSize[3] = 4;
        invalidTagSize[6] = (byte) 0x80; // Not a synchsafe length.
        assertThat(MediaFormatValidator.detectAudioFormat(invalidTagSize)).isEqualTo("UNKNOWN");

        byte[] reservedMpegVersion = new byte[] {(byte) 0xFF, (byte) 0xE0, 0x10, 0};
        byte[] reservedBitrate = new byte[] {(byte) 0xFF, (byte) 0xFB, (byte) 0xF0, 0};
        byte[] validMpegHeader = new byte[44];
        validMpegHeader[0] = (byte) 0xFF;
        validMpegHeader[1] = (byte) 0xFB;
        validMpegHeader[2] = (byte) 0x90;
        validMpegHeader[3] = 0x64;
        assertThat(MediaFormatValidator.detectAudioFormat(reservedMpegVersion)).isEqualTo("UNKNOWN");
        assertThat(MediaFormatValidator.detectAudioFormat(reservedBitrate)).isEqualTo("UNKNOWN");
        // This identifies a plausible container/frame header only. validateAudio
        // still reports that no qualified MP3 decoder is installed.
        assertThat(MediaFormatValidator.detectAudioFormat(validMpegHeader)).isEqualTo("MP3");
        assertThat(MediaFormatValidator.validateAudio(validMpegHeader, null, 0).valid).isFalse();
    }

    @Test
    void rejectsRiffChunksWhoseUnsignedLengthExceedsTheInput() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, -1);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk exceeds available data");
    }

    @Test
    void rejectsFormatChunksTooShortToContainThePcmFields() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 8);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV fmt chunk is shorter than the PCM header");
    }

    @Test
    void rejectsRiffLengthThatClaimsBytesBeyondTheInput() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, -1);
        putAscii(wav, 8, "WAVE");

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV RIFF chunk exceeds available data");
    }

    @Test
    void rejectsChunksThatFitTheArrayButExceedTheDeclaredRiffBoundary() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 20);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 16);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk exceeds RIFF bounds");
    }

    @Test
    void rejectsOddSizedChunkWithoutItsRequiredPaddingByte() {
        byte[] wav = new byte[44];
        putAscii(wav, 0, "RIFF");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 29);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(16, 17);

        var validation = MediaFormatValidator.validateAudio(wav, "WAV", 0);
        assertThat(validation.valid).isFalse();
        assertThat(validation.errorMessage).isEqualTo("WAV chunk padding exceeds RIFF bounds");
    }

    @Test
    void acceptsCompleteAlignedPcmContainerWithoutClaimingDecodeQualification() {
        var result = MediaFormatValidator.validateAudio(pcmWav(4), "WAV", 16000);
        assertThat(result.valid).isTrue();
        assertThat(result.sampleRate).isEqualTo(16000);
        assertThat(result.channels).isEqualTo(1);
        assertThat(result.bitsPerSample).isEqualTo(16);
    }

    @Test
    void rejectsMissingDataAndIncompleteSampleFrames() {
        byte[] noData = java.util.Arrays.copyOf(pcmWav(4), 36);
        ByteBuffer.wrap(noData).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 28);
        // Keep enough input bytes to reach the container parser.
        noData = java.util.Arrays.copyOf(noData, 44);
        ByteBuffer.wrap(noData).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 36);
        putAscii(noData, 36, "JUNK");
        assertThat(MediaFormatValidator.validateAudio(noData, "WAV", 0).errorMessage).contains("missing data");
        assertThat(MediaFormatValidator.validateAudio(pcmWav(0), "WAV", 0).errorMessage).contains("nonempty sample frames");
        assertThat(MediaFormatValidator.validateAudio(pcmWav(3), "WAV", 0).errorMessage).contains("complete nonempty sample frames");
    }

    @Test
    void rejectsPcmRateAndAlignmentInconsistencies() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(32, (short) 1);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("block alignment");
        wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(28, 16000);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("byte rate");
    }

    @Test
    void rejectsLayoutsWhoseExtensibleSemanticsAreNotImplemented() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(22, (short) 3);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("Unsupported basic WAV PCM");
        wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putShort(34, (short) 24);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("Unsupported basic WAV PCM");
    }

    @Test
    void validatesPngIhdrStructureAndSupportedUnsignedDimensions() throws IOException {
        var dimensionBoundary = MediaFormatValidator.validateImage(encodedImage("PNG", 8192, 1), "PNG");
        assertThat(dimensionBoundary.valid).isTrue();
        assertThat(dimensionBoundary.width).isEqualTo(8192);
        assertThat(dimensionBoundary.height).isEqualTo(1);

        var pixelBoundary = MediaFormatValidator.validateImage(pngHeader(4000, 4000), "PNG");
        assertThat(pixelBoundary.valid).isFalse();
        assertThat(pixelBoundary.errorMessage).contains("cannot be decoded");

        assertThat(MediaFormatValidator.validateImage(pngHeader(4001, 4000), "PNG").errorMessage)
                .contains("supported image bounds");
        assertThat(MediaFormatValidator.validateImage(pngHeader(8193, 1), "PNG").errorMessage)
                .contains("supported image bounds");
        assertThat(MediaFormatValidator.validateImage(pngHeader(0, 1), "PNG").errorMessage)
                .contains("supported image bounds");
        assertThat(MediaFormatValidator.validateImage(pngHeader(0x8000_0000L, 1), "PNG").errorMessage)
                .contains("supported image bounds");

        byte[] signatureOnly = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
        assertThat(MediaFormatValidator.validateImage(signatureOnly, "PNG").errorMessage)
                .contains("complete IHDR");
        byte[] invalidSignature = pngHeader(1, 1);
        invalidSignature[7] = 0;
        assertThat(MediaFormatValidator.validateImage(invalidSignature, "PNG").errorMessage)
                .contains("signature is invalid");
        byte[] wrongChunkType = pngHeader(1, 1);
        putAscii(wrongChunkType, 12, "IDAT");
        assertThat(MediaFormatValidator.validateImage(wrongChunkType, "PNG").errorMessage)
                .contains("valid IHDR");
    }

    @Test
    void pngSpecificBoundsDoNotChangeOtherImageHeaderHandling() throws IOException {
        byte[] jpegHeader = encodedImage("JPEG", 640, 480);
        var result = MediaFormatValidator.validateImage(jpegHeader, "JPEG");
        assertThat(result.valid).isTrue();
        assertThat(result.width).isEqualTo(640);
        assertThat(result.height).isEqualTo(480);
        assertThat(MediaFormatValidator.validateImage(jpegHeader(4001, 4000), "JPEG").errorMessage)
                .contains("supported image bounds");
        assertThat(MediaFormatValidator.validateImage(
                new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 4, 0, 0}, "JPEG").errorMessage)
                .contains("valid dimensions");
    }

    @Test
    void requiresInstalledDecoderToDecodeTheAdvertisedPngJpegAndGifPayload() throws IOException {
        for (String format : new String[] {"PNG", "JPEG", "GIF"}) {
            byte[] encoded = encodedImage(format, 2, 1);
            var valid = MediaFormatValidator.validateImage(encoded, format);
            assertThat(valid.valid).as(format).isTrue();
            assertThat(valid.format).as(format).isEqualTo(format);

            byte[] headerOnly = switch (format) {
                case "PNG" -> pngHeader(2, 1);
                case "JPEG" -> jpegHeader(2, 1);
                default -> gifHeader(2, 1);
            };
            var invalid = MediaFormatValidator.validateImage(headerOnly, format);
            assertThat(invalid.valid).as(format).isFalse();
            assertThat(invalid.errorMessage).as(format).contains("cannot be decoded");
        }
    }

    @Test
    void rejectsOversizedGifCanvasAndTruncatedGifDimensions() {
        byte[] oversized = gifHeader(4001, 4000);
        assertThat(MediaFormatValidator.validateImage(oversized, "GIF").errorMessage)
                .contains("supported image bounds");

        byte[] truncated = new byte[] {'G', 'I', 'F', '8', '9', 'a', 1, 0};
        assertThat(MediaFormatValidator.validateImage(truncated, "GIF").errorMessage)
                .contains("image dimensions");

        byte[] invalidVersion = gifHeader(1, 1);
        invalidVersion[4] = 'x';
        assertThat(MediaFormatValidator.detectImageFormat(invalidVersion)).isEqualTo("UNKNOWN");
        assertThat(MediaFormatValidator.validateImage(invalidVersion, "GIF").errorMessage)
                .contains("not a valid image file");
    }

    @Test
    void rejectsWebpContainerHeaderWithoutParsedDimensions() {
        byte[] webp = new byte[12];
        putAscii(webp, 0, "RIFF");
        putAscii(webp, 8, "WEBP");

        var result = MediaFormatValidator.validateImage(webp, "WEBP");
        assertThat(result.valid).isFalse();
        assertThat(result.errorMessage).contains("valid dimensions");
    }

    @Test
    void validatesChunksAfterFmtEvenWhenSampleRateDiffers() {
        byte[] wav = pcmWav(4);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(40, 1000);
        var result = MediaFormatValidator.validateAudio(wav, "WAV", 8000);
        assertThat(result.valid).isFalse();
        assertThat(result.errorMessage).contains("exceeds available data");
    }

    @Test
    void rejectsTruncatedTrailingHeaderAndBytesOutsideContainer() {
        byte[] wav = java.util.Arrays.copyOf(pcmWav(4), 51);
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(4, 43);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("incomplete trailing chunk");
        wav = java.util.Arrays.copyOf(pcmWav(4), 50);
        assertThat(MediaFormatValidator.validateAudio(wav, "WAV", 0).errorMessage).contains("outside the RIFF");
    }

    private static byte[] pcmWav(int dataSize) {
        byte[] wav = new byte[44 + dataSize + (dataSize & 1)];
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        putAscii(wav, 0, "RIFF"); b.putInt(4, wav.length - 8); putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt "); b.putInt(16, 16); b.putShort(20, (short) 1);
        b.putShort(22, (short) 1); b.putInt(24, 16000); b.putInt(28, 32000);
        b.putShort(32, (short) 2); b.putShort(34, (short) 16);
        putAscii(wav, 36, "data"); b.putInt(40, dataSize);
        return wav;
    }

    private static byte[] pngHeader(long width, long height) {
        ByteBuffer buffer = ByteBuffer.allocate(33).order(ByteOrder.BIG_ENDIAN);
        buffer.put(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10});
        buffer.putInt(13);
        buffer.put("IHDR".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt((int) width);
        buffer.putInt((int) height);
        buffer.put(new byte[] {8, 2, 0, 0, 0});
        buffer.putInt(0); // CRC is outside this header-only validator's current qualification.
        return buffer.array();
    }

    private static byte[] gifHeader(int width, int height) {
        byte[] header = new byte[10];
        putAscii(header, 0, "GIF89a");
        header[6] = (byte) width;
        header[7] = (byte) (width >>> 8);
        header[8] = (byte) height;
        header[9] = (byte) (height >>> 8);
        return header;
    }

    private static byte[] jpegHeader(int width, int height) {
        return new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xC0,
                0, 11, 8, (byte) (height >>> 8), (byte) height,
                (byte) (width >>> 8), (byte) width, 1, 1, 0x11, 0};
    }

    private static byte[] encodedImage(String format, int width, int height) throws IOException {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!ImageIO.write(image, format, output)) {
            throw new IOException("No local writer for " + format);
        }
        return output.toByteArray();
    }

    private static void putAscii(byte[] bytes, int offset, String text) {
        byte[] encoded = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(encoded, 0, bytes, offset, encoded.length);
    }
}
