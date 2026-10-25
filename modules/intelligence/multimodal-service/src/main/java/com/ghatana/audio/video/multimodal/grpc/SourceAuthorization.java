package com.ghatana.audio.video.multimodal.grpc;

import java.util.Set;
import java.util.UUID;

/** Trusted source-rights seam. Caller consent strings are deliberately not an input. */
@FunctionalInterface
interface SourceAuthorization {
    Decision authorize(AuthorizationRequest request);

    static SourceAuthorization unavailable() {
        return request -> Decision.NOT_ADMITTED;
    }

    enum Decision { ADMITTED, NOT_ADMITTED }
    enum Modality { AUDIO, IMAGE, VIDEO, TEXT }

    record AuthorizationRequest(String tenantId, UUID principalId, Set<Modality> modalities,
                                String artifactId, String artifactVersion, String purpose,
                                String consentReference, long contentBytes) {
        public AuthorizationRequest {
            modalities = Set.copyOf(modalities);
        }
    }
}
