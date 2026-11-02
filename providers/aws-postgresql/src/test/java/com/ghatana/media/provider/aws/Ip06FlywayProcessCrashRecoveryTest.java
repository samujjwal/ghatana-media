package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Test-only IP-06 process kill while V021 DDL is open in a PostgreSQL transaction. */
@Testcontainers(disabledWithoutDocker = true)
class Ip06FlywayProcessCrashRecoveryTest {
    private static final String LEGACY = "classpath:db/legacy-media-runtime-v001-v016";
    private static final String CURRENT = "classpath:db/media-runtime";
    private static final long LOCK_KEY = 867530921L;
    private static final String[] TAIL = {
            "V017__media_transcript_revisions.sql", "V018__media_lifecycle_outbox_leases.sql",
            "V019__media_stream_acknowledgements.sql", "V020__media_stream_inflight_attempts.sql",
            "V021__media_transcript_processing_purpose.sql", "V022__media_transcript_attempt_binding.sql",
            "V023__media_stt_request_snapshot.sql", "V024__media_source_rights_authority.sql",
            "V025__media_transcript_production_admission.sql", "V026__media_multimodal_operation_snapshot.sql",
            "V027__media_transcript_segment_timing.sql", "V028__media_caption_versions.sql",
            "V029__media_transcript_version_ref_readback.sql"
    };

    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    @Test
    void killedMigrationTransactionRollsBackAndFreshProcessResumesThroughV029(@TempDir Path tempDir)
            throws Exception {
        String schema = "ip06_kill_" + Long.toUnsignedString(System.nanoTime(), 36);
        Path tail = Files.createDirectories(tempDir.resolve("current-tail"));
        for (String script : TAIL) {
            try (var input = getClass().getResourceAsStream("/db/media-runtime/" + script)) {
                assertThat(input).as(script).isNotNull();
                Files.copy(input, tail.resolve(script));
            }
        }
        Flyway legacy = flyway(LEGACY, schema);
        assertThat(legacy.migrate().migrationsExecuted).isEqualTo(16);
        seedLegacyArtifact(schema);

        Path v021 = tail.resolve(TAIL[4]);
        byte[] exactV021 = Files.readAllBytes(v021);
        byte[] barrier = ("\n-- TEST-ONLY transaction barrier; never part of the production migration.\n"
                + "SELECT pg_advisory_lock(" + LOCK_KEY + ");\n").getBytes(StandardCharsets.UTF_8);
        byte[] blockedV021 = java.util.Arrays.copyOf(exactV021, exactV021.length + barrier.length);
        System.arraycopy(barrier, 0, blockedV021, exactV021.length, barrier.length);
        Files.write(v021, blockedV021);

        Path output = tempDir.resolve("blocked-child.out");
        Path log = tempDir.resolve("blocked-child.log");
        String app = "ip06-v021-block-" + schema;
        String filesystemTail = "filesystem:" + tail.toAbsolutePath();
        String locations = LEGACY + "," + filesystemTail;
        try (Connection lock = connection(); var statement = lock.createStatement()) {
            statement.execute("SELECT pg_advisory_lock(" + LOCK_KEY + ")");
            Process child = child(output, log, app, schema, locations);
            try {
                awaitBlockedV021(child, app, log);
                child.destroyForcibly();
                assertThat(child.waitFor(15, TimeUnit.SECONDS)).isTrue();
            } finally {
                if (child.isAlive()) child.destroyForcibly().waitFor(15, TimeUnit.SECONDS);
                statement.execute("SELECT pg_advisory_unlock(" + LOCK_KEY + ")");
            }
        }

        // The child died without returning through Flyway. PostgreSQL must discard V021's
        // transactional DDL and Flyway history insert while retaining the committed V001–V020.
        awaitNoActiveMigration(schema, app);
        assertHistory(schema, 20);
        assertThat(columnExists(schema, "media_transcript_revisions", "purpose_ref")).isFalse();
        assertThat(count(schema, "media_artifacts", "artifact_id='ip06-crash-artifact'")).isEqualTo(1);
        assertThat(output).doesNotExist();

        Files.write(v021, exactV021);
        String resumeLocations = LEGACY + ",filesystem:" + tail.toAbsolutePath();
        Path resumed = tempDir.resolve("resumed-child.out");
        Process resume = child(resumed, tempDir.resolve("resumed-child.log"),
                "ip06-v021-resume-" + schema, schema, resumeLocations);
        awaitExit(resume, tempDir.resolve("resumed-child.log"));
        assertThat(Files.readString(resumed)).isEqualTo("MIGRATED:9");
        assertHistory(schema, 29);
        assertThat(columnExists(schema, "media_transcript_revisions", "purpose_ref")).isTrue();
        assertThat(count(schema, "media_artifacts", "artifact_id='ip06-crash-artifact'")).isEqualTo(1);

        Path noop = tempDir.resolve("noop-child.out");
        Process second = child(noop, tempDir.resolve("noop-child.log"),
                "ip06-v021-noop-" + schema, schema, resumeLocations);
        awaitExit(second, tempDir.resolve("noop-child.log"));
        assertThat(Files.readString(noop)).isEqualTo("MIGRATED:0");
        assertHistory(schema, 29);
    }

