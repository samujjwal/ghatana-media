package com.ghatana.audio.video.integration;

import com.ghatana.servicecontracts.testing.OpenApiContractAssertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

@DisplayName("Media OpenAPI contract consumption")
class MediaOpenApiContractConsumptionTest {

    private static final String CONTRACT_PATH = "contracts/openapi/media.yaml";
    private static final Path ROUTE_MANIFEST_PATH = Path.of("config/route-manifest.json");

    @Test
    void consumesCanonicalOpenApiContract() {
        OpenApiContractAssertions.assertRuntimeMatchesContract(
                "media",
                CONTRACT_PATH,
                ROUTE_MANIFEST_PATH);
    }
}
