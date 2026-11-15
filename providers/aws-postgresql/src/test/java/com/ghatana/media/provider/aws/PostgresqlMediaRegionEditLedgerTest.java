package com.ghatana.media.provider.aws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Appended;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.LineageExistsException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Proposal;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.StaleHeadException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Version;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

/**
 * PostgreSQL persistence of the DEV_ONLY region edit ledger (V042): the version number is the compare-and-set, so
 * concurrent appenders of one head have exactly one winner, a request id is idempotent, ownership is concealed, the
 * history survives a full restart of the shared runtime state, and the schema itself refuses malformed rows.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaRegionEditLedgerTest {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3");

    private static String sha(char c) { return String.valueOf(c).repeat(64); }

    private static String ver(char c) { return "sha256:" + sha(c); }

    private static Proposal edit(String requestId, char c) {
        return new Proposal(Kind.EDIT, requestId, "art-" + c, ver(c), sha(c), 100, "man-" + c, ver(c), null, "{}");
    }

    @Test
    void concurrentAppendersOfOneHeadHaveExactlyOneWinnerAcrossStores() throws Exception {
        try (Fixture fixture = openFixture();
             PostgresqlMediaRegionEditLedger left = new PostgresqlMediaRegionEditLedger();
             PostgresqlMediaRegionEditLedger right = new PostgresqlMediaRegionEditLedger();
             ExecutorService workers = Executors.newFixedThreadPool(16)) {
            String tenant = "tenant-" + UUID.randomUUID();
            left.createLineage(tenant, "p1", "line", "base", "art-0", ver('0'), sha('0'), 10, "{}");
            CountDownLatch start = new CountDownLatch(1);
            List<Callable<String>> calls = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                int n = i;
                calls.add(() -> {
                    start.await();
                    try {
                        (n % 2 == 0 ? left : right).append(tenant, "p1", "line", 1, edit("req-" + n, Character.forDigit(n, 16)));
                        return "WON";
                    } catch (StaleHeadException stale) {
                        assertThat(stale.actual()).isEqualTo(2);
                        return "STALE";
                    }
                });
            }
            List<Future<String>> futures = new ArrayList<>();
            for (Callable<String> call : calls) futures.add(workers.submit(call));
            start.countDown();
            int won = 0;
            for (Future<String> future : futures) if (future.get().equals("WON")) won++;
            assertThat(won).isEqualTo(1);
            List<Version> versions = left.versions(tenant, "p1", "line");
            assertThat(versions).hasSize(2);
            assertThat(versions.get(1).versionNumber()).isEqualTo(2);
            assertThat(versions.get(1).parentVersionNumber()).isEqualTo(1);
        }
    }

    @Test
    void aRequestIdIsIdempotentAndOwnershipAndTenantAreConcealed() throws Exception {
        try (Fixture fixture = openFixture(); PostgresqlMediaRegionEditLedger ledger = new PostgresqlMediaRegionEditLedger()) {
            String tenant = "tenant-" + UUID.randomUUID();
            Appended base = ledger.createLineage(tenant, "p1", "line", "base", "art-0", ver('0'), sha('0'), 10, "{}");
            assertThat(base.deduplicated()).isFalse();
            assertThat(ledger.createLineage(tenant, "p1", "line", "base", "art-0", ver('0'), sha('0'), 10, "{}").deduplicated())
                    .isTrue();
            assertThatThrownBy(() -> ledger.createLineage(tenant, "p1", "line", "base", "art-9", ver('9'), sha('9'), 10, "{}"))
                    .isInstanceOf(LineageExistsException.class);
            assertThatThrownBy(() -> ledger.createLineage(tenant, "p2", "line", "base", "art-0", ver('0'), sha('0'), 10, "{}"))
                    .isInstanceOf(LineageExistsException.class);

            Appended first = ledger.append(tenant, "p1", "line", 1, edit("req-1", 'a'));
            assertThat(first.deduplicated()).isFalse();
            // The same request id after the head moved still returns the version it produced.
            ledger.append(tenant, "p1", "line", 2, edit("req-2", 'b'));
            Appended again = ledger.append(tenant, "p1", "line", 1, edit("req-1", 'a'));
            assertThat(again.deduplicated()).isTrue();
            assertThat(again.version().versionNumber()).isEqualTo(2);

            // An undo points at the exact earlier artifact.
            Appended undo = ledger.append(tenant, "p1", "line", 3, new Proposal(Kind.UNDO, "req-u", "art-a", ver('a'), sha('a'),
                    100, null, null, 2, "{}"));
            assertThat(undo.version().kind()).isEqualTo(Kind.UNDO);
            assertThat(undo.version().restoresVersionNumber()).isEqualTo(2);
            assertThat(undo.version().contentSha256()).isEqualTo(sha('a'));

            assertThat(ledger.versions(tenant, "p2", "line")).isEmpty();
            assertThat(ledger.versions("other-" + tenant, "p1", "line")).isEmpty();
            assertThatThrownBy(() -> ledger.append(tenant, "p2", "line", 4, edit("req-x", 'x')))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> ledger.append("other-" + tenant, "p1", "line", 4, edit("req-y", 'y')))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void theHistorySurvivesAFullRestartOfTheSharedRuntimeState() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String bucket = "media-region-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        try (Fixture first = openFixture(bucket); PostgresqlMediaRegionEditLedger ledger = new PostgresqlMediaRegionEditLedger()) {
            ledger.createLineage(tenant, "p1", "line", "base", "art-0", ver('0'), sha('0'), 10, "{\"k\":1}");
            ledger.append(tenant, "p1", "line", 1, edit("req-1", 'a'));
        }
        try (Fixture second = openFixture(bucket); PostgresqlMediaRegionEditLedger ledger = new PostgresqlMediaRegionEditLedger()) {
            List<Version> versions = ledger.versions(tenant, "p1", "line");
            assertThat(versions).extracting(Version::versionNumber).containsExactly(1, 2);
            assertThat(versions.get(0).detailJson()).isEqualTo("{\"k\":1}");
            assertThat(versions.get(1).manifestArtifactId()).isEqualTo("man-a");
            assertThat(ledger.byRequest(tenant, "p1", "line", "req-1")).isPresent();
        }
    }

    @Test
    void theSchemaItselfRefusesMalformedRows() throws Exception {
        try (Fixture fixture = openFixture()) {
            String tenant = "tenant-" + UUID.randomUUID();
            try (Connection connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                    POSTGRES.getPassword())) {
                // An EDIT without a manifest, an UNDO that restores the head, a gap in the version numbers, a BASE at 2.
                assertThatThrownBy(() -> insertRaw(connection, tenant, 2, "EDIT", "r-1", null, 1, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_shape_check");
                assertThatThrownBy(() -> insertRaw(connection, tenant, 3, "UNDO", "r-2", null, 2, 2))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_shape_check");
                assertThatThrownBy(() -> insertRaw(connection, tenant, 4, "EDIT", "r-3", "m", 2, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_shape_check");
                assertThatThrownBy(() -> insertRaw(connection, tenant, 2, "BASE", "r-4", null, null, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_shape_check");
                assertThatThrownBy(() -> insertRaw(connection, tenant, 1, "BOGUS", "r-5", null, null, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_kind_check");
                insertRaw(connection, tenant, 1, "BASE", "r-6", null, null, null);
                assertThatThrownBy(() -> insertRaw(connection, tenant, 1, "BASE", "r-7", null, null, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_versions_pkey");
                assertThatThrownBy(() -> insertRaw(connection, tenant, 2, "EDIT", "r-6", "m", 1, null))
                        .isInstanceOf(SQLException.class).hasMessageContaining("media_dev_region_edit_request_unique");
            }
        }
    }

    private static void insertRaw(Connection connection, String tenant, int number, String kind, String requestId,
                                  String manifest, Integer parent, Integer restores) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_dev_region_edit_versions (tenant_id,principal_id,lineage_id,version_number,kind,request_id,
                artifact_id,artifact_version_id,content_sha256,size_bytes,manifest_artifact_id,manifest_artifact_version_id,
                parent_version_number,restores_version_number,detail_json,created_at)
                VALUES (?, 'p', 'raw', ?, ?, ?, 'a', ?, ?, 5, ?, ?, ?, ?, '{}', now())""")) {
            insert.setString(1, tenant);
            insert.setInt(2, number);
            insert.setString(3, kind);
            insert.setString(4, requestId);
            insert.setString(5, ver('1'));
            insert.setString(6, sha('1'));
            insert.setString(7, manifest);
            insert.setString(8, manifest == null ? null : ver('2'));
            if (parent == null) insert.setNull(9, java.sql.Types.INTEGER); else insert.setInt(9, parent);
            if (restores == null) insert.setNull(10, java.sql.Types.INTEGER); else insert.setInt(10, restores);
            insert.executeUpdate();
        }
    }

    private static void createBucket(String bucket) {
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static Fixture openFixture() {
        String bucket = "media-region-" + UUID.randomUUID().toString().replace("-", "");
        createBucket(bucket);
        return openFixture(bucket);
    }

    private static Fixture openFixture(String bucket) {
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
        MediaAwsPostgresqlRuntimeState keepAlive = MediaAwsPostgresqlRuntimeState.acquire();
        return new Fixture(installed, keepAlive);
    }

    private record Fixture(AutoCloseable installed, MediaAwsPostgresqlRuntimeState keepAlive) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { keepAlive.release(); } finally { installed.close(); }
        }
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_REGION_DB_PASSWORD");
        env.put("MEDIA_REGION_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_REGION_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_REGION_SECRET");
        env.put("MEDIA_REGION_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_REGION_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }
}
