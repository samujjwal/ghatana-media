package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

/** Source-derived, test-only IP-06 probe for the historical provider migration lineage. */
@Testcontainers(disabledWithoutDocker = true)
class Ip06LegacyMigrationCompatibilityTest {

    private static final String LEGACY_LOCATION = "classpath:db/legacy-media-runtime-v001-v016";
    private static final String CURRENT_LOCATION = "classpath:db/media-runtime";
    private static final String MANIFEST = "/db/legacy-media-runtime-v001-v016/manifest.csv";
    private static final String[] CURRENT_TAIL = {
            "V017__media_transcript_revisions.sql", "V018__media_lifecycle_outbox_leases.sql",
            "V019__media_stream_acknowledgements.sql", "V020__media_stream_inflight_attempts.sql",
            "V021__media_transcript_processing_purpose.sql", "V022__media_transcript_attempt_binding.sql",
            "V023__media_stt_request_snapshot.sql", "V024__media_source_rights_authority.sql",
            "V025__media_transcript_production_admission.sql", "V026__media_multimodal_operation_snapshot.sql",
            "V027__media_transcript_segment_timing.sql", "V028__media_caption_versions.sql",
            "V029__media_transcript_version_ref_readback.sql"
    };
    private static final String[] CURRENT_V007_V016_DESCRIPTIONS = {
            "media job unknown outcome", "media job request fingerprint", "media upload idempotency",
            "media job artifact content version", "media job attempts and outbox",
            "media artifact format verification", "media job submission digest",
            "media outbox delivery attempts", "media artifact quarantine and lineage",
            "media attempt finality and lifecycle outbox"
    };

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Test
    void sourceLineageIsRecordedCurrentChainFailsClosedAndForwardSqlIsProbed(@TempDir Path tempDir)
            throws Exception {
        applyLegacyAndAssertHistory("ip06_legacy");
        assertCurrentChainRejectsLegacyHistoryBeforeV017();
        probeLegacyToCurrentForwardSql("ip06_forward_probe", tempDir);
    }

    @Test
    void forwardMigrationRollsBackFailedVersionAndResumesWithPinnedBytes(@TempDir Path tempDir)
            throws Exception {
        String schema = "ip06_interrupted_forward";
        Path currentTail = copyCurrentTail(tempDir);
        assertThat(flyway(LEGACY_LOCATION, schema, null).migrate().migrationsExecuted).isEqualTo(16);
        seedLegacyRows(schema);

        String location = LEGACY_LOCATION + ",filesystem:" + currentTail.toAbsolutePath();
        Path v021 = currentTail.resolve(CURRENT_TAIL[4]);
        byte[] pinnedV021 = Files.readAllBytes(v021);
        byte[] injectedFailure = "\nSELECT 1 / 0; -- test-only migration fault\n"
                .getBytes(StandardCharsets.UTF_8);
        byte[] failingV021 = java.util.Arrays.copyOf(pinnedV021, pinnedV021.length + injectedFailure.length);
        System.arraycopy(injectedFailure, 0, failingV021, pinnedV021.length, injectedFailure.length);
        Files.write(v021, failingV021);

        Throwable migrationFailure = catchThrowable(() -> flyway(location, schema, "29").migrate());

        assertThat(migrationFailure).isNotNull();
        assertAppliedHistory(schema, 20);
        assertLegacyRowsUnchanged(schema);

        // Remove the test-only SQL fault so retry runs the exact checked-in V021 source bytes.
        // PostgreSQL must roll back the failed V021 transaction while keeping V017..V020.
        Files.write(v021, pinnedV021);
        // A fresh Flyway instance represents process recovery from the durable boundary. It
        // applies only V021..V029, keeps the legacy rows, and is idempotent.
        assertThat(flyway(location, schema, "29").migrate().migrationsExecuted).isEqualTo(9);
        assertAppliedHistory(schema, 29);
        assertLegacyRowsUnchanged(schema);
        assertThat(flyway(location, schema, "29").migrate().migrationsExecuted).isZero();
        assertAppliedHistory(schema, 29);
        assertLegacyRowsUnchanged(schema);
    }

