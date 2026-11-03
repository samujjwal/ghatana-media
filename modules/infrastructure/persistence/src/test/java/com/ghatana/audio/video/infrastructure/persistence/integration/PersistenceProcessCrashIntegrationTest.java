package com.ghatana.audio.video.infrastructure.persistence.integration;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies PostgreSQL recovery when the JVM owning an active or committed transaction is killed. */
@Testcontainers
class PersistenceProcessCrashIntegrationTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"))
            .withDatabaseName("media_process_crash_test")
            .withUsername("test")
            .withPassword("test");

    @Test
    void killedWriterProcessLeavesNoFlushedUncommittedRow() throws Throwable {
        verifyKilledWriterLeavesNoCommit(false);
    }

    @Test
    void killedWriterProcessLeavesNoFlushedAudioOrTranscription() throws Throwable {
        verifyKilledWriterLeavesNoCommit(true);
    }

    @Test
    void killedWriterProcessAfterCommitKeepsAudioAndTranscriptionReadable() throws Throwable {
        verifyKilledWriterAfterCommit(true);
    }

    @Test
    void killedWriterProcessKeepsEarlierCommitAndRollsBackLaterTransaction() throws Throwable {
        verifyKilledWriterWithCommittedAudioAndPendingTranscription();
    }

    private void verifyKilledWriterLeavesNoCommit(boolean includeTranscription) throws Throwable {
        verifyKilledWriter(includeTranscription, false);
    }

    private void verifyKilledWriterAfterCommit(boolean includeTranscription) throws Throwable {
        verifyKilledWriter(includeTranscription, true);
    }

    private void verifyKilledWriterWithCommittedAudioAndPendingTranscription() throws Throwable {
        String databaseName = "media_crash_boundary_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = POSTGRES.getJdbcUrl().substring(0, POSTGRES.getJdbcUrl().lastIndexOf('/') + 1)
                + databaseName;
        String tenantId = "process-crash-boundary-" + UUID.randomUUID();
        UUID audioId = UUID.randomUUID();
        UUID transcriptionId = UUID.randomUUID();
        Path readyFile = Files.createTempFile("media-persistence-child-", ".ready");
        Files.delete(readyFile);
        Process child = null;
        EntityManagerFactory schemaFactory = null;
        EntityManagerFactory readFactory = null;
        Throwable primaryFailure = null;
        try {
            try (var connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE DATABASE \"" + databaseName + "\"");
            }
            try (var connection = DriverManager.getConnection(
                    jdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE SCHEMA audio_video");
            }

            schemaFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", persistenceProperties(jdbcUrl, "create"));
            schemaFactory.close();
            schemaFactory = null;

            String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
            child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                    ChildTransactionWriter.class.getName(), jdbcUrl, POSTGRES.getUsername(),
                    POSTGRES.getPassword(), tenantId, audioId.toString(), readyFile.toString(),
                    transcriptionId.toString(), "false", "true")
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();

            long readyDeadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
            while (!Files.exists(readyFile) && child.isAlive() && System.nanoTime() < readyDeadline) {
                Thread.sleep(20L);
            }
            assertThat(Files.exists(readyFile))
                    .as("child committed audio, then reached the kill boundary with a flushed transcription")
                    .isTrue();
            assertThat(child.isAlive()).isTrue();

            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).as("writer JVM exits after forced termination").isTrue();
            child = null;

            readFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", persistenceProperties(jdbcUrl, "validate"));
            EntityManager readManager = readFactory.createEntityManager();
            try {
                Long audioRows = readManager.createQuery(
                                "select count(a) from AudioFileEntity a where a.id = :id and a.tenantId = :tenant",
                                Long.class)
                        .setParameter("id", audioId)
                        .setParameter("tenant", tenantId)
                        .getSingleResult();
                Long transcriptionRows = readManager.createQuery(
                                "select count(t) from TranscriptionEntity t where t.id = :id and t.tenantId = :tenant",
                                Long.class)
                        .setParameter("id", transcriptionId)
                        .setParameter("tenant", tenantId)
                        .getSingleResult();
                assertThat(audioRows).as("earlier committed audio survives writer termination").isEqualTo(1L);
                assertThat(transcriptionRows).as("later uncommitted transcription is rolled back").isZero();
            } finally {
                readManager.close();
            }
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            if (child != null && child.isAlive()) {
                child.destroyForcibly();
                child.waitFor(10, TimeUnit.SECONDS);
            }
            close(readFactory);
            close(schemaFactory);
            try (var connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS \"" + databaseName + "\" WITH (FORCE)");
            } catch (Throwable cleanupFailure) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanupFailure);
                else throw cleanupFailure;
            }
            Files.deleteIfExists(readyFile);
        }
    }

    private void verifyKilledWriter(boolean includeTranscription, boolean commitBeforeWait) throws Throwable {
        String databaseName = "media_crash_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = POSTGRES.getJdbcUrl().substring(0, POSTGRES.getJdbcUrl().lastIndexOf('/') + 1)
                + databaseName;
        String tenantId = "process-crash-" + UUID.randomUUID();
        UUID audioId = UUID.randomUUID();
        UUID transcriptionId = includeTranscription ? UUID.randomUUID() : null;
        Path readyFile = Files.createTempFile("media-persistence-child-", ".ready");
        Files.delete(readyFile);
        Process child = null;
        EntityManagerFactory schemaFactory = null;
        EntityManagerFactory readFactory = null;
        Throwable primaryFailure = null;
        try {
            try (var connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE DATABASE \"" + databaseName + "\"");
            }
            try (var connection = DriverManager.getConnection(
                    jdbcUrl, POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE SCHEMA audio_video");
            }

            schemaFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", persistenceProperties(jdbcUrl, "create"));
            schemaFactory.close();
            schemaFactory = null;

            String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
            child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                    ChildTransactionWriter.class.getName(), jdbcUrl, POSTGRES.getUsername(),
                    POSTGRES.getPassword(), tenantId, audioId.toString(), readyFile.toString(),
                    transcriptionId == null ? "-" : transcriptionId.toString(), Boolean.toString(commitBeforeWait))
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();

            long readyDeadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
            while (!Files.exists(readyFile) && child.isAlive() && System.nanoTime() < readyDeadline) {
                Thread.sleep(20L);
            }
            assertThat(Files.exists(readyFile))
                    .as("child reached the kill boundary after flush and the selected commit state")
                    .isTrue();
            assertThat(child.isAlive()).isTrue();

            child.destroyForcibly();
            assertThat(child.waitFor(10, TimeUnit.SECONDS))
                    .as("writer JVM exits after forced termination")
                    .isTrue();
            child = null;

            readFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", persistenceProperties(jdbcUrl, "validate"));
            EntityManager readManager = readFactory.createEntityManager();
            try {
                Long rows = readManager.createQuery(
                                "select count(a) from AudioFileEntity a where a.id = :id and a.tenantId = :tenant",
                                Long.class)
                        .setParameter("id", audioId)
                        .setParameter("tenant", tenantId)
                        .getSingleResult();
                assertThat(rows).as("audio row outcome after the owning JVM is killed")
                        .isEqualTo(commitBeforeWait ? 1L : 0L);
                if (transcriptionId != null) {
                    Long transcriptionRows = readManager.createQuery(
                                    "select count(t) from TranscriptionEntity t where t.id = :id and t.tenantId = :tenant",
                                    Long.class)
                            .setParameter("id", transcriptionId)
                            .setParameter("tenant", tenantId)
                            .getSingleResult();
                    assertThat(transcriptionRows)
                            .as("transcription row outcome after the owning JVM is killed")
                            .isEqualTo(commitBeforeWait ? 1L : 0L);
                    if (commitBeforeWait) {
                        TranscriptionEntity persisted = readManager.find(TranscriptionEntity.class, transcriptionId);
                        assertThat(persisted.getAudioFileId()).isEqualTo(audioId);
                        assertThat(persisted.getTenantId()).isEqualTo(tenantId);
                        assertThat(persisted.getText()).isEqualTo("crash-boundary-transcript");
                    }
                }
            } finally {
                readManager.close();
            }
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            if (child != null && child.isAlive()) {
                child.destroyForcibly();
                child.waitFor(10, TimeUnit.SECONDS);
            }
            close(readFactory);
            close(schemaFactory);
            try (var connection = DriverManager.getConnection(
                    POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS \"" + databaseName + "\" WITH (FORCE)");
            } catch (Throwable cleanupFailure) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanupFailure);
                else throw cleanupFailure;
            }
            Files.deleteIfExists(readyFile);
        }
    }

    private static Map<String, Object> persistenceProperties(String jdbcUrl, String ddlMode) {
        Map<String, Object> properties = new HashMap<>();
        properties.put("jakarta.persistence.jdbc.url", jdbcUrl);
        properties.put("jakarta.persistence.jdbc.user", POSTGRES.getUsername());
        properties.put("jakarta.persistence.jdbc.password", POSTGRES.getPassword());
        properties.put("jakarta.persistence.jdbc.driver", "org.postgresql.Driver");
        properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
        properties.put("hibernate.hbm2ddl.auto", ddlMode);
        properties.put("hibernate.default_schema", "audio_video");
        properties.put("hibernate.show_sql", "false");
        return properties;
    }

    private static void close(EntityManagerFactory factory) {
        if (factory != null && factory.isOpen()) factory.close();
    }

    /** Child JVM boundary is intentional: killing it exercises PostgreSQL crash recovery. */
    public static final class ChildTransactionWriter {
        private ChildTransactionWriter() {}

        public static void main(String[] args) throws Exception {
            String jdbcUrl = args[0];
            String username = args[1];
            String password = args[2];
            String tenantId = args[3];
            UUID audioId = UUID.fromString(args[4]);
            Path readyFile = Path.of(args[5]);
            UUID transcriptionId = "-".equals(args[6]) ? null : UUID.fromString(args[6]);
            boolean commitAudioBeforeTranscription = args.length > 8 && Boolean.parseBoolean(args[8]);
            Map<String, Object> properties = new HashMap<>();
            properties.put("jakarta.persistence.jdbc.url", jdbcUrl);
            properties.put("jakarta.persistence.jdbc.user", username);
            properties.put("jakarta.persistence.jdbc.password", password);
            properties.put("jakarta.persistence.jdbc.driver", "org.postgresql.Driver");
            properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
            properties.put("hibernate.hbm2ddl.auto", "validate");
            properties.put("hibernate.default_schema", "audio_video");
            properties.put("hibernate.show_sql", "false");

            EntityManagerFactory factory = Persistence.createEntityManagerFactory("audio-video-test", properties);
            EntityManager manager = factory.createEntityManager();
            manager.getTransaction().begin();
            manager.persist(new AudioFileEntity(audioId, tenantId, UUID.randomUUID(),
                    "crash.wav", "/storage/crash.wav", "wav"));
            if (commitAudioBeforeTranscription) {
                manager.flush();
                manager.getTransaction().commit();
                manager.getTransaction().begin();
            }
            if (transcriptionId != null) {
                manager.persist(new TranscriptionEntity(
                        transcriptionId, tenantId, audioId, UUID.randomUUID(), "crash-boundary-transcript", "en"));
            }
            manager.flush();
            if (Boolean.parseBoolean(args[7])) {
                manager.getTransaction().commit();
            }
            Files.createFile(readyFile);
            Thread.sleep(TimeUnit.MINUTES.toMillis(5));
        }
    }
}
