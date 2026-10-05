package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Verifies runtime profile typos and disabled production composition fail closed. */
class MediaRuntimeConfigValidationTest {

    @Test
    void unknownProfileCannotSilentlyDowngradeProductionPosture() {
        Map<String, String> environment = localEnvironment();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "prodution");
        assertThatThrownBy(() -> MediaRuntimeConfig.fromEnvironment(environment))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported Media Runtime profile");
    }

    @Test
    void productionLikeRuntimeCannotBeDisabled() {
        Map<String, String> environment = localEnvironment();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "production");
        environment.put("MEDIA_RUNTIME_ENABLED", "false");
        environment.put("MEDIA_LOCAL_STORES_ENABLED", "false");
        environment.put("MEDIA_LOCAL_PROVIDER_ENABLED", "false");
        environment.put("MEDIA_ARTIFACT_STORE_ID", "object-store");
        environment.put("MEDIA_JOB_STORE_ID", "durable-job-store");

        assertThatThrownBy(() -> MediaRuntimeConfig.fromEnvironment(environment))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("cannot be disabled");
    }

    private static Map<String, String> localEnvironment() {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENABLED", "true");
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "local");
        environment.put("MEDIA_LOCAL_STORES_ENABLED", "true");
        environment.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        return environment;
    }
}
