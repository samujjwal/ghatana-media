package com.ghatana.tts.grpc;

import java.util.Objects;
import java.util.Set;

/**
 * Trusted source-controlled admission for one exact TTS model and default voice profile.
 * Candidate configuration is untrusted metadata; an implementation must independently resolve
 * source authority, rights, license, resource profile, and qualification for the exact digests.
 */
@FunctionalInterface
interface TtsProviderAdmission {
    enum Capability { SYNTHESIS, PCM_STREAMING }

    record Candidate(
            String providerMode,
            String modelId,
            String modelVersion,
            String modelDigest,
            String voiceSidecarDigest,
            String modelLicenseReference,
            String language,
            String region,
            String retention,
            String hardwareProfile,
            String defaultVoiceId) {}

    /** A decision is effective only with a trusted authority reference and explicit capabilities. */
    record Decision(Set<Capability> capabilities, String authorityReference, String reason) {
        public Decision {
            capabilities = Set.copyOf(Objects.requireNonNull(capabilities, "capabilities"));
            authorityReference = normalize(authorityReference);
            reason = normalize(reason);
        }

        boolean admitted() {
            return !capabilities.isEmpty() && authorityReference != null;
        }

        boolean allows(Capability capability) {
            return admitted() && capabilities.contains(capability);
        }

        private static String normalize(String value) {
            return value == null || value.isBlank() ? null : value.trim();
        }
    }

    Decision resolve(Candidate candidate);

    /** No trusted provider/model/voice admission resolver is currently wired in Media. */
    static TtsProviderAdmission unavailable() {
        return candidate -> new Decision(Set.of(), null,
                "no source-authoritative TTS provider and voice admission resolver is configured");
    }
}
