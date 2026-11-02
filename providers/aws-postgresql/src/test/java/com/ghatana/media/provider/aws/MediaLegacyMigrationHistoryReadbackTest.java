package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Reads full applied Flyway history from an isolated synthetic PostgreSQL fixture, never deployment. */
@Testcontainers(disabledWithoutDocker = true)
class MediaLegacyMigrationHistoryReadbackTest {
    private static final String SOURCE_COMMIT = "d62557fdaac7a324e036ca25f672d2a62ac532ea";
    private static final String LOCATION = "classpath:db/legacy-media-runtime-v001-v016";
    private static final String FIXTURE = "/db/legacy-media-runtime-v001-v016/";
    private static final String SCHEMA = "ip06_history_readback";
    private static final String MANIFEST = FIXTURE + "manifest.csv";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Test
    void emitsAppliedHistoryWithSyntheticRowsAndValidatesManifest() throws Exception {
        List<History> expected = readManifest();
        Flyway flyway = Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations(LOCATION)
                .schemas(SCHEMA)
                .defaultSchema(SCHEMA)
                .validateMigrationNaming(true)
                .load();
        assertThat(flyway.migrate().migrationsExecuted).isEqualTo(16);
        seedSyntheticRows();

        List<AppliedHistory> applied = new ArrayList<>();
        try (Connection connection = connection();
             var statement = connection.prepareStatement(
                     "SELECT installed_rank, version, description, type, script, checksum, installed_by,"
                             + " installed_on, execution_time, success FROM " + SCHEMA
                             + ".flyway_schema_history WHERE version IS NOT NULL ORDER BY installed_rank");
             ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                applied.add(new AppliedHistory(rows.getInt("installed_rank"), rows.getString("version"),
                        rows.getString("description"), rows.getString("type"), rows.getString("script"),
                        rows.getInt("checksum"), rows.getString("installed_by"),
                        rows.getTimestamp("installed_on").toInstant().toString(),
                        rows.getInt("execution_time"), rows.getBoolean("success")));
            }
        }
        assertThat(applied).hasSize(16);
        for (int index = 0; index < applied.size(); index++) {
            AppliedHistory actual = applied.get(index);
            History manifest = expected.get(index);
            assertThat(actual.installedRank()).isEqualTo(index + 1);
            assertThat(actual.version()).isEqualTo(String.format("%03d", manifest.version()));
            assertThat(actual.description()).isEqualTo(manifest.description());
            assertThat(actual.script()).isEqualTo(manifest.script());
            assertThat(actual.checksum()).isEqualTo(manifest.checksum());
            assertThat(actual.success()).isTrue();
            assertThat(actual.installedBy()).isEqualTo(POSTGRES.getUsername());
            assertThat(actual.type()).isEqualTo("SQL");
        }

