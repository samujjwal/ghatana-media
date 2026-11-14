package com.ghatana.media.integration;

import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaLauncherProcessFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * Shared real-process helpers for the DEV_ONLY journey ITs: launcher process control, signed DEV_ONLY tokens,
 * artifact upload over HTTP and independent PostgreSQL/S3 readback. Mirrors the patterns of the existing DEV restart
 * ITs without modifying them.
 */
final class MediaDevLiveFixtures {
    static final ObjectMapper JSON = new ObjectMapper();
    static final String DEV_SECRET = "media-dev-production-journey-secret";

    private MediaDevLiveFixtures() { }

    static Map<String, String> environment(PostgreSQLContainer<?> postgres, LocalStackContainer localstack,
            String bucket, int port, String schema) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        env.put("MEDIA_PROFILE", "dev");
        env.put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        env.put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        env.put("MEDIA_HTTP_PORT", Integer.toString(port));
        env.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        env.put("MEDIA_POSTGRES_JDBC_URL", postgres.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", postgres.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_LAUNCHER_DB_PASSWORD");
        env.put("MEDIA_LAUNCHER_DB_PASSWORD", postgres.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_ENDPOINT", localstack.getEndpointOverride(S3).toString());
        env.put("MEDIA_S3_REGION", localstack.getRegion());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_LAUNCHER_SECRET");
        env.put("MEDIA_LAUNCHER_ACCESS", localstack.getAccessKey());
        env.put("MEDIA_LAUNCHER_SECRET", localstack.getSecretKey());
        env.put("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "true");
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL", postgres.getJdbcUrl());
        env.put("MEDIA_PROJECT_TIMELINE_SCHEMA", schema);
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_USER", postgres.getUsername());
        env.put("MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE",
                "secret:env:MEDIA_PROJECT_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_PROJECT_TIMELINE_DB_PASSWORD", postgres.getPassword());
        return env;
    }

    static String issueDevToken(String tenant, String principal, String... extraPermissions) throws Exception {
        Path repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (!Files.isRegularFile(repoRoot.resolve("scripts/media-dev-identity-token.mjs"))) {
            repoRoot = repoRoot.getParent();
            if (repoRoot == null) throw new AssertionError("Could not locate the Media DEV_ONLY token issuer");
        }
        List<String> command = new ArrayList<>(List.of("node", "scripts/media-dev-identity-token.mjs",
                "--tenant", tenant, "--subject", principal, "--expires-in", "300"));
        List<String> permissions = new ArrayList<>(List.of("media:project:dev:create", "media:project:dev:read",
                "media:project:dev:write", "media:artifact:create", "media:artifact:write", "media:artifact:read"));
        permissions.addAll(List.of(extraPermissions));
        for (String permission : permissions) { command.add("--permission"); command.add(permission); }
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(repoRoot.toFile());
        builder.redirectErrorStream(true);
        builder.environment().put("MEDIA_PROFILE", "dev");
        builder.environment().put("MEDIA_RUNTIME_ENVIRONMENT", "dev");
        builder.environment().put("MEDIA_DEV_IDENTITY_ENABLED", "true");
        builder.environment().put("MEDIA_DEV_JWT_HMAC_SECRET", DEV_SECRET);
        Process issuer = builder.start();
        byte[] outputBytes = issuer.getInputStream().readAllBytes();
        if (!issuer.waitFor(10, TimeUnit.SECONDS)) {
            issuer.destroyForcibly();
            throw new AssertionError("DEV_ONLY issuer did not exit");
        }
        String output = new String(outputBytes, StandardCharsets.US_ASCII).trim();
        assertThat(issuer.exitValue()).as("DEV_ONLY issuer output: " + output).isZero();
        return output;
    }

    static void installDescriptors(Path root) throws Exception {
        Path services = root.resolve("META-INF/services");
        Files.createDirectories(services);
        Files.writeString(services.resolve("com.ghatana.governance.PolicyEngine"),
                MediaLauncherProcessFixtures.Policy.class.getName() + "\n");
        Files.writeString(services.resolve(
                "com.ghatana.media.runtime.MediaRuntimeContracts$MediaProcessingProvider"),
                MediaLauncherProcessFixtures.Stt.class.getName() + "\n");
    }

    static S3Client s3(LocalStackContainer localstack) {
        return S3Client.builder().endpointOverride(localstack.getEndpointOverride(S3))
                .region(Region.of(localstack.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(localstack.getAccessKey(), localstack.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    static Process startLauncher(String classpath, Map<String, String> env, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                "com.ghatana.media.launcher.MediaLauncher");
        builder.environment().putAll(env);
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
        return builder.start();
    }

    static void awaitReady(Process process, int port) throws Exception {
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

    static void stopLauncher(Process process) throws Exception {
        process.destroy();
        if (!process.waitFor(15, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    static HttpResponse<String> send(int port, String tenant, String token, String method, String path,
            String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** POST helper that asserts the expected status and returns the parsed body. */
    static JsonNode post(int port, String tenant, String token, String path, Object body, int status)
            throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "POST", path, JSON.writeValueAsString(body));
        assertThat(response.statusCode()).as(path + " -> " + response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    static JsonNode get(int port, String tenant, String token, String path, int status) throws Exception {
        HttpResponse<String> response = send(port, tenant, token, "GET", path, null);
        assertThat(response.statusCode()).as(path + " -> " + response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    /** Uploads one chunk-sized object over the canonical intake routes and returns the artifactId. */
    static String upload(int port, String tenant, String principal, String token, String key, String fileName,
            String contentType, byte[] bytes) throws Exception {
        Map<String, Object> requestBody = Map.of(
                "tenantId", tenant, "principalId", principal, "fileName", fileName,
                "contentType", contentType, "expectedSizeBytes", bytes.length, "expectedSha256", sha256(bytes),
                "classification", "INTERNAL", "retention", "P30D",
                "metadata", Map.of("scope", "DEV_ONLY", "fixture", "synthetic-journey-source"));
        HttpResponse<String> begun = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + "/api/v1/artifacts/uploads"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Idempotency-Key", "journey-source-" + key).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(requestBody), StandardCharsets.UTF_8))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(begun.statusCode()).as(begun.body()).isEqualTo(201);
        String uploadId = JSON.readTree(begun.body()).path("uploadId").asString();
        HttpResponse<String> chunk = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create(
                        "http://127.0.0.1:" + port + "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0"))
                .header("Authorization", "Bearer " + token).header("X-Tenant-Id", tenant)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(chunk.statusCode()).as(chunk.body()).isEqualTo(200);
        HttpResponse<String> completed = send(port, tenant, token, "POST",
                "/api/v1/artifacts/uploads/" + uploadId + "/complete", "");
        assertThat(completed.statusCode()).as(completed.body()).isEqualTo(201);
        return JSON.readTree(completed.body()).path("artifactId").asString();
    }

    /** Durable media_artifacts row (content type, sha, S3 key) for an artifact the principal owns. */
    record StoredArtifact(String contentType, String sha256, String objectReference) { }

    static StoredArtifact storedArtifact(PostgreSQLContainer<?> postgres, String tenant, String principal,
            String artifactId) throws Exception {
        try (var connection = DriverManager.getConnection(
                     postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                var statement = connection.prepareStatement(
                        "SELECT object_reference, content_type, sha256 FROM media_artifacts "
                                + "WHERE tenant_id=? AND artifact_id=? AND principal_id=?")) {
            statement.setString(1, tenant);
            statement.setString(2, artifactId);
            statement.setString(3, principal);
            try (var row = statement.executeQuery()) {
                assertThat(row.next()).as("media_artifacts row for " + artifactId).isTrue();
                StoredArtifact stored = new StoredArtifact(row.getString("content_type"), row.getString("sha256"),
                        row.getString("object_reference"));
                assertThat(row.next()).as("exactly one durable row for " + artifactId).isFalse();
                return stored;
            }
        }
    }

    static byte[] s3Bytes(LocalStackContainer localstack, String bucket, StoredArtifact stored) {
        String key = stored.objectReference().substring(("s3://" + bucket + "/").length());
        try (S3Client s3 = s3(localstack)) {
            return s3.getObjectAsBytes(GetObjectRequest.builder().bucket(bucket).key(key).build()).asByteArray();
        }
    }

    static void dropSchema(PostgreSQLContainer<?> postgres, String schema) {
        if (schema == null || !schema.matches("media_dev_[a-z0-9_]{1,48}")) return;
        try (var connection = DriverManager.getConnection(postgres.getJdbcUrl(), postgres.getUsername(),
                postgres.getPassword()); var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
        } catch (Exception ignored) { }
    }

    static void deleteBucket(LocalStackContainer localstack, String bucket) {
        try (S3Client s3 = s3(localstack)) {
            s3.listObjectsV2(builder -> builder.bucket(bucket)).contents().forEach(object ->
                    s3.deleteObject(builder -> builder.bucket(bucket).key(object.key())));
            s3.deleteBucket(builder -> builder.bucket(bucket));
        } catch (Exception ignored) { }
    }

    static void deleteTree(Path root) {
        if (root == null || !Files.exists(root)) return;
        try (var paths = Files.walk(root)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }

    static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    static byte[] solidPng(int argb) throws Exception {
        var image = new java.awt.image.BufferedImage(8, 6, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 6; y++) for (int x = 0; x < 8; x++) image.setRGB(x, y, argb);
        var out = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }
}
