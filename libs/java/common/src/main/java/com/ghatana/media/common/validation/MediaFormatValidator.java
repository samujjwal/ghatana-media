/**
 * @doc.type class
 * @doc.purpose Media format validation for audio and video data
 * @doc.layer platform
 * @doc.pattern utility
 */
package com.ghatana.media.common.validation;

import com.ghatana.media.common.ValidationError;


/**
 * Validates media file formats using magic numbers and header parsing.
 * Detects format type, validates integrity, and extracts basic metadata.
 */
public final class MediaFormatValidator {

    /**
     * Creates a new MediaFormatValidator instance.
     * Note: All validation methods are static, but instance creation is supported
     * for dependency injection and testing purposes.
     */
    public MediaFormatValidator() {}

    // Audio format magic numbers
    private static final byte[] WAV_RIFF = {0x52, 0x49, 0x46, 0x46}; // "RIFF"
    private static final byte[] WAV_WAVE = {0x57, 0x41, 0x56, 0x45}; // "WAVE"
    private static final byte[] MP3_ID3 = {0x49, 0x44, 0x33}; // "ID3"
    private static final byte[] MP3_MPEG = {(byte) 0xFF, (byte) 0xFB}; // MPEG sync
    private static final byte[] FLAC_MARKER = {0x66, 0x4C, 0x61, 0x43}; // "fLaC"
    private static final byte[] OGG_MARKER = {0x4F, 0x67, 0x67, 0x53}; // "OggS"

