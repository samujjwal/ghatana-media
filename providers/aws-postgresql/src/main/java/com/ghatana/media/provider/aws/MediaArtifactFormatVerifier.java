package com.ghatana.media.provider.aws;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;

/**
 * Small signature consistency check for common uploaded media formats.
 *
 * <p>This is not a parser or malware scanner. Unknown formats remain explicitly unrecognized;
 * this check only rejects a known extension/content-type claim when the bytes contradict it.</p>
 */
public final class MediaArtifactFormatVerifier {
    static final String POLICY_VERSION = "media-signature-consistency-v1";

    private static final Map<String, String> EXTENSION_FORMATS = Map.ofEntries(
            Map.entry("png", "png"), Map.entry("jpg", "jpeg"), Map.entry("jpeg", "jpeg"),
            Map.entry("gif", "gif"), Map.entry("webp", "webp"),
            Map.entry("mp4", "iso-bmff"), Map.entry("m4v", "iso-bmff"),
            Map.entry("mov", "iso-bmff"), Map.entry("m4a", "iso-bmff"),
            Map.entry("webm", "webm"), Map.entry("mkv", "webm"),
            Map.entry("ogg", "ogg"), Map.entry("ogv", "ogg"),
            Map.entry("mp3", "mp3"), Map.entry("wav", "wav"), Map.entry("pdf", "pdf"));
    private static final Map<String, String> CONTENT_TYPE_FORMATS = Map.ofEntries(
            Map.entry("image/png", "png"), Map.entry("image/jpeg", "jpeg"),
            Map.entry("image/gif", "gif"), Map.entry("image/webp", "webp"),
            Map.entry("video/mp4", "iso-bmff"), Map.entry("audio/mp4", "iso-bmff"),
            Map.entry("video/quicktime", "iso-bmff"),
            Map.entry("video/webm", "webm"), Map.entry("audio/webm", "webm"),
            Map.entry("audio/ogg", "ogg"), Map.entry("video/ogg", "ogg"),
            Map.entry("audio/mpeg", "mp3"), Map.entry("audio/wav", "wav"),
            Map.entry("audio/x-wav", "wav"), Map.entry("application/pdf", "pdf"));

    private MediaArtifactFormatVerifier() { }

    /** Direct MIME/signature check used by the development quarantine scanner. */
    public static boolean matches(String declaredContentType, byte[] bytes) {
        if (declaredContentType == null || bytes == null || bytes.length == 0) return false;
        String type = normalizeContentType(declaredContentType);
        return switch (type) {
            case "application/octet-stream" -> true;
            case "text/plain" -> validUtf8Text(bytes);
            case "audio/wav", "audio/wave", "audio/x-wav" -> ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE");
            case "audio/mpeg", "audio/mp3" -> ascii(bytes, 0, "ID3") || isMpegAudioFrame(bytes);
            case "audio/ogg", "video/ogg" -> ascii(bytes, 0, "OggS");
            case "audio/flac" -> ascii(bytes, 0, "fLaC");
            case "video/mp4", "audio/mp4", "application/mp4" -> ascii(bytes, 4, "ftyp");
            case "video/webm", "audio/webm" -> starts(bytes, new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3});
            case "image/png" -> starts(bytes, new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10});
            case "image/jpeg", "image/jpg" -> starts(bytes, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff});
            case "image/gif" -> ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a");
            case "image/webp" -> ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
            default -> false;
        };
    }

    private static boolean validUtf8Text(byte[] bytes) {
        try {
            StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(bytes));
            for (byte value : bytes) if (value == 0) return false;
            return true;
        } catch (java.nio.charset.CharacterCodingException invalid) {
            return false;
        }
    }

    static Verification verify(String fileName, String contentType, byte[] prefix) {
        String extensionClaim = extensionFormat(fileName);
        String contentTypeClaim = CONTENT_TYPE_FORMATS.get(normalizeContentType(contentType));
        String detected = detect(prefix);
        if (extensionClaim != null && contentTypeClaim != null && !extensionClaim.equals(contentTypeClaim)) {
            return new Verification("SIGNATURE_MISMATCH", detected, "extension and content-type claims conflict");
        }
        String claimed = contentTypeClaim != null ? contentTypeClaim : extensionClaim;
        if (claimed == null) {
            return new Verification("SIGNATURE_UNRECOGNIZED", detected, "no supported format claim to verify");
        }
        if (!claimed.equals(detected)) {
            return new Verification("SIGNATURE_MISMATCH", detected, "bytes do not match claimed format");
        }
        return new Verification("SIGNATURE_MATCH", detected, "known signature matches format claim");
    }

    private static String extensionFormat(String fileName) {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return null;
        return EXTENSION_FORMATS.get(fileName.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    private static String normalizeContentType(String value) {
        int parameters = value.indexOf(';');
        return (parameters < 0 ? value : value.substring(0, parameters)).trim().toLowerCase(Locale.ROOT);
    }

    private static String detect(byte[] bytes) {
        if (starts(bytes, new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10})) return "png";
        if (starts(bytes, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff})) return "jpeg";
        if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "gif";
        if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
        if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "wav";
        if (ascii(bytes, 0, "OggS")) return "ogg";
        if (starts(bytes, new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3})) return "webm";
        if (ascii(bytes, 0, "%PDF-")) return "pdf";
        if (ascii(bytes, 0, "ID3") || isMpegAudioFrame(bytes)) return "mp3";
        if (bytes.length >= 8 && ascii(bytes, 4, "ftyp")) return "iso-bmff";
        return "unknown";
    }

    private static boolean isMpegAudioFrame(byte[] bytes) {
        return bytes.length >= 2
                && (bytes[0] & 0xff) == 0xff
                && (bytes[1] & 0xe0) == 0xe0;
    }

    private static boolean starts(byte[] bytes, byte[] prefix) {
        if (bytes.length < prefix.length) return false;
        for (int i = 0; i < prefix.length; i++) if (bytes[i] != prefix[i]) return false;
        return true;
    }

    private static boolean ascii(byte[] bytes, int offset, String expected) {
        byte[] encoded = expected.getBytes(StandardCharsets.US_ASCII);
        if (bytes.length < offset + encoded.length) return false;
        for (int i = 0; i < encoded.length; i++) if (bytes[offset + i] != encoded[i]) return false;
        return true;
    }

    record Verification(String state, String detectedFormat, String detail) { }
}
