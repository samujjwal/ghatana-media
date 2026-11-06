package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.flywaydb.core.api.output.MigrateResult;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * A09 historical-lineage fixture: a database built at the Media pre-V010 lineage (V001–V009)
 * must migrate forward through V010–V029 and V031 without checksum conflicts, row loss or phantom state;
 * a repeated migrate pass must be a no-op and the V009-era column surface must remain readable.
 */
class MediaMigrationLineageFixtureTest {

    private static final String FINGERPRINT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private JdbcDataSource dataSource() {
        JdbcDataSource ds = new JdbcDataSource();
        ds.setURL("jdbc:h2:mem:migration_lineage_" + UUID.randomUUID().toString().replace("-", "")
                + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ds.setUser("sa");
        return ds;
    }

    private static Flyway flyway(JdbcDataSource ds, String target) {
        var configured = Flyway.configure()
                .dataSource(ds)
                .locations("classpath:db/media-runtime")
                .validateMigrationNaming(true);
        if (target != null) configured = configured.target(target);
        return configured.load();
    }

    private static Flyway flywayWithExtraLocation(JdbcDataSource ds, String target, Path extraLocation) {
        var configured = Flyway.configure()
                .dataSource(ds)
                .locations("classpath:db/media-runtime", "filesystem:" + extraLocation.toAbsolutePath())
                .validateMigrationNaming(true);
        if (target != null) configured = configured.target(target);
        return configured.load();
    }

    @Test
    void preV010LineageMigratesForwardWithoutRowLossOrPhantomState() throws Exception {
        JdbcDataSource ds = dataSource();

        // Build the historical Media lineage head: exactly V001..V009.
        MigrateResult seeded = flyway(ds, "9").migrate();
        assertThat(seeded.migrationsExecuted).isEqualTo(9);

        try (Connection connection = ds.getConnection()) {
            // A fingerprinted historical job: V013 must carry the fingerprint into submission_digest.
            insertJob(connection, "job-hist-fp", "req-hist-fp", "COMPLETED", FINGERPRINT);
            // A pre-fingerprint legacy job: no digest evidence; replay must stay fail-closed.
            insertJob(connection, "job-hist-legacy", "req-hist-legacy", "FAILED", null);
            // A running job under a legacy lease: ownership fields must survive the migration.
            insertRunningLeasedJob(connection);
            // An artifact and an upload session written under the V009-era shape.
            insertArtifact(connection);
            insertUploadSession(connection);
        }

        MigrateResult forward = flyway(ds, null).migrate();
        assertThat(forward.migrationsExecuted).isEqualTo(21); // V010..V029 and additive V031

        try (Connection connection = ds.getConnection()) {
            assertThat(count(connection, "media_processing_jobs")).isEqualTo(3);
            assertThat(count(connection, "media_artifacts")).isEqualTo(1);
            assertThat(count(connection, "media_upload_sessions")).isEqualTo(1);

            // Submission digest backfill: fingerprinted rows carry it forward; unevidenced
            // legacy rows stay blank so replay admission fails closed instead of guessing.
            assertThat(column(connection,
                    "SELECT submission_digest FROM media_processing_jobs WHERE job_id='job-hist-fp'"))
                    .isEqualTo(FINGERPRINT);
            assertThat(column(connection,
                    "SELECT submission_digest FROM media_processing_jobs WHERE job_id='job-hist-legacy'"))
                    .isEqualTo("");

            // Lease ownership history is preserved, not reset into a phantom claim.
            assertThat(column(connection,
                    "SELECT lease_owner FROM media_processing_jobs WHERE job_id='job-hist-leased'"))
                    .isEqualTo("worker-legacy");
            assertThat(column(connection,
                    "SELECT CAST(lease_token AS VARCHAR) FROM media_processing_jobs WHERE job_id='job-hist-leased'"))
                    .isEqualTo("7");

            // Newly added governance columns carry their declared defaults, not invented truth.
            assertThat(column(connection,
                    "SELECT scan_status FROM media_artifacts WHERE artifact_id='art-hist'"))
                    .isEqualTo("UNVERIFIED");
            assertThat(column(connection,
                    "SELECT CAST(legal_hold AS VARCHAR) FROM media_artifacts WHERE artifact_id='art-hist'"))
                    .isEqualTo("FALSE");
            assertThat(column(connection,
                    "SELECT scan_status FROM media_upload_sessions WHERE upload_id='upl-hist'"))
                    .isEqualTo("UNVERIFIED");

            // Old-reader compatibility: the V009-era column projection still resolves.
            try (PreparedStatement oldReader = connection.prepareStatement(
                    "SELECT tenant_id, job_id, request_id, artifact_id, job_type, provider_id,"
                            + " status, created_at, started_at, completed_at, result_json,"
                            + " failure_code, version, principal_id, request_fingerprint"
                            + " FROM media_processing_jobs WHERE job_id = ?")) {
                oldReader.setString(1, "job-hist-fp");
                try (ResultSet rows = oldReader.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getString("request_fingerprint")).isEqualTo(FINGERPRINT);
                }
            }

            // Migration history records every version without a failed or pending entry.
            try (var historyStatement = connection.createStatement();
                 ResultSet history = historyStatement.executeQuery(
                    "SELECT COUNT(*), SUM(CASE WHEN success THEN 0 ELSE 1 END)"
                            + " FROM flyway_schema_history WHERE version IS NOT NULL")) {
                history.next();
                assertThat(history.getLong(1)).isEqualTo(30);
                assertThat(history.getLong(2)).isZero();
            }
            assertThat(tableExists(connection, "media_delivery_operations")).isTrue();
            assertThat(columnExists(connection, "media_delivery_operations", "version_ref")).isTrue();
        }

        // Mid-backfill crash/retry equivalence: a second migrate is a strict no-op and the
        // backfilled digest is stable — replay fencing is lossless across re-runs.
        MigrateResult again = flyway(ds, null).migrate();
        assertThat(again.migrationsExecuted).isZero();
        try (Connection connection = ds.getConnection()) {
            assertThat(column(connection,
                    "SELECT submission_digest FROM media_processing_jobs WHERE job_id='job-hist-fp'"))
                    .isEqualTo(FINGERPRINT);
        }
    }

