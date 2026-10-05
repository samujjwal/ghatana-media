package com.ghatana.audio.video.common.platform;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Singleton HTTP client for the platform auth-gateway service.
 *
 * <p>When {@code AUTH_GATEWAY_URL} is set, this client provides a fallback
 * token validation path for platform-issued tokens (e.g. cross-service calls
 * that bypass the Audio-Video local JWT secret). If the environment variable
 * is absent the client returns a disabled singleton that always reports
 * {@link ValidationResult#INVALID}.
 *
 * <p>Usage:
 * <pre>{@code
 *   AuthGatewayClient client = AuthGatewayClient.getInstance();
 *   AuthGatewayClient.ValidationResult result = client.validate(bearerToken, tenantId);
 *   if (result.valid()) {
 *     String userId = result.userId();   // non-null when valid
 *   }
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose HTTP client for platform auth-gateway token validation
 * @doc.layer platform
 * @doc.pattern Singleton
 */
public final class AuthGatewayClient {

    private static final Logger LOG = LoggerFactory.getLogger(AuthGatewayClient.class);
    private static volatile AuthGatewayClient INSTANCE;

    /**
     * Result of a token validation call to the auth-gateway.
     *
     * @param valid  true if the token is accepted by the platform
     * @param userId authenticated subject, non-null when {@code valid == true}
     * @param email  email associated with the token, may be null
     * @param tenantId tenant returned by the gateway, non-null when valid
     */
    public record ValidationResult(boolean valid, String userId, String email, String tenantId) {
        /** Stateless invalid singleton to avoid repeated allocation. */
        static final ValidationResult INVALID = new ValidationResult(false, null, null, null);
    }

    private final String baseUrl;
    private final HttpClient http;
    private final boolean enabled;

    private AuthGatewayClient(String baseUrl) {
        this.baseUrl  = baseUrl;
        this.enabled  = baseUrl != null && !baseUrl.isBlank();
        this.http = enabled
                ? HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(3))
                        .build()
                : null;

        if (enabled) {
            LOG.info("AuthGatewayClient configured (base={})", baseUrl);
        } else {
            LOG.info("AuthGatewayClient disabled — AUTH_GATEWAY_URL not set");
        }
    }

    /**
     * Returns the process-wide singleton, initialised from {@code AUTH_GATEWAY_URL}.
     *
     * <p>Thread-safe via double-checked locking.
     */
    public static AuthGatewayClient getInstance() {
        if (INSTANCE == null) {
            synchronized (AuthGatewayClient.class) {
                if (INSTANCE == null) {
                    INSTANCE = new AuthGatewayClient(System.getenv("AUTH_GATEWAY_URL"));
                }
            }
        }
        return INSTANCE;
    }

    /** Returns {@code true} when the client is configured and can make real calls. */
    public boolean isEnabled() {
        return enabled;
    }

    /**
     * Validates a raw Bearer token string against the auth-gateway.
     *
     * <p>Sends {@code GET /api/v1/auth/validate} with the token in an Authorization header
     * and the tenant in {@code X-Tenant-ID}
     * and interprets the JSON response. Returns {@link ValidationResult#INVALID}
     * on any network or parse error so callers never see an exception from this
     * method.
     *
     * @param token the raw token (without "Bearer " prefix)
     * @param tenantId tenant scope asserted by the caller
     * @return validation outcome — never {@code null}
     */
    public ValidationResult validate(String token, String tenantId) {
        if (!enabled || token == null || token.isBlank() || tenantId == null || tenantId.isBlank()) {
            return ValidationResult.INVALID;
        }

        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/auth/validate"))
                    .header("Authorization", "Bearer " + token)
                    .header("X-Tenant-ID", tenantId)
                    .header("Accept", "application/json")
                    .timeout(Duration.ofSeconds(3))
                    .GET()
                    .build();

            HttpResponse<String> response = http.send(request,
                    HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                LOG.debug("AuthGateway rejected token: HTTP {}", response.statusCode());
                return ValidationResult.INVALID;
            }

            return parseValidationResponse(response.body());

        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            LOG.warn("AuthGateway call failed: {}", e.getMessage());
            return ValidationResult.INVALID;
        }
    }

    // -------------------------------------------------------------------------
    // Minimal JSON parser — avoids adding a JSON library dependency
    // -------------------------------------------------------------------------

    /**
     * Parses a minimal {@code {valid, userId, email, tenantId}} JSON payload.
     * Expected format: {@code {"valid":true,"userId":"u1","email":"a@b.com","tenantId":"t1"}}
     */
    private static ValidationResult parseValidationResponse(String json) {
        if (json == null || json.isBlank()) return ValidationResult.INVALID;

        boolean valid  = extractBool(json, "valid");
        String userId  = extractString(json, "userId");
        String email   = extractString(json, "email");
        String tenantId = extractString(json, "tenantId");

        return valid && tenantId != null ? new ValidationResult(true, userId, email, tenantId) : ValidationResult.INVALID;
    }

    private static boolean extractBool(String json, String key) {
        String pattern = "\"" + key + "\"";
        int idx = json.indexOf(pattern);
        if (idx < 0) return false;
        String rest = json.substring(idx + pattern.length()).stripLeading();
        if (!rest.startsWith(":")) return false;
        rest = rest.substring(1).stripLeading();
        return rest.startsWith("true");
    }

    private static String extractString(String json, String key) {
        String pattern = "\"" + key + "\":\"";
        int start = json.indexOf(pattern);
        if (start < 0) return null;
        start += pattern.length();
        int end = json.indexOf('"', start);
        if (end < 0) return null;
        return json.substring(start, end);
    }
}
