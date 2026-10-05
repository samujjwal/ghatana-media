package com.ghatana.stt.grpc;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Proves STT delegates transport configuration to the shared fail-closed Media policy. */
class SttGrpcServerTransportSecurityTest {

    @Test
    void localProfileMayUseExplicitPlaintextDefault() {
        var security = SttGrpcServer.transportSecurity(Map.of("STT_ENVIRONMENT", "local"));
        assertThat(security.tlsEnabled()).isFalse();
    }

    @Test
    void productionLikeProfileRequiresTlsMaterial() {
        for (String profile : new String[] {"production", "staging", "sovereign"}) {
            assertThatThrownBy(() -> SttGrpcServer.transportSecurity(Map.of(
                            "STT_ENVIRONMENT", profile)))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Production-like STT gRPC requires TLS");
        }
    }

    @Test
    void partialTlsConfigurationIsRejectedInEveryProfile() {
        assertThatThrownBy(() -> SttGrpcServer.transportSecurity(Map.of(
                        "STT_ENVIRONMENT", "local",
                        "STT_GRPC_TLS_CERT_CHAIN_PATH", "/tmp/cert.pem")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("configured together");
    }

    @Test
    void completeTlsConfigurationSelectsTlsTransport() {
        var security = SttGrpcServer.transportSecurity(Map.of(
                "STT_ENVIRONMENT", "production",
                "STT_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/stt-cert.pem",
                "STT_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/stt-key.pem"));

        assertThat(security.tlsEnabled()).isTrue();
        assertThat(security.certificateChain().toString()).endsWith("stt-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("stt-key.pem");
    }
}
