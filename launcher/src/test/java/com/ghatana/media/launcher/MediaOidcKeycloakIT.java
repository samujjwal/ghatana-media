package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaVerifiedIdentityContracts;
import com.sun.net.httpserver.HttpServer;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real-IdP integration: a self-hosted Keycloak (the pinned image used by {@code deploy/keycloak}) issues an access
 * token to a user created in this test, the launcher's security filter verifies it over standard OIDC, and the real
 * persisted runtime serves the routes. Forged, foreign and tampered tokens are refused.
 *
 * <p>Passwords are generated at runtime and never logged. No credential is committed.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaOidcKeycloakIT {
    private static final String KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.8.2";
    private static final String REALM = "ghatana-media";
    private static final String AUDIENCE = "ghatana-media";
    private static final String DIRECT_CLIENT = "media-it-direct";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();

    private static final String ADMIN_PASSWORD = randomSecret();

    @org.testcontainers.junit.jupiter.Container
    private static final GenericContainer<?> KEYCLOAK = new GenericContainer<>(DockerImageName.parse(KEYCLOAK_IMAGE))
            .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", "it-admin")
            .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", ADMIN_PASSWORD)
            .withCommand("start-dev", "--import-realm")
            .withCopyFileToContainer(
                    MountableFile.forHostPath(Path.of(System.getProperty("user.dir")).resolve(
                            "../deploy/keycloak/realm/ghatana-media-realm.json").normalize()),
                    "/opt/keycloak/data/import/ghatana-media-realm.json")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHttp("/realms/" + REALM).forPort(8080).forStatusCode(200)
                    .withStartupTimeout(Duration.ofMinutes(4)));

    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static String keycloakBase;
    private static String adminToken;
    private static String issuer;
    private static HttpServer server;
    private static MediaRuntime runtime;
    private static Path root;

    @BeforeAll
    static void startEverything() throws Exception {
        keycloakBase = "http://" + KEYCLOAK.getHost() + ":" + KEYCLOAK.getMappedPort(8080);
        issuer = keycloakBase + "/realms/" + REALM;
        adminToken = token("master", "admin-cli", "it-admin", ADMIN_PASSWORD, null);
        createDirectGrantClient(REALM);

        root = Files.createTempDirectory("media-oidc-it");
        runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 128, 1_024,
                        Duration.ofSeconds(2), 1, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                java.util.List.of(new NoEffectProvider()),
                java.util.List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));

        // Production-like filter profile: only OIDC tokens are accepted. The persisted runtime behind it is the
        // same real local runtime other launcher ITs use.
        Map<String, String> security = new HashMap<>();
        security.put("MEDIA_OIDC_ISSUER", issuer);
        security.put("MEDIA_OIDC_AUDIENCE", AUDIENCE);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(new MediaHttpHandler(runtime), "production", security,
                java.time.Clock.systemUTC()));
        server.start();
    }

    @AfterAll
    static void stopEverything() throws Exception {
        if (server != null) server.stop(0);
        if (runtime != null) runtime.close();
        if (root != null) {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    @Test
    void keycloakIssuedTokenIsAcceptedPersistsTheVerifiedPrincipalAndIsTenantIsolated() throws Exception {
        TestUser owner = createUser(REALM, "owner", "tenant-a", "media-operator");
        String ownerToken = token(REALM, DIRECT_CLIENT, owner.username, owner.password, null);
        JsonNode claims = claims(ownerToken);
        assertThat(claims.path("iss").asText()).isEqualTo(issuer);
        assertThat(claims.path("tenant_id").asText()).isEqualTo("tenant-a");
        String principal = MediaVerifiedIdentityContracts.oidcPrincipalId(issuer, claims.path("sub").asText());

        byte[] payload = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 9, 8, 7};
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(payload));
        String uploadBody = """
                {"tenantId":"tenant-a","principalId":"%s","fileName":"fixture.png","contentType":"image/png",
                 "expectedSizeBytes":%d,"expectedSha256":"%s","classification":"INTERNAL","retention":"P30D","metadata":{}}
                """.formatted(principal, payload.length, sha);
        HttpResponse<String> begin = call("POST", "/api/v1/artifacts/uploads", ownerToken, "oidc-upload",
                uploadBody.getBytes(StandardCharsets.UTF_8), "application/json");
        assertThat(begin.statusCode()).as("begin upload: %s", begin.body()).isEqualTo(201);
        String uploadId = JSON.readTree(begin.body()).get("uploadId").asText();
        assertThat(call("PUT", "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0", ownerToken, null, payload,
                "application/octet-stream").statusCode()).isEqualTo(200);
        HttpResponse<String> completed = call("POST", "/api/v1/artifacts/uploads/" + uploadId + "/complete",
                ownerToken, null, new byte[0], "application/json");
        assertThat(completed.statusCode()).as("complete: %s", completed.body()).isEqualTo(201);
        String artifactId = JSON.readTree(completed.body()).get("artifactId").asText();

        assertThat(call("GET", "/api/v1/artifacts/" + artifactId, ownerToken, null, null, null).statusCode())
                .isEqualTo(200);

        // The stored artifact is bound to the identity-provider principal and the tenant claim, not caller input.
        HttpResponse<String> readback = call("GET", "/api/v1/artifacts/" + artifactId, ownerToken, null, null, null);
        assertThat(JSON.readTree(readback.body()).path("principalId").asText()).isEqualTo(principal).startsWith("oidc:");
        assertThat(JSON.readTree(readback.body()).path("tenantId").asText()).isEqualTo("tenant-a");

        // A different Keycloak user in another tenant cannot see the artifact.
        TestUser other = createUser(REALM, "other", "tenant-b", "media-operator");
        String otherToken = token(REALM, DIRECT_CLIENT, other.username, other.password, null);
        assertThat(call("GET", "/api/v1/artifacts/" + artifactId, otherToken, null, null, null).statusCode())
                .isEqualTo(404);
    }

    @Test
    void usersWithoutMappedRolesAreForbiddenAndAnonymousOrApiKeyCallsAreRefused() throws Exception {
        TestUser unprivileged = createUser(REALM, "norole", "tenant-a");
        String token = token(REALM, DIRECT_CLIENT, unprivileged.username, unprivileged.password, null);
        assertThat(call("GET", "/api/v1/jobs", token, null, null, null).statusCode()).isEqualTo(403);

        HttpRequest anonymous = HttpRequest.newBuilder(URI.create(base() + "/api/v1/jobs"))
                .header("X-Tenant-Id", "tenant-a").GET().build();
        assertThat(HTTP.send(anonymous, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
        HttpRequest apiKey = HttpRequest.newBuilder(URI.create(base() + "/api/v1/jobs"))
                .header("X-Tenant-Id", "tenant-a").header("X-API-Key", "anything").GET().build();
        assertThat(HTTP.send(apiKey, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }

    @Test
    void forgedForeignAndTamperedTokensAreRefused() throws Exception {
        TestUser user = createUser(REALM, "victim", "tenant-a", "media-operator");
        String real = token(REALM, DIRECT_CLIENT, user.username, user.password, null);
        String[] parts = real.split("\\.");
        String realHeader = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
        String realKid = JSON.readTree(realHeader).path("kid").asText();

        // 1. Self-signed token that claims Keycloak's kid, issuer and audience.
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair attacker = generator.generateKeyPair();
        String forged = sign(attacker, realKid, claims(real).deepCopy());
        assertThat(call("GET", "/api/v1/jobs", forged, null, null, null).statusCode()).isEqualTo(401);

        // 2. Genuine token from a different realm (another issuer, its own signing keys).
        createRealm("foreign-idp");
        createDirectGrantClient("foreign-idp");
        TestUser foreign = createUser("foreign-idp", "foreigner", "tenant-a");
        String foreignToken = token("foreign-idp", DIRECT_CLIENT, foreign.username, foreign.password, null);
        assertThat(call("GET", "/api/v1/jobs", foreignToken, null, null, null).statusCode()).isEqualTo(401);

        // 3. Genuine token with a modified payload (tenant swap) keeps the old signature.
        ObjectNode tamperedClaims = (ObjectNode) claims(real).deepCopy();
        tamperedClaims.put("tenant_id", "tenant-b");
        String tampered = parts[0] + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(JSON.writeValueAsBytes(tamperedClaims)) + "." + parts[2];
        assertThat(call("GET", "/api/v1/jobs", tampered, null, null, null).statusCode()).isEqualTo(401);

        // 4. alg=none with a valid-looking payload.
        String none = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"alg\":\"none\",\"kid\":\"" + realKid + "\"}").getBytes(StandardCharsets.UTF_8))
                + "." + parts[1] + ".";
        assertThat(call("GET", "/api/v1/jobs", none, null, null, null).statusCode()).isEqualTo(401);

        // The untouched genuine token still works.
        assertThat(call("GET", "/api/v1/jobs", real, null, null, null).statusCode()).isEqualTo(200);
    }

    // ---- helpers ----

    private static String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private static HttpResponse<String> call(String method, String path, String token, String idempotencyKey,
                                             byte[] body, String contentType) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base() + path))
                .header("Authorization", "Bearer " + token)
                // Whatever the caller claims, the verified tenant claim wins.
                .header("X-Tenant-Id", "caller-chosen-tenant");
        if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
        if (contentType != null) builder.header("Content-Type", contentType);
        HttpRequest.BodyPublisher publisher = body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofByteArray(body);
        builder.method(method, publisher);
        return HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private record TestUser(String username, String password) { }

    private static String randomSecret() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String form(Map<String, String> fields) {
        StringBuilder out = new StringBuilder();
        fields.forEach((key, value) -> {
            if (!out.isEmpty()) out.append('&');
            out.append(URLEncoder.encode(key, StandardCharsets.UTF_8)).append('=')
                    .append(URLEncoder.encode(value, StandardCharsets.UTF_8));
        });
        return out.toString();
    }

    private static String token(String realm, String client, String username, String password, String scope)
            throws Exception {
        Map<String, String> fields = new HashMap<>();
        fields.put("grant_type", "password");
        fields.put("client_id", client);
        fields.put("username", username);
        fields.put("password", password);
        if (scope != null) fields.put("scope", scope);
        HttpResponse<String> response = HTTP.send(HttpRequest.newBuilder(
                        URI.create(keycloakBase + "/realms/" + realm + "/protocol/openid-connect/token"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form(fields))).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as("token endpoint status for realm %s", realm).isEqualTo(200);
        return JSON.readTree(response.body()).get("access_token").asText();
    }

    private static JsonNode claims(String token) throws Exception {
        return JSON.readTree(Base64.getUrlDecoder().decode(token.split("\\.")[1]));
    }

    private static String sign(KeyPair key, String kid, JsonNode claims) throws Exception {
        String header = Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("{\"alg\":\"RS256\",\"kid\":\"" + kid + "\"}").getBytes(StandardCharsets.UTF_8));
        String payload = Base64.getUrlEncoder().withoutPadding().encodeToString(JSON.writeValueAsBytes(claims));
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(key.getPrivate());
        signature.update((header + "." + payload).getBytes(StandardCharsets.US_ASCII));
        return header + "." + payload + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign());
    }

    private static HttpResponse<String> admin(String method, String path, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(keycloakBase + "/admin" + path))
                .header("Authorization", "Bearer " + adminToken).header("Content-Type", "application/json");
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body));
        return HTTP.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static void createRealm(String realm) throws Exception {
        HttpResponse<String> response = admin("POST", "/realms", "{\"realm\":\"" + realm + "\",\"enabled\":true}");
        assertThat(response.statusCode()).as("create realm: %s", response.body()).isIn(201, 409);
        // Let the second realm's administrator set the tenant attribute (unmanaged attributes, admin-editable).
        ObjectNode profile = (ObjectNode) JSON.readTree(admin("GET", "/realms/" + realm + "/users/profile", null).body());
        profile.put("unmanagedAttributePolicy", "ADMIN_EDIT");
        HttpResponse<String> updated = admin("PUT", "/realms/" + realm + "/users/profile",
                JSON.writeValueAsString(profile));
        assertThat(updated.statusCode()).as("profile: %s", updated.body()).isIn(200, 204);
    }

    /** A direct-grant test client that carries the same audience and tenant mappers as the committed explorer client. */
    private static void createDirectGrantClient(String realm) throws Exception {
        String body = """
                {"clientId":"%s","enabled":true,"publicClient":true,"directAccessGrantsEnabled":true,
                 "standardFlowEnabled":false,"fullScopeAllowed":true,
                 "protocolMappers":[
                  {"name":"media-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper",
                   "config":{"included.custom.audience":"%s","id.token.claim":"false","access.token.claim":"true"}},
                  {"name":"media-tenant-id","protocol":"openid-connect","protocolMapper":"oidc-usermodel-attribute-mapper",
                   "config":{"user.attribute":"tenant_id","claim.name":"tenant_id","jsonType.label":"String",
                             "id.token.claim":"false","access.token.claim":"true","userinfo.token.claim":"false"}}]}
                """.formatted(DIRECT_CLIENT, AUDIENCE);
        HttpResponse<String> response = admin("POST", "/realms/" + realm + "/clients", body);
        assertThat(response.statusCode()).as("create client: %s", response.body()).isIn(201, 409);
    }

    private static TestUser createUser(String realm, String prefix, String tenant, String... roles) throws Exception {
        String username = prefix + "-" + UUID.randomUUID().toString().substring(0, 8);
        String password = randomSecret();
        ObjectNode user = JSON.createObjectNode();
        user.put("username", username);
        user.put("enabled", true);
        // Other realms' default user profile requires these before a token can be issued.
        user.put("email", username + "@example.test");
        user.put("firstName", "Test");
        user.put("lastName", "User");
        user.putObject("attributes").putArray("tenant_id").add(tenant);
        HttpResponse<String> created = admin("POST", "/realms/" + realm + "/users", JSON.writeValueAsString(user));
        assertThat(created.statusCode()).as("create user: %s", created.body()).isEqualTo(201);
        String location = created.headers().firstValue("Location").orElseThrow();
        String userId = location.substring(location.lastIndexOf('/') + 1);
        ObjectNode credential = JSON.createObjectNode();
        credential.put("type", "password");
        credential.put("value", password);
        credential.put("temporary", false);
        assertThat(admin("PUT", "/realms/" + realm + "/users/" + userId + "/reset-password",
                JSON.writeValueAsString(credential)).statusCode()).isEqualTo(204);
        if (roles.length > 0) {
            var mapping = JSON.createArrayNode();
            for (String role : roles) {
                HttpResponse<String> found = admin("GET", "/realms/" + realm + "/roles/" + role, null);
                assertThat(found.statusCode()).as("role %s", role).isEqualTo(200);
                mapping.add(JSON.readTree(found.body()));
            }
            assertThat(admin("POST", "/realms/" + realm + "/users/" + userId + "/role-mappings/realm",
                    JSON.writeValueAsString(mapping)).statusCode()).isEqualTo(204);
        }
        return new TestUser(username, password);
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "oidc-it-no-effect"; }
        @Override public String providerVersion() { return "test-only"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            throw new AssertionError("artifact routes must not invoke a processing provider");
        }
    }
}