    private static void applyLegacyAndAssertHistory(String schema) throws Exception {
        Flyway legacy = flyway(LEGACY_LOCATION, schema, null);
        assertThat(legacy.migrate().migrationsExecuted).isEqualTo(16);
        Map<Integer, LegacyRow> expected = readManifest();
        try (Connection connection = connection();
             var statement = connection.prepareStatement(
                     "SELECT version::integer, description, checksum, success"
                             + " FROM " + schema + ".flyway_schema_history"
                             + " WHERE version IS NOT NULL ORDER BY version::integer");
             ResultSet rows = statement.executeQuery()) {
            int count = 0;
            while (rows.next()) {
                int version = rows.getInt("version");
                LegacyRow manifest = expected.get(version);
                assertThat(manifest).as("manifest entry for V%03d", version).isNotNull();
                assertThat(rows.getString("description")).isEqualTo(manifest.description());
                assertThat(rows.getBoolean("success")).isTrue();
                int checksum = rows.getInt("checksum");
                System.out.printf("IP06_LEGACY_HISTORY,%03d,%s,%d%n", version,
                        rows.getString("description"), checksum);
                if (manifest.checksum() != null) assertThat(checksum).isEqualTo(manifest.checksum());
                count++;
            }
            assertThat(count).isEqualTo(16);
        }
    }

