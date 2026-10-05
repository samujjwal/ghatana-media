package com.ghatana.media.provider.aws;

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

import java.sql.Connection;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/** @doc.type class @doc.purpose Verify Media-owned PostgreSQL migrations and S3 readiness */
@Testcontainers(disabledWithoutDocker = true)
class MediaAwsPostgresqlRuntimeStateIntegrationTest {

    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8"))
            .withServices(S3);

    @Test
    void h2AndLocalstackComposeCompleteMediaState() throws Exception {
        String bucket = "media-runtime-test";
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }

        Map<String, String> environment = integrationEnvironment(bucket);
        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.create(environment);
        try {
            assertThat(state.configured()).isTrue();
            assertThat(state.ready()).isTrue();
            assertThat(state.productionEligible()).isFalse();
            try (Connection connection = state.connection()) {
                for (String table : new String[] {
                        "media_upload_sessions", "media_upload_chunks", "media_artifacts",
                        "media_processing_jobs", "media_stream_sessions"
                }) {
                    try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM " + table);
                         var result = statement.executeQuery()) {
                        result.next();
                        assertThat(result.getLong(1)).isZero();
                    }
                }
            }
        } finally {
            state.close();
        }
        assertThatThrownBy(state::connection)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not configured");
    }

    @Test
    void migrationRejectsUnconfirmedCancellationAsTerminalTruth() throws Exception {
        String bucket = "media-cancellation-truth";
        try (S3Client client = S3Client.builder()
                .endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }

        MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.create(
                integrationEnvironment(bucket));
        try (Connection connection = state.connection()) {
            String sql = """
                    INSERT INTO media_processing_jobs
                      (tenant_id,job_id,request_id,principal_id,artifact_id,job_type,provider_id,status,
                       created_at,started_at,completed_at,result_json,failure_code,version)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """;
            assertThatThrownBy(() -> {
                try (var statement = connection.prepareStatement(sql)) {
                    statement.setString(1, "tenant-a");
                    statement.setString(2, "job-a");
                    statement.setString(3, "request-a");
                    statement.setString(4, "principal-a");
                    statement.setString(5, "artifact-a");
                    statement.setString(6, "VISION");
                    statement.setString(7, "remote");
                    statement.setString(8, "CANCELLED");
                    statement.setLong(9, System.currentTimeMillis());
                    statement.setObject(10, null);
                    statement.setLong(11, System.currentTimeMillis());
                    statement.setString(12, "{\"cancellationOutcome\":\"REQUESTED_UNCONFIRMED\"}");
                    statement.setString(13, "CANCELLED_UNCONFIRMED");
                    statement.setLong(14, 2L);
                    statement.executeUpdate();
                }
            }).isInstanceOf(SQLException.class);
        } finally {
            state.close();
        }
    }

    @Test
    void productionRejectsNonPostgresqlAndPartialAwsCredentials() {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "production");
        environment.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media");
        environment.put("MEDIA_S3_BUCKET", "bucket");
        assertThatThrownBy(() -> MediaAwsPostgresqlRuntimeState.create(environment))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("requires PostgreSQL");

        Map<String, String> partial = new HashMap<>();
        partial.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        partial.put("MEDIA_POSTGRES_JDBC_URL", "jdbc:h2:mem:media-partial");
        partial.put("MEDIA_POSTGRES_USER", "sa");
        partial.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        partial.put("MEDIA_S3_BUCKET", "bucket");
        partial.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:ACCESS");
        partial.put("ACCESS", "access");
        assertThatThrownBy(() -> MediaAwsPostgresqlRuntimeState.create(partial))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("configured together");
    }

    private static Map<String, String> integrationEnvironment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        environment.put("MEDIA_POSTGRES_JDBC_URL",
                "jdbc:h2:mem:media-" + UUID.randomUUID()
                        + ";MODE=PostgreSQL;DB_CLOSE_DELAY=-1;DB_CLOSE_ON_EXIT=false");
        environment.put("MEDIA_POSTGRES_USER", "sa");
        environment.put("MEDIA_POSTGRES_DRIVER", "org.h2.Driver");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_SECRET");
        environment.put("MEDIA_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }
}
