package com.ghatana.media.provider.aws;

import java.util.Map;

/**
 * Test bridge exposing {@link MediaAwsPostgresqlRuntimeState#installForTesting} to
 * launcher-level end-to-end tests that live outside the provider package's module.
 * The runtime's ServiceLoader-discovered stores acquire this shared state, so the
 * installed environment is the same wiring a deployed {@code MediaRuntime.compose}
 * would resolve from process environment.
 */
public final class TestAwsStateInstall {

    private TestAwsStateInstall() { }

    public static AutoCloseable install(Map<String, String> environment) {
        return MediaAwsPostgresqlRuntimeState.installForTesting(environment);
    }
}