    private static Flyway flyway(String location, String schema) {
        return Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations(location).schemas(schema).defaultSchema(schema).validateMigrationNaming(true).load();
    }

    private static Process child(Path output, Path log, String app, String schema, String locations) throws Exception {
        String classpath = System.getProperty("media.child.classpath", "");
        if (classpath.isBlank()) throw new IllegalStateException("Gradle did not provide media.child.classpath");
        String jdbc = POSTGRES.getJdbcUrl() + (POSTGRES.getJdbcUrl().contains("?") ? "&" : "?")
                + "ApplicationName=" + app;
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        ProcessBuilder builder = new ProcessBuilder(java.toString(), "-cp", classpath,
                MediaIp06FlywayCrashWorker.class.getName(), jdbc, POSTGRES.getUsername(),
                POSTGRES.getPassword(), schema, locations, "29", output.toString());
        builder.redirectErrorStream(true).redirectOutput(log.toFile());
        return builder.start();
    }

    private static void awaitBlockedV021(Process child, String app, Path log) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (System.nanoTime() < deadline) {
            if (!child.isAlive()) throw new AssertionError("migration child exited early: " + readLog(log));
            try (Connection connection = connection(); var statement = connection.prepareStatement(
                    "SELECT query FROM pg_stat_activity WHERE application_name=? AND state='active'")) {
                statement.setString(1, app);
                try (ResultSet rows = statement.executeQuery()) {
                    if (rows.next() && rows.getString(1).contains("pg_advisory_lock(" + LOCK_KEY)) return;
                }
            }
            Thread.sleep(50);
        }
        throw new AssertionError("timed out waiting for V021 transaction barrier: " + readLog(log));
    }

    private static void awaitExit(Process process, Path log) throws Exception {
        if (!process.waitFor(30, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            if (!process.waitFor(15, TimeUnit.SECONDS)) {
                throw new AssertionError("timed out and could not reap Flyway child: " + readLog(log));
            }
            throw new AssertionError("Flyway child timed out and was forcibly reaped: " + readLog(log));
        }
        assertThat(process.exitValue()).as(readLog(log)).isZero();
    }

    private static void awaitNoActiveMigration(String schema, String app) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            try (Connection connection = connection(); var statement = connection.prepareStatement(
                    "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name=? AND pid<>pg_backend_pid()")) {
                statement.setString(1, app);
                try (ResultSet rows = statement.executeQuery()) {
                    rows.next();
                    if (rows.getLong(1) == 0) return;
                }
            }
            Thread.sleep(50);
        }
        throw new AssertionError("migration backend remained active for schema " + schema);
    }

    private static void assertHistory(String schema, int expected) throws Exception {
        try (Connection connection = connection(); var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT version::integer,success FROM " + schema
                     + ".flyway_schema_history WHERE version IS NOT NULL ORDER BY version::integer")) {
            int seen = 0;
            while (rows.next()) {
                assertThat(rows.getInt(1)).isEqualTo(++seen);
                assertThat(rows.getBoolean(2)).isTrue();
            }
            assertThat(seen).isEqualTo(expected);
        }
    }

    private static boolean columnExists(String schema, String table, String column) throws Exception {
        try (Connection connection = connection(); var statement = connection.prepareStatement(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=?"
                        + " AND table_name=? AND column_name=?)")) {
            statement.setString(1, schema); statement.setString(2, table); statement.setString(3, column);
            try (ResultSet rows = statement.executeQuery()) { rows.next(); return rows.getBoolean(1); }
        }
    }

    private static long count(String schema, String table, String predicate) throws Exception {
        try (Connection connection = connection(); var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT COUNT(*) FROM " + schema + "." + table
                     + " WHERE " + predicate)) { rows.next(); return rows.getLong(1); }
    }

    private static void seedLegacyArtifact(String schema) throws Exception {
        try (Connection connection = connection(); var statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO " + schema + ".media_artifacts"
                    + " (tenant_id,artifact_id,file_name,content_type,size_bytes,sha256,object_reference,"
                    + "classification,created_at,expires_at,metadata_json) VALUES"
                    + " ('ip06-tenant','ip06-crash-artifact','legacy.wav','audio/wav',128,"
                    + "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',"
                    + "'s3://fixture/ip06','INTERNAL',1700000000000,1800000000000,'{}')");
        }
    }

    private static Connection connection() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static String readLog(Path log) {
        try { return Files.exists(log) ? Files.readString(log) : "<no child output>"; }
        catch (Exception ignored) { return "<unable to read child output>"; }
    }
}
