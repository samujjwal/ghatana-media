package com.ghatana.tts.grpc;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

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
}
