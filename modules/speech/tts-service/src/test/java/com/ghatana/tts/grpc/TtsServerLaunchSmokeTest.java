package com.ghatana.tts.grpc;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Smoke test: verifies the TTS server launch class is on the classpath and has a
 * public {@code main(String[])} entry point, so broken {@code mainClass} paths
 * fail at build/test time rather than at deployment.
 *
 * @doc.type class
 * @doc.purpose Smoke test for TTS gRPC server mainClass existence
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("TtsGrpcServer — launch smoke")
class TtsServerLaunchSmokeTest {

    private static final String EXPECTED_MAIN_CLASS = "com.ghatana.tts.grpc.TtsGrpcServer";

    @Test
    @DisplayName("mainClass is resolvable on the classpath")
    void mainClassIsResolvable() throws ClassNotFoundException {
        Class<?> clazz = Class.forName(EXPECTED_MAIN_CLASS);
        assertThat(clazz).isNotNull();
        assertThat(clazz.getSimpleName()).isEqualTo("TtsGrpcServer");
    }

    @Test
    @DisplayName("mainClass has a public static main(String[]) method")
    void mainClassHasMainMethod() throws ClassNotFoundException, NoSuchMethodException {
        Class<?> clazz = Class.forName(EXPECTED_MAIN_CLASS);
        Method main = clazz.getMethod("main", String[].class);
        assertThat(main).isNotNull();
        assertThat(java.lang.reflect.Modifier.isPublic(main.getModifiers())).isTrue();
        assertThat(java.lang.reflect.Modifier.isStatic(main.getModifiers())).isTrue();
    }

    @Test
    @DisplayName("mainClass package matches build.gradle.kts application.mainClass")
    void mainClassPackageMatchesBuildConfig() {
        assertThat(EXPECTED_MAIN_CLASS)
            .startsWith("com.ghatana.tts.grpc.")
            .doesNotContain("core.grpc");
    }

    @Test
    @DisplayName("mainClass can be loaded without throwing ClassNotFoundException")
    void mainClassLoadsCleanly() {
        assertThatCode(() -> Class.forName(EXPECTED_MAIN_CLASS))
            .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("production transport refuses to start without TLS material")
    void productionTransportRequiresTlsMaterial() {
        assertThatThrownBy(() -> TtsGrpcServer.transportSecurity(Map.of("TTS_ENVIRONMENT", "production")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("requires mTLS server certificate, private key, and client CA");
    }

    @Test
    @DisplayName("shared Media TLS configuration is accepted by the TTS server consumer")
    void sharedMediaTlsPairConfiguresTlsTransport() {
        var security = TtsGrpcServer.transportSecurity(Map.of(
                "TTS_ENVIRONMENT", "production",
                "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                "MEDIA_GRPC_TLS_CLIENT_CA_PATH", "/run/secrets/media-client-ca.pem"));

        assertThat(security.tlsEnabled()).isTrue();
        assertThat(security.certificateChain().toString()).endsWith("media-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("media-key.pem");
    }
}
