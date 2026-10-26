package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.Status;

import java.util.Objects;

/**
 * Trusted per-request owner and consent decision for a TTS voice, including the configured
 * default voice when the caller omits a selection.
 * Implementations resolve voice/profile IDs as untrusted lookup keys and must check current
 * owner, purpose, consent expiry, revocation, region, and retention. Caller consent fields are
 * deliberately excluded from this contract.
 */
@FunctionalInterface
interface TtsRequestAuthorization {
    enum Operation { SYNTHESIZE, STREAM_SYNTHESIZE }
    enum Decision { ADMITTED, DENIED, REVOKED, UNAVAILABLE }

    record Request(
            JwtServerInterceptor.VerifiedIdentity identity,
            Operation operation,
            String voiceId,
            String profileId) {
        public Request {
            Objects.requireNonNull(identity, "identity");
            Objects.requireNonNull(operation, "operation");
            voiceId = normalize(voiceId);
            profileId = normalize(profileId);
        }

        private static String normalize(String value) {
            return value == null || value.isBlank() ? null : value;
        }
    }

    Decision authorize(Request request);

    /** A production composition may select a configured voice even when the request omits one. */
    default String configuredDefaultVoiceId() { return null; }

    /** Whether an authoritative resolver is configured; true means calls can still be unavailable. */
    default boolean isConfigured() { return true; }

    /**
     * Whether the same live owner/consent authority snapshot used by {@link #authorize(Request)}
     * is currently available. This is service readiness only; it does not authorize any request.
     * Implementations must fail closed when snapshot freshness or resolver health is unknown.
     */
    default boolean isReady() { return false; }

    /** No source-authoritative voice ownership or consent resolver is currently wired. */
    static TtsRequestAuthorization unavailable() {
        return new TtsRequestAuthorization() {
            @Override public Decision authorize(Request request) { return Decision.UNAVAILABLE; }
            @Override public boolean isConfigured() { return false; }
        };
    }

    static void requireAdmission(
            TtsRequestAuthorization authorization,
            JwtServerInterceptor.VerifiedIdentity identity,
            Operation operation,
            String voiceId,
            String profileId) {
        Objects.requireNonNull(authorization, "authorization");
        String configuredDefaultVoiceId = authorization.configuredDefaultVoiceId();
        if (configuredDefaultVoiceId != null && configuredDefaultVoiceId.isBlank()) {
            configuredDefaultVoiceId = null;
        }
        String effectiveVoiceId = voiceId == null || voiceId.isBlank()
                ? configuredDefaultVoiceId : voiceId;
        boolean selected = effectiveVoiceId != null || profileId != null && !profileId.isBlank();
        if (!selected) {
            throw new AuthorizationException(Status.UNAVAILABLE,
                    "TTS_VOICE_SELECTION_NOT_ADMITTED: explicit voice/profile or configured default is required");
        }
        if (identity == null || identity.subject() == null || identity.subject().isBlank()
                || identity.tenantId() == null || identity.tenantId().isBlank()) {
            throw new AuthorizationException(Status.UNAUTHENTICATED,
                    "TTS_IDENTITY_REQUIRED: verified tenant and subject are required for synthesis");
        }
        if (!authorization.isConfigured()) {
            throw new AuthorizationException(Status.UNAVAILABLE,
                    "TTS_VOICE_AUTH_NOT_ADMITTED: owner, consent, purpose, and revocation authority is unavailable");
        }

        Decision decision;
        try {
            decision = authorization.authorize(new Request(identity, operation, effectiveVoiceId, profileId));
        } catch (RuntimeException unavailable) {
            decision = Decision.UNAVAILABLE;
        }
        if (decision == null) decision = Decision.UNAVAILABLE;
        switch (decision) {
            case ADMITTED -> { }
            case DENIED -> throw new AuthorizationException(Status.PERMISSION_DENIED,
                    "TTS_VOICE_AUTH_DENIED: selected voice is not authorized for this request");
            case REVOKED -> throw new AuthorizationException(Status.PERMISSION_DENIED,
                    "TTS_VOICE_AUTH_REVOKED: selected voice authorization is revoked or expired");
            case UNAVAILABLE -> throw new AuthorizationException(Status.UNAVAILABLE,
                    "TTS_VOICE_AUTH_NOT_ADMITTED: owner, consent, purpose, and revocation authority is unavailable");
        }
    }

    final class AuthorizationException extends RuntimeException {
        private final Status status;

        AuthorizationException(Status status, String description) {
            super(description);
            this.status = Objects.requireNonNull(status, "status").withDescription(description);
        }

        Status status() { return status; }
    }
}
