package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** Emits a reproducible, explicitly test-only reconstruction of the historical IP-06 lineage. */
class MediaLegacyMigrationSnapshotArtifactTest {
    private static final String FIXTURE = "/db/legacy-media-runtime-v001-v016/";
    private static final String MANIFEST = FIXTURE + "manifest.csv";
    private static final String README = FIXTURE + "README.md";
    private static final String SNAPSHOT_FIXTURE = "/db/legacy-media-runtime-v001-v016-snapshot/";
    private static final String CHECKED_IN_SNAPSHOT = SNAPSHOT_FIXTURE + "test-snapshot.sql";
    private static final String CHECKED_IN_HISTORY = SNAPSHOT_FIXTURE + "applied-history.csv";
    private static final Pattern SOURCE_COMMIT = Pattern.compile("commit `([0-9a-f]{40})`");

    @Test
    void emitsDeterministicTestOnlySqlSnapshotAndValidatesManifest() throws Exception {
        String readme = resourceText(README);
        Matcher sourceCommitMatch = SOURCE_COMMIT.matcher(readme);
        assertThat(sourceCommitMatch.find()).as("historical source commit in fixture README").isTrue();
        String sourceCommit = sourceCommitMatch.group(1);
        List<Migration> migrations = readManifest();
        assertThat(migrations).hasSize(16);
        assertThat(migrations).extracting(Migration::version).containsExactlyElementsOf(
                java.util.stream.IntStream.rangeClosed(1, 16).boxed().toList());

        StringBuilder sql = new StringBuilder();
        sql.append("-- TEST-ONLY RECONSTRUCTION; NOT A DEPLOYED DATABASE EXPORT.\n")
                .append("-- Historical source commit: ").append(sourceCommit).append('\n')
                .append("-- Historical source path: providers/aws-postgresql/src/main/resources/db/media-runtime/\n")
                .append("-- Fixture path: providers/aws-postgresql/src/test/resources/db/legacy-media-runtime-v001-v016/\n")
                .append("-- Synthetic rows below reuse the IP-06 fixture identities and values.\n")
                .append("-- History projection contains manifest fields only. installed_by, installed_rank,\n")
                .append("-- installed_on, and execution_time require a live PostgreSQL readback.\n")
                .append("CREATE SCHEMA IF NOT EXISTS ip06_legacy_v001_v016_snapshot;\n")
                .append("SET search_path TO ip06_legacy_v001_v016_snapshot;\n\n");

        for (Migration migration : migrations) {
            String script = resourceText(FIXTURE + migration.script());
            assertThat(sha256(script)).as("pinned legacy source SHA-256 for %s", migration.script())
                    .isEqualTo(migration.sourceSha256());
            sql.append("-- BEGIN ").append(migration.script()).append(" sha256=")
                    .append(sha256(script)).append("\n")
                    .append(script);
            if (!script.endsWith("\n")) sql.append('\n');
            sql.append("-- END ").append(migration.script()).append("\n\n");
        }

        sql.append(syntheticRowsSql());
        sql.append("\n-- Manifest-backed applied-history projection; not a PostgreSQL readback.\n")
                .append("CREATE TABLE flyway_schema_history_manifest_projection (\n")
                .append("  version VARCHAR(50) NOT NULL, description VARCHAR(200) NOT NULL,\n")
                .append("  script VARCHAR(1000) NOT NULL, checksum INTEGER NOT NULL, success BOOLEAN NOT NULL\n")
                .append(");\n");
        for (Migration migration : migrations) {
            sql.append("INSERT INTO flyway_schema_history_manifest_projection ")
                    .append("(version,description,script,checksum,success) VALUES ('")
                    .append(String.format("%03d", migration.version())).append("','")
                    .append(migration.description()).append("','")
                    .append(migration.script()).append("',").append(migration.checksum()).append(",TRUE);\n");
        }

        Path artifact = Path.of("build/reports/test-snapshots/ip06-v001-v016-snapshot.sql");
        Files.createDirectories(artifact.getParent());
        Files.writeString(artifact, sql, StandardCharsets.UTF_8);
        String snapshot = sql.toString();
        assertThat(Files.readString(artifact, StandardCharsets.UTF_8)).isEqualTo(snapshot);
        assertThat(resourceText(CHECKED_IN_SNAPSHOT)).isEqualTo(snapshot);
        assertThat(snapshot).contains("TEST-ONLY RECONSTRUCTION", "NOT A DEPLOYED DATABASE EXPORT",
                "synthetic legacy transcript", "ip06-event", "flyway_schema_history_manifest_projection");
        assertThat(snapshot.split("INSERT INTO flyway_schema_history_manifest_projection", -1))
                .hasSize(17);
        validateCheckedInAppliedHistory(migrations);
    }

