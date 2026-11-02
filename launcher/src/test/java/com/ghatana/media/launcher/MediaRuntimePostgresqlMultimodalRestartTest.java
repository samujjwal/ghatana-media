package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
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

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** PostgreSQL-backed MediaRuntime recovery for a synthetic ambiguous MM child after JVM death. */
@Testcontainers(disabledWithoutDocker = true)
class MediaRuntimePostgresqlMultimodalRestartTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private record Identity(String tenantId, String parentJobId, String childJobId, String parentRequestId) { }

    @Test
    void restartedRuntimeKeepsParentUnknownAndDoesNotReplaySyntheticUnknownChild(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String bucket = "media-mm-runtime-" + runId;
        createBucket(bucket);
        Identity identity = new Identity("tenant-mm-runtime-" + runId,
                "job-mm-runtime-" + runId, "job-mm-runtime-vision-" + runId,
                "request-mm-runtime-" + runId);
        Map<String, String> environment = environment(bucket);
        Path seedMarker = tempDir.resolve("seed-committed.marker");
        Path seedLog = tempDir.resolve("seed-worker.log");

        Process seed = startWorker(environment, "seed", seedMarker, identity, seedLog);
        try {
            awaitMarker(seed, seedMarker, "CHILD_UNKNOWN_COMMITTED", seedLog);
            seed.destroyForcibly();
            assertThat(seed.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (seed.isAlive()) seed.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Path recoveryMarker = tempDir.resolve("runtime-recovered.marker");
        Path recoveryLog = tempDir.resolve("recovery-worker.log");
        Process recovery = startWorker(environment, "recover", recoveryMarker, identity, recoveryLog);
        try {
            awaitMarker(recovery, recoveryMarker, "PARENT_OUTCOME_UNKNOWN", recoveryLog);
            assertThat(recovery.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(recovery.exitValue()).isZero();
        } finally {
            if (recovery.isAlive()) recovery.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }
    }

    private static Process startWorker(
            Map<String, String> environment, String mode, Path marker, Identity identity, Path log)
            throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaRuntimePostgresqlMultimodalRestartWorker.class.getName(), mode,
                marker.toString(), identity.tenantId(), identity.parentJobId(),
                identity.childJobId(), identity.parentRequestId());
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process process, Path marker, String expected, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains(expected)) return;
            if (!process.isAlive()) {
                throw new AssertionError("worker exited before " + expected + ": " + logText(log));
            }
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for " + expected + ": " + logText(log));
    }

    private static void createBucket(String bucket) {
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_MM_RUNTIME_DB_PASSWORD");
        environment.put("MEDIA_MM_RUNTIME_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_MM_RUNTIME_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_MM_RUNTIME_S3_SECRET");
        environment.put("MEDIA_MM_RUNTIME_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_MM_RUNTIME_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static String logText(Path log) throws Exception {
        return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "<no child output>";
    }
}