        try (Connection connection = connection();
             var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT (SELECT COUNT(*) FROM " + SCHEMA + ".media_artifacts)"
                             + ",(SELECT COUNT(*) FROM " + SCHEMA + ".media_processing_jobs)"
                             + ",(SELECT COUNT(*) FROM " + SCHEMA + ".media_transcript_revisions)"
                             + ",(SELECT COUNT(*) FROM " + SCHEMA + ".media_processing_lifecycle_outbox)")) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getInt(1)).isEqualTo(1);
            assertThat(rows.getInt(2)).isEqualTo(1);
            assertThat(rows.getInt(3)).isEqualTo(1);
            assertThat(rows.getInt(4)).isEqualTo(1);
        }

        Path artifact = Path.of("build/reports/test-snapshots/ip06-v001-v016-applied-history.csv");
        Files.createDirectories(artifact.getParent());
        Files.writeString(artifact, renderCsv(applied), StandardCharsets.UTF_8);
        assertThat(Files.readString(artifact, StandardCharsets.UTF_8)).isEqualTo(renderCsv(applied));
    }

    private static void seedSyntheticRows() throws Exception {
        try (Connection connection = connection(); var statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO " + SCHEMA + ".media_artifacts"
                    + " (tenant_id,artifact_id,file_name,content_type,size_bytes,sha256,object_reference,"
                    + "classification,created_at,expires_at,metadata_json) VALUES"
                    + " ('ip06-tenant','ip06-artifact','legacy.wav','audio/wav',128,"
                    + "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                    + "'s3://fixture/ip06','INTERNAL',1700000000000,1800000000000,'{}')");
            statement.executeUpdate("INSERT INTO " + SCHEMA + ".media_processing_jobs"
                    + " (tenant_id,job_id,request_id,artifact_id,job_type,provider_id,status,created_at,"
                    + "result_json,failure_code,version) VALUES"
                    + " ('ip06-tenant','ip06-job','ip06-request','ip06-artifact','STT','fixture-provider',"
                    + "'COMPLETED',1700000000000,'{\"legacy\":true}','',1)");
            statement.executeUpdate("INSERT INTO " + SCHEMA + ".media_transcript_revisions"
                    + " (tenant_id,transcript_id,revision,principal_id,source_artifact_id,source_artifact_version,"
                    + "source_sha256,job_id,profile_id,provider_id,model_id,language,timebase,transcript_text,"
                    + "consent_decision_id,rights_decision_id,policy_version,created_at) VALUES"
                    + " ('ip06-tenant','ip06-transcript',1,'fixture-principal','ip06-artifact',"
                    + "'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                    + "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ip06-job',"
                    + "'fixture-profile','fixture-provider','fixture-model','en','milliseconds',"
                    + "'synthetic legacy transcript','fixture-consent','fixture-rights','fixture-policy',"
                    + "1700000001000)");
            statement.executeUpdate("INSERT INTO " + SCHEMA + ".media_processing_lifecycle_outbox"
                    + " (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,"
                    + "payload_json,classification,created_at) VALUES"
                    + " ('ip06-event','ip06-tenant','MEDIA_JOB','ip06-job',1,'MEDIA_JOB_COMPLETED',"
                    + "'{\"legacy\":true}','INTERNAL',1700000002000)");
        }
    }

    private static List<History> readManifest() throws Exception {
        try (var input = MediaLegacyMigrationHistoryReadbackTest.class.getResourceAsStream(MANIFEST)) {
            assertThat(input).isNotNull();
            try (var reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(input, StandardCharsets.UTF_8))) {
                return reader.lines().filter(line -> !line.isBlank() && !line.startsWith("#")
                                && !line.startsWith("version,"))
                        .map(line -> line.split(",", -1))
                        .map(parts -> {
                            assertThat(parts).hasSize(4);
                            int version = Integer.parseInt(parts[0]);
                            String script = String.format("V%03d__%s.sql", version,
                                    parts[1].replace(' ', '_'));
                            assertThat(parts[3]).matches("[0-9a-f]{64}");
                            try (var migration = MediaLegacyMigrationHistoryReadbackTest.class
                                    .getResourceAsStream(FIXTURE + script)) {
                                assertThat(migration).as("fixture migration %s", script).isNotNull();
                                assertThat(sha256(migration.readAllBytes()))
                                        .as("pinned legacy source SHA-256 for %s", script)
                                        .isEqualTo(parts[3]);
                            } catch (Exception error) {
                                throw new IllegalStateException("could not verify fixture migration " + script, error);
                            }
                            return new History(version, parts[1], Integer.parseInt(parts[2]), script, parts[3]);
                        }).toList();
            }
        }
    }

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static String renderCsv(List<AppliedHistory> rows) {
        StringBuilder csv = new StringBuilder();
        csv.append("# test-only isolated PostgreSQL readback; not a deployed database export\n")
                .append("# source_commit,").append(SOURCE_COMMIT).append('\n')
                .append("installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success\n");
        for (AppliedHistory row : rows) {
            csv.append(row.installedRank()).append(',').append(csv(row.version())).append(',')
                    .append(csv(row.description())).append(',').append(csv(row.type())).append(',')
                    .append(csv(row.script())).append(',').append(row.checksum()).append(',')
                    .append(csv(row.installedBy())).append(',').append(csv(row.installedOn())).append(',')
                    .append(row.executionTime()).append(',').append(row.success()).append('\n');
        }
        return csv.toString();
    }

    private static String csv(String value) {
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }

    private static Connection connection() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private record History(int version, String description, int checksum, String script, String sourceSha256) { }
    private record AppliedHistory(int installedRank, String version, String description, String type, String script,
                                  int checksum, String installedBy, String installedOn, int executionTime,
                                  boolean success) { }
}
