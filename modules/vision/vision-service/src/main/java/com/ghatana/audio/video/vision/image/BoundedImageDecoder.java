package com.ghatana.audio.video.vision.image;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Set;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;

/**
 * Validates encoded and expanded image bounds before allocating decoded pixels.
 * Bounded EXIF orientation is applied before inference. Returned boxes therefore use the
 * EXIF-oriented source-raster coordinate system.
 */
public final class BoundedImageDecoder {
    public static final int MAX_ENCODED_BYTES = 50 * 1024 * 1024;
    public static final int MAX_DIMENSION = 8192;
    public static final long MAX_PIXELS = 16_000_000L;
    private static final Set<String> FORMATS = Set.of("jpeg", "jpg", "png", "bmp", "wbmp", "webp");

    private BoundedImageDecoder() { }

    public static BufferedImage decode(byte[] bytes) {
        return decodeWithMetadata(bytes).image();
    }

    public static DecodedImage decodeWithMetadata(byte[] bytes) {
        if (bytes == null || bytes.length == 0) throw new IllegalArgumentException("Image data is required");
        if (bytes.length > MAX_ENCODED_BYTES) throw new IllegalArgumentException("Encoded image exceeds the 50 MiB limit");
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            if (input == null) throw new IllegalArgumentException("Image stream is unavailable");
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new IllegalArgumentException("Unsupported or malformed image encoding");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                if (!FORMATS.contains(reader.getFormatName().toLowerCase(java.util.Locale.ROOT))) {
                    throw new IllegalArgumentException("Unsupported image format");
                }
                int orientation = exifOrientation(bytes, reader.getFormatName().toLowerCase(java.util.Locale.ROOT));
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
                        || (long) width * height > MAX_PIXELS) {
                    throw new IllegalArgumentException("Decoded image dimensions exceed the supported bounds");
                }
                BufferedImage image = reader.read(0);
                if (image == null || image.getWidth() != width || image.getHeight() != height) {
                    throw new IllegalArgumentException("Decoded image dimensions do not match the validated header");
                }
                return new DecodedImage(applyOrientation(image, orientation), orientation, width, height);
            } finally {
                reader.dispose();
            }
        } catch (IOException failure) {
            throw new IllegalArgumentException("Failed to decode image data", failure);
        }
    }

    private static BufferedImage applyOrientation(BufferedImage source, int orientation) {
        ExifOrientationTransform transform = new ExifOrientationTransform(
                orientation, source.getWidth(), source.getHeight());
        if (orientation == 1) return source;
        BufferedImage oriented = new BufferedImage(transform.orientedWidth(), transform.orientedHeight(),
                source.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < source.getHeight(); y++) {
            for (int x = 0; x < source.getWidth(); x++) {
                ExifOrientationTransform.Pixel target = transform.toOrientedPixel(x, y);
                oriented.setRGB(target.x(), target.y(), source.getRGB(x, y));
            }
        }
        return oriented;
    }

    public record DecodedImage(BufferedImage image, int orientation, int encodedWidth, int encodedHeight) { }

    private static int exifOrientation(byte[] bytes, String format) {
        byte[] tiff = null;
        if (format.equals("jpeg") || format.equals("jpg")) {
            tiff = jpegExif(bytes);
        } else if (format.equals("png")) {
            tiff = pngExif(bytes);
        } else if (format.equals("webp")) {
            tiff = webpExif(bytes);
        }
        return tiff == null ? 1 : parseTiffOrientation(tiff);
    }

    private static byte[] jpegExif(byte[] bytes) {
        if (bytes.length < 4 || u8(bytes, 0) != 0xFF || u8(bytes, 1) != 0xD8) return null;
        int offset = 2;
        while (offset + 4 <= bytes.length) {
            if (u8(bytes, offset) != 0xFF) throw metadataError("Malformed JPEG marker stream");
            while (offset < bytes.length && u8(bytes, offset) == 0xFF) offset++;
            if (offset >= bytes.length) throw metadataError("Truncated JPEG marker");
            int marker = u8(bytes, offset++);
            if (marker == 0xD9 || marker == 0xDA) return null;
            if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) continue;
            if (offset + 2 > bytes.length) throw metadataError("Truncated JPEG segment length");
            int length = (u8(bytes, offset) << 8) | u8(bytes, offset + 1);
            if (length < 2 || offset + length > bytes.length) throw metadataError("Invalid JPEG segment length");
            int data = offset + 2;
            if (marker == 0xE1 && length >= 8 && ascii(bytes, data, "Exif\0\0")) {
                return copyRange(bytes, data + 6, offset + length);
            }
            offset += length;
        }
        return null;
    }

    private static byte[] pngExif(byte[] bytes) {
        if (bytes.length < 8 || u8(bytes, 0) != 0x89 || !ascii(bytes, 1, "PNG\r\n\u001a\n")) return null;
        int offset = 8;
        while (offset + 12 <= bytes.length) {
            long length = u32be(bytes, offset);
            if (length > Integer.MAX_VALUE || offset + 12L + length > bytes.length) {
                throw metadataError("Invalid PNG chunk length");
            }
            int data = offset + 8;
            if (ascii(bytes, offset + 4, "eXIf")) return copyRange(bytes, data, data + (int) length);
            offset = data + (int) length + 4;
        }
        return null;
    }

    private static byte[] webpExif(byte[] bytes) {
        if (bytes.length < 12 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
        int offset = 12;
        while (offset + 8 <= bytes.length) {
            long length = u32le(bytes, offset + 4);
            if (length > Integer.MAX_VALUE || offset + 8L + length > bytes.length) {
                throw metadataError("Invalid WebP chunk length");
            }
            int data = offset + 8;
            if (ascii(bytes, offset, "EXIF")) {
                int start = data;
                if (length >= 6 && ascii(bytes, start, "Exif\0\0")) start += 6;
                return copyRange(bytes, start, data + (int) length);
            }
            offset = data + (int) length + ((int) length & 1);
        }
        return null;
    }

    private static int parseTiffOrientation(byte[] tiff) {
        if (tiff.length < 8) throw metadataError("Truncated EXIF TIFF header");
        boolean little;
        if (u8(tiff, 0) == 'I' && u8(tiff, 1) == 'I') little = true;
        else if (u8(tiff, 0) == 'M' && u8(tiff, 1) == 'M') little = false;
        else throw metadataError("Unknown EXIF byte order");
        if (u16(tiff, 2, little) != 42) throw metadataError("Invalid EXIF TIFF signature");
        long ifd = u32(tiff, 4, little);
        if (ifd + 2 > tiff.length) throw metadataError("EXIF IFD offset is out of bounds");
        int count = u16(tiff, (int) ifd, little);
        if (ifd + 2L + count * 12L > tiff.length) throw metadataError("EXIF IFD entries are truncated");
        for (int index = 0; index < count; index++) {
            int entry = (int) ifd + 2 + index * 12;
            if (u16(tiff, entry, little) != 0x0112) continue;
            if (u16(tiff, entry + 2, little) != 3 || u32(tiff, entry + 4, little) != 1) {
                throw metadataError("EXIF orientation has an unsupported representation");
            }
            int orientation = u16(tiff, entry + 8, little);
            if (orientation < 1 || orientation > 8) throw metadataError("EXIF orientation is out of range");
            return orientation;
        }
        return 1;
    }

    private static int u8(byte[] bytes, int offset) { return bytes[offset] & 0xFF; }
    private static long u32be(byte[] bytes, int offset) {
        return ((long) u8(bytes, offset) << 24) | ((long) u8(bytes, offset + 1) << 16)
                | ((long) u8(bytes, offset + 2) << 8) | u8(bytes, offset + 3);
    }
    private static long u32le(byte[] bytes, int offset) {
        return u8(bytes, offset) | ((long) u8(bytes, offset + 1) << 8)
                | ((long) u8(bytes, offset + 2) << 16) | ((long) u8(bytes, offset + 3) << 24);
    }
    private static long u32(byte[] bytes, int offset, boolean little) {
        return little ? u32le(bytes, offset) : u32be(bytes, offset);
    }
    private static int u16(byte[] bytes, int offset, boolean little) {
        return little ? u8(bytes, offset) | (u8(bytes, offset + 1) << 8)
                : (u8(bytes, offset) << 8) | u8(bytes, offset + 1);
    }
    private static boolean ascii(byte[] bytes, int offset, String value) {
        if (offset < 0 || offset + value.length() > bytes.length) return false;
        for (int i = 0; i < value.length(); i++) if (u8(bytes, offset + i) != value.charAt(i)) return false;
        return true;
    }
    private static byte[] copyRange(byte[] bytes, int start, int end) {
        if (start < 0 || end < start || end > bytes.length) throw metadataError("EXIF payload is out of bounds");
        return java.util.Arrays.copyOfRange(bytes, start, end);
    }
    private static UnsupportedImageMetadataException metadataError(String message) {
        return new UnsupportedImageMetadataException(message);
    }

    public static final class UnsupportedImageMetadataException extends RuntimeException {
        public UnsupportedImageMetadataException(String message) { super(message); }
    }
}
