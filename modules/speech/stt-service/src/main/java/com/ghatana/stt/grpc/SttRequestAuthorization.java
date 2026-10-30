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

    record Request(JwtServerInterceptor.VerifiedIdentity identity, Operation operation, String resourceId) {
        public Request {
            Objects.requireNonNull(identity, "identity");
            Objects.requireNonNull(operation, "operation");
            resourceId = resourceId == null || resourceId.isBlank() ? null : resourceId;
        }
    }

    Decision authorize(Request request);

    /** Fail-closed authorization when no production rights/ownership authority is installed. */
    static SttRequestAuthorization unavailable() {
        return request -> Decision.UNAVAILABLE;
    }
}
