package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** HTTP-level subject isolation over the real persisted local runtime. */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaSubjectIsolationHttpIT {
    private static final String TENANT = "tenant-subject-isolation";
    private static final String SECRET = "0123456789abcdef0123456789abcdef";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-08-03T00:00:00Z"), ZoneOffset.UTC);
    private static final String[] PERMISSIONS = {
            "media:artifact:create", "media:artifact:write", "media:artifact:read",
            "media:job:create", "media:job:read"
    };
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
    private MediaRuntime runtime;
    private AutoCloseable installed;
    private String jdbcUrl;
    private String bucket;

    @AfterEach
    void tearDown() throws Exception {
        if (server != null) server.stop(0);
        if (runtime != null) runtime.close();
        if (installed != null) installed.close();
    }

    @Test
    void sameTenantJwtSubjectsCannotReadEachOthersPersistedArtifactOrJob() throws Exception {
        startStack();
        String ownerToken = jwt("subject-owner");
        String otherToken = jwt("subject-other");
        byte[] payload = new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3};
        String sha = sha256(payload);

        String uploadBody = """
                {"tenantId":"%s","principalId":"subject-owner","fileName":"fixture.png",
                 "contentType":"image/png","expectedSizeBytes":%d,
                 "expectedSha256":"%s","classification":"INTERNAL","retention":"P30D","metadata":{}}
                """.formatted(TENANT, payload.length, sha);
        HttpResponse<String> begin = send("POST", "/api/v1/artifacts/uploads", TENANT, ownerToken,
                "owner-upload", uploadBody);
        assertThat(begin.statusCode()).as("begin upload: %s", begin.body()).isEqualTo(201);
        String uploadId = MAPPER.readTree(begin.body()).get("uploadId").asText();

        HttpResponse<String> chunk = sendBytes("PUT", "/api/v1/artifacts/uploads/" + uploadId + "/chunks/0",
                TENANT, ownerToken, payload);
        assertThat(chunk.statusCode()).as("append chunk: %s", chunk.body()).isEqualTo(200);
        HttpResponse<String> completed = send("POST", "/api/v1/artifacts/uploads/" + uploadId + "/complete",
                TENANT, ownerToken, null, "");
        assertThat(completed.statusCode()).as("complete upload: %s", completed.body()).isEqualTo(201);
        JsonNode artifact = MAPPER.readTree(completed.body());
        String artifactId = artifact.get("artifactId").asText();

        HttpResponse<String> ownerArtifact = send("GET", "/api/v1/artifacts/" + artifactId,
                TENANT, ownerToken, null, "");
        HttpResponse<String> otherArtifact = send("GET", "/api/v1/artifacts/" + artifactId,
                TENANT, otherToken, null, "");
        HttpResponse<String> absentArtifact = send("GET", "/api/v1/artifacts/absent-subject-isolation-artifact",
                TENANT, otherToken, null, "");
        assertThat(ownerArtifact.statusCode()).as("owner artifact read: %s", ownerArtifact.body()).isEqualTo(200);
        assertThat(otherArtifact.statusCode()).as("other subject artifact read: %s", otherArtifact.body()).isEqualTo(404);
        assertThat(MAPPER.readTree(otherArtifact.body()).path("error"))
                .isEqualTo(MAPPER.readTree(absentArtifact.body()).path("error"));
        assertThat(otherArtifact.body()).doesNotContain(artifactId);

        String jobBody = """
                {"requestId":"subject-isolation-job","tenantId":"%s","principalId":"subject-owner",
                 "correlationId":"subject-isolation-correlation","artifactId":"%s","jobType":"TRANSCODE",
                 "providerHint":"local-diagnostic","parameters":{}}
                """.formatted(TENANT, artifactId);
        HttpResponse<String> submitted = send("POST", "/api/v1/jobs", TENANT, ownerToken,
                "owner-job", jobBody);
        assertThat(submitted.statusCode()).as("submit job: %s", submitted.body()).isEqualTo(202);
        String jobId = MAPPER.readTree(submitted.body()).get("jobId").asText();

        HttpResponse<String> ownerJob = send("GET", "/api/v1/jobs/" + jobId,
                TENANT, ownerToken, null, "");
        HttpResponse<String> otherJob = send("GET", "/api/v1/jobs/" + jobId,
                TENANT, otherToken, null, "");
        HttpResponse<String> absentJob = send("GET", "/api/v1/jobs/absent-subject-isolation-job",
                TENANT, otherToken, null, "");
        assertThat(ownerJob.statusCode()).as("owner job read: %s", ownerJob.body()).isEqualTo(200);
        assertThat(otherJob.statusCode()).as("other subject job read: %s", otherJob.body()).isEqualTo(404);
        assertThat(MAPPER.readTree(otherJob.body()).path("error"))
                .isEqualTo(MAPPER.readTree(absentJob.body()).path("error"));
        assertThat(otherJob.body()).doesNotContain(jobId);

        // Verify owner-bound rows committed in the durable PostgreSQL-compatible store.
        try (var connection = DriverManager.getConnection(jdbcUrl, "sa", "")) {
            assertOwnerRow(connection, "media_artifacts", artifactId);
            assertOwnerRow(connection, "media_processing_jobs", jobId);
        }
    }

    private void startStack() throws Exception {
        jdbcUrl = "jdbc:h2:mem:media_subject_isolation_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        bucket = "media-subject-isolation-" + UUID.randomUUID().toString().replace("-", "");
        try (S3Client s3 = s3()) {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENABLED", "true");
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_PROFILE", "local");
        environment.put("MEDIA_LOCAL_PROVIDER_ENABLED", "true");
        environment.put("MEDIA_JOB_TIMEOUT_MS", "60000");
        environment.put("MEDIA_POSTGRES_JDBC_URL", jdbcUrl);
        environment.put("MEDIA_POSTGRES_USER", "sa");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "8");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_TEST_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_TEST_SECRET");
        environment.put("MEDIA_TEST_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_TEST_SECRET", LOCALSTACK.getSecretKey());
        installed = TestAwsStateInstall.install(environment);
        runtime = MediaRuntime.compose(environment);

        Map<String, String> securityEnvironment = new HashMap<>(environment);
        securityEnvironment.put("MEDIA_JWT_HMAC_SECRET_REFERENCE", "secret:env:MEDIA_TEST_JWT_SECRET");
        securityEnvironment.put("MEDIA_JWT_ISSUER", "https://issuer.example");
        securityEnvironment.put("MEDIA_JWT_AUDIENCE", "ghatana-runtime");
        securityEnvironment.put("MEDIA_TEST_JWT_SECRET", SECRET);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", new MediaSecurityFilter(
                new MediaHttpHandler(runtime), "local", securityEnvironment, CLOCK));
        server.start();
    }

    private S3Client s3() {
        return S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build();
    }

    private HttpResponse<String> send(String method, String path, String tenant, String token,
                                      String idempotencyKey, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base() + path))
                .header("X-Tenant-Id", tenant)
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json");
        if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey);
        if ("POST".equals(method)) builder.POST(HttpRequest.BodyPublishers.ofString(body));
        else builder.GET();
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private HttpResponse<String> sendBytes(String method, String path, String tenant, String token, byte[] body)
            throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(base() + path))
                .header("X-Tenant-Id", tenant)
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/octet-stream")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        return client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private static String jwt(String subject) throws Exception {
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissions = String.join(",", java.util.Arrays.stream(PERMISSIONS)
                .map(permission -> "\"" + permission + "\"").toList());
        String payload = base64Url("{\"sub\":\"" + subject + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"https://issuer.example\",\"aud\":\"ghatana-runtime\",\"exp\":"
                + CLOCK.instant().plusSeconds(300).getEpochSecond() + ",\"permissions\":[" + permissions + "]}");
        String signingInput = header + "." + payload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static void assertOwnerRow(java.sql.Connection connection, String table, String recordId)
            throws Exception {
        // table is selected only from the two fixed schema names above.
        try (var statement = connection.prepareStatement(
                "SELECT COUNT(*) FROM " + table + " WHERE tenant_id=? AND principal_id=? AND "
                        + ("media_artifacts".equals(table) ? "artifact_id" : "job_id") + "=?")) {
            statement.setString(1, TENANT);
            statement.setString(2, "subject-owner");
            statement.setString(3, recordId);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getLong(1)).as("persisted %s ownership row", table).isEqualTo(1);
            }
        }
    }
}
