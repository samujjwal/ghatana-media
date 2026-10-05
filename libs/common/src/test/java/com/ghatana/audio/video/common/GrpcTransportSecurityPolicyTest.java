package com.ghatana.audio.video.common;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Proves one fail-closed TLS policy is shared by every standalone Media gRPC service. */
class GrpcTransportSecurityPolicyTest {

    @Test
    void localWithoutTlsMaterialUsesPlaintext() {
        var security = GrpcTransportSecurityPolicy.resolve(
                Map.of("MEDIA_ENVIRONMENT", "local"), "TTS");
        assertThat(security.tlsEnabled()).isFalse();
    }

    @Test
    void productionLikeProfilesRequireCompleteTlsPair() {
        for (String profile : new String[] {"production", "staging", "sovereign"}) {
            assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(
                            Map.of("GHATANA_DEPLOYMENT_PROFILE", profile), "VISION"))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Production-like VISION gRPC requires TLS");
        }
    }

    @Test
    void sharedMediaTlsPairCanSecureEveryService() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "MEDIA_ENVIRONMENT", "production",
                "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem"), "MULTIMODAL");

        assertThat(security.tlsEnabled()).isTrue();
        assertThat(security.certificateChain().toString()).endsWith("media-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("media-key.pem");
    }

    @Test
    void serviceSpecificPairOverridesSharedPair() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "MEDIA_ENVIRONMENT", "production",
                "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                "TTS_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/tts-cert.pem",
                "TTS_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/tts-key.pem"), "TTS");

        assertThat(security.certificateChain().toString()).endsWith("tts-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("tts-key.pem");
    }

    @Test
    void partialServicePairCannotBorrowFromSharedPair() {
        assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(
                        "MEDIA_ENVIRONMENT", "production",
                        "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                        "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                        "TTS_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/tts-cert.pem"), "TTS"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("TTS_GRPC_TLS_CERT_CHAIN_PATH")
                .hasMessageContaining("TTS_GRPC_TLS_PRIVATE_KEY_PATH");
    }

    @Test
    void serviceProfileOverridesSharedAndDeploymentProfiles() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "GHATANA_DEPLOYMENT_PROFILE", "production",
                "MEDIA_ENVIRONMENT", "staging",
                "STT_ENVIRONMENT", "local"), "STT");
        assertThat(security.tlsEnabled()).isFalse();
    }

    @Test
    void invalidPrefixIsRejected() {
        assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(), "bad-prefix"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("servicePrefix");
    }
}
