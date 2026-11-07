package com.ghatana.audio.video.common.platform;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class AuthGatewayClientTest {

    @Test
    void parsesEscapedFieldsFromOneWellFormedValidationObject() {
        byte[] response = "{\"valid\":true,\"userId\":\"user\\\"-1\",\"email\":\"a\\\\b@example.test\",\"tenantId\":\"tenant-1\"}"
                .getBytes(StandardCharsets.UTF_8);

        assertThat(AuthGatewayClient.parseValidationResponse(response))
                .isEqualTo(new AuthGatewayClient.ValidationResult(
                        true, "user\"-1", "a\\b@example.test", "tenant-1"));
    }

    @Test
    void rejectsMalformedDuplicateAndTrailingValidationData() {
        assertThat(parse("{\"valid\":truex,\"tenantId\":\"tenant-1\"}")).isEqualTo(invalid());
        assertThat(parse("{\"valid\":false,\"valid\":true,\"tenantId\":\"tenant-1\"}")).isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"tenantId\":\"tenant-1\"} false")).isEqualTo(invalid());
    }

    @Test
    void rejectsInvalidOrMissingTenantValidation() {
        assertThat(parse("{\"valid\":false,\"tenantId\":\"tenant-1\"}")).isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"tenantId\":\" \"}")).isEqualTo(invalid());
        assertThat(parse("{\"valid\":true}")).isEqualTo(invalid());
    }

    @Test
    void rejectsValidResponseWithoutUsablePrincipal() {
        assertThat(parse("{\"valid\":true,\"tenantId\":\"tenant-1\"}")).isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"userId\":7,\"tenantId\":\"tenant-1\"}"))
                .isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"userId\":\" \",\"tenantId\":\"tenant-1\"}"))
                .isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"userId\":\"platform\",\"tenantId\":\"tenant-1\"}"))
                .isEqualTo(invalid());
        assertThat(parse("{\"valid\":true,\"userId\":\" Unknown \",\"tenantId\":\"tenant-1\"}"))
                .isEqualTo(invalid());
    }

    @Test
    void rejectsValidationResponseAboveBoundedSize() {
        byte[] oversized = new byte[16 * 1024 + 1];
        assertThat(AuthGatewayClient.parseValidationResponse(oversized)).isEqualTo(invalid());
    }

    private static AuthGatewayClient.ValidationResult parse(String json) {
        return AuthGatewayClient.parseValidationResponse(json.getBytes(StandardCharsets.UTF_8));
    }

    private static AuthGatewayClient.ValidationResult invalid() {
        return new AuthGatewayClient.ValidationResult(false, null, null, null);
    }
}
