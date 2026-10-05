package com.ghatana.audio.video.multimodal.adapter;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Verifies STT gRPC transport security is explicit and fail closed. */
class SttGrpcTransportSecurityTest {

    @Test
    void localPlaintextMustBeExplicit() {
        SttGrpcTransportSecurity security = SttGrpcTransportSecurity.fromEnvironment(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "STT_GRPC_TRANSPORT_MODE", "plaintext"));

        assertThat(security.mode()).isEqualTo(SttGrpcTransportSecurity.Mode.PLAINTEXT);
        assertThat(security.profile()).isEqualTo(SttGrpcTransportSecurity.Profile.LOCAL);
    }

    @Test
    void productionRejectsPlaintextBeforeChannelConstruction() {
        assertThatThrownBy(() -> SttGrpcTransportSecurity.fromEnvironment(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "production",
                "STT_GRPC_TRANSPORT_MODE", "plaintext")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Plaintext");
    }

    @Test
    void productionTlsRequiresExplicitTrustMaterial() {
        assertThatThrownBy(() -> SttGrpcTransportSecurity.fromEnvironment(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "production",
                "STT_GRPC_TRANSPORT_MODE", "tls")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_GRPC_TRUST_CERT_PATH");
    }

    @Test
    void mtlsRequiresAllCertificateReferences() {
        assertThatThrownBy(() -> SttGrpcTransportSecurity.fromEnvironment(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "STT_GRPC_TRANSPORT_MODE", "mtls")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mTLS requires");
    }

    @Test
    void unknownProfileFailsClosed() {
        assertThatThrownBy(() -> SttGrpcTransportSecurity.fromEnvironment(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "prodution",
                "STT_GRPC_TRANSPORT_MODE", "tls")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("profile");
    }

    @Test
    void localFactoryIsPlaintextAndTestScoped() {
        SttGrpcTransportSecurity security = SttGrpcTransportSecurity.localPlaintext();
        assertThat(security.mode()).isEqualTo(SttGrpcTransportSecurity.Mode.PLAINTEXT);
        assertThat(security.profile()).isEqualTo(SttGrpcTransportSecurity.Profile.TEST);
    }
}
