package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-01: a first-time user signs in through a real, self-hosted Keycloak (authorization code + PKCE, driven in
 * Chromium against the real Explorer page), creates a project and a first revision, and reopens it after a real
 * launcher process restart. The launcher verifies the Keycloak token over standard OIDC (issuer, audience, JWKS
 * signature, expiry); nothing is signed by a local test issuer.
 *
 * <p>Fault suite, all with genuine Keycloak-issued tokens: another tenant gets 404 without disclosure, duplicate
 * create replays or conflicts, expired, tampered and wrong-audience tokens are 401, a user removed from the tenant
 * group is refused on the next token, and signing out drops the in-memory token. Test credentials live in
 * {@code integration-tests/src/test/resources/keycloak/ghatana-media-test-realm.json} and are TEST values for this local realm only.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevOidcFirstUseJourneyIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DEV_SECRET = "media-dev-oidc-first-use-secret-0123456789abcdef";
    private static final String KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.8.2";
    private static final String REALM = "ghatana-media-test";
    private static final String AUDIENCE = "ghatana-media";
    private static final String EXPLORER_CLIENT = "ghatana-media-explorer";
    private static final String ADMIN_PASSWORD = randomSecret();

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);
    @Container
    private static final GenericContainer<?> KEYCLOAK = new GenericContainer<>(DockerImageName.parse(KEYCLOAK_IMAGE))
            .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", "it-admin")
            .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", ADMIN_PASSWORD)
            .withCommand("start-dev", "--import-realm")
            .withCopyFileToContainer(MountableFile.forHostPath(realmFile()),
                    "/opt/keycloak/data/import/ghatana-media-test-realm.json")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHttp("/realms/" + REALM).forPort(8080).forStatusCode(200)
                    .withStartupTimeout(Duration.ofMinutes(4)));

    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static String keycloakBase;
    private static String issuer;
    private static JsonNode realmJson;

    private static Path realmFile() {
        return Path.of(System.getProperty("user.dir")).resolve("src/test/resources/keycloak/ghatana-media-test-realm.json")
                .normalize();
    }

    @Test
    void keycloakSignInCreatesProjectRevisionAndReopensAfterLauncherRestartWithFaultSuite() throws Exception {
        realmJson = JSON.readTree(Files.readString(realmFile()));
        // 127.0.0.1 everywhere: the issuer string is derived from the host name the caller used.
        keycloakBase = "http://127.0.0.1:" + KEYCLOAK.getMappedPort(8080);
        issuer = keycloakBase + "/realms/" + REALM;
        assertThat(JSON.readTree(get(issuer + "/.well-known/openid-configuration").body()).path("issuer").asString())
                .isEqualTo(issuer);

        String ownerUser = "test-owner-tenant-a";
        String otherTenantUser = "test-owner-tenant-b";
        String removableUser = "test-removable-tenant-a";
        String ownerTenant = "tenant-a-test";
        String otherTenant = "tenant-b-test";
        String testPassword = passwordOf(ownerUser);

        String run = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-dev-oidc-" + run;
        String schema = "media_dev_" + run;
        int port;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        // Other sessions run Explorer dev servers on the default port 4178, so this run takes its own free port
        // and registers exactly that redirect URI/origin on the PKCE client.
        int explorerPort;
        try (var socket = new java.net.ServerSocket(0)) { explorerPort = socket.getLocalPort(); }
        registerExplorerOrigin(explorerPort);
        Path services = Files.createTempDirectory("media-dev-oidc-services-");
        Path log = Files.createTempFile("media-dev-oidc-process-", ".log");
        Path browserLog = Files.createTempFile("media-dev-oidc-browser-", ".log");
        Process launcher = null;
        Process browser = null;
        boolean passed = false;
        try {
            try (S3Client s3 = s3()) {
                s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
            }
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            String classpath = services + java.io.File.pathSeparator + childClasspath;
            Map<String, String> environment = new HashMap<>(environment(bucket, port, schema));
            environment.put("MEDIA_OIDC_ISSUER", issuer);
            environment.put("MEDIA_OIDC_AUDIENCE", AUDIENCE);
            environment.put("MEDIA_OIDC_TENANT_CLAIM", "media_tenant");
            environment.put("MEDIA_OIDC_CLOCK_SKEW_SECONDS", "0");
            launcher = startLauncher(classpath, environment, log);
            awaitReady(launcher, port);

            Path repoRoot = findMediaRepoRoot();
            Path script = repoRoot.resolve("apps/media-experience-explorer/test/dev-oidc-first-use-live-browser.mjs");
            assertThat(Files.isRegularFile(script)).isTrue();
            Path viteBinary = findViteBinary(repoRoot);
            Path playwrightModule = findPlaywrightModule(repoRoot);
            String viteVersion = packageVersion(viteBinary);
            ProcessBuilder browserBuilder = new ProcessBuilder("node", script.toString());
            browserBuilder.directory(repoRoot.toFile());
            browserBuilder.redirectError(ProcessBuilder.Redirect.appendTo(browserLog.toFile()));
            Map<String, String> browserEnv = browserBuilder.environment();
            browserEnv.put("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT", Integer.toString(port));
            browserEnv.put("VITE_MEDIA_OIDC_ISSUER", issuer);
            browserEnv.put("VITE_MEDIA_OIDC_CLIENT_ID", EXPLORER_CLIENT);
            browserEnv.put("MEDIA_J01_EXPLORER_PORT", Integer.toString(explorerPort));
            browserEnv.put("MEDIA_J01_TEST_PASSWORD", testPassword);
            browserEnv.put("MEDIA_J01_OWNER_USER", ownerUser);
            browserEnv.put("MEDIA_J01_OWNER_TENANT", ownerTenant);
            browserEnv.put("MEDIA_J01_OTHER_TENANT_USER", otherTenantUser);
            browserEnv.put("MEDIA_J01_OTHER_TENANT", otherTenant);
            browserEnv.put("MEDIA_J01_REMOVED_USER", removableUser);
            browserEnv.put("MEDIA_DEV_VITE_BINARY", viteBinary.toString());
            browserEnv.put("MEDIA_DEV_VITE_VERSION", viteVersion);
            browserEnv.put("MEDIA_DEV_PLAYWRIGHT_MODULE", playwrightModule.toString());
            browser = browserBuilder.start();
            try (BufferedReader out = new BufferedReader(new InputStreamReader(browser.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter in = new BufferedWriter(new OutputStreamWriter(browser.getOutputStream(), StandardCharsets.UTF_8))) {

                // ---- 1. Browser: real sign-in, workspace, project, first revisions ----
                JsonNode created = readBrowserEvent(browser, out, "created", browserLog);
                String projectId = created.path("projectId").asString();
                String principal = created.path("principal").asString();
                String workspaceId = created.path("workspaceId").asString();
                String headRevisionId = created.path("headRevisionId").asString();
                String title = created.path("title").asString();
                JsonNode createBody = created.path("createBody");
                assertThat(principal).startsWith("oidc:");
                assertThat(projectId).isNotBlank();

                String ownerToken = token("media-test-direct", ownerUser, testPassword);
                JsonNode claims = claims(ownerToken);
                assertThat(claims.path("iss").asString()).isEqualTo(issuer);
                assertThat(claims.path("media_tenant").size()).isEqualTo(1);
                assertThat(claims.path("media_tenant").get(0).asString()).isEqualTo(ownerTenant);
                assertThat(principal).as("browser principal is the Keycloak (issuer, sub) pair")
                        .isEqualTo(com.ghatana.media.runtime.MediaVerifiedIdentityContracts.oidcPrincipalId(
                                issuer, claims.path("sub").asString()));

                // ---- 2. Real launcher restart, then the browser reopens the exact head ----
                stopLauncher(launcher);
                launcher = null;
                launcher = startLauncher(classpath, environment, log);
                awaitReady(launcher, port);
                in.write("host-restarted\n");
                in.flush();

                HttpResponse<String> reopened = send(port, "ignored", ownerToken, "GET", "/dev/v1/projects/" + projectId, null);
                assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
                assertThat(JSON.readTree(reopened.body()).path("currentRevision").path("revisionId").asString())
                        .isEqualTo(headRevisionId);
                assertThat(JSON.readTree(reopened.body()).path("currentRevision").path("timelines").get(0)
                        .path("graph").path("scenes").get(0).path("sceneId").asString())
                        .isEqualTo(created.path("sceneId").asString());
                assertThat(projectRows(schema, ownerTenant, title)).as("one project after the journey").isEqualTo(1);

                // ---- 3. Duplicate create ----
                String createJson = JSON.writeValueAsString(createBody);
                HttpResponse<String> replay = send(port, "ignored", ownerToken, "POST", "/dev/v1/projects", createJson);
                assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
                assertThat(JSON.readTree(replay.body()).path("createdNow").asBoolean()).isFalse();
                assertThat(JSON.readTree(replay.body()).path("project").path("projectId").asString()).isEqualTo(projectId);
                ObjectNode changed = ((ObjectNode) createBody.deepCopy());
                changed.put("title", title + " (different payload)");
                HttpResponse<String> conflict = send(port, "ignored", ownerToken, "POST", "/dev/v1/projects",
                        JSON.writeValueAsString(changed));
                assertThat(conflict.statusCode()).as(conflict.body()).isEqualTo(409);
                assertThat(conflict.body()).doesNotContain(projectId);
                assertThat(projectRows(schema, ownerTenant, title)).isEqualTo(1);
                assertThat(projectRows(schema, ownerTenant, title + " (different payload)")).isZero();

                // ---- 4. Other principal in the same tenant: owner scope ----
                String colleagueToken = token("media-test-direct", "test-colleague-tenant-a", testPassword);
                HttpResponse<String> colleague = send(port, "ignored", colleagueToken, "GET", "/dev/v1/projects/" + projectId, null);
                assertThat(colleague.statusCode()).as(colleague.body()).isIn(403, 404);
                assertThat(colleague.body()).doesNotContain(projectId, headRevisionId, title);

                // ---- 5. Wrong tenant: 404, no leak, header cannot choose the tenant ----
                String otherToken = token("media-test-direct", otherTenantUser, testPassword);
                assertThat(claims(otherToken).path("media_tenant").get(0).asString()).isEqualTo(otherTenant);
                for (String path : new String[] {"/dev/v1/projects/" + projectId,
                        "/dev/v1/projects/" + projectId + "/revisions/" + headRevisionId}) {
                    HttpResponse<String> foreign = send(port, ownerTenant, otherToken, "GET", path, null);
                    assertThat(foreign.statusCode()).as(path + " " + foreign.body()).isEqualTo(404);
                    assertThat(foreign.body()).doesNotContain(projectId, headRevisionId, title, ownerTenant,
                            created.path("sceneId").asString());
                }
                HttpResponse<String> foreignWrite = send(port, ownerTenant, otherToken, "POST",
                        "/dev/v1/projects/" + projectId + "/timelines", JSON.writeValueAsString(Map.of(
                                "expectedHeadRevisionId", headRevisionId, "timelineId", "intruder")));
                assertThat(foreignWrite.statusCode()).as(foreignWrite.body()).isEqualTo(404);
                HttpResponse<String> foreignCreate = send(port, ownerTenant, otherToken, "POST", "/dev/v1/projects", createJson);
                assertThat(foreignCreate.statusCode()).as("tenant A's workspace id must not be usable by tenant B: "
                        + foreignCreate.body()).isIn(400, 403, 404, 409);
                assertThat(foreignCreate.body()).doesNotContain(projectId, headRevisionId);
                assertThat(projectRows(schema, otherTenant, title)).as("nothing was created for tenant B").isZero();
                // The same request id from tenant B's own context is a different receipt: it creates B's project.
                String otherWorkspace = JSON.readTree(send(port, "x", otherToken, "GET", "/dev/v1/context", null).body())
                        .path("selectedAuthorizedWorkspaceId").asString();
                assertThat(otherWorkspace).isNotEqualTo(workspaceId);
                ObjectNode own = ((ObjectNode) createBody.deepCopy());
                own.put("selectedAuthorizedWorkspaceId", otherWorkspace);
                HttpResponse<String> ownCreate = send(port, "x", otherToken, "POST", "/dev/v1/projects", JSON.writeValueAsString(own));
                assertThat(ownCreate.statusCode()).as(ownCreate.body()).isEqualTo(201);
                assertThat(JSON.readTree(ownCreate.body()).path("project").path("projectId").asString()).isNotEqualTo(projectId);

                JsonNode tenantB = readBrowserEvent(browser, out, "tenant-b-done", browserLog);
                assertThat(tenantB.path("status").asInt()).isEqualTo(404);

                // ---- 6. Token faults (all start from a genuine Keycloak token) ----
                assertThat(send(port, "x", ownerToken, "GET", "/dev/v1/context", null).statusCode()).isEqualTo(200);
                assertThat(sendRaw(port, "GET", "/dev/v1/context", null).statusCode()).as("no token").isEqualTo(401);
                String[] parts = ownerToken.split("\\.");
                ObjectNode swapped = (ObjectNode) claims(ownerToken).deepCopy();
                swapped.putArray("media_tenant").add(otherTenant);
                String tampered = parts[0] + "." + b64(JSON.writeValueAsBytes(swapped)) + "." + parts[2];
                assertThat(send(port, "x", tampered, "GET", "/dev/v1/context", null).statusCode()).as("tampered").isEqualTo(401);
                String stripped = parts[0] + "." + parts[1] + "." + b64(new byte[256]);
                assertThat(send(port, "x", stripped, "GET", "/dev/v1/context", null).statusCode()).as("bad signature").isEqualTo(401);

                String wrongAudience = token("media-test-direct-other-audience", ownerUser, testPassword);
                assertThat(claims(wrongAudience).path("aud").toString()).doesNotContain(AUDIENCE);
                assertThat(send(port, "x", wrongAudience, "GET", "/dev/v1/context", null).statusCode())
                        .as("different audience").isEqualTo(401);

                String shortLived = token("media-test-direct-short", ownerUser, testPassword);
                assertThat(send(port, "x", shortLived, "GET", "/dev/v1/context", null).statusCode()).as("fresh").isEqualTo(200);
                long expiresAt = claims(shortLived).path("exp").asLong();
                while (System.currentTimeMillis() / 1000 <= expiresAt) Thread.sleep(250);
                assertThat(send(port, "x", shortLived, "GET", "/dev/v1/context", null).statusCode()).as("expired").isEqualTo(401);

                assertThat(send(port, "x", token("media-test-direct", "test-no-tenant", testPassword), "GET",
                        "/dev/v1/context", null).statusCode()).as("user in no tenant group").isEqualTo(401);
                assertThat(send(port, "x", token("media-test-direct", "test-both-tenants", testPassword), "GET",
                        "/dev/v1/context", null).statusCode()).as("ambiguous tenant (two groups)").isEqualTo(401);

                // ---- 7. Removed from the tenant group: the next token is refused ----
                String removableBefore = token("media-test-direct", removableUser, testPassword);
                assertThat(send(port, "x", removableBefore, "GET", "/dev/v1/context", null).statusCode()).isEqualTo(200);
                removeFromGroup(removableUser, ownerTenant);
                String removableAfter = token("media-test-direct", removableUser, testPassword);
                assertThat(claims(removableAfter).path("media_tenant").size()).isZero();
                assertThat(send(port, "x", removableAfter, "GET", "/dev/v1/context", null).statusCode())
                        .as("token minted after removal").isEqualTo(401);
                in.write("user-removed\n");
                in.flush();

                // ---- 8. Browser finishes (sign-out, removed-user sign-in, wrong password) ----
                readBrowserEvent(browser, out, "done", browserLog);
                assertThat(browser.waitFor(60, TimeUnit.SECONDS)).isTrue();
                assertThat(browser.exitValue()).as("browser journey; see " + log).isZero();
                passed = true;
            }
        } finally {
            if (browser != null && browser.isAlive()) stopProcessTree(browser);
            if (launcher != null && launcher.isAlive()) stopLauncher(launcher);
            dropSchema(schema);
            deleteBucket(bucket);
            if (passed) { Files.deleteIfExists(log); Files.deleteIfExists(browserLog); }
            else System.err.println("OIDC journey logs retained at " + log + " and " + browserLog);
            if (Files.exists(services)) try (var paths = Files.walk(services)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    // ---- Keycloak helpers ----

    private static String passwordOf(String username) {
        for (JsonNode user : realmJson.path("users")) {
            if (username.equals(user.path("username").asString())) {
                return user.path("credentials").get(0).path("value").asString();
            }
        }
        throw new AssertionError("No such test user in the realm file: " + username);
    }

    private static String token(String client, String username, String password) throws Exception {
        HttpResponse<String> response = post(issuer + "/protocol/openid-connect/token", form(Map.of(
                "grant_type", "password", "client_id", client, "username", username, "password", password)), null);
        assertThat(response.statusCode()).as("token for %s via %s: %s", username, client, response.body()).isEqualTo(200);
        return JSON.readTree(response.body()).path("access_token").asString();
    }

    private static JsonNode claims(String token) throws Exception {
        return JSON.readTree(Base64.getUrlDecoder().decode(token.split("\\.")[1]));
    }

    private static String b64(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }

    /** Master-realm admin tokens live 60 seconds, so every admin call mints its own. */
    private static String adminToken() throws Exception {
        return JSON.readTree(post(keycloakBase + "/realms/master/protocol/openid-connect/token", form(Map.of(
                "grant_type", "password", "client_id", "admin-cli", "username", "it-admin",
                "password", ADMIN_PASSWORD)), null).body()).path("access_token").asString();
    }

    private static void registerExplorerOrigin(int port) throws Exception {
        String token = adminToken();
        JsonNode clients = JSON.readTree(adminGet("/admin/realms/" + REALM + "/clients?clientId=" + EXPLORER_CLIENT).body());
        ObjectNode client = (ObjectNode) clients.get(0);
        client.putArray("redirectUris").add("http://127.0.0.1:" + port + "/*");
        client.putArray("webOrigins").add("http://127.0.0.1:" + port);
        HttpResponse<String> updated = HTTP.send(HttpRequest.newBuilder(URI.create(
                        keycloakBase + "/admin/realms/" + REALM + "/clients/" + client.path("id").asString()))
                .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
                .PUT(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(client))).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(updated.statusCode()).as(updated.body()).isEqualTo(204);
    }

    private static void removeFromGroup(String username, String groupName) throws Exception {
        JsonNode users = JSON.readTree(adminGet("/admin/realms/" + REALM + "/users?exact=true&username=" + username).body());
        String userId = users.get(0).path("id").asString();
        JsonNode groups = JSON.readTree(adminGet("/admin/realms/" + REALM + "/groups?exact=true&search=" + groupName).body());
        String groupId = groups.get(0).path("id").asString();
        HttpResponse<String> deleted = HTTP.send(HttpRequest.newBuilder(URI.create(
                        keycloakBase + "/admin/realms/" + REALM + "/users/" + userId + "/groups/" + groupId))
                .header("Authorization", "Bearer " + adminToken()).DELETE().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(deleted.statusCode()).as(deleted.body()).isEqualTo(204);
    }

    private static HttpResponse<String> adminGet(String path) throws Exception {
        HttpResponse<String> response = HTTP.send(HttpRequest.newBuilder(URI.create(keycloakBase + path))
                .header("Authorization", "Bearer " + adminToken()).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(path + " " + response.body()).isEqualTo(200);
        return response;
    }

    private static HttpResponse<String> get(String url) throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create(url)).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<String> post(String url, String body, String bearer) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
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

    private static String randomSecret() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static HttpResponse<String> sendRaw(int port, String method, String path, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static int projectRows(String schema, String tenant, String title) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                var statement = connection.prepareStatement("SELECT count(*) FROM \"" + schema
                        + "\".media_timeline_projects WHERE tenant_id=? AND title=?")) {
            statement.setString(1, tenant);
            statement.setString(2, title);
            try (var rows = statement.executeQuery()) { rows.next(); return rows.getInt(1); }
        }
    }

    private static JsonNode readBrowserEvent(Process browser, BufferedReader output, String expectedEvent, Path log)
            throws Exception {
        FutureTask<String> lineTask = new FutureTask<>(output::readLine);
        Thread reader = new Thread(lineTask, "media-dev-live-browser-output");
        reader.setDaemon(true);
        reader.start();
        String line;
        try {
            line = lineTask.get(130, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            stopProcessTree(browser);
            String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
            String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
            throw new AssertionError("Timed out waiting for browser event " + expectedEvent
                    + "; process=" + processState + "; log=" + diagnostics, timeout);
        }
        String processState = browser.isAlive() ? "still-running" : "exit=" + browser.exitValue();
        String diagnostics = Files.exists(log) ? Files.readString(log) : "<no browser log>";
        assertThat(line).as("browser event " + expectedEvent + "; process=" + processState + "; log=" + diagnostics)
                .isNotNull();
        JsonNode event = JSON.readTree(line);
        assertThat(event.path("event").asString()).isEqualTo(expectedEvent);
        return event;
    }


    private static void stopProcessTree(Process process) throws InterruptedException {
        if (process == null) return;
        var descendants = process.toHandle().descendants().toList();
        for (int index = descendants.size() - 1; index >= 0; index--) {
            descendants.get(index).destroy();
        }
        process.destroy();
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        for (ProcessHandle descendant : descendants) {
            if (!descendant.isAlive()) continue;
            descendant.destroyForcibly();
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) break;
            try {
                descendant.onExit().get(remaining, TimeUnit.NANOSECONDS);
            } catch (java.util.concurrent.TimeoutException ignored) {
                break;
            } catch (java.util.concurrent.ExecutionException ignored) {
                // The descendant already exited; continue cleaning up siblings.
            }
        }
    }


    private static Path findMediaRepoRoot() {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media repository root");
        }
        return repoRoot;
    }

    private static Path findViteBinary(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("apps/media-experience-explorer/node_modules/vite/bin/vite.js");
        if (Files.isRegularFile(local)) {
            assertThat(packageVersion(local)).as("workspace Vite pin").isEqualTo("7.3.1");
            return local;
        }
        Path localPnpm = findPnpmPackageBinary(repoRoot, "vite@7.3.1", "vite/bin/vite.js");
        if (localPnpm != null) {
            assertThat(packageVersion(localPnpm)).as("workspace Vite pin").isEqualTo("7.3.1");
            return localPnpm;
        }
        Path globalRoot = globalNodeModules();
        Path globalVite = globalRoot.resolve("vitest/node_modules/vite/bin/vite.js");
        assertThat(Files.isRegularFile(globalVite))
                .as("Vite 8.3.0 from the documented global Vitest toolchain is required when the workspace link is absent")
                .isTrue();
        assertThat(packageVersion(globalVite)).as("documented host Vite fallback pin").isEqualTo("8.3.0");
        return globalVite;
    }

    private static Path findPlaywrightModule(Path repoRoot) throws Exception {
        Path local = repoRoot.resolve("node_modules/playwright/index.mjs");
        if (Files.isRegularFile(local)) return local;
        Path appLocal = repoRoot.resolve("apps/media-experience-explorer/node_modules/playwright/index.mjs");
        if (Files.isRegularFile(appLocal)) return appLocal;
        Path localPnpm = findPnpmPackageBinary(repoRoot, "playwright@1.63.0", "playwright/index.mjs");
        if (localPnpm != null) return localPnpm;
        Path global = globalNodeModules().resolve("@playwright/test/index.mjs");
        assertThat(Files.isRegularFile(global))
                .as("Playwright 1.63.0 global runner is required when the workspace package link is absent").isTrue();
        return global;
    }

    private static Path findPnpmPackageBinary(Path repoRoot, String packagePrefix, String relativeBinary)
            throws Exception {
        Path pnpmStore = repoRoot.resolve("node_modules/.pnpm");
        if (!Files.isDirectory(pnpmStore)) return null;
        try (var entries = Files.list(pnpmStore)) {
            return entries.filter(path -> path.getFileName().toString().startsWith(packagePrefix))
                    .map(path -> path.resolve("node_modules").resolve(relativeBinary))
                    .filter(Files::isRegularFile)
                    .findFirst().orElse(null);
        }
    }

    private static String packageVersion(Path executable) throws Exception {
        Path resolved = executable.toRealPath();
        Path packageJson = resolved.getParent().getParent().resolve("package.json");
        return JSON.readTree(Files.readString(packageJson)).path("version").asString();
    }

    private static Path globalNodeModules() throws Exception {
        Process npm = new ProcessBuilder("npm", "root", "-g").redirectErrorStream(true).start();
        byte[] output = npm.getInputStream().readAllBytes();
        assertThat(npm.waitFor(10, TimeUnit.SECONDS)).as("npm root -g must finish").isTrue();
        assertThat(npm.exitValue()).as("npm root -g output: " + new String(output, StandardCharsets.UTF_8)).isZero();
        return Path.of(new String(output, StandardCharsets.UTF_8).trim());
    }


    private static Map<String, String> environment(String bucket, int port, String schema) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_DB_PASSWORD");
        env.put("MEDIA_LAUNCHER_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_SECRET");
        env.put("MEDIA_LAUNCHER_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_LAUNCHER_SECRET", LOCALSTACK.getSecretKey());
        env.put("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true");
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_PROJECT_TIMELINE_SCHEMA", schema);
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE",
                "secret:env:MEDIA_PROJECT_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_PROJECT_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
        return env;
    }

    private static void installDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve(
                "com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }


    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitReady(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(2).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready"))
                                .GET().build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (java.io.IOException ignored) { }
            Thread.sleep(200);
        }
        throw new AssertionError("MediaLauncher did not become ready");
    }

    private static HttpResponse<String> send(int port, String tenant, String token,
            String method, String path, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Authorization", "Bearer " + token)
                .header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }


    private static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static void dropSchema(String schema) {
        if (schema == null || !schema.matches("media_dev_[a-z0-9_]{1,48}")) return;
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
        } catch (Exception ignored) { }
    }

    private static void deleteBucket(String bucket) {
        try (S3Client s3 = s3()) {
            s3.listObjectsV2(builder -> builder.bucket(bucket)).contents().forEach(object ->
                    s3.deleteObject(builder -> builder.bucket(bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(bucket));
        } catch (Exception ignored) { }
    }

}
