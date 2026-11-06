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
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** AS-03 runtime/store recovery through the canonical private audio frame adapter. */
@Testcontainers(disabledWithoutDocker = true)
class MediaRuntimePostgresqlAudioStreamRestartTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    @Test
    void freshRuntimeReconnectsFromDurableAudioAckWithoutReplayingOldFrames(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-audio-restart-" + runId;
        String bucket = "media-audio-restart-" + runId;
        createBucket(bucket);
        Path bindingFile = tempDir.resolve("caller-held-stream-binding.properties");
        Path seedMarker = tempDir.resolve("seed-acked.marker");
        Path seedLog = tempDir.resolve("seed-worker.log");
        Map<String, String> environment = environment(bucket);

        Process seed = startWorker(environment, "seed", bindingFile, seedMarker, tenantId, seedLog);
        try {
            awaitMarker(seed, seedMarker, "FRAME_ZERO_ACKNOWLEDGED", seedLog);
            seed.destroyForcibly();
            assertThat(seed.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (seed.isAlive()) seed.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Properties callerBinding = new Properties();
        try (var input = Files.newInputStream(bindingFile)) {
            callerBinding.load(input);
        }
        assertThat(callerBinding.getProperty("connectionToken")).isNotBlank();
        assertThat(callerBinding.getProperty("lastAcknowledgedSequence")).isEqualTo("-1");

        Path recoveryMarker = tempDir.resolve("recovered.marker");
        Path recoveryLog = tempDir.resolve("recovery-worker.log");
        Process recovery = startWorker(
                environment, "recover", bindingFile, recoveryMarker, tenantId, recoveryLog);
        try {
            awaitMarker(recovery, recoveryMarker, "DURABLE_CURSOR_AND_REPLAY_FENCE_VERIFIED", recoveryLog);
            assertThat(recovery.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(recovery.exitValue()).isZero();
        } finally {
            if (recovery.isAlive()) recovery.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }
    }

    @Test
    void freshRuntimeReconnectsFromDurableVideoAckWithoutReplayingOldFrames(@TempDir Path tempDir)
            throws Exception {
        String runId = UUID.randomUUID().toString().replace("-", "");
        String tenantId = "tenant-video-restart-" + runId;
        String bucket = "media-video-restart-" + runId;
        createBucket(bucket);
        Path bindingFile = tempDir.resolve("caller-held-video-stream-binding.properties");
        Path seedMarker = tempDir.resolve("video-seed-acked.marker");
        Path seedLog = tempDir.resolve("video-seed-worker.log");
        Map<String, String> environment = environment(bucket);

        Process seed = startWorker(environment, "seed-video", bindingFile, seedMarker, tenantId, seedLog);
        try {
            awaitMarker(seed, seedMarker, "VIDEO_FRAME_ZERO_ACKNOWLEDGED", seedLog);
            seed.destroyForcibly();
            assertThat(seed.waitFor(15, TimeUnit.SECONDS)).isTrue();
        } finally {
            if (seed.isAlive()) seed.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }

        Properties callerBinding = new Properties();
        try (var input = Files.newInputStream(bindingFile)) {
            callerBinding.load(input);
        }
        assertThat(callerBinding.getProperty("connectionToken")).isNotBlank();
        assertThat(callerBinding.getProperty("lastAcknowledgedSequence")).isEqualTo("-1");

        Path recoveryMarker = tempDir.resolve("video-recovered.marker");
        Path recoveryLog = tempDir.resolve("video-recovery-worker.log");
        Process recovery = startWorker(
                environment, "recover-video", bindingFile, recoveryMarker, tenantId, recoveryLog);
        try {
            awaitMarker(recovery, recoveryMarker, "VIDEO_DURABLE_CURSOR_AND_REPLAY_FENCE_VERIFIED", recoveryLog);
            assertThat(recovery.waitFor(15, TimeUnit.SECONDS)).isTrue();
            assertThat(recovery.exitValue()).isZero();
        } finally {
            if (recovery.isAlive()) recovery.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
        }
    }

    private static Process startWorker(
            Map<String, String> environment,
            String mode,
            Path bindingFile,
            Path marker,
            String tenantId,
            Path log) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaRuntimePostgresqlAudioStreamRestartWorker.class.getName(), mode,
                bindingFile.toString(), marker.toString(), tenantId);
        builder.environment().putAll(environment);
        builder.redirectErrorStream(true);
        builder.redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitMarker(Process process, Path marker, String expected, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            if (Files.exists(marker) && Files.readString(marker, StandardCharsets.UTF_8).contains(expected)) return;
            if (!process.isAlive()) {
                throw new AssertionError("worker exited before " + expected + ": " + logText(log));
            }
            Thread.sleep(25);
        }
        throw new AssertionError("timed out waiting for " + expected + ": " + logText(log));
    }

    private static String logText(Path log) throws Exception {
        return Files.exists(log) ? Files.readString(log, StandardCharsets.UTF_8) : "<no child output>";
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
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_AUDIO_RESTART_DB_PASSWORD");
        environment.put("MEDIA_AUDIO_RESTART_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "3");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_AUDIO_RESTART_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_AUDIO_RESTART_S3_SECRET");
        environment.put("MEDIA_AUDIO_RESTART_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_AUDIO_RESTART_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }
}
