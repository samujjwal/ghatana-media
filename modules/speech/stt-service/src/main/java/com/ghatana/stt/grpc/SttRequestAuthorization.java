package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;

import java.util.Objects;

/**
 * Trusted per-request rights and ownership decision for STT effects.
 * Implementations must resolve {@code resourceId} as an untrusted lookup key and bind its
 * canonical owner, tenant, rights, purpose, and current revocation state to the supplied
 * interceptor-verified identity. Caller-provided tenant and consent fields are never inputs.
 */
@FunctionalInterface
interface SttRequestAuthorization {
    enum Operation {
        TRANSCRIBE, STREAM_TRANSCRIBE, LOAD_MODEL, UNLOAD_MODEL, LIST_MODELS, READ_STATUS,
        ADAPT_MODEL, SUBMIT_CORRECTION,
        CREATE_SPEAKER_IDENTITY, READ_SPEAKER_IDENTITY, UPDATE_SPEAKER_IDENTITY
    }
    enum Decision { ADMITTED, DENIED, REVOKED, UNAVAILABLE }

    record Request(JwtServerInterceptor.VerifiedIdentity identity, Operation operation,
                   String resourceId, String sourceSha256) {
        public Request {
            Objects.requireNonNull(identity, "identity");
            Objects.requireNonNull(operation, "operation");
            resourceId = resourceId == null || resourceId.isBlank() ? null : resourceId;
            if (sourceSha256 != null && !sourceSha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("sourceSha256 must be a lowercase SHA-256 digest");
            }
        }

        Request(JwtServerInterceptor.VerifiedIdentity identity, Operation operation, String resourceId) {
            this(identity, operation, resourceId, null);
        }
    }

    Decision authorize(Request request);

    /** Fail-closed authorization when no production rights/ownership authority is installed. */
    static SttRequestAuthorization unavailable() {
        return request -> Decision.UNAVAILABLE;
    }
}