    // Image format magic numbers
    private static final byte[] PNG_SIGNATURE = {(byte) 0x89, 0x50, 0x4E, 0x47};
    private static final byte[] JPEG_SIGNATURE = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF};
    private static final byte[] WEBP_SIGNATURE = {0x52, 0x49, 0x46, 0x46}; // "RIFF"
    private static final byte[] WEBP_VP8 = {0x57, 0x45, 0x42, 0x50}; // "WEBP"
    private static final byte[] GIF_SIGNATURE = {0x47, 0x49, 0x46, 0x38}; // "GIF8"

    // Video format magic numbers
    private static final byte[] MP4_FTYP = {0x66, 0x74, 0x79, 0x70}; // "ftyp"
    private static final byte[] AVI_SIGNATURE = {0x52, 0x49, 0x46, 0x46}; // "RIFF"
    private static final byte[] AVI_AVI = {0x41, 0x56, 0x49, 0x20}; // "AVI "
    private static final byte[] MKV_SIGNATURE = {0x1A, 0x45, (byte) 0xDF, (byte) 0xA3};
    private static final byte[] MOV_SIGNATURE = {0x66, 0x74, 0x79, 0x70}; // "ftyp"

    /**
     * Detects the audio format from the raw bytes.
     * @return detected format or "UNKNOWN"
     */
    public static String detectAudioFormat(byte[] data) {
        if (data == null || data.length < 4) {
            return "UNKNOWN";
        }

        // Check WAV
        if (matchesMagic(data, 0, WAV_RIFF) && data.length >= 8) {
            // Check for WAVE in bytes 8-12
            if (matchesMagic(data, 8, WAV_WAVE)) {
                return "WAV";
            }
        }

        // Check MP3 (ID3 tag)
        if (matchesMagic(data, 0, MP3_ID3)) {
            return "MP3";
        }

        // Check MP3 (MPEG sync)
        if (data.length >= 2 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xE0) == 0xE0) {
            return "MP3";
        }

        // Check FLAC
        if (matchesMagic(data, 0, FLAC_MARKER)) {
            return "FLAC";
        }

        // Check OGG
        if (matchesMagic(data, 0, OGG_MARKER)) {
            return "OGG";
        }

        return "UNKNOWN";
    }

    /**
     * Detects the image format from the raw bytes.
     * @return detected format or "UNKNOWN"
     */
    public static String detectImageFormat(byte[] data) {
        if (data == null || data.length < 4) {
            return "UNKNOWN";
        }

        // Check PNG
        if (matchesMagic(data, 0, PNG_SIGNATURE)) {
            return "PNG";
        }

        // Check JPEG
        if (matchesMagic(data, 0, JPEG_SIGNATURE)) {
            return "JPEG";
        }

        // Check WEBP (RIFF container)
        if (matchesMagic(data, 0, WEBP_SIGNATURE) && data.length >= 12) {
            if (matchesMagic(data, 8, WEBP_VP8)) {
                return "WEBP";
            }
        }

        // Check GIF
        if (matchesMagic(data, 0, GIF_SIGNATURE)) {
            return "GIF";
        }

        return "UNKNOWN";
    }

    /**
     * Detects the video format from the raw bytes.
     * @return detected format or "UNKNOWN"
     */
    public static String detectVideoFormat(byte[] data) {
        if (data == null || data.length < 12) {
            return "UNKNOWN";
        }

        // Check MP4/MOV (ftyp box)
        if (data.length >= 12) {
            // Check for ftyp at offset 4
            if (matchesMagic(data, 4, MP4_FTYP) || matchesMagic(data, 4, MOV_SIGNATURE)) {
                return "MP4";
            }
        }

        // Check AVI
        if (matchesMagic(data, 0, AVI_SIGNATURE) && data.length >= 12) {
            if (matchesMagic(data, 8, AVI_AVI)) {
                return "AVI";
            }
        }

        // Check MKV/WebM
        if (matchesMagic(data, 0, MKV_SIGNATURE)) {
            return "MKV";
        }

        return "UNKNOWN";
    }

    /**
     * Validates audio data format and returns validation result.
     */
    public static AudioValidationResult validateAudio(byte[] data, String expectedFormat, int expectedSampleRate) {
        if (data == null) {
            return AudioValidationResult.error("Audio data is null");
        }

        if (data.length == 0) {
            return AudioValidationResult.error("Audio data is empty");
        }

        // Check minimum size for valid audio (at least header)
        if (data.length < 44) { // Minimum WAV header size
            return AudioValidationResult.error("Audio data too small (" + data.length + " bytes), minimum 44 bytes required");
        }

        // Detect actual format
        String detectedFormat = detectAudioFormat(data);

        // If expected format specified, validate match
        if (expectedFormat != null && !expectedFormat.equalsIgnoreCase(detectedFormat)) {
            if (!"UNKNOWN".equals(detectedFormat)) {
                return AudioValidationResult.error(
                    "Format mismatch: expected " + expectedFormat + " but detected " + detectedFormat);
            }
        }

        // Format-specific validation
        if ("WAV".equals(detectedFormat)) {
            return validateWavFormat(data, expectedSampleRate);
        }

        if ("UNKNOWN".equals(detectedFormat)) {
            return AudioValidationResult.error("Unable to detect audio format - not a valid audio file");
        }

        return AudioValidationResult.success(detectedFormat, data.length);
    }

    /**
     * Validates WAV format and extracts metadata.
     */
    private static AudioValidationResult validateWavFormat(byte[] data, int expectedSampleRate) {
        try {
            // Parse WAV header
            // RIFF header at 0-3
            // File size at 4-7 (little endian)
            // WAVE at 8-11
            // fmt chunk at 12-15

            int offset = 12; // Start after RIFF + WAVE

            // Find fmt chunk
            while (offset < data.length - 8) {
                String chunkId = new String(data, offset, 4);
                int chunkSize = (data[offset + 4] & 0xFF) |
                               ((data[offset + 5] & 0xFF) << 8) |
                               ((data[offset + 6] & 0xFF) << 16) |
                               ((data[offset + 7] & 0xFF) << 24);

                if (chunkId.equals("fmt ")) {
                    // Found fmt chunk
                    int audioFormat = (data[offset + 8] & 0xFF) | ((data[offset + 9] & 0xFF) << 8);
                    int numChannels = (data[offset + 10] & 0xFF) | ((data[offset + 11] & 0xFF) << 8);
                    int sampleRate = (data[offset + 12] & 0xFF) |
                                    ((data[offset + 13] & 0xFF) << 8) |
                                    ((data[offset + 14] & 0xFF) << 16) |
                                    ((data[offset + 15] & 0xFF) << 24);
                    int bitsPerSample = (data[offset + 22] & 0xFF) | ((data[offset + 23] & 0xFF) << 8);

                    if (audioFormat != 1) { // PCM = 1
                        return AudioValidationResult.error("Unsupported audio format: " + audioFormat + " (only PCM supported)");
                    }

                    if (expectedSampleRate > 0 && sampleRate != expectedSampleRate) {
                        return AudioValidationResult.warning("Sample rate mismatch: expected " +
                            expectedSampleRate + " Hz but got " + sampleRate + " Hz");
                    }

                    return AudioValidationResult.success("WAV", data.length, sampleRate, numChannels, bitsPerSample);
                }

                offset += 8 + chunkSize;
                // Align to word boundary
                if (chunkSize % 2 == 1) offset++;
            }

            return AudioValidationResult.error("WAV file missing fmt chunk");

        } catch (Exception e) {
            return AudioValidationResult.error("Error parsing WAV header: " + e.getMessage());
        }
    }

    /**
     * Validates image data format.
     */
    public static ImageValidationResult validateImage(byte[] data, String expectedFormat) {
        if (data == null) {
            return ImageValidationResult.error("Image data is null");
        }

        if (data.length == 0) {
            return ImageValidationResult.error("Image data is empty");
        }

        // Check minimum size for valid image (at least header)
        if (data.length < 8) {
            return ImageValidationResult.error("Image data too small (" + data.length + " bytes)");
        }

        // Detect actual format
        String detectedFormat = detectImageFormat(data);

        // If expected format specified, validate match
        if (expectedFormat != null && !expectedFormat.equalsIgnoreCase(detectedFormat)) {
            if (!"UNKNOWN".equals(detectedFormat)) {
                return ImageValidationResult.error(
                    "Format mismatch: expected " + expectedFormat + " but detected " + detectedFormat);
            }
        }

        if ("UNKNOWN".equals(detectedFormat)) {
            return ImageValidationResult.error("Unable to detect image format - not a valid image file");
        }

        // Extract dimensions based on format
        ImageDimensions dims = extractImageDimensions(data, detectedFormat);

        return ImageValidationResult.success(detectedFormat, data.length, dims.width, dims.height);
    }

    private static ImageDimensions extractImageDimensions(byte[] data, String format) {
        try {
            if ("PNG".equals(format) && data.length >= 24) {
                // PNG dimensions at bytes 16-23
                int width = ((data[16] & 0xFF) << 24) | ((data[17] & 0xFF) << 16) |
                           ((data[18] & 0xFF) << 8) | (data[19] & 0xFF);
                int height = ((data[20] & 0xFF) << 24) | ((data[21] & 0xFF) << 16) |
                            ((data[22] & 0xFF) << 8) | (data[23] & 0xFF);
                return new ImageDimensions(width, height);
            }

            if ("JPEG".equals(format)) {
                // JPEG dimensions require parsing segments
                // Simplified: return unknown
                return new ImageDimensions(0, 0);
            }

            if ("GIF".equals(format) && data.length >= 10) {
                int width = (data[6] & 0xFF) | ((data[7] & 0xFF) << 8);
                int height = (data[8] & 0xFF) | ((data[9] & 0xFF) << 8);
                return new ImageDimensions(width, height);
            }

        } catch (Exception e) {
            return new ImageDimensions(0, 0);
        }

        return new ImageDimensions(0, 0);
    }

    private static boolean matchesMagic(byte[] data, int offset, byte[] magic) {
        if (data == null || magic == null) return false;
        if (offset + magic.length > data.length) return false;

        for (int i = 0; i < magic.length; i++) {
            if (data[offset + i] != magic[i]) {
                return false;
            }
        }
        return true;
    }

    // Result classes
    public static class AudioValidationResult {
        public final boolean valid;
        public final String errorMessage;
        public final String format;
        public final int dataSize;
        public final int sampleRate;
        public final int channels;
        public final int bitsPerSample;
        public final boolean warning;

        private AudioValidationResult(boolean valid, String errorMessage, String format, int dataSize,
                                      int sampleRate, int channels, int bitsPerSample, boolean warning) {
            this.valid = valid;
            this.errorMessage = errorMessage;
            this.format = format;
            this.dataSize = dataSize;
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bitsPerSample = bitsPerSample;
            this.warning = warning;
        }

        static AudioValidationResult success(String format, int dataSize) {
            return new AudioValidationResult(true, null, format, dataSize, 0, 0, 0, false);
        }

        static AudioValidationResult success(String format, int dataSize, int sampleRate, int channels, int bitsPerSample) {
            return new AudioValidationResult(true, null, format, dataSize, sampleRate, channels, bitsPerSample, false);
        }

        static AudioValidationResult error(String message) {
            return new AudioValidationResult(false, message, null, 0, 0, 0, 0, false);
        }

        static AudioValidationResult warning(String message) {
            return new AudioValidationResult(true, message, null, 0, 0, 0, 0, true);
        }

        public void throwIfInvalid() {
            if (!valid && !warning) {
                throw new ValidationError(errorMessage);
            }
        }
    }

    public static class ImageValidationResult {
        public final boolean valid;
        public final String errorMessage;
        public final String format;
        public final int dataSize;
        public final int width;
        public final int height;

        private ImageValidationResult(boolean valid, String errorMessage, String format, int dataSize, int width, int height) {
            this.valid = valid;
            this.errorMessage = errorMessage;
            this.format = format;
            this.dataSize = dataSize;
            this.width = width;
            this.height = height;
        }

        static ImageValidationResult success(String format, int dataSize, int width, int height) {
            return new ImageValidationResult(true, null, format, dataSize, width, height);
        }

        static ImageValidationResult error(String message) {
            return new ImageValidationResult(false, message, null, 0, 0, 0);
        }

        public void throwIfInvalid() {
            if (!valid) {
                throw new ValidationError(errorMessage);
            }
        }
    }

    private static class ImageDimensions {
        final int width;
        final int height;

        ImageDimensions(int width, int height) {
            this.width = width;
            this.height = height;
        }
    }
}