    private static void assertCurrentChainRejectsLegacyHistoryBeforeV017() throws Exception {
        Throwable validationFailure = catchThrowable(() -> flyway(CURRENT_LOCATION, "ip06_legacy", null).migrate());
        assertThat(validationFailure)
                .isInstanceOf(RuntimeException.class)
                .satisfies(error -> assertThat(error.getMessage().toLowerCase())
                        .containsAnyOf("description mismatch", "checksum mismatch"));
        Map<Integer, LegacyRow> legacyManifest = readManifest();
        try (Connection connection = connection();
             var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT version::integer, description FROM ip06_legacy.flyway_schema_history"
                             + " WHERE version::integer BETWEEN 7 AND 16 ORDER BY version::integer")) {
            int mismatches = 0;
            while (rows.next()) {
                int version = rows.getInt("version");
                assertThat(rows.getString("description")).isEqualTo(legacyManifest.get(version).description());
                assertThat(rows.getString("description"))
                        .isNotEqualTo(CURRENT_V007_V016_DESCRIPTIONS[version - 7]);
                mismatches++;
            }
            assertThat(mismatches).isEqualTo(10);
        }
        try (Connection connection = connection();
             var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT COUNT(*) FROM ip06_legacy.flyway_schema_history"
                             + " WHERE version::integer >= 17")) {
            rows.next();
            assertThat(rows.getLong(1)).isZero();
        }
    }

    private static void probeLegacyToCurrentForwardSql(String schema, Path tempDir) throws Exception {
        Path currentTail = copyCurrentTail(tempDir);
        assertThat(flyway(LEGACY_LOCATION, schema, null).migrate().migrationsExecuted).isEqualTo(16);
        seedLegacyRows(schema);
        Flyway forward = flyway(LEGACY_LOCATION + ",filesystem:" + currentTail.toAbsolutePath(), schema, "29");
        assertThat(forward.migrate().migrationsExecuted).isEqualTo(13);
        try (Connection connection = connection();
             var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT COUNT(*) FROM " + schema + ".flyway_schema_history"
                             + " WHERE version IS NOT NULL AND success")) {
            rows.next();
            assertThat(rows.getLong(1)).isEqualTo(29);
        }
        assertLegacyRowsUnchanged(schema);
    }

    private static Path copyCurrentTail(Path tempDir) throws Exception {
        Path currentTail = Files.createDirectories(tempDir.resolve("current-tail"));
        for (int version = 17; version <= 29; version++) {
            String resource = CURRENT_TAIL[version - 17];
            try (var input = Ip06LegacyMigrationCompatibilityTest.class.getResourceAsStream(
                    "/db/media-runtime/" + resource)) {
                assertThat(input).as(resource).isNotNull();
                Files.copy(input, currentTail.resolve(resource));
            }
        }
        return currentTail;
    }

    private static void assertAppliedHistory(String schema, int expectedCount) throws Exception {
        try (Connection connection = connection();
             var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT version::integer, success FROM " + schema
                             + ".flyway_schema_history WHERE version IS NOT NULL ORDER BY version::integer")) {
            int version = 0;
            while (rows.next()) {
                version++;
                assertThat(rows.getInt("version")).isEqualTo(version);
                assertThat(rows.getBoolean("success")).isTrue();
            }
            assertThat(version).isEqualTo(expectedCount);
        }
    }

    private static void assertLegacyRowsUnchanged(String schema) throws Exception {
        try (Connection connection = connection()) {
            assertThat(stringValue(connection, "SELECT sha256 FROM " + schema
                    + ".media_artifacts WHERE artifact_id='ip06-artifact'")).isEqualTo(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            assertThat(stringValue(connection, "SELECT result_json FROM " + schema
                    + ".media_processing_jobs WHERE job_id='ip06-job'")).isEqualTo("{\"legacy\":true}");
            assertThat(stringValue(connection, "SELECT transcript_text FROM " + schema
                    + ".media_transcript_revisions WHERE transcript_id='ip06-transcript'")).isEqualTo(
                    "synthetic legacy transcript");
            assertThat(stringValue(connection, "SELECT payload_json FROM " + schema
                    + ".media_processing_lifecycle_outbox WHERE event_id='ip06-event'")).isEqualTo(
                    "{\"legacy\":true}");
        }
    }

    private static void seedLegacyRows(String schema) throws Exception {
        try (Connection connection = connection(); var statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO " + schema + ".media_artifacts"
                    + " (tenant_id,artifact_id,file_name,content_type,size_bytes,sha256,object_reference,"
                    + "classification,created_at,expires_at,metadata_json) VALUES"
                    + " ('ip06-tenant','ip06-artifact','legacy.wav','audio/wav',128,"
                    + "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                    + "'s3://fixture/ip06','INTERNAL',1700000000000,1800000000000,'{}')");
            statement.executeUpdate("INSERT INTO " + schema + ".media_processing_jobs"
                    + " (tenant_id,job_id,request_id,artifact_id,job_type,provider_id,status,created_at,"
                    + "result_json,failure_code,version) VALUES"
                    + " ('ip06-tenant','ip06-job','ip06-request','ip06-artifact','STT','fixture-provider',"
                    + "'COMPLETED',1700000000000,'{\"legacy\":true}','',1)");
            statement.executeUpdate("INSERT INTO " + schema + ".media_transcript_revisions"
                    + " (tenant_id,transcript_id,revision,principal_id,source_artifact_id,source_artifact_version,"
                    + "source_sha256,job_id,profile_id,provider_id,model_id,language,timebase,transcript_text,"
                    + "consent_decision_id,rights_decision_id,policy_version,created_at) VALUES"
                    + " ('ip06-tenant','ip06-transcript',1,'fixture-principal','ip06-artifact',"
                    + "'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                    + "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ip06-job',"
                    + "'fixture-profile','fixture-provider','fixture-model','en','milliseconds',"
                    + "'synthetic legacy transcript','fixture-consent','fixture-rights','fixture-policy',"
                    + "1700000001000)");
            statement.executeUpdate("INSERT INTO " + schema + ".media_processing_lifecycle_outbox"
                    + " (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,"
                    + "payload_json,classification,created_at) VALUES"
                    + " ('ip06-event','ip06-tenant','MEDIA_JOB','ip06-job',1,'MEDIA_JOB_COMPLETED',"
                    + "'{\"legacy\":true}','INTERNAL',1700000002000)");
        }
    }

    private static Flyway flyway(String location, String schema, String target) {
        var configuration = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations(location.split(","))
                .schemas(schema)
                .defaultSchema(schema)
                .group(false)
                .validateMigrationNaming(true);
        if (target != null) configuration = configuration.target(target);
        return configuration.load();
    }

    private static Connection connection() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static String stringValue(Connection connection, String query) throws Exception {
        try (var statement = connection.createStatement(); ResultSet rows = statement.executeQuery(query)) {
            assertThat(rows.next()).isTrue();
            return rows.getString(1);
        }
    }

    private static Map<Integer, LegacyRow> readManifest() throws Exception {
        try (var input = Ip06LegacyMigrationCompatibilityTest.class.getResourceAsStream(MANIFEST)) {
            assertThat(input).isNotNull();
            try (var reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                return reader.lines().filter(line -> !line.isBlank() && !line.startsWith("#")
                                && !line.startsWith("version,"))
                        .map(line -> line.split(",", -1))
                        .collect(Collectors.toMap(parts -> Integer.parseInt(parts[0]),
                                parts -> {
                                    assertThat(parts).hasSize(4);
                                    int version = Integer.parseInt(parts[0]);
                                    String script = String.format("V%03d__%s.sql", version,
                                            parts[1].replace(' ', '_'));
                                    assertThat(parts[3]).matches("[0-9a-f]{64}");
                                    try (var migration = Ip06LegacyMigrationCompatibilityTest.class
                                            .getResourceAsStream("/db/legacy-media-runtime-v001-v016/" + script)) {
                                        assertThat(migration).as("fixture migration %s", script).isNotNull();
                                        assertThat(sha256(migration.readAllBytes()))
                                                .as("pinned legacy source SHA-256 for %s", script)
                                                .isEqualTo(parts[3]);
                                    } catch (Exception error) {
                                        throw new IllegalStateException(
                                                "could not verify fixture migration " + script, error);
                                    }
                                    return new LegacyRow(parts[1], parts[2].isBlank()
                                            ? null : Integer.valueOf(parts[2]), parts[3]);
                                }, (first, ignored) -> first,
                                LinkedHashMap::new));
            }
        }
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private record LegacyRow(String description, Integer checksum, String sourceSha256) { }
}
