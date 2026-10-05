package com.ghatana.media.launcher;

import com.ghatana.launcher.errorcode.ErrorCode;

import java.util.Set;

/**
 * Canonical error codes for the Media runtime service.
 *
 * @doc.type enum
 * @doc.purpose Categorized error codes for consistent API error responses
 * @doc.layer service
 * @doc.pattern ErrorCode
 */
public enum MediaErrorCode implements ErrorCode {
    ARTIFACT_NOT_FOUND("MEDIA_001", "Media artifact not found", "artifact"),
    PROCESSING_FAILED("MEDIA_002", "Media processing failed", "processing"),
    STT_FAILED("MEDIA_003", "Speech-to-text failed", "stt"),
    TTS_FAILED("MEDIA_004", "Text-to-speech failed", "tts"),
    VISION_FAILED("MEDIA_005", "Vision processing failed", "vision"),
    TRANSCODE_FAILED("MEDIA_006", "Transcoding failed", "transcode"),
    TENANT_ISOLATION_VIOLATION("MEDIA_007", "Tenant isolation violation detected", "security"),
    UNAUTHENTICATED("MEDIA_008", "Authentication required", "security"),
    PERMISSION_DENIED("MEDIA_009", "Permission denied", "security"),
    RATE_LIMITED("MEDIA_010", "Rate limit exceeded", "throttle"),
    INTERNAL_ERROR("MEDIA_500", "Internal server error", "system");

    private static Set<String> validCategories() { return Set.of(
            "artifact", "processing", "stt", "tts", "vision", "transcode", "security", "throttle", "system"); }

    private final String code;
    private final String message;
    private final String category;

    MediaErrorCode(String code, String message, String category) {
        ErrorCode.validateCategory(category, validCategories());
        this.code = code;
        this.message = message;
        this.category = category;
    }

    @Override
    public String code() { return code; }

    @Override
    public String message() { return message; }

    @Override
    public String category() { return category; }
}
