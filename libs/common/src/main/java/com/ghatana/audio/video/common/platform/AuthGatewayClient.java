package com.ghatana.audio.video.common.platform;

import tools.jackson.core.JsonParser;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
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
    private static final int MAX_VALIDATION_RESPONSE_BYTES = 16 * 1024;
    private static final JsonFactory JSON_FACTORY = JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build();
    private static final ObjectMapper JSON_MAPPER = new ObjectMapper(JSON_FACTORY);

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

            HttpResponse<InputStream> response = http.send(request,
                    HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream body = response.body()) {
                if (response.statusCode() != 200) {
                    LOG.debug("AuthGateway rejected token: HTTP {}", response.statusCode());
                    return ValidationResult.INVALID;
                }
                byte[] responseBytes = body.readNBytes(MAX_VALIDATION_RESPONSE_BYTES + 1);
                if (responseBytes.length > MAX_VALIDATION_RESPONSE_BYTES) {
                    LOG.debug("AuthGateway validation response exceeded its byte limit");
                    return ValidationResult.INVALID;
                }
                return parseValidationResponse(responseBytes);
            }

        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            LOG.warn("AuthGateway call failed: {}", e.getMessage());
            return ValidationResult.INVALID;
        }
    }

    // -------------------------------------------------------------------------
    // Strictly parse the bounded response using the module's existing Jackson dependency.
    // -------------------------------------------------------------------------

    /**
     * Parses a minimal {@code {valid, userId, email, tenantId}} JSON payload.
     * Expected format: {@code {"valid":true,"userId":"u1","email":"a@b.com","tenantId":"t1"}}
     */
    static ValidationResult parseValidationResponse(byte[] json) {
        if (json == null || json.length == 0 || json.length > MAX_VALIDATION_RESPONSE_BYTES) {
            return ValidationResult.INVALID;
        }
        try (JsonParser parser = JSON_FACTORY.createParser(json)) {
            JsonNode root = JSON_MAPPER.readTree(parser);
            if (root == null || !root.isObject() || parser.nextToken() != null) {
                return ValidationResult.INVALID;
            }
            JsonNode validNode = root.get("valid");
            JsonNode tenantNode = root.get("tenantId");
            if (validNode == null || !validNode.isBoolean() || !validNode.booleanValue()
                    || tenantNode == null || !tenantNode.isTextual()) {
                return ValidationResult.INVALID;
            }
            String userId = textField(root.get("userId"));
            String email = textField(root.get("email"));
            String tenantId = tenantNode.textValue();
            return !isUsableSubject(userId) || tenantId.isBlank()
                    ? ValidationResult.INVALID
                    : new ValidationResult(true, userId, email, tenantId);
        } catch (RuntimeException malformed) {
            return ValidationResult.INVALID;
        }
    }

    private static boolean isUsableSubject(String subject) {
        if (subject == null || subject.isBlank()) {
            return false;
        }
        String normalized = subject.trim();
        return !normalized.equalsIgnoreCase("platform") && !normalized.equalsIgnoreCase("unknown");
    }

    private static String textField(JsonNode value) {
        return value != null && value.isTextual() ? value.textValue() : null;
    }
}