    @Test
    void mismatchedAppliedChecksumFailsClosedBeforeApplyingAnotherVersion() throws Exception {
        JdbcDataSource ds = dataSource();
        MigrateResult seeded = flyway(ds, "16").migrate();
        assertThat(seeded.migrationsExecuted).isEqualTo(16);

        try (Connection connection = ds.getConnection();
             PreparedStatement tamper = connection.prepareStatement(
                     "UPDATE flyway_schema_history SET checksum = checksum + 1 WHERE CAST(version AS INTEGER) = 7")) {
            assertThat(tamper.executeUpdate()).isEqualTo(1);
        }

        assertThatThrownBy(() -> flyway(ds, null).migrate())
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("checksum");

        try (Connection connection = ds.getConnection();
             PreparedStatement pending = connection.prepareStatement(
                     "SELECT COUNT(*) FROM flyway_schema_history WHERE CAST(version AS INTEGER) = 17")) {
            try (ResultSet rows = pending.executeQuery()) {
                rows.next();
                assertThat(rows.getLong(1)).isZero();
            }
        }
    }

    @Test
    void failedForwardMigrationLeavesHistoryFailClosedWithoutRepair(@TempDir Path migrationDirectory)
            throws Exception {
        // H2 fault-injection only; real PostgreSQL process-death recovery and applied legacy
        // history remain separate Testcontainers/operator evidence.
        JdbcDataSource ds = dataSource();
        MigrateResult seeded = flyway(ds, "29").migrate();
        assertThat(seeded.migrationsExecuted).isEqualTo(29);
        try (Connection connection = ds.getConnection()) {
            insertJob(connection, "job-ip06-retry", "req-ip06-retry", "FAILED", FINGERPRINT);
        }

        Path migration = migrationDirectory.resolve("V032__ip06_recovery_probe.sql");
        Files.writeString(migration, "UPDATE media_processing_jobs SET result_json='partial'"
                + " WHERE job_id='job-ip06-retry';\n"
                + "INSERT INTO ip06_missing_recovery_table (id) VALUES (2);\n");
        Files.writeString(migrationDirectory.resolve("V033__ip06_after_failure_probe.sql"),
                "CREATE TABLE ip06_v033_applied_marker (id INTEGER PRIMARY KEY);\n"
                        + "INSERT INTO ip06_v033_applied_marker (id) VALUES (33);\n");

        assertThatThrownBy(() -> flywayWithExtraLocation(ds, null, migrationDirectory).migrate())
                .isInstanceOf(RuntimeException.class);
        try (Connection connection = ds.getConnection();
             PreparedStatement state = connection.prepareStatement(
                     "SELECT result_json FROM media_processing_jobs WHERE job_id='job-ip06-retry'");
             ResultSet rows = state.executeQuery()) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getString(1)).isEqualTo("{}");
        }
        try (Connection connection = ds.getConnection();
             PreparedStatement history = connection.prepareStatement(
                             "SELECT COUNT(*), SUM(CASE WHEN success=FALSE THEN 1 ELSE 0 END),"
                             + " SUM(CASE WHEN success=TRUE THEN 1 ELSE 0 END)"
                             + " FROM flyway_schema_history WHERE CAST(version AS INTEGER)=32");
             ResultSet rows = history.executeQuery()) {
            rows.next();
            assertThat(rows.getLong(1)).isEqualTo(1);
            assertThat(rows.getLong(2)).isEqualTo(1);
            assertThat(rows.getLong(3)).isZero();
        }
        try (Connection connection = ds.getConnection()) {
            assertThat(tableExists(connection, "ip06_v033_applied_marker")).isFalse();
        }
        try (Connection connection = ds.getConnection();
             PreparedStatement history = connection.prepareStatement(
                             "SELECT COUNT(*) FROM flyway_schema_history"
                             + " WHERE CAST(version AS INTEGER)=33");
             ResultSet rows = history.executeQuery()) {
            rows.next();
            assertThat(rows.getLong(1)).isZero();
        }

        // H2 keeps a failed history row, so retry without a separately authorized repair
        // must fail validation before V033's visible table/data side effect can run.
        assertThatThrownBy(() -> flywayWithExtraLocation(ds, null, migrationDirectory).migrate())
                .isInstanceOf(FlywayValidateException.class);
        try (Connection connection = ds.getConnection()) {
            assertThat(tableExists(connection, "ip06_v033_applied_marker")).isFalse();
        }
        try (Connection connection = ds.getConnection();
             PreparedStatement history = connection.prepareStatement(
                             "SELECT COUNT(*) FROM flyway_schema_history"
                             + " WHERE CAST(version AS INTEGER)=33");
             ResultSet rows = history.executeQuery()) {
            rows.next();
            assertThat(rows.getLong(1)).isZero();
        }
    }

    private static boolean tableExists(Connection connection, String tableName) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT COUNT(*) FROM information_schema.tables WHERE UPPER(table_name)=UPPER(?)")) {
            statement.setString(1, tableName);
            try (ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1) > 0;
            }
        }
    }

    private static boolean columnExists(Connection connection, String tableName, String columnName) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT COUNT(*) FROM information_schema.columns WHERE UPPER(table_name)=UPPER(?)"
                        + " AND UPPER(column_name)=UPPER(?)")) {
            statement.setString(1, tableName);
            statement.setString(2, columnName);
            try (ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1) > 0;
            }
        }
    }

    private static void insertJob(
            Connection connection, String jobId, String requestId, String status, String fingerprint)
            throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_processing_jobs (tenant_id, job_id, request_id, artifact_id,"
                        + " job_type, provider_id, status, created_at, started_at, completed_at,"
                        + " result_json, failure_code, version, principal_id, request_fingerprint)"
                        + " VALUES ('tenant-h', ?, ?, 'art-hist', 'VISION', 'provider-h', ?,"
                        + " 1700000000000, 1700000001000, 1700000002000, '{}', '', 1,"
                        + " 'principal-h', ?)")) {
            insert.setString(1, jobId);
            insert.setString(2, requestId);
            insert.setString(3, status);
            insert.setString(4, fingerprint);
            insert.executeUpdate();
        }
    }

    private static void insertRunningLeasedJob(Connection connection) throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_processing_jobs (tenant_id, job_id, request_id, artifact_id,"
                        + " job_type, provider_id, status, created_at, started_at,"
                        + " result_json, failure_code, version, principal_id,"
                        + " lease_owner, lease_token, lease_expires_at)"
                        + " VALUES ('tenant-h', 'job-hist-leased', 'req-hist-leased', 'art-hist',"
                        + " 'VISION', 'provider-h', 'RUNNING', 1700000000000, 1700000001000,"
                        + " '{}', '', 3, 'principal-h', 'worker-legacy', 7, 1700000060000)")) {
            insert.executeUpdate();
        }
    }

    private static void insertArtifact(Connection connection) throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_artifacts (tenant_id, artifact_id, file_name, content_type,"
                        + " size_bytes, sha256, object_reference, classification, created_at,"
                        + " expires_at, metadata_json, principal_id)"
                        + " VALUES ('tenant-h', 'art-hist', 'clip.wav', 'audio/wav', 128,"
                        + " 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                        + " 's3://bucket/hist', 'RESTRICTED', 1700000000000, 1800000000000,"
                        + " '{}', 'principal-h')")) {
            insert.executeUpdate();
        }
    }

    private static void insertUploadSession(Connection connection) throws Exception {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_upload_sessions (tenant_id, upload_id, file_name, content_type,"
                        + " expected_size_bytes, expected_sha256, classification, retention_millis,"
                        + " created_at, expires_at, bytes_received, next_chunk_index, status,"
                        + " metadata_json, updated_at, principal_id, idempotency_key,"
                        + " request_fingerprint)"
                        + " VALUES ('tenant-h', 'upl-hist', 'clip.wav', 'audio/wav', 128,"
                        + " 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                        + " 'RESTRICTED', 2592000000, 1700000000000, 1800000000000, 128, 1,"
                        + " 'COMPLETED', '{}', 1700000001000, 'principal-h', 'idem-hist', ?)")) {
            insert.setString(1, FINGERPRINT);
            insert.executeUpdate();
        }
    }

    private static long count(Connection connection, String table) throws Exception {
        try (var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT COUNT(*) FROM " + table)) {
            rows.next();
            return rows.getLong(1);
        }
    }

    private static String column(Connection connection, String sql) throws Exception {
        try (var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            Object value = rows.getObject(1);
            return value == null ? null : value.toString();
        }
    }
}