    private static String syntheticRowsSql() {
        return """
                -- Synthetic IP-06 rows; no customer or deployed database data.
                INSERT INTO media_artifacts
                  (tenant_id,artifact_id,file_name,content_type,size_bytes,sha256,object_reference,
                   classification,created_at,expires_at,metadata_json) VALUES
                  ('ip06-tenant','ip06-artifact','legacy.wav','audio/wav',128,
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   's3://fixture/ip06','INTERNAL',1700000000000,1800000000000,'{}');
                INSERT INTO media_processing_jobs
                  (tenant_id,job_id,request_id,artifact_id,job_type,provider_id,status,created_at,
                   result_json,failure_code,version) VALUES
                  ('ip06-tenant','ip06-job','ip06-request','ip06-artifact','STT','fixture-provider',
                   'COMPLETED',1700000000000,'{"legacy":true}','',1);
                INSERT INTO media_transcript_revisions
                  (tenant_id,transcript_id,revision,principal_id,source_artifact_id,source_artifact_version,
                   source_sha256,job_id,profile_id,provider_id,model_id,language,timebase,transcript_text,
                   consent_decision_id,rights_decision_id,policy_version,created_at) VALUES
                  ('ip06-tenant','ip06-transcript',1,'fixture-principal','ip06-artifact',
                   'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','ip06-job',
                   'fixture-profile','fixture-provider','fixture-model','en','milliseconds',
                   'synthetic legacy transcript','fixture-consent','fixture-rights','fixture-policy',
                   1700000001000);
                INSERT INTO media_processing_lifecycle_outbox
                  (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,
                   payload_json,classification,created_at) VALUES
                  ('ip06-event','ip06-tenant','MEDIA_JOB','ip06-job',1,'MEDIA_JOB_COMPLETED',
                   '{"legacy":true}','INTERNAL',1700000002000);
                """;
    }

    private static List<Migration> readManifest() throws Exception {
        try (var input = MediaLegacyMigrationSnapshotArtifactTest.class.getResourceAsStream(MANIFEST)) {
            assertThat(input).isNotNull();
            try (var reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                return reader.lines().filter(line -> !line.isBlank() && !line.startsWith("#")
                                && !line.startsWith("version,"))
                        .map(line -> line.split(",", -1))
                        .map(parts -> {
                            int version = Integer.parseInt(parts[0]);
                            String script = String.format("V%03d__%s.sql", version,
                                    parts[1].replace(' ', '_'));
                            assertThat(parts).hasSize(4);
                            assertThat(parts[2]).as("manifest checksum V%03d", version).isNotBlank();
                            assertThat(parts[3]).matches("[0-9a-f]{64}");
                            return new Migration(version, parts[1], Integer.parseInt(parts[2]), script, parts[3]);
                        }).collect(Collectors.toList());
            }
        }
    }

    private static void validateCheckedInAppliedHistory(List<Migration> migrations) throws Exception {
        List<String> lines = resourceText(CHECKED_IN_HISTORY).lines().toList();
        assertThat(lines.get(0)).contains("test-only isolated PostgreSQL readback")
                .contains("not a deployed database export");
        assertThat(lines.get(1)).isEqualTo("# source_commit,d62557fdaac7a324e036ca25f672d2a62ac532ea");
        assertThat(lines.get(2)).isEqualTo(
                "installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success");
        List<String> rows = lines.subList(3, lines.size()).stream().filter(line -> !line.isBlank()).toList();
        assertThat(rows).hasSize(16);
        for (int index = 0; index < rows.size(); index++) {
            List<String> fields = parseCsvRow(rows.get(index));
            Migration migration = migrations.get(index);
            assertThat(fields).hasSize(10);
            assertThat(fields.get(0)).isEqualTo(Integer.toString(index + 1));
            assertThat(fields.get(1)).isEqualTo(String.format("%03d", migration.version()));
            assertThat(fields.get(2)).isEqualTo(migration.description());
            assertThat(fields.get(3)).isEqualTo("SQL");
            assertThat(fields.get(4)).isEqualTo(migration.script());
            assertThat(fields.get(5)).isEqualTo(Integer.toString(migration.checksum()));
            assertThat(fields.get(6)).isNotBlank();
            assertThat(java.time.Instant.parse(fields.get(7))).isNotNull();
            assertThat(Integer.parseInt(fields.get(8))).isGreaterThanOrEqualTo(0);
            assertThat(fields.get(9)).isEqualTo("true");
        }
    }

    private static List<String> parseCsvRow(String line) {
        java.util.ArrayList<String> fields = new java.util.ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        for (int index = 0; index < line.length(); index++) {
            char current = line.charAt(index);
            if (current == '"') {
                if (quoted && index + 1 < line.length() && line.charAt(index + 1) == '"') {
                    field.append('"');
                    index++;
                } else {
                    quoted = !quoted;
                }
            } else if (current == ',' && !quoted) {
                fields.add(field.toString());
                field.setLength(0);
            } else {
                field.append(current);
            }
        }
        fields.add(field.toString());
        return fields;
    }

    private static String resourceText(String path) throws Exception {
        try (var input = MediaLegacyMigrationSnapshotArtifactTest.class.getResourceAsStream(path)) {
            assertThat(input).as(path).isNotNull();
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String sha256(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private record Migration(int version, String description, int checksum, String script, String sourceSha256) { }
}
