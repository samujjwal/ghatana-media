package com.ghatana.audio.video.multimodal.grpc;

import java.util.Set;
import java.util.UUID;
import java.util.List;

/** Trusted source-rights seam. Caller consent strings are deliberately not an input. */
@FunctionalInterface
interface SourceAuthorization {
    Decision authorize(AuthorizationRequest request);

    static SourceAuthorization unavailable() {
        return request -> Decision.NOT_ADMITTED;
    }

    enum Decision { ADMITTED, DENIED, NOT_ADMITTED }
    enum Modality { AUDIO, IMAGE, VIDEO, TEXT }

    record AuthorizationRequest(String tenantId, UUID principalId, Set<Modality> modalities,
                                String capabilityRef, String operationRef, int operationVersion,
                                String requestId, String artifactId, String artifactVersion,
                                String purpose, String correlationId, List<String> dimensions,
                                String consentReference,
                                long contentBytes, String contentSha256) {
        public AuthorizationRequest {
            modalities = Set.copyOf(modalities);
            dimensions = List.copyOf(dimensions);
            if (contentBytes < 0 || contentSha256 == null || !contentSha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("Authorization requires bounded content size and SHA-256 digest");
            }
        }
    }
}
